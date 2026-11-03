#include <Arduino.h>
#include <HardwareSerial.h>
#include <driver/gpio.h>
#include <driver/uart.h>
#include <driver/rmt.h>
#include <esp_intr_alloc.h>
#include <esp_timer.h>
#include <soc/soc.h>
#include <soc/uart_struct.h>
#include <soc/uart_reg.h>
#include <soc/gpio_struct.h>
#include <soc/gpio_sig_map.h>
#include <soc/timer_group_struct.h>
#include <soc/rmt_struct.h>
#include <cstring>

// Ford EEC-IV experimental 97AB SME-105 USB field bridge.
// There is NO arbitrary bus write API and NO automatic vehicle transmission.
// Flxkrmr B=26A4 and doncreat0r B=260E are competing SOURCE CANDIDATES,
// not an ECU-supported or verified DTC command. No erase/actuator modes.
namespace {
constexpr int kRO = 16, kDI = 17, kDE = 18;
constexpr uint8_t kEchoId[] = {0, 0, 0, 0, 0, 1, 0x82, 0, 0, 0, 0x83};
constexpr uint8_t kGoCart[] = {0, 0, 0, 0, 0, 1, 0x04, 0, 0, 0, 0x05};
constexpr uint32_t kCaptureMs = 10000, kQuietMs = 150, kAckMs = 400;
constexpr uint32_t kArmMs = 15000, kHandshakeWatchdogUs = 75000;
constexpr uint32_t kSlotWatchdogUs = 2250;
constexpr uint32_t kSlotMinLeadUs = 180, kSlotMaxLeadUs = 1250;
constexpr uint32_t kGapToleranceUs = 175;
constexpr size_t kRxRingSize = 2048; // single producer ISR / single USB consumer
static_assert((kRxRingSize & (kRxRingSize - 1)) == 0, "ring power of two");

// All USB commands run in loop(); only register operations run in UART/timer ISRs.
enum Stage : uint8_t { IDLE, QUIET, ECHO_TX, ACK_WAIT, GO_TX,
                       CART_PASSIVE, CART_READ, FINISHING, FAULTED };
enum Fault : uint8_t { NO_FAULT, BAD_IDLE, HSK_TX, HSK_TIMEOUT, HSK_ACK,
                       CART_INIT, CART_ERR, CART_HEADER, CART_PHASE,
                       CART_CADENCE, CART_TIMER, PAD_MISMATCH, PAD_FRAMING,
                       DE_TIMEOUT, RX_OVERFLOW, HOST_STOP, CAPTURE_TIMEOUT };
struct RxEvent { uint32_t at; uint8_t value; };
struct HeaderByte { uint32_t at; uint8_t value; };
struct CmdWord { uint8_t first; uint8_t second; };
constexpr CmdWord IRAM_ATTR word(uint8_t variant, uint8_t slot) {
  return slot == 0 ? CmdWord{0x01,0xB0} :
         slot == 1 ? CmdWord{0xFF,0x5F} :
         slot == 2 ? (variant == 0 ? CmdWord{0x26,0xA4} : CmdWord{0x26,0x0E}) :
         CmdWord{0x00,0xA0};
}
constexpr uint8_t parity(uint8_t first, uint8_t id) {
  return static_cast<uint8_t>((((first >> 4) ^ (first & 15) ^ id ^ 10) << 4) | id);
}
static_assert(parity(1,0)==0xB0 && parity(0xFF,15)==0x5F &&
              parity(0x26,4)==0xA4 && parity(0x26,14)==0x0E,
              "candidate reference parity");

HardwareSerial referenceBus(2);
hw_timer_t* deTimer = nullptr;
hw_timer_t* slotTimer = nullptr;
intr_handle_t uart1Handle = nullptr;
intr_handle_t uart2Handle = nullptr;
portMUX_TYPE txLock = portMUX_INITIALIZER_UNLOCKED;
volatile Stage stage = IDLE;
volatile Fault failure = NO_FAULT;
volatile bool stopLatched = true, deCutoff = false, slotInFlight = false;
volatile bool slotArmed = false, uart1Live = false;
volatile uint32_t targetUs = 0;
volatile uint8_t variant = 0, pendingSlot = 0;
volatile uint8_t wordsStarted = 0, wordsVerified = 0;
volatile uint8_t padCount = 0;
volatile uint8_t padRx[4][2] = {{0}};
volatile uint32_t txStartUs[4] = {}, txDoneUs[4] = {};
volatile uint32_t uartErr = 0, lostRx = 0, rxTotal = 0;
volatile uint16_t rxWrite = 0, rxRead = 0;
RxEvent rxRing[kRxRingSize] = {};
volatile bool frameLocked = false, captureOnly = false;
volatile uint8_t headerUsed = 0, baselineCount = 0, phase = 255, nextId = 0;
volatile uint32_t lastSyncUs = 0;
HeaderByte header[4] = {};
uint32_t stageStartedMs = 0, captureStartedMs = 0, armExpiresMs = 0;
uint32_t refTxStartedUs = 0, ackLastMs = 0;
uint8_t ack[16] = {}, ackCount = 0;
volatile uint32_t handshakeErrors = 0;
volatile bool transmitConsumed = false;
volatile bool observeConsumed = false; // active Echo-ID/Go-CART, not passive sniff
uint8_t armedVariant = 255;
bool nativeReady = false, refReady = false, gateReady = false;
uint8_t gateChannels = 0;
char commandBuffer[48] = {};
uint8_t commandUsed = 0;
bool discardLine = false;
uint8_t sentPadReports = 0;
uint32_t reportedErrors = 0, reportedLost = 0;
uint8_t lastReportedBaseline = 0;

void IRAM_ATTR deOff() {
  GPIO.out_w1tc = 1UL << kDE;
  GPIO.func_out_sel_cfg[kDE].func_sel = SIG_GPIO_OUT_IDX;
}
void IRAM_ATTR disableSlotTimer() { TIMERG0.hw_timer[1].config.alarm_en = 0; }
void IRAM_ATTR disableDeTimer() { TIMERG0.hw_timer[0].config.alarm_en = 0; }
void IRAM_ATTR faultISR(Fault why) {
  deOff();
  disableSlotTimer();
  disableDeTimer();
  UART2.int_ena.tx_done = 0;
  stopLatched = true;
  slotArmed = false;
  slotInFlight = false;
  if (failure == NO_FAULT) failure = why;
  stage = FAULTED;
}
void IRAM_ATTR watchdogISR() {
  deOff();
  disableDeTimer();
  deCutoff = true;
  if (stage == ECHO_TX || stage == GO_TX || slotInFlight)
    faultISR(DE_TIMEOUT);
}
// Direct TIMERG0 alarms avoid calling timer APIs that acquire locks in ISR.
bool IRAM_ATTR armTimer(uint8_t n, uint32_t deltaUs) {
  if (n > 1) return false;
  TIMERG0.hw_timer[n].config.alarm_en = 0;
  TIMERG0.hw_timer[n].update = 1;
  const uint64_t now = (static_cast<uint64_t>(TIMERG0.hw_timer[n].cnt_high) << 32) |
                       TIMERG0.hw_timer[n].cnt_low;
  const uint64_t target = now + deltaUs;
  TIMERG0.hw_timer[n].alarm_high = static_cast<uint32_t>(target >> 32);
  TIMERG0.hw_timer[n].alarm_low = static_cast<uint32_t>(target);
  if (n == 0) TIMERG0.int_clr_timers.t0 = 1;
  else TIMERG0.int_clr_timers.t1 = 1;
  TIMERG0.hw_timer[n].config.alarm_en = 1;
  return true;
}

bool IRAM_ATTR nearUs(uint32_t a, uint32_t b, uint32_t window = kGapToleranceUs) {
  const int32_t diff = static_cast<int32_t>(a - b);
  return diff >= -static_cast<int32_t>(window) &&
         diff <= static_cast<int32_t>(window);
}
bool IRAM_ATTR headerValid(uint8_t id, uint8_t expectedPhase) {
  if (headerUsed != 4 || header[0].value != 0 || header[1].value != 0 ||
      header[3].value != parity(header[2].value, id)) return false;
  if (!nearUs(header[1].at, header[0].at + 1042) ||
      !nearUs(header[3].at, header[2].at + 1042)) return false;
  const bool four = nearUs(header[2].at, header[1].at + 1458);
  const bool zero = nearUs(header[2].at, header[1].at + 1042);
  return expectedPhase == 255 ? (four || zero) :
         (expectedPhase == 4 ? four : zero);
}

void IRAM_ATTR slotISR() {
  disableSlotTimer();
  portENTER_CRITICAL_ISR(&txLock);
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  if (stage != CART_READ || stopLatched || !slotArmed || slotInFlight ||
      pendingSlot != wordsStarted || wordsVerified != wordsStarted ||
      wordsStarted >= 4 || !gateReady ||
      !nearUs(now, targetUs) || UART2.status.txfifo_cnt != 0 ||
      !(GPIO.in & (1UL << kRO))) {
    faultISR(CART_TIMER);
    portEXIT_CRITICAL_ISR(&txLock);
    return;
  }
  if (!armTimer(0, kSlotWatchdogUs)) {
    faultISR(DE_TIMEOUT);
    portEXIT_CRITICAL_ISR(&txLock);
    return;
  }
  UART2.int_clr.val = 0xFFFFFFFF;
  UART2.conf0.rxfifo_rst = 1;
  UART2.conf0.rxfifo_rst = 0;
  UART2.int_ena.tx_done = 1;
  slotArmed = false;
  slotInFlight = true;
  const uint8_t index = wordsStarted++;
  txStartUs[index] = now;
  // RMT autonomous single-shot gate: 2180us HIGH then 80us LOW.
  const uint8_t channel = static_cast<uint8_t>(2 + index);
  GPIO.func_out_sel_cfg[kDE].func_sel = RMT_SIG_OUT2_IDX + index;
  RMT.conf_ch[channel].conf1.mem_rd_rst = 1;
  RMT.conf_ch[channel].conf1.mem_rd_rst = 0;
  RMT.conf_ch[channel].conf1.tx_start = 1;
  const CmdWord selected = word(variant, index);
  // Native UART2 TX AHB FIFO writes, not the APB RX register bitfield.
  WRITE_PERI_REG(UART_FIFO_AHB_REG(2), selected.first);
  WRITE_PERI_REG(UART_FIFO_AHB_REG(2), selected.second);
  portEXIT_CRITICAL_ISR(&txLock);
}

void IRAM_ATTR uart2ISR(void*) {
  const uint32_t pending = UART2.int_st.val;
  if (pending & (1UL << 14)) { // TX_DONE shifted final 8N1 stop bit
    deOff();
    disableDeTimer();
    UART2.int_ena.tx_done = 0;
    const uint8_t index = static_cast<uint8_t>(wordsStarted - 1);
    const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
    slotInFlight = false;
    if (stage != CART_READ || stopLatched || index >= 4 ||
        !nearUs(now, txStartUs[index] + 2083, 175)) {
      faultISR(CART_TIMER);
    } else {
      // UART2 RX input matrix is ALSO attached to physical GPIO17.
      // Verify actual pad-decoded pair, not merely requested TX FIFO bytes.
      const uint32_t flags = UART2.int_raw.val;
      const uint32_t count = UART2.status.rxfifo_cnt;
      const uint8_t b0 = count > 0 ? static_cast<uint8_t>(UART2.fifo.rw_byte) : 0;
      const uint8_t b1 = count > 1 ? static_cast<uint8_t>(UART2.fifo.rw_byte) : 0;
      padRx[index][0] = b0;
      padRx[index][1] = b1;
      txDoneUs[index] = now;
      __sync_synchronize();
      padCount = index + 1;
      const CmdWord expected = word(variant, index);
      // RXFIFO_TOUT (bit 8) indicates inactivity, not a UART frame error.
      // Parity, framing and overflow (bits 2..4) invalidate the pad witness.
      if (count != 2 || (flags & ((1UL << 2) | (1UL << 3) | (1UL << 4)))) {
        faultISR(PAD_FRAMING);
      } else if (b0 != expected.first || b1 != expected.second) {
        faultISR(PAD_MISMATCH);
      } else {
        ++wordsVerified;
        if (wordsVerified == 4) captureOnly = true;
      }
    }
  }
  UART2.int_clr.val = pending;
}

void IRAM_ATTR observeHeader(uint8_t octet, uint32_t at) {
  if (stage != CART_READ && stage != CART_PASSIVE) return;
  if (captureOnly) return;
  // Preserve every byte in raw ring. Ignore likely local echo for *header parsing only*.
  if (wordsStarted > 0 && (uint32_t)(at - txStartUs[wordsStarted - 1]) <= 2600) return;
  if (!frameLocked) {
    if (headerUsed < 4) header[headerUsed++] = {at, octet};
    else {
      for (int i = 0; i < 3; ++i) header[i] = header[i + 1];
      header[3] = {at, octet};
    }
    if (headerUsed == 4 && headerValid(0, 255)) {
      frameLocked = true;
      phase = nearUs(header[2].at, header[1].at + 1458) ? 4 : 0;
      baselineCount = 1;
      nextId = 1;
      lastSyncUs = header[1].at;
      headerUsed = 0;
    }
    return;
  }
  // Only original consecutive full headers are accepted for grant of TX authority.
  if (headerUsed < 4) header[headerUsed++] = {at, octet};
  else { faultISR(CART_HEADER); return; }
  if (headerUsed != 4) return;
  const uint8_t id = baselineCount < 16 ? baselineCount : nextId;
  const uint32_t sync = header[1].at;
  const uint32_t dt = sync - lastSyncUs;
  const bool cadence = nearUs(dt, 10000) ||
      (baselineCount == 16 && nearUs(dt, 12500));
  const bool valid = headerValid(id, phase) && cadence;
  headerUsed = 0;
  if (!valid) { faultISR(CART_HEADER); return; }
  lastSyncUs = sync;
  if (baselineCount < 16) {
    ++baselineCount;
    if (baselineCount == 16) {
      nextId = 0;
      // In passive observation, all following RO bytes are evidence, not
      // an obligation to satisfy the four diagnostic-command ID headers.
      if (stage == CART_PASSIVE) captureOnly = true;
    }
    return;
  }
  if (stage == CART_PASSIVE) return;
  if (nextId >= 4 || wordsVerified != nextId || slotInFlight || slotArmed) {
    faultISR(CART_PHASE);
    return;
  }
  const uint32_t target = sync + 2917; // 4-bit sync + 24-bit CART word slot
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  const int32_t lead = static_cast<int32_t>(target - now);
  if (lead < static_cast<int32_t>(kSlotMinLeadUs) ||
      lead > static_cast<int32_t>(kSlotMaxLeadUs) || !armTimer(1, static_cast<uint32_t>(lead))) {
    faultISR(CART_TIMER);
    return;
  }
  targetUs = target;
  pendingSlot = nextId;
  slotArmed = true;
  ++nextId;
}

void IRAM_ATTR uart1ISR(void*) {
  const uint32_t pending = UART1.int_st.val;
  if (pending & ((1UL << 2) | (1UL << 3) | (1UL << 4) | (1UL << 8))) {
    ++uartErr;
    if (stage == CART_READ) faultISR(CART_ERR);
  }
  const uint32_t count = UART1.status.rxfifo_cnt;
  if (count > 1) {
    ++uartErr;
    if (stage == CART_READ) faultISR(CART_ERR);
  }
  for (uint32_t i = 0; i < count; ++i) {
    const uint8_t value = static_cast<uint8_t>(UART1.fifo.rw_byte);
    const uint32_t at = static_cast<uint32_t>(esp_timer_get_time());
    const uint16_t head = rxWrite;
    const uint16_t next = (head + 1) & (kRxRingSize - 1);
    if (next == rxRead) {
      ++lostRx;
      if (stage == CART_READ) faultISR(RX_OVERFLOW);
    } else {
      rxRing[head] = {at, value};
      __sync_synchronize();
      rxWrite = next;
      ++rxTotal;
    }
    if (stage == CART_READ || stage == CART_PASSIVE) observeHeader(value, at);
  }
  UART1.int_clr.val = pending;
}

void onReferenceError(hardwareSerial_error_t) { ++handshakeErrors; }
void outputHex(uint8_t value) {
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}
void closeNative() {
  deOff(); disableSlotTimer(); disableDeTimer();
  UART1.int_ena.val = 0; UART2.int_ena.val = 0;
  if (uart1Handle) { esp_intr_free(uart1Handle); uart1Handle = nullptr; }
  if (uart2Handle) { esp_intr_free(uart2Handle); uart2Handle = nullptr; }
  nativeReady = false;
  pinMode(kDI, INPUT);
}
void closeReference() {
  deOff(); disableDeTimer();
  if (refReady) referenceBus.end();
  refReady = false;
  pinMode(kDI, INPUT);
}
void stopEverything(Fault reason) {
  portENTER_CRITICAL(&txLock);
  stopLatched = true;
  deOff(); disableSlotTimer(); disableDeTimer();
  UART2.int_ena.tx_done = 0;
  UART2.conf0.txfifo_rst = 1; UART2.conf0.txfifo_rst = 0;
  slotArmed = false;
  slotInFlight = false;
  portEXIT_CRITICAL(&txLock);
  closeNative(); closeReference();
  if (failure == NO_FAULT) failure = reason;
  stage = FINISHING;
}

bool setupGate() {
  rmt_config_t conf = {};
  conf.rmt_mode = RMT_MODE_TX;
  conf.gpio_num = GPIO_NUM_18;
  conf.clk_div = 80;
  conf.mem_block_num = 1;
  conf.tx_config.loop_en = false;
  conf.tx_config.carrier_en = false;
  conf.tx_config.idle_output_en = true;
  conf.tx_config.idle_level = RMT_IDLE_LEVEL_LOW;
  rmt_item32_t pulse = {};
  pulse.duration0 = 2180; pulse.level0 = 1;
  pulse.duration1 = 80; pulse.level1 = 0;
  for (int i = 0; i < 4; ++i) {
    conf.channel = static_cast<rmt_channel_t>(RMT_CHANNEL_2 + i);
    if (rmt_config(&conf) != ESP_OK ||
        rmt_driver_install(conf.channel, 0, 0) != ESP_OK ||
        rmt_fill_tx_items(conf.channel, &pulse, 1, 0) != ESP_OK) return false;
    ++gateChannels;
  }
  // The 2400/8N2 handshake takes ~50.4ms for eleven octets.
  // RMT6 is an AUTONOMOUS 52ms DE ceiling: CPU/USB lockups cannot
  // leave the MAX487 transmitting indefinitely. A separate 75ms
  // timer ISR also aborts the session if the serial shifter wedges.
  conf.channel = RMT_CHANNEL_6;
  if (rmt_config(&conf) != ESP_OK ||
      rmt_driver_install(conf.channel, 0, 0) != ESP_OK) return false;
  rmt_item32_t handshakeGate[2] = {};
  handshakeGate[0].duration0 = 32000;
  handshakeGate[0].level0 = 1;
  handshakeGate[0].duration1 = 20000;
  handshakeGate[0].level1 = 1;
  handshakeGate[1].duration0 = 80;
  handshakeGate[1].level0 = 0;
  if (rmt_fill_tx_items(RMT_CHANNEL_6, handshakeGate, 2, 0) != ESP_OK) return false;
  deOff();
  gateReady = (gateChannels == 4);
  return gateReady;
}
bool openReference() {
  closeNative();
  referenceBus.setRxBufferSize(256);
  referenceBus.begin(2400, SERIAL_8N2, kRO, kDI);
  referenceBus.onReceiveError(onReferenceError);
  refReady = true;
  return true;
}
bool openNative() {
  closeReference();
  rxRead = rxWrite = 0;
  rxTotal = lostRx = uartErr = 0;
  frameLocked = false; captureOnly = false;
  baselineCount = 0; headerUsed = 0; phase = 255; nextId = 0;
  wordsStarted = wordsVerified = padCount = 0;
  slotInFlight = slotArmed = false;
  const uart_config_t conf = {
    .baud_rate = 9600,
    .data_bits = UART_DATA_8_BITS,
    .parity = UART_PARITY_DISABLE,
    .stop_bits = UART_STOP_BITS_1,
    .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
    .rx_flow_ctrl_thresh = 0,
    .source_clk = UART_SCLK_APB,
  };
  if (uart_param_config(UART_NUM_1, &conf) != ESP_OK ||
      uart_param_config(UART_NUM_2, &conf) != ESP_OK ||
      uart_set_pin(UART_NUM_1, UART_PIN_NO_CHANGE, kRO,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK ||
      uart_set_pin(UART_NUM_2, kDI, kDI,
                   UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE) != ESP_OK) return false;
  gpio_pad_select_gpio(static_cast<gpio_num_t>(kRO));
  gpio_matrix_in(kRO, U1RXD_IN_IDX, false);
  gpio_set_direction(GPIO_NUM_17, GPIO_MODE_INPUT_OUTPUT);
  gpio_matrix_out(GPIO_NUM_17, U2TXD_OUT_IDX, false, false);
  // Input-only mirror of actual TX GPIO17 pad into native UART2 RX.
  gpio_matrix_in(GPIO_NUM_17, U2RXD_IN_IDX, false);
  if (GPIO.func_in_sel_cfg[U1RXD_IN_IDX].func_sel != kRO ||
      GPIO.func_in_sel_cfg[U2RXD_IN_IDX].func_sel != kDI ||
      GPIO.func_in_sel_cfg[U2RXD_IN_IDX].sig_in_sel != 1 ||
      GPIO.func_out_sel_cfg[kDI].func_sel != U2TXD_OUT_IDX) return false;
  UART1.int_ena.val = 0; UART2.int_ena.val = 0;
  UART1.int_clr.val = 0xFFFFFFFF; UART2.int_clr.val = 0xFFFFFFFF;
  UART1.conf0.rxfifo_rst = 1; UART1.conf0.rxfifo_rst = 0;
  UART2.conf0.rxfifo_rst = 1; UART2.conf0.rxfifo_rst = 0;
  UART2.conf0.txfifo_rst = 1; UART2.conf0.txfifo_rst = 0;
  UART1.conf1.rxfifo_full_thrhd = 1;
  if (esp_intr_alloc(ETS_UART1_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &uart1ISR, nullptr, &uart1Handle) != ESP_OK) return false;
  if (esp_intr_alloc(ETS_UART2_INTR_SOURCE, ESP_INTR_FLAG_IRAM,
                     &uart2ISR, nullptr, &uart2Handle) != ESP_OK) {
    esp_intr_free(uart1Handle); uart1Handle = nullptr; return false;
  }
  nativeReady = true;
  UART1.int_ena.rxfifo_full = 1;
  UART1.int_ena.rxfifo_ovf = 1;
  UART1.int_ena.frm_err = 1;
  UART1.int_ena.parity_err = 1;
  return true;
}
void beginSession(Stage target, uint8_t kind) {
  if (stage != IDLE || !gateReady || deTimer == nullptr || slotTimer == nullptr) {
    Serial.println(F("DENIED busy_or_unready")); return;
  }
  // OBSERVE transmits 2400-baud source frames, unlike LISTEN_9600.
  // Never allow repeated active handshakes from a persistent USB client.
  if (target == CART_PASSIVE && kind == 3) {
    if (observeConsumed) {
      Serial.println(F("DENIED observe_already_used")); return;
    }
    observeConsumed = true; // consume before any possible handshake TX
  }
  if (target == CART_READ &&
      (transmitConsumed || armedVariant != kind ||
       static_cast<int32_t>(armExpiresMs - millis()) <= 0)) {
    Serial.println(F("DENIED arm_required_or_consumed")); return;
  }
  if (target == CART_READ) transmitConsumed = true; // before any 2400 TX
  armedVariant = 255;
  stopLatched = true;
  failure = NO_FAULT;
  deCutoff = false;
  reportedErrors = reportedLost = 0;
  lastReportedBaseline = sentPadReports = 0;
  captureOnly = false;
  variant = kind;
  const bool listen = target == CART_PASSIVE && kind == 2;
  if (listen) {
    if (!openNative()) { stopEverything(CART_INIT); Serial.println(F("FAULT reason=CART_INIT")); return; }
    stopLatched = false;
    stage = CART_PASSIVE; captureStartedMs = millis();
    Serial.println(F("EVENT session=LISTEN_9600 origin=RO_ONLY no_tx=1"));
    return;
  }
  if (!openReference()) { stopEverything(CART_INIT); return; }
  stopLatched = false;
  stage = QUIET;
  stageStartedMs = millis();
  Serial.print(F("EVENT session="));
  Serial.println(target == CART_READ ? F("READ_CANDIDATE") : F("OBSERVE"));
}

bool sendReference(const uint8_t (&bytes)[11]) {
  if (!refReady || handshakeErrors || digitalRead(kRO) != HIGH) return false;
  if (!armTimer(0, kHandshakeWatchdogUs)) return false;
  // Output mux switches only after an independently bounded RMT6 gate
  // has been initialized. Never drive handshake DE from a CPU-only GPIO.
  GPIO.func_out_sel_cfg[kDE].func_sel = RMT_SIG_OUT6_IDX;
  RMT.conf_ch[6].conf1.mem_rd_rst = 1;
  RMT.conf_ch[6].conf1.mem_rd_rst = 0;
  RMT.conf_ch[6].conf1.tx_start = 1;
  delayMicroseconds(20); // fixed hardware settle, never waits on USB
  refTxStartedUs = static_cast<uint32_t>(esp_timer_get_time());
  const size_t sent = referenceBus.write(bytes, 11); // <= FIFO capacity, no flush
  return sent == 11;
}
void pollHandshake() {
  const uint32_t now = millis();
  if (stage == QUIET) {
    if (referenceBus.available() || digitalRead(kRO) != HIGH || handshakeErrors) {
      stopEverything(BAD_IDLE); return;
    }
    if (now - stageStartedMs >= kQuietMs) {
      if (!sendReference(kEchoId)) { stopEverything(HSK_TX); return; }
      stage = ECHO_TX; stageStartedMs = now;
      Serial.println(F("EVENT h2400_tx=ECHO_ID bytes=11 candidate=1"));
    }
  } else if (stage == ECHO_TX || stage == GO_TX) {
    const uint32_t elapsed = static_cast<uint32_t>(esp_timer_get_time()) - refTxStartedUs;
    if (elapsed > 90000 || deCutoff || handshakeErrors) {
      stopEverything(HSK_TIMEOUT); return;
    }
    if (elapsed > 40000 && UART2.status.txfifo_cnt == 0 && UART2.status.st_utx_out == 0) {
      deOff(); disableDeTimer();
      if (stage == ECHO_TX) {
        stage = ACK_WAIT;
        stageStartedMs = ackLastMs = now;
        ackCount = 0;
        Serial.println(F("EVENT h2400_tx_done=ECHO_ID"));
      } else {
        if (!openNative()) { stopEverything(CART_INIT); return; }
        stopLatched = false;
        stage = variant >= 2 ? CART_PASSIVE : CART_READ;
        captureStartedMs = now;
        Serial.println(F("EVENT cart=9600_8N1 raw_ro=1 ecu_verified=0 dtc_verified=0"));
      }
    }
  } else if (stage == ACK_WAIT) {
    while (referenceBus.available()) {
      const int c = referenceBus.read();
      if (c < 0 || ackCount >= sizeof(ack)) { stopEverything(HSK_ACK); return; }
      ack[ackCount++] = static_cast<uint8_t>(c);
      ackLastMs = now;
      // H2400 logs preserve candidate bytes; host must not infer ECU ownership.
      Serial.print(F("H2400 t_ms=")); Serial.print(now);
      Serial.print(F(" byte=")); outputHex(static_cast<uint8_t>(c)); Serial.println();
    }
    if (handshakeErrors || ackCount > 12 || now - stageStartedMs >= kAckMs) {
      stopEverything(HSK_ACK); return;
    }
    if (ackCount == 12 && now - ackLastMs >= 20) {
      if (memcmp(ack, kEchoId, 11) || ack[11] != 0x01) {
        stopEverything(HSK_ACK); return;
      }
      Serial.println(F("EVENT ack=candidate_11_echo_plus_01 source=UNVERIFIED"));
      if (!sendReference(kGoCart)) { stopEverything(HSK_TX); return; }
      stage = GO_TX; stageStartedMs = now;
      Serial.println(F("EVENT h2400_tx=GO_CART bytes=11 candidate=1"));
    }
  }
}

void flushPadReports() {
  // Diagnostic headers are only 10ms apart. Avoid task-level USB printing
  // during any uncompleted four-word critical timing sequence. ISR evidence
  // stays in bounded SRAM until the fourth word or a latched fault/STOP.
  if (stage == CART_READ && !captureOnly && failure == NO_FAULT) return;
  while (sentPadReports < padCount) {
    const uint8_t i = sentPadReports++;
    const CmdWord selected = word(variant, i);
    Serial.print(F("TX_PAD slot=")); Serial.print(i);
    Serial.print(F(" expected=")); outputHex(selected.first); outputHex(selected.second);
    Serial.print(F(" observed=")); outputHex(padRx[i][0]); outputHex(padRx[i][1]);
    Serial.print(F(" tx_us=")); Serial.print(txStartUs[i]);
    Serial.print(F(" done_us=")); Serial.print(txDoneUs[i]);
    Serial.print(F(" match=")); Serial.println(i < wordsVerified ? 1 : 0);
  }
}
void flushRaw() {
  char line[45];
  while (rxRead != rxWrite) {
    const RxEvent value = rxRing[rxRead];
    const int len = snprintf(line, sizeof(line), "RX t_us=%lu byte=%02X\n",
                             static_cast<unsigned long>(value.at), value.value);
    if (len <= 0 || len >= static_cast<int>(sizeof(line))) break;
    if (Serial.availableForWrite() < len) break; // never block USB and disturb MCU timing
    Serial.write(reinterpret_cast<const uint8_t*>(line), static_cast<size_t>(len));
    rxRead = (rxRead + 1) & (kRxRingSize - 1);
  }
}
void pollActive() {
  if (stage == CART_READ || stage == CART_PASSIVE) {
    if (reportedErrors != uartErr) { reportedErrors = uartErr; Serial.print(F("EVENT uart_errors=")); Serial.println(uartErr); }
    if (reportedLost != lostRx) { reportedLost = lostRx; Serial.print(F("EVENT rx_lost=")); Serial.println(lostRx); }
    if (baselineCount != lastReportedBaseline && baselineCount == 16) {
      lastReportedBaseline = baselineCount;
      Serial.println(F("EVENT baseline=16 synced=1 authority=unverified"));
    }
    if (millis() - captureStartedMs >= kCaptureMs) stopEverything(CAPTURE_TIMEOUT);
  }
}
void reportEnd() {
  // Raw events MUST be drained before END. Retain bounded capture on USB host.
  flushPadReports();
  flushRaw();
  if (rxRead != rxWrite) return;
  Serial.print(F("END reason=")); Serial.print(static_cast<unsigned>(failure));
  Serial.print(F(" ro_bytes=")); Serial.print(rxTotal);
  Serial.print(F(" ro_lost=")); Serial.print(lostRx);
  Serial.print(F(" uart_errors=")); Serial.print(uartErr);
  Serial.print(F(" pad_verified=")); Serial.print(wordsVerified);
  Serial.print(F(" words_started=")); Serial.print(wordsStarted);
  Serial.println(F(" ecu_verified=0 dtc_verified=0 DE=LOW"));
  stage = IDLE;
}
void printStatus() {
  Serial.print(F("STATUS SME105_USB_BRIDGE_V1 stage=")); Serial.print(static_cast<unsigned>(stage));
  const bool transmitting = (stage == ECHO_TX || stage == GO_TX || slotInFlight);
  Serial.print(transmitting ? F(" DE=ACTIVE_GUARDED") : F(" DE=LOW"));
  Serial.print(F(" auto_tx=0 gate4=")); Serial.print(gateReady ? 1 : 0);
  Serial.print(F(" pad_rx=")); Serial.print(nativeReady ? 1 : 0);
  Serial.print(F(" read_used=")); Serial.print(transmitConsumed ? 1 : 0);
  Serial.print(F(" observe_used=")); Serial.print(observeConsumed ? 1 : 0);
  Serial.print(F(" armed="));
  if (armedVariant < 2 && !transmitConsumed &&
      static_cast<int32_t>(armExpiresMs - millis()) > 0)
    Serial.print(armedVariant == 0 ? F("A4") : F("0E"));
  else Serial.print(F("NONE"));
  Serial.print(F(" fault=")); Serial.println(static_cast<unsigned>(failure));
}
void printPins() {
  Serial.println(F("PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1"));
}
void runCommand(const char* cmd) {
  if (!strcmp(cmd, "STOP")) {
    if (stage != IDLE && stage != FINISHING) { stopEverything(HOST_STOP); Serial.println(F("EVENT stop=accepted DE=LOW")); }
    else { deOff(); Serial.println(F("EVENT stop=idle DE=LOW")); }
    return;
  }
  if (!strcmp(cmd, "HELLO")) { Serial.println(F("HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1")); return; }
  if (!strcmp(cmd, "HELP")) {
    Serial.println(F("COMMANDS HELLO HELP STATUS PINS LISTEN_9600 OBSERVE ARM_A4 READ_A4 ARM_0E READ_0E STOP RESET_IDLE"));
    Serial.println(F("READ_* only after matching ARM_* within 15s; one diagnostic attempt per boot; no clear/actuate/raw write"));
    return;
  }
  if (!strcmp(cmd, "STATUS")) { printStatus(); return; }
  if (!strcmp(cmd, "PINS")) { printPins(); return; }
  if (!strcmp(cmd, "RESET_IDLE")) {
    if (stage != IDLE || slotInFlight || !stopLatched) Serial.println(F("DENIED busy"));
    else { failure = NO_FAULT; armedVariant = 255; Serial.println(F("EVENT idle_reset no_read_rearm=1")); }
    return;
  }
  if (!strcmp(cmd, "ARM_A4") || !strcmp(cmd, "ARM_0E")) {
    if (stage != IDLE || transmitConsumed) { Serial.println(F("DENIED read_used_or_busy")); return; }
    armedVariant = strcmp(cmd, "ARM_A4") == 0 ? 0 : 1;
    armExpiresMs = millis() + kArmMs;
    Serial.print(F("EVENT read_armed variant=")); Serial.print(armedVariant == 0 ? F("A4") : F("0E"));
    Serial.println(F(" valid_ms=15000 no_tx_yet=1"));
    return;
  }
  if (!strcmp(cmd, "READ_A4")) { beginSession(CART_READ, 0); return; }
  if (!strcmp(cmd, "READ_0E")) { beginSession(CART_READ, 1); return; }
  if (!strcmp(cmd, "OBSERVE")) { beginSession(CART_PASSIVE, 3); return; }
  if (!strcmp(cmd, "LISTEN_9600")) { beginSession(CART_PASSIVE, 2); return; }
  Serial.println(F("DENIED unknown_or_unsafe_command"));
}
void pollUsb() {
  while (Serial.available()) {
    const char ch = static_cast<char>(Serial.read());
    if (ch == '\n' || ch == '\r') {
      if (discardLine) { discardLine = false; commandUsed = 0; continue; }
      if (commandUsed) { commandBuffer[commandUsed] = 0; runCommand(commandBuffer); commandUsed = 0; }
    } else if (ch < 32 || ch > 126 || commandUsed >= sizeof(commandBuffer) - 1) {
      discardLine = true;
      commandUsed = 0;
    } else if (!discardLine) {
      commandBuffer[commandUsed++] = ch;
    }
  }
}
} // namespace

void setup() {
  pinMode(kDI, INPUT);
  gpio_set_direction(GPIO_NUM_18, GPIO_MODE_OUTPUT);
  deOff();
  Serial.begin(115200);
  deTimer = timerBegin(0, 80, true);
  if (deTimer) {
    timerAttachInterruptFlag(deTimer, &watchdogISR, false, ESP_INTR_FLAG_IRAM);
    timerAlarmWrite(deTimer, kHandshakeWatchdogUs, false);
    timerAlarmDisable(deTimer);
  }
  slotTimer = timerBegin(2, 80, true);
  if (slotTimer) {
    timerAttachInterruptFlag(slotTimer, &slotISR, false, ESP_INTR_FLAG_IRAM);
    timerAlarmDisable(slotTimer);
  }
  gateReady = setupGate();
  deOff();
  stopLatched = true;
  Serial.println(F("BOOT SME105_USB_BRIDGE_V1 no_auto_tx=1 DE=LOW source_commands_unverified=1"));
  if (!gateReady || !deTimer || !slotTimer) Serial.println(F("FAULT reason=HARDWARE_INIT no_transmit=1"));
}
void loop() {
  pollUsb();
  if (stage == QUIET || stage == ECHO_TX || stage == ACK_WAIT || stage == GO_TX) pollHandshake();
  pollActive();
  flushRaw();
  if (stage == FAULTED) {
    const Fault reason = failure;
    stopEverything(reason);
    Serial.print(F("FAULT reason=")); Serial.println(static_cast<unsigned>(reason));
  }
  flushPadReports();
  if (stage == FINISHING) reportEnd();
  delay(0);
}
