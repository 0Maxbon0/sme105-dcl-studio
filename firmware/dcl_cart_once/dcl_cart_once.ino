#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <cstring>

// REFERENCE-BASED, EXPERIMENTAL, ONE-SHOT Ford EEC-IV DCL UART -> CART
// Original: doncreat0r/eeciv Diag324.c (cmdEchoID, cmdGoCART, br2400u,
// br9600, modeWaitID). Not independently validated for SME-105.
// NEVER use unqualified/unprotected vehicle wiring. No arbitrary commands,
// polling, EEPROM writes, resets, diagnostics clearing or engine control.
namespace {
HardwareSerial Dcl(2);
constexpr int kRx = 16;
constexpr int kTx = 17;
constexpr gpio_num_t kDe = GPIO_NUM_18;
constexpr uint64_t kTxLimitUs = 100000;
constexpr uint32_t kAckWaitMs = 400;
constexpr uint32_t kAckQuietMs = 20;
constexpr uint32_t kCartListenMs = 10000;
constexpr uint8_t kEchoId[11] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x82, 0x00, 0x00, 0x00, 0x83};
constexpr uint8_t kGoCart[11] = {
    0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00, 0x00, 0x05};

esp_timer_handle_t txTimer = nullptr;
volatile bool txTimeout = false;
volatile uint32_t uartErrors = 0;
bool attemptUsed = false;
bool uartStarted = false;
char input[24] = {};
size_t inputCount = 0;

void txDeadline(void*) {
  gpio_set_level(kDe, 0);
  txTimeout = true;
}

void onReceiveError(hardwareSerial_error_t) { ++uartErrors; }

void printHex(uint8_t byteValue) {
  if (byteValue < 0x10) Serial.print('0');
  Serial.print(byteValue, HEX);
}

void receiveMode() { gpio_set_level(kDe, 0); }

void initUart(uint32_t baud, uint32_t format, int txPin) {
  receiveMode();
  if (uartStarted) Dcl.end();
  Dcl.setRxBufferSize(4096);
  Dcl.begin(baud, format, kRx, txPin);
  Dcl.onReceiveError(onReceiveError);
  uartStarted = true;
  if (txPin < 0) pinMode(kTx, INPUT);
}

bool sendFrame(const uint8_t* bytes, size_t size, const char* name) {
  if (!txTimer || size != 11 || digitalRead(kRx) != HIGH) {
    Serial.print(F("ABORT_TX_PRECHECK "));
    Serial.println(name);
    receiveMode();
    return false;
  }
  txTimeout = false;
  if (esp_timer_start_once(txTimer, kTxLimitUs) != ESP_OK) {
    Serial.println(F("ABORT_TX_TIMER"));
    receiveMode();
    return false;
  }
  gpio_set_level(kDe, 1);
  delayMicroseconds(20);
  const size_t written = Dcl.write(bytes, size);
  Dcl.flush();
  receiveMode();
  (void)esp_timer_stop(txTimer);
  Serial.print(F("TX_FRAME "));
  Serial.print(name);
  Serial.print(F(" bytes="));
  Serial.print(written);
  Serial.print(F(" watchdog="));
  Serial.println(txTimeout ? F("TRIPPED") : F("OK"));
  return written == size && !txTimeout;
}

// This particular MAX487 assembly has /RE grounded, so the receiver
// observed the whole 11-byte transmitted frame on the previous run.
// Only exactly 11 local echo bytes then a single extra 0x01 can lead
// to the next phase. Anything else fails closed.
bool waitForStrictAck() {
  uint8_t answer[16] = {};
  size_t used = 0;
  uint32_t lastByteMs = millis();
  const uint32_t startMs = millis();
  while (millis() - startMs < kAckWaitMs) {
    while (Dcl.available() > 0) {
      const int b = Dcl.read();
      if (b < 0) break;
      if (used >= sizeof(answer)) {
        Serial.println(F("ACK_REJECT overflow"));
        return false;
      }
      answer[used++] = static_cast<uint8_t>(b);
      lastByteMs = millis();
    }
    if (used >= sizeof(kEchoId) + 1 &&
        millis() - lastByteMs >= kAckQuietMs) {
      break;
    }
    delay(1);
  }
  Serial.print(F("HELLO_RX n="));
  Serial.print(used);
  Serial.print(F(" hex="));
  for (size_t i = 0; i < used; ++i) {
    if (i) Serial.print(' ');
    printHex(answer[i]);
  }
  Serial.println();

  const bool match =
      used == sizeof(kEchoId) + 1 &&
      memcmp(answer, kEchoId, sizeof(kEchoId)) == 0 &&
      answer[sizeof(kEchoId)] == 0x01 &&
      uartErrors == 0;
  if (!match) {
    Serial.println(F("ACK_REJECT expected exact echo(11) + 01; CART NOT SENT"));
    return false;
  }
  Serial.println(F("ACK_CANDIDATE 01; matches reference; origin unverified"));
  return true;
}

void captureCart() {
  // Reference switches to 9600 baud 8N1 AFTER Go CART 2400 baud 8N2.
  initUart(9600, SERIAL_8N1, -1);
  Serial.println(F("CART_MONITOR 9600 8N1 duration_ms=10000 TX_DISABLED"));
  uint8_t chunk[16] = {};
  size_t chunkSize = 0;
  size_t count = 0;
  uint32_t chunkStart = millis();
  const uint32_t startMs = millis();
  const uint32_t initialErrors = uartErrors;

  while (millis() - startMs < kCartListenMs) {
    while (Dcl.available() > 0) {
      const int data = Dcl.read();
      if (data < 0) break;
      if (chunkSize == 0) chunkStart = millis();
      chunk[chunkSize++] = static_cast<uint8_t>(data);
      ++count;
      if (chunkSize == sizeof(chunk)) break;
    }
    if (chunkSize != 0 &&
        (chunkSize == sizeof(chunk) || millis() - chunkStart >= 80)) {
      Serial.print(F("CART_RX t_ms="));
      Serial.print(millis() - startMs);
      Serial.print(F(" n="));
      Serial.print(chunkSize);
      Serial.print(F(" hex="));
      for (size_t i = 0; i < chunkSize; ++i) {
        if (i) Serial.print(' ');
        printHex(chunk[i]);
      }
      Serial.println();
      chunkSize = 0;
    }
    delay(1);
  }
  if (chunkSize) {
    Serial.print(F("CART_RX_END n="));
    Serial.print(chunkSize);
    Serial.print(F(" hex="));
    for (size_t i = 0; i < chunkSize; ++i) {
      if (i) Serial.print(' ');
      printHex(chunk[i]);
    }
    Serial.println();
  }
  Serial.print(F("CART_DONE bytes="));
  Serial.print(count);
  Serial.print(F(" uart_errors="));
  Serial.println(uartErrors - initialErrors);
}

void startOnce() {
  attemptUsed = true;  // Lock BEFORE any electrical activity.
  Serial.println(F("START one-shot reference EchoID -> guarded GoCART"));
  if (digitalRead(kRx) != HIGH || !txTimer) {
    Serial.println(F("ABORT preconditions failed; no TX"));
    return;
  }
  uartErrors = 0;
  while (Dcl.available() > 0) (void)Dcl.read();
  if (!sendFrame(kEchoId, sizeof(kEchoId), "ECHO_ID")) {
    Serial.println(F("ABORT HELLO TX; CART NOT SENT"));
    return;
  }
  if (!waitForStrictAck()) {
    Serial.println(F("DONE no verified candidate ACK; CART NOT SENT"));
    return;
  }
  // A matching 0x01 MAY still be electrically spurious: this is a
  // reference experiment, not a protocol authentication guarantee.
  if (!sendFrame(kGoCart, sizeof(kGoCart), "GO_CART")) {
    Serial.println(F("ABORT GO_CART TX; no UART mode transition"));
    return;
  }
  captureCart();
  Serial.println(F("DONE one-shot closed; no further TX until reboot"));
}

void onLine() {
  if (!strcmp(input, "STATUS")) {
    Serial.print(F("STATUS rx2="));
    Serial.print(digitalRead(kRx) == HIGH ? F("HIGH") : F("LOW"));
    Serial.print(F(" tx="));
    Serial.println(attemptUsed ? F("LOCKED") : F("WAITING_FOR_EXPLICIT_START"));
  } else if (!strcmp(input, "START")) {
    if (attemptUsed) Serial.println(F("LOCKED no repeat until reboot"));
    else startOnce();
  } else if (input[0] != '\0') {
    Serial.println(F("ERR allowed commands: STATUS, START (once)"));
  }
}
}  // namespace

void setup() {
  // Physical external 10k DE pull-down still required during boot/reset.
  receiveMode();
  gpio_set_direction(kDe, GPIO_MODE_OUTPUT);
  receiveMode();
  Serial.begin(115200);
  initUart(2400, SERIAL_8N2, kTx);
  esp_timer_create_args_t args = {};
  args.callback = &txDeadline;
  args.name = "dcl_tx_deadline";
  if (esp_timer_create(&args, &txTimer) != ESP_OK) txTimer = nullptr;
  delay(250);
  Serial.println(F("DCL guarded CART reference probe: NO AUTO TX"));
}

void loop() {
  while (Serial.available() > 0) {
    const char c = static_cast<char>(Serial.read());
    if (c == '\r' || c == '\n') {
      if (inputCount) {
        input[inputCount] = '\0';
        onLine();
        inputCount = 0;
        input[0] = '\0';
      }
    } else if (inputCount < sizeof(input) - 1) {
      input[inputCount++] = c;
    } else {
      inputCount = 0;
      input[0] = '\0';
      Serial.println(F("ERR input overflow discarded"));
    }
  }
}
