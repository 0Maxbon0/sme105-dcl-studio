#include <Arduino.h>
#include <cstring>

// DESK ONLY. This sketch actively drives the MAX487 A/B pair.
// NEVER connect this firmware or its A/B leads to a vehicle/ECU.
// The receiver is enabled by permanently tying the board's /RE to GND.
namespace {

HardwareSerial Bus(2);

constexpr int kRx = 16;      // LV1 from the 4-channel level shifter
constexpr int kTx = 17;      // MAX487 DI (3.3V HIGH meets TTL VIH)
constexpr int kDe = 18;      // MAX487 DE, also external 10k pull-down to GND
constexpr uint32_t kBusBaud = 9600;
constexpr size_t kTestLength = 8;

uint32_t passes = 0;
uint32_t failures = 0;
uint16_t sequenceNumber = 0;

void printBytes(const uint8_t* bytes, size_t size) {
  for (size_t i = 0; i < size; ++i) {
    if (i != 0) Serial.write(' ');
    if (bytes[i] < 16) Serial.write('0');
    Serial.print(bytes[i], HEX);
  }
}

void runEchoTest() {
  uint8_t tx[kTestLength] = {0xA5, 0x5A, 0x00, 0xFF, 0x55, 0xAA,
                             static_cast<uint8_t>(sequenceNumber),
                             static_cast<uint8_t>(sequenceNumber >> 8)};
  uint8_t rx[kTestLength] = {};
  ++sequenceNumber;

  while (Bus.available() > 0) (void)Bus.read();

  // /RE stays LOW, so the receiver can observe our local driven A/B pair.
  // This checks UART, voltage translator, MAX487 TX and RO on the desk.
  digitalWrite(kDe, HIGH);
  delayMicroseconds(20);
  Bus.write(tx, sizeof(tx));
  Bus.flush();
  digitalWrite(kDe, LOW);

  size_t received = 0;
  const uint32_t startMs = millis();
  while (millis() - startMs < 250 && received < kTestLength) {
    if (Bus.available() > 0) {
      const int data = Bus.read();
      if (data >= 0) rx[received++] = static_cast<uint8_t>(data);
    }
  }
  const bool success =
      received == kTestLength && memcmp(rx, tx, sizeof(tx)) == 0;
  if (success) ++passes;
  else ++failures;

  Serial.print(success ? F("PASS ") : F("FAIL "));
  Serial.print(F("TX: "));
  printBytes(tx, sizeof(tx));
  Serial.print(F("  RX: "));
  printBytes(rx, received);
  Serial.print(F("  count="));
  Serial.print(received);
  Serial.print(F("  pass="));
  Serial.print(passes);
  Serial.print(F("  fail="));
  Serial.println(failures);
}

}  // namespace

void setup() {
  // Make DE safe before starting serial. Also fit a physical 10k pull-down.
  digitalWrite(kDe, LOW);
  pinMode(kDe, OUTPUT);
  Serial.begin(115200);
  Bus.setRxBufferSize(256);
  Bus.begin(kBusBaud, SERIAL_8N2, kRx, kTx);
  delay(300);
  Serial.println(F("MAX487 DESK SELF-ECHO - NEVER CONNECT TO THE CAR"));
  Serial.println(F("MAX487 5V, GND; DI=GPIO17, DE=GPIO18+10k/GND, /RE=GND"));
  Serial.println(F("RO=shifter HV1, LV1=GPIO16; HV=5V, LV=3V3"));
  Serial.println(F("Leave A/B completely DISCONNECTED from other equipment."));
}

void loop() {
  runEchoTest();
  delay(1000);
}
