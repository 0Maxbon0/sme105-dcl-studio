#include <Arduino.h>
#include <cstring>
#include "soc/gpio_sig_map.h"

// Desk-only. GPIO4/GPIO21 drive K485 A+/B- as a differential UART stimulus.
// GPIO17 stays disconnected. Re-flash firmware/passive_binary before car work.
// Do not tie B- to GND: that collapses the UART start bit and fails every loop.

namespace {

HardwareSerial BenchRx(2);
HardwareSerial BenchTx(1);

constexpr uint32_t kUsbBaud = 115200;
constexpr uint32_t kBenchBaud = 9600;
constexpr int kRxPin = 16;
constexpr int kAPin = 4;
constexpr int kBPin = 21;
constexpr uint32_t kIntervalMs = 1000;
constexpr uint32_t kRxTimeoutMs = 200;
constexpr size_t kFrameSize = 8;

uint32_t loopIndex = 0;
uint32_t passCount = 0;
uint32_t failCount = 0;
bool invertA = false;
bool mcuUartOk = false;

void printHex(const uint8_t* data, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    if (i != 0) {
      Serial.print(' ');
    }
    if (data[i] < 0x10) {
      Serial.print('0');
    }
    Serial.print(data[i], HEX);
  }
}

void attachBusPolarity(bool invert_a) {
  pinMode(kAPin, OUTPUT);
  pinMode(kBPin, OUTPUT);
  pinMatrixOutAttach(kAPin, U1TXD_OUT_IDX, invert_a, false);
  pinMatrixOutAttach(kBPin, U1TXD_OUT_IDX, !invert_a, false);
}

void attachPhysicalRx() {
  pinMode(kRxPin, INPUT);
  pinMatrixInAttach(kRxPin, U2RXD_IN_IDX, false);
}

void attachInternalRx() {
  pinMatrixInAttach(kAPin, U2RXD_IN_IDX, false);
}

void fillFrame(uint8_t* tx, uint32_t index) {
  tx[0] = 0xA5;
  tx[1] = 0x5A;
  tx[2] = 0x00;
  tx[3] = 0xFF;
  tx[4] = 0x55;
  tx[5] = 0xAA;
  tx[6] = static_cast<uint8_t>(index & 0xFF);
  tx[7] = static_cast<uint8_t>((index >> 8) & 0xFF);
}

size_t exchange(const uint8_t* tx, uint8_t* rx) {
  while (BenchRx.available() > 0) {
    (void)BenchRx.read();
  }
  BenchTx.write(tx, kFrameSize);
  BenchTx.flush();
  size_t got = 0;
  const uint32_t deadline = millis() + kRxTimeoutMs;
  while (millis() < deadline && got < kFrameSize) {
    if (BenchRx.available() > 0) {
      rx[got] = static_cast<uint8_t>(BenchRx.read());
      got += 1;
    }
  }
  return got;
}

}  // namespace

void setup() {
  Serial.begin(kUsbBaud);
  delay(400);
  Serial.println();
  Serial.println(F("===================================================="));
  Serial.println(F("SME-105 DESK BENCH TEST — NOT FOR THE VEHICLE"));
  Serial.println(F("GPIO4 -> A+   GPIO21 -> B-   (differential, 1k each)"));
  Serial.println(F("K485 TXD/RO -> GPIO16     RXD/DI idle-high to 3V3"));
  Serial.println(F("GPIO17 unused. Do NOT tie B- to GND."));
  Serial.println(F("===================================================="));

  pinMode(kAPin, OUTPUT);
  digitalWrite(kAPin, HIGH);
  BenchRx.setRxBufferSize(256);
  BenchRx.begin(kBenchBaud, SERIAL_8N2, kRxPin, -1);
  BenchTx.begin(kBenchBaud, SERIAL_8N2, -1, kAPin);

  uint8_t tx[kFrameSize];
  uint8_t rx[kFrameSize] = {};
  fillFrame(tx, 0);
  attachInternalRx();
  delay(2);
  const size_t internalGot = exchange(tx, rx);
  mcuUartOk = internalGot == kFrameSize && memcmp(tx, rx, kFrameSize) == 0;
  Serial.print(F("MCU UART self-test: "));
  Serial.println(mcuUartOk ? F("PASS") : F("FAIL"));
  if (!mcuUartOk) {
    Serial.print(F("  internal RX="));
    if (internalGot == 0) {
      Serial.println(F("(none)"));
    } else {
      printHex(rx, internalGot);
      Serial.println();
    }
  }

  attachPhysicalRx();
  attachBusPolarity(invertA);
  Serial.println(F("USB 115200 8N1  |  A/B stimulus 9600 8N2"));
  Serial.println();
}

void loop() {
  loopIndex += 1;
  uint8_t tx[kFrameSize];
  uint8_t rx[kFrameSize] = {};
  fillFrame(tx, loopIndex);
  attachBusPolarity(invertA);
  const size_t got = exchange(tx, rx);
  const bool pass = got == kFrameSize && memcmp(tx, rx, kFrameSize) == 0;

  Serial.print(F("LOOP "));
  Serial.print(loopIndex);
  Serial.print(F("  polarity="));
  Serial.print(invertA ? F("swapped") : F("normal"));
  Serial.print(F("  TX: "));
  printHex(tx, kFrameSize);
  Serial.println();
  Serial.print(F("         RX: "));
  if (got == 0) {
    Serial.println(F("(none)"));
  } else {
    printHex(rx, got);
    Serial.print(F("  ("));
    Serial.print(static_cast<unsigned>(got));
    Serial.println(F(" bytes)"));
  }

  if (pass) {
    passCount += 1;
    Serial.println(F("RESULT: PASS  XY-K485 receiver + UART2 path intact"));
  } else {
    failCount += 1;
    Serial.println(F("RESULT: FAIL  physical A/B path did not loop back"));
    if (!mcuUartOk) {
      Serial.println(F("HINT: MCU UART self-test already failed; re-upload this sketch"));
    } else if (got == 0) {
      Serial.println(
          F("HINT: 3V3+GND, K485 TXD->GPIO16, GPIO4-1k->A+, GPIO21-1k->B-, "
            "RXD 10k to 3V3, 120R open, car disconnected"));
    } else {
      Serial.println(F("HINT: swapping A/B polarity next loop"));
    }
    invertA = !invertA;
  }
  Serial.print(F("SCORE   pass="));
  Serial.print(passCount);
  Serial.print(F("  fail="));
  Serial.println(failCount);
  Serial.println();
  delay(kIntervalMs);
}
