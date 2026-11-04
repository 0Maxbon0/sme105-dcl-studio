#ifdef SME105_BLE

#include "ble_transport.h"

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>

namespace ble_transport {
namespace {

constexpr char kService[] = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kRx[] = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr char kTx[] = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E";
constexpr size_t kRing = 2048;  // power of two
// One notification per interval keeps NimBLE mbufs available; notify() is
// never retried in a loop that could stall the CART handshake.
constexpr uint32_t kNotifyIntervalUs = 2000;

struct Ring {
  uint8_t bytes[kRing] = {};
  uint32_t head = 0, tail = 0;
  size_t used() const { return head - tail; }
};

portMUX_TYPE lock = portMUX_INITIALIZER_UNLOCKED;
Ring rx, tx;
NimBLEServer* server = nullptr;
NimBLECharacteristic* txChar = nullptr;
volatile bool linkUp = false;
volatile bool linkAuthenticated = false;
volatile uint16_t connHandle = 0xFFFF;
volatile uint16_t payload = 20;  // ATT MTU - 3
uint32_t lastNotifyUs = 0;

void resetRings() {
  portENTER_CRITICAL(&lock);
  rx.tail = rx.head;
  tx.tail = tx.head;
  portEXIT_CRITICAL(&lock);
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, ble_gap_conn_desc* desc) override {
    resetRings();
    connHandle = desc->conn_handle;
    linkAuthenticated = desc->sec_state.encrypted && desc->sec_state.authenticated;
    linkUp = true;
  }
  void onDisconnect(NimBLEServer*) override {
    linkUp = false;
    linkAuthenticated = false;
    connHandle = 0xFFFF;
    resetRings();
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    payload = mtu > 3 ? static_cast<uint16_t>(mtu - 3) : 20;
  }
  void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
    linkAuthenticated = desc->sec_state.encrypted && desc->sec_state.authenticated;
    if (!linkAuthenticated) NimBLEDevice::getServer()->disconnect(desc->conn_handle);
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, ble_gap_conn_desc* desc) override {
    if (!(desc->sec_state.encrypted && desc->sec_state.authenticated)) return;
    const std::string value = c->getValue();
    portENTER_CRITICAL(&lock);
    for (const char ch : value) {
      if (rx.used() >= kRing) break;  // overflow: line parser rejects the line
      rx.bytes[rx.head++ & (kRing - 1)] = static_cast<uint8_t>(ch);
    }
    portEXIT_CRITICAL(&lock);
  }
};

}  // namespace

void begin(const char* deviceName, uint32_t passkey) {
  NimBLEDevice::init(deviceName);
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setSecurityAuth(true, true, true);  // bond, MITM, secure connections
  NimBLEDevice::setSecurityPasskey(passkey);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
  server = NimBLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  NimBLEService* service = server->createService(kService);
  txChar = service->createCharacteristic(
      kTx, NIMBLE_PROPERTY::NOTIFY | NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::READ_AUTHEN);
  NimBLECharacteristic* rxChar = service->createCharacteristic(
      kRx, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR | NIMBLE_PROPERTY::WRITE_AUTHEN);
  rxChar->setCallbacks(new RxCallbacks());
  service->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(kService);
  adv->setScanResponse(true);
  adv->start();
}

bool connected() { return linkUp; }
bool authenticatedLink() { return linkUp && linkAuthenticated; }
uint16_t payloadSize() { return payload; }

size_t read(uint8_t* out, size_t max) {
  size_t n = 0;
  portENTER_CRITICAL(&lock);
  while (n < max && rx.used()) out[n++] = rx.bytes[rx.tail++ & (kRing - 1)];
  portEXIT_CRITICAL(&lock);
  return n;
}

size_t writable() {
  if (!authenticatedLink()) return 0;
  portENTER_CRITICAL(&lock);
  const size_t room = kRing - tx.used();
  portEXIT_CRITICAL(&lock);
  return room;
}

size_t write(const uint8_t* data, size_t len) {
  if (!authenticatedLink()) return 0;
  size_t n = 0;
  portENTER_CRITICAL(&lock);
  while (n < len && tx.used() < kRing) tx.bytes[tx.head++ & (kRing - 1)] = data[n++];
  portEXIT_CRITICAL(&lock);
  return n;
}

void poll() {
  if (!authenticatedLink() || !txChar) return;
  const uint32_t now = static_cast<uint32_t>(micros());
  if (now - lastNotifyUs < kNotifyIntervalUs) return;
  uint8_t chunk[244];
  size_t n = 0;
  portENTER_CRITICAL(&lock);
  const size_t limit = payload < sizeof(chunk) ? payload : sizeof(chunk);
  while (n < limit && n < tx.used()) {
    chunk[n] = tx.bytes[(tx.tail + n) & (kRing - 1)];
    ++n;
  }
  portEXIT_CRITICAL(&lock);
  if (!n || txChar->getSubscribedCount() == 0) return;
  // NimBLECharacteristic::notify() drops data silently when mbufs run out.
  // The host call consumes the mbuf either way; bytes stay queued on error.
  os_mbuf* om = ble_hs_mbuf_from_flat(chunk, n);
  if (!om) return;
  lastNotifyUs = now;
  if (ble_gattc_notify_custom(connHandle, txChar->getHandle(), om) != 0) return;
  portENTER_CRITICAL(&lock);
  tx.tail += n;
  portEXIT_CRITICAL(&lock);
}

void disconnect() {
  if (server && connHandle != 0xFFFF) server->disconnect(connHandle);
}

void forgetBonds() { NimBLEDevice::deleteAllBonds(); }

}  // namespace ble_transport

#endif  // SME105_BLE
