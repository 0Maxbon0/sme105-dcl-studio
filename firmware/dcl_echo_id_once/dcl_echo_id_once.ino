#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_timer.h>

// Experimental Ford EEC-IV reference-only Echo Module ID transaction.
// Source: doncreat0r/eeciv Diag324.c, modeEchoID, cmdEchoID.
// 2400 baud 8N2, 11 reference bytes, expected first answer 0x01.
// NOT validated on SME-105. No ECU reads are attempted automatically.
// Never attach an electrically unqualified / unprotected interface to an ECU.
namespace {
constexpr int kRx = 16;
constexpr int kTx = 17;
constexpr gpio_num_t kDe = GPIO_NUM_18;
constexpr uint32_t kDclBaud = 2400;
constexpr uint64_t kMaxDriveUs = 100000;
constexpr uint32_t kReplyWindowMs = 1500;

constexpr uint8_t kEchoModuleId[] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x82, 0x00, 0x00, 0x00, 0x83,
};

HardwareSerial Dcl(2);
esp_timer_handle_t deWatchdog = nullptr;
volatile bool driveDeadlineTripped = false;
bool txLocked = false;
char input[24] = {};
uint8_t inputLength = 0;

void deOff(void*) {
  gpio_set_level(kDe, 0);
  driveDeadlineTripped = true;
}

void printHex(uint8_t value) {
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}

void sendOnce() {
  txLocked = true;  // Never repeat during this boot, even after an error.
  if (!deWatchdog) {
    Serial.println(F("ABORT: DE watchdog unavailable; no transmission"));
    return;
  }
  if (digitalRead(kRx) != HIGH) {
    Serial.println(F("ABORT: RX2 not HIGH at preflight; no transmission"));
    return;
  }
  while (Dcl.available() > 0) (void)Dcl.read();
  driveDeadlineTripped = false;
  Serial.println(F("TX reference Echo Module ID once at 2400 8N2"));

  // Fail closed if the DE release timer cannot start.
  if (esp_timer_start_once(deWatchdog, kMaxDriveUs) != ESP_OK) {
    Serial.println(F("ABORT: DE timer failed to start; no transmission"));
    return;
  }
  gpio_set_level(kDe, 1);
  delayMicroseconds(20);
  const size_t sent = Dcl.write(kEchoModuleId, sizeof(kEchoModuleId));
  Dcl.flush();
  gpio_set_level(kDe, 0);
  (void)esp_timer_stop(deWatchdog);

  Serial.print(F("TX complete bytes="));
  Serial.print(sent);
  Serial.print(F(" watchdog_tripped="));
  Serial.println(driveDeadlineTripped ? F("YES") : F("NO"));
  Serial.println(F("RX stream below may include LOCAL ECHO. It is not proof of ECU response."));
  const uint32_t start = millis();
  size_t rxCount = 0;
  while (millis() - start < kReplyWindowMs) {
    while (Dcl.available() > 0) {
      const int value = Dcl.read();
      if (value < 0) break;
      if (rxCount < 128) {
        Serial.print(F("RX "));
        Serial.print(rxCount);
        Serial.print(F(" "));
        printHex(static_cast<uint8_t>(value));
        Serial.print(F(" t_ms="));
        Serial.println(millis() - start);
      }
      ++rxCount;
    }
    delay(1);
  }
  Serial.print(F("DONE rx_total="));
  Serial.print(rxCount);
  Serial.println(F("; TX LOCKED until device reboot"));
}

void processLine() {
  if (!strcmp(input, "ECHOID")) {
    if (txLocked) {
      Serial.println(F("LOCKED: one-shot already attempted"));
    } else {
      sendOnce();
    }
  } else if (!strcmp(input, "STATUS")) {
    Serial.print(F("STATUS rx2="));
    Serial.print(digitalRead(kRx) == HIGH ? F("HIGH") : F("LOW"));
    Serial.print(F(" tx="));
    Serial.println(txLocked ? F("LOCKED") : F("WAITING_FOR_EXPLICIT_ECHOID"));
  } else if (input[0] != '\0') {
    Serial.println(F("Unknown command. Allowed: STATUS; ECHOID once."));
  }
}
}  // namespace

void setup() {
  // Hardware: 10k pull-down must keep DE low even during reset.
  gpio_set_level(kDe, 0);
  gpio_set_direction(kDe, GPIO_MODE_OUTPUT);
  Serial.begin(115200);
  Dcl.setRxBufferSize(512);
  Dcl.begin(kDclBaud, SERIAL_8N2, kRx, kTx);
  esp_timer_create_args_t args = {};
  args.callback = &deOff;
  args.name = "dcl_de_deadline";
  if (esp_timer_create(&args, &deWatchdog) != ESP_OK) {
    deWatchdog = nullptr;
  }
  delay(300);
  Serial.println(F("DCL ECHO-ID REFERENCE PROBE; NOT VALIDATED ON SME-105"));
  Serial.println(F("No automatic TX. To request exactly one attempt: ECHOID"));
  Serial.println(F("Never use with an unqualified vehicle electrical interface."));
}

void loop() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r' || c == '\n') {
      if (inputLength != 0) {
        input[inputLength] = '\0';
        processLine();
        inputLength = 0;
        input[0] = '\0';
      }
    } else if (inputLength < sizeof(input) - 1) {
      input[inputLength++] = c;
    } else {
      inputLength = 0;
      input[0] = '\0';
      Serial.println(F("Input too long: discarded"));
    }
  }
}
