#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <cstring>

// DESK ONLY: MAX487 controlled sender + MAX487 RO receiver + older XY-K485
// independent RO receiver. Both share an isolated A/B pair. NEVER connect to
// OBD, ECU, car, power supply >5V, or another live differential bus.
// NO AUTO TX. START_DESK_TEST works exactly once per ESP32 boot.
// Leaving the ESP32 with this firmware does not qualify it for vehicle use.
namespace {
HardwareSerial MaxUart(2);  // GPIO16=MAX487 RO, GPIO17=MAX487 DI
HardwareSerial OldUart(1);  // GPIO19 (D19)=XY-K485 RXD (RO); verify <=3.3V first!
constexpr int kMaxRxPin = 16;
constexpr int kMaxTxPin = 17;
constexpr int kOldRxPin = 19;
constexpr gpio_num_t kDePin = GPIO_NUM_18;  // external 10k to GND required
constexpr uint64_t kDeadlineUs = 100000;   // upper bound for 11B@2400 and 64B@9600
constexpr uint32_t kReceiveTimeoutMs = 400;
constexpr uint8_t kHello[11] = {
    0, 0, 0, 0, 0, 1, 0x82, 0, 0, 0, 0x83};
constexpr size_t kCartSize = 64;

esp_timer_handle_t cutoffTimer = nullptr;
volatile bool cutoffTripped = false;
volatile uint32_t maxErrors = 0;
volatile uint32_t oldErrors = 0;
bool attempted = false;
bool configured = false;
char command[24] = {};
size_t inputLength = 0;

void deLow() { gpio_set_level(kDePin, 0); }

void IRAM_ATTR cutoff(void*) {
  gpio_set_level(kDePin, 0);
  cutoffTripped = true;
}

void maxError(hardwareSerial_error_t) { ++maxErrors; }
void oldError(hardwareSerial_error_t) { ++oldErrors; }

void startSerial(uint32_t baud, uint32_t format) {
  deLow();
  if (configured) {
    MaxUart.end();
    OldUart.end();
  }
  MaxUart.setRxBufferSize(512);
  OldUart.setRxBufferSize(512);
  MaxUart.begin(baud, format, kMaxRxPin, kMaxTxPin);
  OldUart.begin(baud, format, kOldRxPin, -1);  // NO TX pin for old module
  MaxUart.onReceiveError(maxError);
  OldUart.onReceiveError(oldError);
  configured = true;
}

size_t receiveExact(HardwareSerial& uart, uint8_t* out, size_t maxLength) {
  size_t received = 0;
  const uint32_t start = millis();
  while (millis() - start < kReceiveTimeoutMs && received < maxLength) {
    int next = uart.read();
    if (next >= 0) {
      out[received++] = static_cast<uint8_t>(next);
    } else {
      delay(1);
    }
  }
  return received;
}

bool trial(uint32_t baud, uint32_t format, const uint8_t* expected,
           size_t length, const char* name) {
  deLow();
  startSerial(baud, format);
  while (MaxUart.read() >= 0) {}
  while (OldUart.read() >= 0) {}
  maxErrors = 0;
  oldErrors = 0;

  // Idle HIGH alone does not certify that A/B are properly terminated or
  // that the old module is receive-only. It is an additional refusal gate.
  if (digitalRead(kMaxRxPin) != HIGH ||
      digitalRead(kOldRxPin) != HIGH || !cutoffTimer) {
    Serial.print(F("FAIL IDLE_OR_TIMER "));
    Serial.println(name);
    return false;
  }

  cutoffTripped = false;
  if (esp_timer_start_once(cutoffTimer, kDeadlineUs) != ESP_OK) {
    Serial.println(F("FAIL cannot arm DE cutoff"));
    return false;
  }
  gpio_set_level(kDePin, 1);
  delayMicroseconds(20);
  const size_t sent = MaxUart.write(expected, length);
  MaxUart.flush(); // wait for outbound UART; DE watchdog is upper bound
  deLow();
  (void)esp_timer_stop(cutoffTimer);

  uint8_t maxReceived[kCartSize] = {};
  uint8_t oldReceived[kCartSize] = {};
  const size_t gotMax = receiveExact(MaxUart, maxReceived, length);
  const size_t gotOld = receiveExact(OldUart, oldReceived, length);
  const bool maxPass = gotMax == length &&
                       memcmp(maxReceived, expected, length) == 0 &&
                       maxErrors == 0;
  const bool oldPass = gotOld == length &&
                       memcmp(oldReceived, expected, length) == 0 &&
                       oldErrors == 0;
  const bool ok = sent == length && !cutoffTripped && maxPass && oldPass;

  Serial.print(ok ? F("PASS ") : F("FAIL "));
  Serial.print(name);
  Serial.print(F(" max="));
  Serial.print(gotMax);
  Serial.print(F("/"));
  Serial.print(length);
  Serial.print(maxPass ? F(":MATCH") : F(":BAD"));
  Serial.print(F(" xy="));
  Serial.print(gotOld);
  Serial.print(F("/"));
  Serial.print(length);
  Serial.print(oldPass ? F(":MATCH") : F(":BAD"));
  Serial.print(F(" de_cutoff="));
  Serial.print(cutoffTripped ? F("TRIPPED") : F("OK"));
  Serial.print(F(" uart_errors_max="));
  Serial.print(maxErrors);
  Serial.print(F(" uart_errors_xy="));
  Serial.println(oldErrors);
  return ok;
}

void selftest() {
  attempted = true; // lock BEFORE a possible transmission
  if (!cutoffTimer) {
    Serial.println(F("SELFTEST FAIL no DE cutoff"));
    return;
  }
  uint8_t cart[kCartSize] = {};
  for (uint8_t id = 0; id < 16; ++id) {
    cart[id * 4 + 3] = static_cast<uint8_t>(((id ^ 0x0A) << 4) | id);
  }
  const bool first = trial(2400, SERIAL_8N2, kHello, sizeof(kHello),
                           "ECHO_ID_2400_8N2");
  // Fail closed on even a single missing/misframed byte at the first baud.
  const bool second = first &&
      trial(9600, SERIAL_8N1, cart, sizeof(cart), "CART_9600_8N1");
  Serial.print(F("SELFTEST "));
  Serial.println(first && second ? F("PASS") : F("FAIL"));
  deLow();
}

void handleLine() {
  if (!strcmp(command, "STATUS")) {
    Serial.print(F("STATUS TWO_RECEIVER_DESK_ONLY DE=LOW TX="));
    Serial.println(attempted ? F("LOCKED") : F("WAITING_FOR_START_DESK_TEST"));
  } else if (!strcmp(command, "START_DESK_TEST")) {
    if (attempted) Serial.println(F("LOCKED no repeat until reboot"));
    else selftest();
  } else {
    Serial.println(F("ERR only STATUS or START_DESK_TEST"));
  }
}
} // namespace

void setup() {
  // Software cannot protect boot/reset time. External 10k pull-down needed.
  gpio_set_direction(kDePin, GPIO_MODE_OUTPUT);
  deLow();
  pinMode(kOldRxPin, INPUT); // don't drive the old module RXD/RO ever
  Serial.begin(115200);
  esp_timer_create_args_t args = {};
  args.callback = &cutoff;
  args.name = "max_de_bench_cutoff";
  if (esp_timer_create(&args, &cutoffTimer) != ESP_OK) cutoffTimer = nullptr;
  delay(200);
  Serial.println(F("TWO RECEIVER RS485 BENCH ONLY; NEVER CONNECT TO ECU"));
  Serial.println(F("MAX487 DE LOW. Only USB STATUS and START_DESK_TEST once."));
}

void loop() {
  while (Serial.available()) {
    const char incoming = static_cast<char>(Serial.read());
    if (incoming == '\n' || incoming == '\r') {
      if (inputLength != 0) {
        command[inputLength] = '\0';
        handleLine();
        inputLength = 0;
      }
    } else if (inputLength < sizeof(command) - 1) {
      command[inputLength++] = incoming;
    } else {
      inputLength = 0;
      Serial.println(F("ERR input overflow"));
    }
  }
}
