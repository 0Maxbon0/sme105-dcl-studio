#include <Arduino.h>
#include <esp_timer.h>

namespace {

HardwareSerial DclSerial(2);

// Fixed-size timestamp records add substantial overhead. 460800 provides
// enough headroom for a continuously busy 9600 8N2 input, including worst-case
// SLIP escaping.
constexpr uint32_t kUsbBaud = 460800;
constexpr uint32_t kDclBaud = 9600;
constexpr int kDclRxPin = 16;
constexpr int kDclTxPin = 17;
constexpr size_t kRxBufferSize = 4096;

constexpr uint8_t kProtocolVersion = 1;
constexpr uint8_t kRecordData = 0x01;
constexpr uint8_t kRecordUartStatus = 0x02;

enum class Direction : uint8_t {
  Unknown = 0,
  McuToBus = 1,
  BusToMcu = 2,
};

constexpr uint8_t kStatusFifoOverflow = 0x01;
constexpr uint8_t kStatusBufferFull = 0x02;
constexpr uint8_t kStatusFrameError = 0x04;
constexpr uint8_t kStatusParityError = 0x08;
constexpr uint8_t kStatusBreak = 0x10;
constexpr uint8_t kStatusBreakDataSuppressed = 0x20;
constexpr uint64_t kStatusReportIntervalUs = 100000;
constexpr uint64_t kBreakRecoveryQuietUs = 100000;
constexpr uint64_t kMinimumPlausibleByteIntervalUs = 900;
constexpr size_t kMaxReadsPerLoop = 256;

constexpr uint8_t kSlipEnd = 0xC0;
constexpr uint8_t kSlipEsc = 0xDB;
constexpr uint8_t kSlipEscEnd = 0xDC;
constexpr uint8_t kSlipEscEsc = 0xDD;

constexpr size_t kRecordWithoutCrcSize = 13;
constexpr size_t kRecordSize = 15;
constexpr size_t kCrcOffset = 13;

static_assert(sizeof(uint64_t) == 8, "binary protocol requires 64-bit uint64_t");
static_assert(kRecordWithoutCrcSize + sizeof(uint16_t) == kRecordSize,
              "binary record must be exactly 15 unescaped bytes");

portMUX_TYPE statusMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint8_t pendingUartStatus = 0;
volatile uint64_t pendingUartStatusUs = 0;
volatile uint64_t lastBreakUs = 0;
uint8_t latchedUartStatus = 0;
uint64_t latchedUartStatusUs = 0;
uint64_t lastStatusReportUs = 0;
uint64_t lastRawReadUs = 0;
uint64_t breakDataSuppressionUntilUs = 0;
uint8_t lastRawValue = 0;
uint8_t rapidRepeatCount = 0;

uint16_t crc16CcittFalse(const uint8_t* data, size_t length) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < length; ++i) {
    crc ^= static_cast<uint16_t>(data[i]) << 8;
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x8000) != 0
                ? static_cast<uint16_t>((crc << 1) ^ 0x1021)
                : static_cast<uint16_t>(crc << 1);
    }
  }
  return crc;
}

void writeSlipByte(uint8_t value) {
  if (value == kSlipEnd) {
    Serial.write(kSlipEsc);
    Serial.write(kSlipEscEnd);
  } else if (value == kSlipEsc) {
    Serial.write(kSlipEsc);
    Serial.write(kSlipEscEsc);
  } else {
    Serial.write(value);
  }
}

void emitRecord(uint8_t type, Direction direction, uint8_t status,
                uint64_t timestampUs, uint8_t value) {
  uint8_t record[kRecordSize] = {
      kProtocolVersion,
      type,
      static_cast<uint8_t>(direction),
      status,
      static_cast<uint8_t>(timestampUs),
      static_cast<uint8_t>(timestampUs >> 8),
      static_cast<uint8_t>(timestampUs >> 16),
      static_cast<uint8_t>(timestampUs >> 24),
      static_cast<uint8_t>(timestampUs >> 32),
      static_cast<uint8_t>(timestampUs >> 40),
      static_cast<uint8_t>(timestampUs >> 48),
      static_cast<uint8_t>(timestampUs >> 56),
      value,
      0,
      0,
  };

  const uint16_t crc = crc16CcittFalse(record, kRecordWithoutCrcSize);
  record[kCrcOffset] = static_cast<uint8_t>(crc);
  record[kCrcOffset + 1] = static_cast<uint8_t>(crc >> 8);

  Serial.write(kSlipEnd);
  for (size_t i = 0; i < kRecordSize; ++i) {
    writeSlipByte(record[i]);
  }
  Serial.write(kSlipEnd);
}

void onDclReceiveError(hardwareSerial_error_t error) {
  uint8_t status = 0;
  switch (error) {
    case UART_FIFO_OVF_ERROR:
      status = kStatusFifoOverflow;
      break;
    case UART_BUFFER_FULL_ERROR:
      status = kStatusBufferFull;
      break;
    case UART_FRAME_ERROR:
      status = kStatusFrameError;
      break;
    case UART_PARITY_ERROR:
      status = kStatusParityError;
      break;
    case UART_BREAK_ERROR:
      status = kStatusBreak;
      break;
    default:
      return;
  }

  const uint64_t observedUs = static_cast<uint64_t>(esp_timer_get_time());
  portENTER_CRITICAL(&statusMux);
  if (pendingUartStatus == 0) {
    pendingUartStatusUs = observedUs;
  }
  pendingUartStatus |= status;
  if ((status & kStatusBreak) != 0) {
    lastBreakUs = observedUs;
  }
  portEXIT_CRITICAL(&statusMux);
}

uint8_t takeUartStatus(uint64_t& timestampUs) {
  portENTER_CRITICAL(&statusMux);
  const uint8_t status = pendingUartStatus;
  timestampUs = pendingUartStatusUs;
  pendingUartStatus = 0;
  pendingUartStatusUs = 0;
  portEXIT_CRITICAL(&statusMux);
  return status;
}

uint64_t readLastBreakUs() {
  portENTER_CRITICAL(&statusMux);
  const uint64_t value = lastBreakUs;
  portEXIT_CRITICAL(&statusMux);
  return value;
}

}  // namespace

void setup() {
  Serial.begin(kUsbBaud);
  DclSerial.setRxBufferSize(kRxBufferSize);
  DclSerial.begin(kDclBaud, SERIAL_8N2, kDclRxPin, kDclTxPin);
  DclSerial.onReceiveError(onDclReceiveError);
}

void loop() {
  const uint64_t nowUs = static_cast<uint64_t>(esp_timer_get_time());
  uint64_t uartStatusUs = 0;
  const uint8_t uartStatus = takeUartStatus(uartStatusUs);
  if (uartStatus != 0) {
    if (latchedUartStatus == 0) {
      latchedUartStatusUs = uartStatusUs;
    }
    latchedUartStatus |= uartStatus;
  }

  const uint64_t observedBreakUs = readLastBreakUs();
  const bool breakActive =
      observedBreakUs != 0 && nowUs - observedBreakUs < kBreakRecoveryQuietUs;

  size_t reads = 0;
  while (DclSerial.available() > 0 && reads < kMaxReadsPerLoop) {
    const int value = DclSerial.read();
    if (value < 0) {
      break;
    }
    ++reads;

    const uint64_t readUs = static_cast<uint64_t>(esp_timer_get_time());
    const bool implausiblyFastRepeat =
        lastRawReadUs != 0 && static_cast<uint8_t>(value) == lastRawValue &&
        readUs - lastRawReadUs < kMinimumPlausibleByteIntervalUs;
    rapidRepeatCount =
        implausiblyFastRepeat && rapidRepeatCount < UINT8_MAX
            ? static_cast<uint8_t>(rapidRepeatCount + 1)
            : 0;
    lastRawReadUs = readUs;
    lastRawValue = static_cast<uint8_t>(value);

    if (rapidRepeatCount >= 3) {
      breakDataSuppressionUntilUs = readUs + kBreakRecoveryQuietUs;
    }
    const bool implausibleLowFlood = readUs < breakDataSuppressionUntilUs;

    if (breakActive || implausibleLowFlood) {
      if (latchedUartStatus == 0) {
        latchedUartStatusUs = readUs;
      }
      latchedUartStatus |= kStatusBreakDataSuppressed;
      continue;
    }

    emitRecord(kRecordData, Direction::BusToMcu, 0,
               readUs, static_cast<uint8_t>(value));
  }

  if (latchedUartStatus != 0 &&
      nowUs - lastStatusReportUs >= kStatusReportIntervalUs) {
    emitRecord(kRecordUartStatus, Direction::BusToMcu, latchedUartStatus,
               latchedUartStatusUs, 0);
    latchedUartStatus = 0;
    latchedUartStatusUs = 0;
    lastStatusReportUs = nowUs;
  }
}
