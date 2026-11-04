#include <Arduino.h>
#include <HardwareSerial.h>
#include <driver/gpio.h>
#include <driver/uart.h>
#include <esp_intr_alloc.h>
#include <esp_timer.h>
#include <soc/soc.h>
#include <soc/gpio_struct.h>
#include <soc/uart_struct.h>
#include <cstring>

// DISCONNECTED USB/ESP32 BENCH ONLY, NEVER CONNECT TO CAR/OBD/ECU.
// Jumper TX GPIO17 -> RX GPIO16 via 1k, and GPIO17 -> GPIO19 via 1k.
// Disconnect MAX487 and all vehicle wiring before powering this firmware.
// GPIO18 (MAX487 DE) is never asserted, including in ISR.
// Both trials transmit a synthetic header LOCALLY over GPIO17, not CART B.
namespace {
constexpr gpio_num_t kDe = GPIO_NUM_18;
constexpr int kTx = 17, kRx = 16, kTrace = 19;
constexpr uint32_t kBaud = 9600;
constexpr size_t kMaxRx = 96, kMaxEdges = 256;
struct RxEvent { uint32_t whenUs; uint8_t byte; };
struct Edge { uint32_t whenUs; uint8_t level; };
RxEvent rx[kMaxRx] = {};
Edge edges[kMaxEdges] = {};
volatile uint32_t nRx = 0, nEdges = 0, rxErrors = 0, rxCoalesced = 0;
volatile bool enabled = false;
bool used = false;
bool rxRunning = false;
intr_handle_t rxHandle = nullptr;
HardwareSerial tx(2);
char line[32] = {};
uint8_t lineUsed = 0;

void IRAM_ATTR traceIsr() {
  if (!enabled) return;
  const uint32_t i = nEdges;
  if (i < kMaxEdges) {
    edges[i].whenUs = static_cast<uint32_t>(esp_timer_get_time());
    edges[i].level = (GPIO.in & (1UL << kTrace)) ? 1 : 0;
    nEdges = i + 1;
  }
}

void IRAM_ATTR uartIsr(void*) {
  const uint32_t pending = UART1.int_st.val;
  if (pending & ((1UL << 2) | (1UL << 3) | (1UL << 4))) ++rxErrors;
  const uint32_t count = UART1.status.rxfifo_cnt;
  if (count > 1) ++rxCoalesced;
  for (uint32_t j = 0; j < count; ++j) {
    const uint8_t byte = static_cast<uint8_t>(UART1.fifo.rw_byte);
    const uint32_t when = static_cast<uint32_t>(esp_timer_get_time());
    const uint32_t i = nRx;
    if (i < kMaxRx) {
      rx[i].whenUs = when;
      rx[i].byte = byte;
      nRx = i + 1;
    } else ++rxErrors;
  }
  UART1.int_clr.val = pending;
}

void stopRx() {
  enabled = false;
  UART1.int_ena.val = 0;
  detachInterrupt(digitalPinToInterrupt(kTrace));
  if (rxRunning && rxHandle) (void)esp_intr_free(rxHandle);
  rxHandle = nullptr;
  rxRunning = false;
  UART1.conf1.rx_tout_en = 0;
}

bool startRx(bool withTimeout) {
  enabled = false;
  nRx = 0;
  nEdges = 0;
  rxErrors = 0;
  rxCoalesced = 0;
  const uart_config_t cfg = {
      .baud_rate = kBaud,
      .data_bits = UART_DATA_8_BITS,
      .parity = UART_PARITY_DISABLE,
      .stop_bits = UART_STOP_BITS_1,
      .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
      .rx_flow_ctrl_thresh = 0,
      .source_clk = UART_SCLK_APB,
  };
  if (uart_param_config(UART_NUM_1, &cfg) != ESP_OK ||
      uart_set_pin(UART_NUM_1, UART_PIN_NO_CHANGE, kRx,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) return false;
  UART1.int_ena.val = 0;
  UART1.int_clr.val = 0xFFFFFFFF;
  UART1.conf0.rxfifo_rst = 1;
  UART1.conf0.rxfifo_rst = 0;
  UART1.conf1.rxfifo_full_thrhd = 1; // zero caused a real interrupt storm on UART2
  UART1.conf1.rx_tout_en = withTimeout ? 1 : 0;
  UART1.conf1.rx_tout_thrhd = 1;
  if (esp_intr_alloc(ETS_UART1_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &uartIsr, nullptr, &rxHandle) != ESP_OK) return false;
  rxRunning = true;
  UART1.int_ena.rxfifo_full = 1;
  UART1.int_ena.rxfifo_ovf = 1;
  UART1.int_ena.frm_err = 1;
  UART1.int_ena.parity_err = 1;
  if (withTimeout) UART1.int_ena.rxfifo_tout = 1;
  attachInterrupt(digitalPinToInterrupt(kTrace), &traceIsr, CHANGE);
  enabled = true;
  return true;
}

void printHex(uint8_t v) {
  if (v < 16) Serial.print('0');
  Serial.print(v, HEX);
}

void runTrial(bool timeout, uint8_t mode) {
  digitalWrite(kDe, LOW);
  if (!startRx(timeout)) {
    stopRx();
    Serial.println(F("BENCH_FAIL cannot configure isolated RX interrupt"));
    return;
  }
  // No automatic TX on setup. The only TX here is the explicit isolated
  // diagnostic stimulus, with a maximum of 8 known constant bytes.
  constexpr uint8_t kOne[4] = {0x00, 0x00, 0x00, 0xA0};
  constexpr uint8_t kTwo[4] = {0x00, 0x00, 0x00, 0xB1};
  delay(4);
  const uint32_t begunUs = static_cast<uint32_t>(esp_timer_get_time());
  tx.write(kOne, sizeof(kOne));
  tx.flush();
  delay(6); // includes the next header gap, exposing FIFO one-byte delay
  tx.write(kTwo, sizeof(kTwo));
  tx.flush();
  delay(4);
  const uint32_t afterUs = static_cast<uint32_t>(esp_timer_get_time());
  stopRx();

  Serial.print(F("BENCH_TRIAL mode=")); Serial.print(mode);
  Serial.print(F(" timeout=")); Serial.print(timeout ? 1 : 0);
  Serial.print(F(" rx=")); Serial.print(nRx);
  Serial.print(F(" edges=")); Serial.print(nEdges);
  Serial.print(F(" uart_errors=")); Serial.print(rxErrors);
  Serial.print(F(" batched=")); Serial.print(rxCoalesced);
  Serial.print(F(" pending_fifo=")); Serial.print(UART1.status.rxfifo_cnt);
  Serial.print(F(" start_us=")); Serial.print(begunUs);
  Serial.print(F(" finish_us=")); Serial.println(afterUs);
  for (uint32_t i = 0; i < nRx && i < kMaxRx; ++i) {
    Serial.print(F("RX t_us=")); Serial.print(rx[i].whenUs);
    Serial.print(F(" byte=")); printHex(rx[i].byte);
    Serial.println();
  }
  for (uint32_t i = 0; i < nEdges && i < kMaxEdges; ++i) {
    Serial.print(F("EDGE t_us=")); Serial.print(edges[i].whenUs);
    Serial.print(F(" level=")); Serial.println(edges[i].level);
  }
}

bool pinCheck() {
  // No UART bytes are transmitted. UART2 is initialized only to establish
  // the electrical idle-HIGH TX level used by the real bench trial.
  digitalWrite(kDe, LOW);
  tx.begin(kBaud, SERIAL_8N1, -1, kTx);
  pinMode(kRx, INPUT);
  pinMode(kTrace, INPUT);
  delay(5);
  const int tx17 = digitalRead(kTx);
  const int rx16 = digitalRead(kRx);
  const int trace19 = digitalRead(kTrace);
  tx.end();
  pinMode(kTx, INPUT);
  const bool ready = tx17 == HIGH && rx16 == HIGH && trace19 == HIGH;
  Serial.print(F("PIN_CHECK tx17=")); Serial.print(tx17);
  Serial.print(F(" rx16=")); Serial.print(rx16);
  Serial.print(F(" trace19=")); Serial.print(trace19);
  Serial.print(F(" ready=")); Serial.print(ready ? 1 : 0);
  Serial.println(F(" DE=LOW no_test_bytes=1"));
  return ready;
}

void test() {
  used = true;
  digitalWrite(kDe, LOW);
  tx.begin(kBaud, SERIAL_8N1, -1, kTx);
  pinMode(kTrace, INPUT);
  // Print all three pin levels, instead of a generic error hiding which
  // jumper or pin mapping was wrong. A bad preflight NEVER writes a byte.
  delay(5);
  const int tx17 = digitalRead(kTx);
  const int rx16 = digitalRead(kRx);
  const int trace19 = digitalRead(kTrace);
  Serial.print(F("PIN_CHECK tx17=")); Serial.print(tx17);
  Serial.print(F(" rx16=")); Serial.print(rx16);
  Serial.print(F(" trace19=")); Serial.print(trace19);
  Serial.print(F(" ready=")); Serial.print(tx17 == HIGH && rx16 == HIGH && trace19 == HIGH ? 1 : 0);
  Serial.println(F(" DE=LOW no_test_bytes=1"));
  if (tx17 != HIGH || rx16 != HIGH || trace19 != HIGH) {
    tx.end();
    pinMode(kTx, INPUT);
    Serial.println(F("BENCH_DENIED jumper_missing_or_input_not_idle_high; no_test_bytes"));
    return;
  }
  Serial.println(F("BENCH_BEGIN LOCAL_ONLY bytes=8x2 baud=9600 DE=LOW"));
  runTrial(false, 1);
  runTrial(true, 2);
  tx.end();
  pinMode(kTx, INPUT);
  digitalWrite(kDe, LOW);
  Serial.println(F("BENCH_END DCL_TX=0 ECU_TX=0 DE=LOW"));
}

void dispatch() {
  if (!strcmp(line, "STATUS")) {
    digitalWrite(kDe, LOW);
    Serial.print(F("STATUS SME105_UART_EDGE_BENCH_V2 DE=LOW ECU_TX=DISABLED used="));
    Serial.println(used ? 1 : 0);
  } else if (!strcmp(line, "PIN_CHECK")) {
    (void)pinCheck();
  } else if (!strcmp(line, "BENCH_GPIO_ONCE")) {
    if (used) Serial.println(F("DENIED one_bench_test_per_boot"));
    else test();
  } else if (!strcmp(line, "STOP")) {
    digitalWrite(kDe, LOW);
    Serial.println(F("STOP DE=LOW"));
  } else if (line[0]) Serial.println(F("DENIED unknown_command"));
}
} // namespace

void setup() {
  pinMode(kDe, OUTPUT);
  digitalWrite(kDe, LOW);
  pinMode(kTx, INPUT);
  pinMode(kRx, INPUT);
  pinMode(kTrace, INPUT);
  Serial.begin(115200);
  delay(250);
  Serial.println(F("SME105_UART_EDGE_BENCH_V2 USB_JUMPER_ONLY NEVER_CONNECT_TO_VEHICLE"));
  Serial.println(F("GPIO17->GPIO16 1k AND GPIO17->GPIO19 1k; MAX487/CAR DISCONNECTED"));
}

void loop() {
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      if (lineUsed) {
        line[lineUsed] = '\0';
        dispatch();
        lineUsed = 0;
      }
    } else if (ch >= ' ' && ch <= '~' && lineUsed < sizeof(line) - 1) {
      line[lineUsed++] = ch;
    } else {
      lineUsed = 0;
      Serial.println(F("DENIED invalid_input"));
    }
  }
}
