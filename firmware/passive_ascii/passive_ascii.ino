#include <Arduino.h>

// Passive Ford EEC-IV DCL candidate capture.
//
// Each USB text line is only a bounded UART batching convenience. It is not a
// decoded DCL frame, packet, message, or transaction boundary.

namespace {

HardwareSerial DclSerial(2);

constexpr uint32_t kUsbBaud = 115200;
constexpr uint32_t kDclBaud = 9600;
constexpr int kDclRxPin = 16;
constexpr int kDclTxPin = 17;
constexpr size_t kRxBufferSize = 4096;
constexpr size_t kBatchCapacity = 64;
constexpr uint32_t kBatchIdleUs = 2500;

uint8_t batch[kBatchCapacity];
size_t batchLength = 0;
uint32_t lastByteUs = 0;

void emitBatch() {
  if (batchLength == 0) {
    return;
  }

  for (size_t i = 0; i < batchLength; ++i) {
    if (batch[i] < 0x10) {
      Serial.print('0');
    }
    Serial.print(batch[i], HEX);
    if (i + 1 < batchLength) {
      Serial.print(' ');
    }
  }
  Serial.println();
  batchLength = 0;
}

void captureAvailableBytes() {
  while (DclSerial.available() > 0) {
    const int value = DclSerial.read();
    if (value < 0) {
      break;
    }

    const uint32_t nowUs = micros();
    batch[batchLength++] = static_cast<uint8_t>(value);
    lastByteUs = nowUs;

    if (batchLength == kBatchCapacity) {
      emitBatch();
    }
  }
}

}  // namespace

void setup() {
  Serial.begin(kUsbBaud);
  DclSerial.setRxBufferSize(kRxBufferSize);
  DclSerial.begin(kDclBaud, SERIAL_8N2, kDclRxPin, kDclTxPin);
}

void loop() {
  captureAvailableBytes();

  if (batchLength > 0 &&
      static_cast<uint32_t>(micros() - lastByteUs) >= kBatchIdleUs) {
    emitBatch();
  }
}
