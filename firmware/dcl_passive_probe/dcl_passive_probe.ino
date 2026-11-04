#include <Arduino.h>

// Ford DCL receive-only link diagnostic. Do not connect a bare, unqualified
// MAX487 module to a vehicle merely because this program is receive-only.
// No ECU command bytes are ever sent by this firmware.
namespace {
HardwareSerial Dcl(2);
constexpr int kRxPin = 16;
constexpr int kUnusedTxPin = 17;
constexpr int kDePin = 18;
constexpr uint32_t kCandidateDclBaud = 9600;

volatile uint32_t edgeCount = 0;
uint32_t totalUartBytes = 0;
uint32_t lastReportedEdges = 0;
uint32_t lastReportedBytes = 0;
uint32_t lastReportMs = 0;
char recentHex[3 * 8 + 1] = {};
uint8_t recentBytes = 0;

void IRAM_ATTR onRxEdge() { ++edgeCount; }

void printReport() {
  const uint32_t edges = edgeCount;
  const int level = digitalRead(kRxPin);
  Serial.print(F("LINK t_ms="));
  Serial.print(millis());
  Serial.print(F(" RX2="));
  Serial.print(level == HIGH ? F("HIGH") : F("LOW"));
  Serial.print(F(" edges_since_last="));
  Serial.print(edges - lastReportedEdges);
  Serial.print(F(" edges_total="));
  Serial.print(edges);
  Serial.print(F(" uart_bytes_since_last="));
  Serial.print(totalUartBytes - lastReportedBytes);
  Serial.print(F(" uart_bytes_total="));
  Serial.print(totalUartBytes);
  Serial.print(F(" last_hex="));
  Serial.println(recentBytes == 0 ? "-" : recentHex);
  lastReportedEdges = edges;
  lastReportedBytes = totalUartBytes;
  recentBytes = 0;
  recentHex[0] = '\0';
}
}  // namespace

void setup() {
  // Driver must be held disabled by physical DE -> GND, not only software.
  digitalWrite(kDePin, LOW);
  pinMode(kDePin, OUTPUT);
  pinMode(kUnusedTxPin, INPUT);
  Serial.begin(115200);
  Dcl.begin(kCandidateDclBaud, SERIAL_8N2, kRxPin, -1);
  attachInterrupt(digitalPinToInterrupt(kRxPin), onRxEdge, CHANGE);
  delay(150);
  Serial.println(F("DCL PASSIVE LINK PROBE: RECEIVE ONLY, NO ECU COMMANDS"));
  Serial.println(F("USB=115200 RX2=GPIO16, UART=9600 8N2, TX=DETACHED, DE=LOW"));
  Serial.println(F("RX2 HIGH or zero edges alone does NOT prove ECU connection."));
  lastReportMs = millis();
}

void loop() {
  while (Dcl.available() > 0) {
    const int byteValue = Dcl.read();
    if (byteValue < 0) break;
    ++totalUartBytes;
    if (recentBytes < 8) {
      const char digits[] = "0123456789ABCDEF";
      const uint8_t value = static_cast<uint8_t>(byteValue);
      recentHex[recentBytes * 3] = digits[value >> 4];
      recentHex[recentBytes * 3 + 1] = digits[value & 0x0F];
      recentHex[recentBytes * 3 + 2] = ' ';
      ++recentBytes;
      recentHex[recentBytes * 3] = '\0';
    }
  }
  const uint32_t now = millis();
  if (now - lastReportMs >= 1000) {
    printReport();
    lastReportMs = now;
  }
}
