#include <Arduino.h>
#include <driver/uart.h>
#include <cstring>

// BENCH ONLY: UART2 digital internal loopback. No RS485 driver enable, EVER.
// This validates the exact ESP32 UART hardware at 2400 8N2 and 9600 8N1.
// It does NOT test the MAX487 A/B physical pins or car-side bus electricals.
namespace {
HardwareSerial Dcl(2);
constexpr int kRx = 16;
constexpr int kTx = 17;
constexpr int kDe = 18;
constexpr uint8_t kEcho[11] = {0, 0, 0, 0, 0, 1, 0x82, 0, 0, 0, 0x83};
constexpr uint32_t kTimeoutMs = 450;
constexpr size_t kMaxBytes = 64;

// No call ever sets this pin HIGH. External 10k resistor required as well.
void disableBusDriver() {
  digitalWrite(kDe, LOW);
  pinMode(kDe, OUTPUT);
}

bool uartTrial(const uint8_t* expected, size_t length, uint32_t baud,
               uint32_t format, const char* name) {
  disableBusDriver();
  Dcl.end();
  Dcl.setRxBufferSize(1024);
  Dcl.begin(baud, format, kRx, kTx);
  const esp_err_t loopStatus = uart_set_loop_back(UART_NUM_2, true);
  if (loopStatus != ESP_OK) {
    Serial.print(F("FAIL "));
    Serial.print(name);
    Serial.println(F(" internal UART loopback unavailable"));
    return false;
  }
  while (Dcl.available() > 0) (void)Dcl.read();
  uint8_t received[kMaxBytes] = {};
  size_t count = 0;
  const size_t submitted = Dcl.write(expected, length);
  Dcl.flush();
  const uint32_t start = millis();
  while (millis() - start < kTimeoutMs && count < length) {
    const int value = Dcl.read();
    if (value < 0) {
      delay(1);
      continue;
    }
    received[count++] = static_cast<uint8_t>(value);
  }
  (void)uart_set_loop_back(UART_NUM_2, false);
  Dcl.end();
  disableBusDriver();
  const bool pass = submitted == length && count == length &&
                    memcmp(expected, received, length) == 0;
  Serial.print(pass ? F("PASS ") : F("FAIL "));
  Serial.print(name);
  Serial.print(F(" sent="));
  Serial.print(submitted);
  Serial.print(F(" recv="));
  Serial.println(count);
  return pass;
}

void runTests() {
  uint8_t cart[kMaxBytes] = {};
  for (uint8_t i = 0; i < 16; ++i) {
    cart[i * 4 + 3] = ((i ^ 0x0A) << 4) | i;
  }
  const bool hello = uartTrial(kEcho, sizeof(kEcho), 2400, SERIAL_8N2,
                               "UART_2400_8N2_ECHO_ID");
  const bool cartResult = uartTrial(cart, sizeof(cart), 9600, SERIAL_8N1,
                                    "UART_9600_8N1_CART64");
  // Validate every sync and parity ID in the host-visible vector as well.
  bool parity = true;
  for (uint8_t i = 0; i < 16; ++i) {
    const size_t base = i * 4;
    parity &= cart[base] == 0 && cart[base + 1] == 0 &&
              cart[base + 2] == 0 &&
              cart[base + 3] == static_cast<uint8_t>(((i ^ 0x0A) << 4) | i);
  }
  Serial.println(parity ? F("PASS CART16_REFERENCE_PARITY")
                       : F("FAIL CART16_REFERENCE_PARITY"));
  Serial.print(F("SELFTEST "));
  Serial.println(hello && cartResult && parity ? F("PASS") : F("FAIL"));
  disableBusDriver();
}

char line[32] = {};
size_t count = 0;
void onCommand() {
  if (!strcmp(line, "STATUS")) {
    Serial.println(F("STATUS BENCH_ONLY DE=LOW NO_DCL_TX_TO_AB"));
  } else if (!strcmp(line, "SELFTEST")) {
    runTests();
  } else {
    Serial.println(F("ERR allowed: STATUS SELFTEST only"));
  }
}
}  // namespace

void setup() {
  disableBusDriver();
  Serial.begin(115200);
  delay(250);
  Serial.println(F("BENCH ONLY: GPIO18 DE PERMANENTLY LOW"));
  Serial.println(F("USB commands STATUS and SELFTEST; no car TX."));
}

void loop() {
  // DE was configured LOW at boot and is never asserted by this sketch.
  // Avoid repeatedly reconfiguring the GPIO on every CPU iteration.
  while (Serial.available()) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (count) {
        line[count] = '\0';
        onCommand();
        count = 0;
      }
    } else if (count < sizeof(line) - 1) {
      line[count++] = c;
    } else {
      count = 0;
      Serial.println(F("ERR input overflow"));
    }
  }
}
