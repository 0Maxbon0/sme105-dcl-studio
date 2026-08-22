#include <Arduino.h>
#include <driver/gpio.h>
#include <esp_timer.h>

#include <cstring>

namespace {

HardwareSerial DclSerial(2);

constexpr uint32_t kUsbBaud = 115200;
constexpr uint32_t kDefaultDclBaud = 9600;
constexpr uint32_t kOptionalDclBaud = 19200;
constexpr int kDclRxPin = 16;
constexpr int kDclTxPin = 17;
constexpr gpio_num_t kDriverEnablePin = GPIO_NUM_18;
constexpr gpio_num_t kReceiverEnableNotPin = GPIO_NUM_19;
constexpr size_t kRxBufferSize = 4096;

constexpr size_t kMaxTxBytes = 32;
constexpr uint64_t kMaxTxActiveUs = 50000;
constexpr uint8_t kBitsPerByte8N2 = 11;
constexpr uint32_t kDriverEnableSettleUs = 2;

constexpr size_t kCommandCapacity = 64;

struct DiagnosticTransaction {
  const char* name;
  const uint8_t* bytes;
  size_t length;
  bool verifiedAndEnabled;
};

// No Ford DCL request bytes have been verified for this project.
// Keep placeholders disabled. Add a constexpr byte array and point a descriptor
// at it only after the complete transaction is independently verified.
constexpr DiagnosticTransaction kDiagnosticTransactions[] = {
    {"UNVERIFIED_PLACEHOLDER", nullptr, 0, false},
};

esp_timer_handle_t txDeadlineTimer = nullptr;
volatile bool txDeadlineForcedRelease = false;
uint32_t dclBaud = kDefaultDclBaud;
char commandBuffer[kCommandCapacity];
size_t commandLength = 0;
bool commandOverflow = false;

void setReceiveMode() {
  // Disable the line driver first, then enable the active-low receiver.
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
  const uint64_t bits =
      static_cast<uint64_t>(byteCount) * kBitsPerByte8N2;
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

bool sendTransaction(const DiagnosticTransaction& transaction) {
  if (!transaction.verifiedAndEnabled || transaction.bytes == nullptr ||
      transaction.length == 0) {
    Serial.println(F("ERR transaction disabled/unverified"));
    return false;
  }
  if (transaction.length > kMaxTxBytes) {
    Serial.println(F("ERR transaction exceeds byte limit"));
    return false;
  }
  if (wireDurationUs(transaction.length, dclBaud) >
      kMaxTxActiveUs - kDriverEnableSettleUs) {
    Serial.println(F("ERR transaction exceeds duration limit"));
    return false;
  }
  if (txDeadlineTimer == nullptr) {
    Serial.println(F("ERR TX safety timer unavailable"));
    return false;
  }

  setReceiveMode();
  txDeadlineForcedRelease = false;

  if (esp_timer_start_once(txDeadlineTimer, kMaxTxActiveUs) != ESP_OK) {
    setReceiveMode();
    Serial.println(F("ERR TX safety timer failed"));
    return false;
  }

  gpio_set_level(kReceiverEnableNotPin, 1);
  gpio_set_level(kDriverEnablePin, 1);
  delayMicroseconds(kDriverEnableSettleUs);

  const size_t written =
      DclSerial.write(transaction.bytes, transaction.length);
  DclSerial.flush();

  const esp_err_t timerStopResult = esp_timer_stop(txDeadlineTimer);
  setReceiveMode();

  if (timerStopResult != ESP_OK || txDeadlineForcedRelease) {
    Serial.println(F("ERR TX deadline forced receive mode"));
    return false;
  }
  if (written != transaction.length) {
    Serial.println(F("ERR short UART write"));
    return false;
  }

  Serial.print(F("OK sent "));
  Serial.println(transaction.name);
  return true;
}

void setBaud(uint32_t baud) {
  setReceiveMode();
  DclSerial.end();
  DclSerial.begin(baud, SERIAL_8N2, kDclRxPin, kDclTxPin);
  dclBaud = baud;
  Serial.print(F("OK baud "));
  Serial.println(dclBaud);
}

void printHelp() {
  Serial.println(F("ALLOW: HELP"));
  Serial.println(F("ALLOW: STATUS"));
  Serial.println(F("ALLOW: LIST"));
  Serial.println(F("ALLOW: BAUD 9600"));
  Serial.println(F("ALLOW: BAUD 19200"));
  Serial.println(F("ALLOW: SEND <compile-time-name>"));
  Serial.println(F("No arbitrary-byte or state-changing command exists."));
}

void printStatus() {
  Serial.print(F("STATUS baud="));
  Serial.print(dclBaud);
  Serial.print(F(" mode=RX max_bytes="));
  Serial.print(kMaxTxBytes);
  Serial.print(F(" max_tx_us="));
  Serial.print(static_cast<unsigned long>(kMaxTxActiveUs));
  Serial.print(F(" safety_timer="));
  Serial.println(txDeadlineTimer != nullptr ? F("ready") : F("failed"));
}

void listTransactions() {
  for (const DiagnosticTransaction& transaction : kDiagnosticTransactions) {
    Serial.print(transaction.name);
    Serial.print(F(" length="));
    Serial.print(transaction.length);
    Serial.print(F(" state="));
    Serial.println(transaction.verifiedAndEnabled ? F("ENABLED")
                                                  : F("DISABLED_UNVERIFIED"));
  }
}

void processCommand(const char* command) {
  if (strcmp(command, "HELP") == 0) {
    printHelp();
  } else if (strcmp(command, "STATUS") == 0) {
    printStatus();
  } else if (strcmp(command, "LIST") == 0) {
    listTransactions();
  } else if (strcmp(command, "BAUD 9600") == 0) {
    setBaud(kDefaultDclBaud);
  } else if (strcmp(command, "BAUD 19200") == 0) {
    setBaud(kOptionalDclBaud);
  } else if (strncmp(command, "SEND ", 5) == 0) {
    const DiagnosticTransaction* transaction = findTransaction(command + 5);
    if (transaction == nullptr) {
      Serial.println(F("ERR transaction not allow-listed"));
    } else {
      sendTransaction(*transaction);
    }
  } else {
    Serial.println(F("ERR command not allowed"));
  }
}

void readUsbCommands() {
  while (Serial.available() > 0) {
    const int input = Serial.read();
    if (input < 0) {
      break;
    }

    const char c = static_cast<char>(input);
    if (c == '\r') {
      continue;
    }
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
  while (DclSerial.available() > 0) {
    const int value = DclSerial.read();
    if (value < 0) {
      break;
    }
    Serial.print(F("RX T="));
    Serial.print(micros());
    Serial.print(F(" BYTE="));
    if (value < 0x10) {
      Serial.print('0');
    }
    Serial.println(value, HEX);
  }
}

}  // namespace

void setup() {
  Serial.begin(kUsbBaud);

  gpio_set_direction(kDriverEnablePin, GPIO_MODE_OUTPUT);
  gpio_set_direction(kReceiverEnableNotPin, GPIO_MODE_OUTPUT);
  setReceiveMode();

  DclSerial.setRxBufferSize(kRxBufferSize);
  DclSerial.begin(dclBaud, SERIAL_8N2, kDclRxPin, kDclTxPin);

  createTxDeadlineTimer();
  Serial.println(F("dcl_master safe shell; default RX, 9600 8N2"));
  printHelp();
  printStatus();
}

void loop() {
  readUsbCommands();
  reportDclRx();
}
