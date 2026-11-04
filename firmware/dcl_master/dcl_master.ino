#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_timer.h>

#include <cstring>

namespace {

HardwareSerial DclSerial(2);

// SAE/SME-105 requests have not been captured from this vehicle.
// This master shell is a reference build only; no vehicle transmissions.
constexpr bool kVehicleTxEnabled = false;

constexpr uint32_t kUsbBaud = 115200;
constexpr uint32_t kDefaultDclBaud = 9600;
constexpr int kDclRxPin = 16;
constexpr int kDclTxPin = 17;
constexpr gpio_num_t kDriverEnablePin = GPIO_NUM_18;
constexpr gpio_num_t kReceiverEnableNotPin = GPIO_NUM_19;
constexpr size_t kRxBufferSize = 4096;

constexpr size_t kMaxTxBytes = 32;
constexpr uint64_t kMaxTxActiveUs = 100000;
constexpr uint8_t kBitsPerByte8N2 = 11;
constexpr uint32_t kDriverEnableSettleUs = 2;

constexpr size_t kCommandCapacity = 128;

struct DiagnosticTransaction {
  const char* name;
  const uint8_t* bytes;
  size_t length;
  bool verifiedAndEnabled;
  const char* description;
};

// Candidate read-only Ford EEC-IV DCL query frames with vertical-nibble parity.
constexpr uint8_t kBytesInitPing[] = {0x00, 0xA0};
constexpr uint8_t kBytesModuleSelect[] = {0x00, 0xB1};
constexpr uint8_t kBytesLiveBlock32B[] = {0x01, 0xFF, 0x20, 0x5F};
constexpr uint8_t kBytesLivePidsAlt[] = {0x00, 0xB1, 0x02, 0x1B};
constexpr uint8_t kBytesDtcContinuous[] = {0x00, 0xB2, 0x00, 0xA0};
constexpr uint8_t kBytesDtcKoeo[] = {0x00, 0xB3, 0x00, 0xA0};
constexpr uint8_t kBytesKoeoFastInit[] = {0x01, 0x5F, 0x01, 0x5F};
constexpr uint8_t kBytesIsoFastInit[] = {0x33, 0xC4}; // 0x33 wake with parity

constexpr DiagnosticTransaction kDiagnosticTransactions[] = {
    {"INIT_PING", kBytesInitPing, sizeof(kBytesInitPing), false, "Unverified candidate; disabled"},
    {"MODULE_SELECT", kBytesModuleSelect, sizeof(kBytesModuleSelect), false, "Unverified candidate; disabled"},
    {"LIVE_BLOCK_32B", kBytesLiveBlock32B, sizeof(kBytesLiveBlock32B), false, "Unverified candidate; disabled"},
    {"LIVE_PIDS_ALT", kBytesLivePidsAlt, sizeof(kBytesLivePidsAlt), false, "Unverified candidate; disabled"},
    {"DTC_CONTINUOUS", kBytesDtcContinuous, sizeof(kBytesDtcContinuous), false, "Unverified candidate; disabled"},
    {"DTC_KOEO", kBytesDtcKoeo, sizeof(kBytesDtcKoeo), false, "Unverified candidate; disabled"},
    {"KOEO_FAST_INIT", kBytesKoeoFastInit, sizeof(kBytesKoeoFastInit), false, "Unverified candidate; disabled"},
    {"ISO_FAST_INIT", kBytesIsoFastInit, sizeof(kBytesIsoFastInit), false, "Unverified candidate; disabled"},
};

esp_timer_handle_t txDeadlineTimer = nullptr;
volatile bool txDeadlineForcedRelease = false;
uint32_t dclBaud = kDefaultDclBaud;
uint32_t dclConfig = SERIAL_8N2;
const char* dclFormatName = "8N2";
char commandBuffer[kCommandCapacity];
size_t commandLength = 0;
bool commandOverflow = false;

// Edge counter for GPIO16 physical line activity detection
volatile uint32_t rxEdgeCount = 0;
void IRAM_ATTR onRxEdge() {
  rxEdgeCount++;
}

// Periodic polling state
bool pollingActive = false;
uint32_t pollIntervalMs = 250;
uint32_t nextPollMs = 0;
const DiagnosticTransaction* pollTransaction = &kDiagnosticTransactions[2]; // LIVE_BLOCK_32B

void setReceiveMode() {
  gpio_set_level(kDriverEnablePin, 0);
  gpio_set_level(kReceiverEnableNotPin, 0);
}

void txDeadlineCallback(void*) {
  setReceiveMode();
  txDeadlineForcedRelease = true;
}

bool createTxDeadlineTimer() {
  esp_timer_create_args_t args = {};
  args.callback = &txDeadlineCallback;
  args.arg = nullptr;
  args.dispatch_method = ESP_TIMER_TASK;
  args.name = "dcl_tx_release";
  return esp_timer_create(&args, &txDeadlineTimer) == ESP_OK;
}

uint64_t wireDurationUs(size_t byteCount, uint32_t baud) {
  const uint64_t bits = static_cast<uint64_t>(byteCount) * kBitsPerByte8N2;
  return (bits * 1000000ULL + baud - 1) / baud;
}

const DiagnosticTransaction* findTransaction(const char* name) {
  for (const DiagnosticTransaction& transaction : kDiagnosticTransactions) {
    if (strcmp(transaction.name, name) == 0) {
      return &transaction;
    }
  }
  return nullptr;
}

bool sendRawBytes(const uint8_t* bytes, size_t length, const char* label = "RAW") {
  if (!kVehicleTxEnabled) {
    Serial.println(F("LOCKED: no verified SME-105 transactions; TX disabled"));
    return false;
  }
  if (bytes == nullptr || length == 0) return false;
  if (length > kMaxTxBytes) {
    Serial.println(F("ERR length > 32 bytes"));
    return false;
  }

  setReceiveMode();
  txDeadlineForcedRelease = false;

  if (txDeadlineTimer != nullptr) {
    esp_timer_start_once(txDeadlineTimer, kMaxTxActiveUs);
  }

  gpio_set_level(kReceiverEnableNotPin, 1);
  gpio_set_level(kDriverEnablePin, 1);
  delayMicroseconds(kDriverEnableSettleUs);

  const size_t written = DclSerial.write(bytes, length);
  DclSerial.flush();

  if (txDeadlineTimer != nullptr) {
    esp_timer_stop(txDeadlineTimer);
  }
  setReceiveMode();

  if (txDeadlineForcedRelease) {
    Serial.println(F("ERR TX deadline forced receive mode"));
    return false;
  }

  Serial.print(F("# TX "));
  Serial.print(label);
  Serial.print(F(" ("));
  for (size_t i = 0; i < length; ++i) {
    if (i != 0) Serial.print(' ');
    if (bytes[i] < 0x10) Serial.print('0');
    Serial.print(bytes[i], HEX);
  }
  Serial.println(F(")"));
  return written == length;
}

bool sendTransaction(const DiagnosticTransaction& transaction) {
  if (!transaction.verifiedAndEnabled || transaction.bytes == nullptr) {
    Serial.println(F("ERR transaction disabled"));
    return false;
  }
  return sendRawBytes(transaction.bytes, transaction.length, transaction.name);
}

void sendBreakPulse(uint32_t durationMs) {
  if (!kVehicleTxEnabled) {
    Serial.println(F("LOCKED: wake pulses disabled"));
    return;
  }
  setReceiveMode();
  DclSerial.end();
  pinMode(kDclTxPin, OUTPUT);
  digitalWrite(kDclTxPin, LOW);
  gpio_set_level(kDriverEnablePin, 1);
  gpio_set_level(kReceiverEnableNotPin, 1);
  delay(durationMs);
  digitalWrite(kDclTxPin, HIGH);
  setReceiveMode();
  delay(15); // inter-frame mark before UART re-init
  DclSerial.begin(dclBaud, dclConfig, kDclRxPin, kDclTxPin);
  Serial.print(F("# TX BREAK_PULSE ("));
  Serial.print(durationMs);
  Serial.println(F("ms)"));
}

void applyDclUartConfig() {
  setReceiveMode();
  DclSerial.end();
  DclSerial.begin(dclBaud, dclConfig, kDclRxPin, kDclTxPin);
  Serial.print(F("OK DCL UART: baud="));
  Serial.print(dclBaud);
  Serial.print(F(" format="));
  Serial.println(dclFormatName);
}

void printHelp() {
  Serial.println(F("=== SME-105 Master Shell: TX HARD-LOCKED ==="));
  Serial.println(F("ALLOW: HELP | STATUS | LIST"));
  Serial.println(F("ALLOW: BAUD <2400|4800|9600|10400|19200|38400>"));
  Serial.println(F("ALLOW: FORMAT <8N2|8N1|8E1|8O1>"));
  Serial.println(F("SEND / RAW / WAKE / WAKE_SEND / POLL ON: LOCKED"));
}

void printStatus() {
  Serial.print(F("STATUS baud="));
  Serial.print(dclBaud);
  Serial.print(F(" format="));
  Serial.print(dclFormatName);
  Serial.print(F(" rx_edges="));
  Serial.print(rxEdgeCount);
  Serial.print(F(" polling="));
  Serial.print(pollingActive ? F("ON") : F("OFF"));
  if (pollingActive) {
    Serial.print(F(" interval="));
    Serial.print(pollIntervalMs);
    Serial.print(F("ms query="));
    Serial.print(pollTransaction->name);
  }
  Serial.println();
}

void listTransactions() {
  Serial.println(F("--- Available Read-Only Transactions ---"));
  for (const DiagnosticTransaction& transaction : kDiagnosticTransactions) {
    Serial.print(transaction.name);
    Serial.print(F(" ("));
    Serial.print(transaction.length);
    Serial.print(F("B): "));
    Serial.println(transaction.description);
  }
}

size_t parseHexBytes(const char* str, uint8_t* out, size_t maxLen) {
  size_t count = 0;
  while (*str && count < maxLen) {
    while (*str == ' ' || *str == '\t' || *str == ',') ++str;
    if (!*str) break;
    char hexPair[3] = {0};
    if (isxdigit(str[0]) && isxdigit(str[1])) {
      hexPair[0] = str[0];
      hexPair[1] = str[1];
      out[count++] = static_cast<uint8_t>(strtol(hexPair, nullptr, 16));
      str += 2;
    } else if (isxdigit(str[0])) {
      hexPair[0] = str[0];
      out[count++] = static_cast<uint8_t>(strtol(hexPair, nullptr, 16));
      str += 1;
    } else {
      break;
    }
  }
  return count;
}

void processCommand(const char* command) {
  if (strcmp(command, "HELP") == 0) {
    printHelp();
  } else if (strcmp(command, "STATUS") == 0) {
    printStatus();
  } else if (strcmp(command, "LIST") == 0) {
    listTransactions();
  } else if (strncmp(command, "BAUD ", 5) == 0) {
    uint32_t b = atoi(command + 5);
    if (b > 0) {
      dclBaud = b;
      applyDclUartConfig();
    }
  } else if (strcmp(command, "FORMAT 8N2") == 0) {
    dclConfig = SERIAL_8N2;
    dclFormatName = "8N2";
    applyDclUartConfig();
  } else if (strcmp(command, "FORMAT 8N1") == 0) {
    dclConfig = SERIAL_8N1;
    dclFormatName = "8N1";
    applyDclUartConfig();
  } else if (strcmp(command, "FORMAT 8E1") == 0) {
    dclConfig = SERIAL_8E1;
    dclFormatName = "8E1";
    applyDclUartConfig();
  } else if (strcmp(command, "FORMAT 8O1") == 0) {
    dclConfig = SERIAL_8O1;
    dclFormatName = "8O1";
    applyDclUartConfig();
  } else if (strncmp(command, "SEND ", 5) == 0) {
    const DiagnosticTransaction* transaction = findTransaction(command + 5);
    if (transaction != nullptr) {
      sendTransaction(*transaction);
    } else {
      Serial.println(F("ERR transaction not found."));
    }
  } else if (strncmp(command, "RAW ", 4) == 0) {
    uint8_t rawBuf[32];
    size_t len = parseHexBytes(command + 4, rawBuf, sizeof(rawBuf));
    if (len > 0) {
      sendRawBytes(rawBuf, len, "RAW");
    } else {
      Serial.println(F("ERR invalid hex bytes"));
    }
  } else if (strncmp(command, "WAKE ", 5) == 0) {
    uint32_t ms = atoi(command + 5);
    if (ms == 0) ms = 25;
    sendBreakPulse(ms);
  } else if (strncmp(command, "WAKE_SEND ", 10) == 0) {
    const char* arg = command + 10;
    char* endPtr = nullptr;
    long ms = strtol(arg, &endPtr, 10);
    if (ms <= 0) ms = 25;
    while (*endPtr == ' ') ++endPtr;
    sendBreakPulse(static_cast<uint32_t>(ms));
    delay(20);
    const DiagnosticTransaction* transaction = findTransaction(endPtr);
    if (transaction != nullptr) {
      sendTransaction(*transaction);
    } else {
      uint8_t rawBuf[32];
      size_t len = parseHexBytes(endPtr, rawBuf, sizeof(rawBuf));
      if (len > 0) {
        sendRawBytes(rawBuf, len, "WAKE_RAW");
      }
    }
  } else if (strncmp(command, "POLL ON", 7) == 0) {
    if (!kVehicleTxEnabled) {
      Serial.println(F("LOCKED: continuous polling disabled"));
      return;
    }
    int interval = 250;
    if (strlen(command) > 8) {
      interval = atoi(command + 8);
      if (interval < 30) interval = 30;
      if (interval > 5000) interval = 5000;
    }
    pollIntervalMs = static_cast<uint32_t>(interval);
    pollingActive = true;
    nextPollMs = millis() + 50;
    Serial.print(F("OK continuous polling started at "));
    Serial.print(pollIntervalMs);
    Serial.print(F("ms interval with "));
    Serial.println(pollTransaction->name);
  } else if (strcmp(command, "POLL OFF") == 0) {
    pollingActive = false;
    Serial.println(F("OK polling stopped"));
  } else {
    Serial.println(F("ERR command not allowed. Type HELP."));
  }
}

void readUsbCommands() {
  while (Serial.available() > 0) {
    const int input = Serial.read();
    if (input < 0) break;

    const char c = static_cast<char>(input);
    if (c == '\r') continue;
    if (c == '\n') {
      if (commandOverflow) {
        Serial.println(F("ERR command too long"));
      } else if (commandLength > 0) {
        commandBuffer[commandLength] = '\0';
        processCommand(commandBuffer);
      }
      commandLength = 0;
      commandOverflow = false;
      continue;
    }

    if (c < 0x20 || c > 0x7E) {
      commandOverflow = true;
    } else if (commandLength + 1 < kCommandCapacity) {
      commandBuffer[commandLength++] = c;
    } else {
      commandOverflow = true;
    }
  }
}

void reportDclRx() {
  if (DclSerial.available() == 0) return;

  uint8_t rxBuf[64];
  size_t count = 0;
  while (DclSerial.available() > 0 && count < sizeof(rxBuf)) {
    rxBuf[count++] = static_cast<uint8_t>(DclSerial.read());
    delayMicroseconds(250);
  }

  if (count > 0) {
    for (size_t i = 0; i < count; ++i) {
      if (i != 0) Serial.write(' ');
      if (rxBuf[i] < 0x10) Serial.write('0');
      Serial.print(rxBuf[i], HEX);
    }
    Serial.write('\n');
  }
}

}  // namespace

void setup() {
  Serial.begin(kUsbBaud);

  gpio_set_direction(kDriverEnablePin, GPIO_MODE_OUTPUT);
  gpio_set_direction(kReceiverEnableNotPin, GPIO_MODE_OUTPUT);
  setReceiveMode();

  pinMode(kDclRxPin, INPUT);
  attachInterrupt(digitalPinToInterrupt(kDclRxPin), onRxEdge, CHANGE);

  DclSerial.setRxBufferSize(kRxBufferSize);
  DclSerial.begin(dclBaud, dclConfig, kDclRxPin, kDclTxPin);

  createTxDeadlineTimer();
  Serial.println(F("SME-105 DCL Master Polling Firmware loaded (9600 8N2)"));
  printHelp();
  printStatus();
}

void loop() {
  readUsbCommands();

  if (pollingActive && millis() >= nextPollMs) {
    if (pollTransaction != nullptr) {
      sendTransaction(*pollTransaction);
    }
    nextPollMs = millis() + pollIntervalMs;
  }

  reportDclRx();
}
