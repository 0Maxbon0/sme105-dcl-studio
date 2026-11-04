#ifdef SME105_BLE

#include "ble_transport.h"

#include <NimBLEDevice.h>
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>

namespace ble_transport {
namespace {

constexpr char kService[] = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kRx[] = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kTx[] = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr size_t kRing = 1024;  // power of two

struct Ring {
  uint8_t bytes[kRing] = {};
  volatile uint32_t head = 0, tail = 0;
  size_t used() const { return head - tail; }
};

portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
Ring rx, tx;
NimBLECharacteristic* txChar = nullptr;
volatile bool linkUp = false;
uint16_t payload = 20;  // ATT MTU - 3, updated on MTU exchange

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, ble_gap_conn_desc*) override { linkUp = true; }
  void onDisconnect(NimBLEServer*) override {
    linkUp = false;
    portENTER_CRITICAL(&lock);
    rx.tail = rx.head;
    tx.tail = tx.head;
    portEXIT_CRITICAL(&lock);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    payload = mtu > 3 ? static_cast<uint16_t>(mtu - 3) : 20;
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c) override {
    const std::string value = c->getValue();
    portENTER_CRITICAL(&lock);
    for (const char ch : value) {
      if (rx.used() >= kRing) break;  // overflow: drop, line parser rejects
      rx.bytes[rx.head++ & (kRing - 1)] = static_cast<uint8_t>(ch);
    }
    portEXIT_CRITICAL(&lock);
  }
};

}  // namespace

void begin(const char* deviceName, uint32_t passkey) {
  NimBLEDevice::init(deviceName);
  NimBLEDevice::setMTU(247);
  // Passkey pairing with bonding and MITM protection; link is encrypted.
  NimBLEDevice::setSecurityAuth(true, true, true);
  NimBLEDevice::setSecurityPasskey(passkey);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService* service = server->createService(kService);
  txChar = service->createCharacteristic(kTx, NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::READ_ENC);
  NimBLECharacteristic* rxChar = service->createCharacteristic(
      kRx, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::WRITE_ENC);
  rxChar->setCallbacks(new RxCallbacks());
  service->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(kService);
  adv->setScanResponse(true);
  adv->start();
}

bool connected() { return linkUp; }

size_t read(uint8_t* out, size_t max) {
  size_t n = 0;
  portENTER_CRITICAL(&lock);
  while (n < max && rx.used()) out[n++] = rx.bytes[rx.tail++ & (kRing - 1)];
  portEXIT_CRITICAL(&lock);
  return n;
}

size_t writable() { return linkUp ? kRing - tx.used() : 0; }

size_t write(const uint8_t* data, size_t len) {
  if (!linkUp) return 0;
  size_t n = 0;
  while (n < len && tx.used() < kRing) tx.bytes[tx.head++ & (kRing - 1)] = data[n++];
  return n;
}

void poll() {
  if (!linkUp || !txChar || !tx.used()) return;
  uint8_t chunk[244];
  const size_t limit = payload < sizeof(chunk) ? payload : sizeof(chunk);
  size_t n = 0;
  while (n < limit && n < tx.used()) {
    chunk[n] = tx.bytes[(tx.tail + n) & (kRing - 1)];
    ++n;
  }
  txChar->setValue(chunk, n);
  txChar->notify();
  tx.tail += n;
}

}  // namespace ble_transport

#endif  // SME105_BLE
