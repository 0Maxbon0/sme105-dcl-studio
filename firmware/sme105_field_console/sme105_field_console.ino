#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <cstring>

// SME-105 experimental field console v1: NO automatic bus TX, NO DTC commands.
// Only CART_REF deliberately emits two exact historical reference handshake
// frames, once per boot, after a strict candidate ACK. No ECU-origin proof.
// 16-bit opcodes for A/B/G are intentionally descriptive ONLY. No arbitrary
// write, clear-codes, KOEO actuator test, PID-map mutation or raw TX commands.
// Do not use the unqualified MAX487 module on an automotive ECU.
namespace {
HardwareSerial bus(2);
constexpr int kRx = 16;
constexpr int kTx = 17;
constexpr gpio_num_t kDe = GPIO_NUM_18;
constexpr uint32_t kUsbBaud = 115200;
constexpr uint64_t kDriverDeadlineUs = 100000;
constexpr uint32_t kListenMs = 5000;
constexpr uint32_t kCartMs = 10000;
constexpr uint32_t kAckWindowMs = 400;
constexpr uint32_t kAckQuietMs = 20;
constexpr size_t kMaxCaptureBytes = 8192;
constexpr uint8_t kEchoId[11] = {
    0, 0, 0, 0, 0, 1, 0x82, 0, 0, 0, 0x83};
constexpr uint8_t kGoCart[11] = {
    0, 0, 0, 0, 0, 1, 0x04, 0, 0, 0, 0x05};
const char kIdentity[] = "SME105_FIELD_V1";
esp_timer_handle_t cutoffTimer = nullptr;
volatile bool cutoffTripped = false;
volatile uint32_t uartErrors = 0;
bool activeAttemptConsumed = false;
bool busOpen = false;
char line[32] = {};
size_t lineLen = 0;
uint32_t lastBaud = 2400;
uint32_t lastFormat = SERIAL_8N2;

void deLow() { gpio_set_level(kDe, 0); }
void onCutoff(void*) {
  deLow();
  cutoffTripped = true;
}
void onError(hardwareSerial_error_t) { ++uartErrors; }

void hexByte(uint8_t value) {
  if (value < 16) Serial.print('0');
  Serial.print(value, HEX);
}

void openBus(uint32_t baud, uint32_t format, bool attachTx) {
  deLow();
  if (busOpen) bus.end();
  bus.setRxBufferSize(4096);
  bus.begin(baud, format, kRx, attachTx ? kTx : -1);
  bus.onReceiveError(onError);
  if (!attachTx) pinMode(kTx, INPUT);
  busOpen = true;
  lastBaud = baud;
  lastFormat = format;
}

bool stopRequested() {
  // STOP is accepted during a receive phase only. Any other host input is
  // discarded and never interpreted as a bus-transmit command.
  static uint8_t stopIndex = 0;
  constexpr char stop[] = "STOP\n";
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == stop[stopIndex]) {
      ++stopIndex;
      if (stopIndex == sizeof(stop) - 1) {
        stopIndex = 0;
        return true;
      }
    } else {
      stopIndex = c == 'S' ? 1 : 0;
    }
  }
  return false;
}

uint8_t verticalParity(uint8_t first, uint8_t id) {
  return (((first >> 4) ^ (first & 15) ^ (id & 15) ^ 10) << 4) |
         (id & 15);
}

void capture(uint32_t milliseconds, const char* label) {
  deLow();
  const uint32_t started = millis();
  const uint32_t firstErrors = uartErrors;
  uint8_t block[16] = {};
  size_t used = 0;
  size_t total = 0;
  size_t headers = 0;
  size_t invalidHeaders = 0;
  size_t outOfOrder = 0;
  uint8_t quartet[4] = {};
  uint8_t quartetUsed = 0;
  uint8_t nextId = 0;
  bool startedAtZero = false;
  bool stoppedByHost = false;
  bool capped = false;

  Serial.print(F("CAPTURE_START mode="));
  Serial.print(label);
  Serial.print(F(" duration_ms="));
  Serial.println(milliseconds);

  while (millis() - started < milliseconds) {
    if (stopRequested()) { stoppedByHost = true; break; }
    while (bus.available() > 0) {
      const int ch = bus.read();
      if (ch < 0) break;
      if (total == kMaxCaptureBytes) { capped = true; break; }
      const uint8_t octet = static_cast<uint8_t>(ch);
      block[used++] = octet;
      ++total;
      quartet[quartetUsed++] = octet;
      if (quartetUsed == 4) {
        const bool good = quartet[0] == 0 && quartet[1] == 0 &&
            verticalParity(quartet[2], quartet[3] & 15) == quartet[3];
        if (good) {
          const uint8_t id = quartet[3] & 15;
          if (headers == 0) startedAtZero = id == 0;
          else if (id != nextId) ++outOfOrder;
          nextId = (id + 1) & 15;
          ++headers;
        } else {
          ++invalidHeaders;
        }
        quartetUsed = 0;
      }
      if (used == sizeof(block)) {
        Serial.print(F("RAW t_ms="));
        Serial.print(millis() - started);
        Serial.print(F(" n="));
        Serial.print(used);
        Serial.print(F(" hex="));
        for (size_t i = 0; i < used; ++i) {
          if (i) Serial.print(' ');
          hexByte(block[i]);
        }
        Serial.println();
        used = 0;
      }
    }
    if (capped || uartErrors != firstErrors) break;
    delay(1);
  }
  if (used) {
    Serial.print(F("RAW_END n="));
    Serial.print(used);
    Serial.print(F(" hex="));
    for (size_t i = 0; i < used; ++i) {
      if (i) Serial.print(' ');
      hexByte(block[i]);
    }
    Serial.println();
  }
  deLow();
  const uint32_t errorDelta = uartErrors - firstErrors;
  Serial.print(F("CAPTURE_END bytes="));
  Serial.print(total);
  Serial.print(F(" uart_errors="));
  Serial.print(errorDelta);
  Serial.print(F(" headers4="));
  Serial.print(headers);
  Serial.print(F(" invalid4="));
  Serial.print(invalidHeaders);
  Serial.print(F(" order_errors="));
  Serial.print(outOfOrder);
  Serial.print(F(" partial4="));
  Serial.print(quartetUsed);
  Serial.print(F(" started_id0="));
  Serial.print(startedAtZero ? 1 : 0);
  Serial.print(F(" stopped="));
  Serial.print(stoppedByHost ? 1 : 0);
  Serial.print(F(" capped="));
  Serial.println(capped ? 1 : 0);
  // Only a zero-payload ID-only quartet stream may have been parsed above.
  // A valid header sequence is NOT DTCs, PID data or ECU-source proof.
  Serial.println(F("NOTE raw quartets are ID-only candidates, NOT fault codes"));
}

bool transmit11(const uint8_t* bytes, const char* label) {
  if (cutoffTimer == nullptr || digitalRead(kRx) != HIGH ||
      uartErrors != 0) {
    Serial.print(F("ABORT precheck ")); Serial.println(label);
    return false;
  }
  cutoffTripped = false;
  if (esp_timer_start_once(cutoffTimer, kDriverDeadlineUs) != ESP_OK) {
    Serial.println(F("ABORT cutoff timer unavailable"));
    return false;
  }
  gpio_set_level(kDe, 1);
  delayMicroseconds(20);
  const size_t written = bus.write(bytes, 11);
  bus.flush();
  deLow();
  (void)esp_timer_stop(cutoffTimer);
  Serial.print(F("TX_FRAME ")); Serial.print(label);
  Serial.print(F(" n=")); Serial.print(written);
  Serial.print(F(" timeout="));
  Serial.println(cutoffTripped ? F("TRIPPED") : F("OK"));
  return written == 11 && !cutoffTripped && uartErrors == 0;
}

bool strictCandidateAck() {
  uint8_t answer[16] = {};
  size_t count = 0;
  const uint32_t start = millis();
  uint32_t last = start;
  while (millis() - start < kAckWindowMs) {
    if (stopRequested()) { Serial.println(F("ABORT STOP before GO_CART")); return false; }
    while (bus.available() > 0) {
      const int value = bus.read();
      if (value < 0 || count == sizeof(answer)) {
        Serial.println(F("ACK_REJECT overflow"));
        return false;
      }
      answer[count++] = static_cast<uint8_t>(value);
      last = millis();
    }
    if (count >= 12 && millis() - last >= kAckQuietMs) break;
    delay(1);
  }
  Serial.print(F("HELLO_RX n="));
  Serial.print(count);
  Serial.print(F(" hex="));
  for (size_t i = 0; i < count; ++i) {
    if (i) Serial.print(' ');
    hexByte(answer[i]);
  }
  Serial.println();
  const bool accepted = count == 12 &&
      memcmp(answer, kEchoId, 11) == 0 && answer[11] == 0x01 &&
      uartErrors == 0;
  Serial.println(accepted
      ? F("ACK_CANDIDATE 01 origin=UNVERIFIED")
      : F("ACK_REJECT no GO_CART"));
  return accepted;
}

void cartReferenceOnce() {
  activeAttemptConsumed = true; // before any possible bus activity
  deLow();
  Serial.println(F("CART_REF_BEGIN experimental one-shot reference; no DTC query"));
  openBus(2400, SERIAL_8N2, true);
  uartErrors = 0;
  while (bus.available()) (void)bus.read();
  if (!transmit11(kEchoId, "ECHO_ID") || !strictCandidateAck()) {
    deLow();
    openBus(2400, SERIAL_8N2, false);
    Serial.println(F("CART_REF_END result=ABORT TX_LOCKED"));
    return;
  }
  if (!transmit11(kGoCart, "GO_CART")) {
    deLow();
    openBus(2400, SERIAL_8N2, false);
    Serial.println(F("CART_REF_END result=ABORT TX_LOCKED"));
    return;
  }
  openBus(9600, SERIAL_8N1, false); // no UART transmitter in CART monitor
  capture(kCartMs, "CART_9600_8N1");
  openBus(9600, SERIAL_8N1, false);
  Serial.println(F("CART_REF_END result=COMPLETE TX_LOCKED"));
}

void help() {
  Serial.println(F("COMMANDS STATUS | HELP | OPTIONS | MON2400 | MON2400N1 | MON4800 | MON4800N2 | MON9600 | MON9600N2 | MON19200 | MON19200N2 | CART_REF | STOP"));
  Serial.println(F("MON*=5s receive-only; CART_REF=one explicit 2400 EchoID + GoCART then 10s 9600 capture"));
  Serial.println(F("DTC A/B/G commands NEVER transmitted. No CLEAR/ACTUATE/RAW."));
}

void options() {
  Serial.println(F("OPTIONS passive 2400/4800/9600/19200 baud, both 8N1 and 8N2"));
  Serial.println(F("OPTIONS reference EchoID+GoCART: prior 2026-11-02 candidate observation, one shot, ECU-source unverified"));
  Serial.println(F("DTC_REF A 03 81 status; B 26 0E versus 26 A4 conflicting; G 21 F6 PID; ALL DISABLED"));
  Serial.println(F("DENIED C clear codes; D self-test; E PID map mutate; arbitrary RAW; unbounded polling"));
}

void monitor(uint32_t baud, uint32_t format, const char* name) {
  openBus(baud, format, false); // no TX routing, DE always LOW
  uartErrors = 0;
  capture(kListenMs, name);
}

void command() {
  if (!strcmp(line, "STATUS")) {
    deLow();
    Serial.print(F("STATUS ")); Serial.print(kIdentity);
    Serial.print(F(" DE=LOW TX="));
    Serial.print(activeAttemptConsumed ? F("LOCKED") : F("ONE_SHOT_CART_REF_ONLY"));
    Serial.print(F(" RX=")); Serial.print(digitalRead(kRx) ? F("HIGH") : F("LOW"));
    Serial.print(F(" watchdog=")); Serial.println(cutoffTimer ? F("READY") : F("FAILED"));
  } else if (!strcmp(line, "HELP")) help();
  else if (!strcmp(line, "OPTIONS")) options();
  else if (!strcmp(line, "MON2400")) monitor(2400, SERIAL_8N2, "MON2400_8N2");
  else if (!strcmp(line, "MON2400N1")) monitor(2400, SERIAL_8N1, "MON2400_8N1");
  else if (!strcmp(line, "MON4800")) monitor(4800, SERIAL_8N1, "MON4800_8N1");
  else if (!strcmp(line, "MON4800N2")) monitor(4800, SERIAL_8N2, "MON4800_8N2");
  else if (!strcmp(line, "MON9600")) monitor(9600, SERIAL_8N1, "MON9600_8N1");
  else if (!strcmp(line, "MON19200")) monitor(19200, SERIAL_8N1, "MON19200_8N1");
  else if (!strcmp(line, "MON9600N2")) monitor(9600, SERIAL_8N2, "MON9600_8N2");
  else if (!strcmp(line, "MON19200N2")) monitor(19200, SERIAL_8N2, "MON19200_8N2");
  else if (!strcmp(line, "CART_REF")) {
    if (activeAttemptConsumed) Serial.println(F("DENIED CART_REF one attempt already used"));
    else cartReferenceOnce();
  } else if (!strcmp(line, "STOP")) {
    deLow();
    Serial.println(F("STOPPED DE=LOW"));
  } else if (line[0]) {
    Serial.println(F("DENIED unknown command; HELP for receive-only and reference options"));
  }
}
} // namespace

void setup() {
  deLow();
  gpio_set_direction(kDe, GPIO_MODE_OUTPUT);
  deLow();
  pinMode(19, INPUT); // optional old XY module, never drive this pin
  Serial.begin(kUsbBaud);
  openBus(2400, SERIAL_8N2, false);
  esp_timer_create_args_t args = {};
  args.callback = &onCutoff;
  args.name = "field_de_deadline";
  if (esp_timer_create(&args, &cutoffTimer) != ESP_OK) cutoffTimer = nullptr;
  delay(250);
  Serial.println(F("SME105_FIELD_V1 NO AUTO BUS TX; HELP for commands"));
}

void loop() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\n' || c == '\r') {
      if (lineLen) {
        line[lineLen] = 0;
        command();
        lineLen = 0;
        line[0] = 0;
      }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = c;
    } else {
      lineLen = 0;
      line[0] = 0;
      Serial.println(F("DENIED command overflow"));
    }
  }
}
