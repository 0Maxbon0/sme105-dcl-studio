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
bool rxDiscardingTruncatedLine = false;
bool rxOverflowBoundaryPending = false;
uint8_t rxOverflowMarkerStep = 0;
uint32_t bleGeneration = 0;
uint32_t bleConnectionEpoch = 0;
uint32_t notifyInFlightGeneration = 0;
bool notifyInFlight = false;
NimBLEServer* server = nullptr;
NimBLECharacteristic* txChar = nullptr;
volatile bool linkUp = false;
volatile bool linkAuthenticated = false;
volatile uint16_t connHandle = 0xFFFF;
volatile uint16_t payload = 20;  // ATT MTU - 3
uint32_t lastNotifyUs = 0;

bool authenticatedLocked() { return linkUp && linkAuthenticated; }

void clearRingsLocked() {
  rx.head = rx.tail = 0;
  tx.head = tx.tail = 0;
  rxDiscardingTruncatedLine = false;
  rxOverflowBoundaryPending = false;
  rxOverflowMarkerStep = 0;
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer*, ble_gap_conn_desc* desc) override {
    portENTER_CRITICAL(&lock);
    ++bleConnectionEpoch;
    clearRingsLocked();
    connHandle = desc->conn_handle;
    // Authentication is admitted only after the security callback for this
    // connection epoch, even if the connect descriptor carries old state.
    linkAuthenticated = false;
    linkUp = true;
    lastNotifyUs = 0;
    notifyInFlight = false;
    portEXIT_CRITICAL(&lock);
  }
  void onDisconnect(NimBLEServer*) override {
    portENTER_CRITICAL(&lock);
    ++bleGeneration;
    ++bleConnectionEpoch;
    linkUp = false;
    linkAuthenticated = false;
    connHandle = 0xFFFF;
    clearRingsLocked();
    lastNotifyUs = 0;
    // A poll already in notify() will fail its generation check before it can
    // consume bytes from a later connection.
    notifyInFlight = false;
    portEXIT_CRITICAL(&lock);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    payload = mtu > 3 ? static_cast<uint16_t>(mtu - 3) : 20;
  }
  void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
    const bool authenticated = desc->sec_state.encrypted && desc->sec_state.authenticated;
    bool disconnectPeer = false;
    portENTER_CRITICAL(&lock);
    if (linkUp && connHandle == desc->conn_handle) {
      linkAuthenticated = authenticated;
      disconnectPeer = !authenticated;
    }
    portEXIT_CRITICAL(&lock);
    if (disconnectPeer) NimBLEDevice::getServer()->disconnect(desc->conn_handle);
  }
};

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, ble_gap_conn_desc* desc) override {
    if (!(desc->sec_state.encrypted && desc->sec_state.authenticated)) return;
    const std::string value = c->getValue();
    portENTER_CRITICAL(&lock);
    if (!authenticatedLocked() || connHandle != desc->conn_handle) {
      portEXIT_CRITICAL(&lock);
      return;
    }
    for (const char ch : value) {
      const bool lineEnd = ch == '\n' || ch == '\r';
      if (rxOverflowBoundaryPending) {
        if (!lineEnd) rxDiscardingTruncatedLine = true;
        continue;
      }
      if (rxDiscardingTruncatedLine) {
        if (lineEnd) {
          rxDiscardingTruncatedLine = false;
          rxOverflowBoundaryPending = true;
          rxOverflowMarkerStep = 0;
        }
        continue;
      }
      if (rx.used() >= kRing) {
        // Preserve a parser boundary after the truncated command. read()
        // inserts a non-printable marker and newline once queued bytes drain.
        if (lineEnd) {
          rxOverflowBoundaryPending = true;
          rxOverflowMarkerStep = 0;
        } else {
          rxDiscardingTruncatedLine = true;
        }
        continue;
      }
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

bool connected() {
  portENTER_CRITICAL(&lock);
  const bool result = linkUp;
  portEXIT_CRITICAL(&lock);
  return result;
}

bool authenticatedLink() {
  portENTER_CRITICAL(&lock);
  const bool result = authenticatedLocked();
  portEXIT_CRITICAL(&lock);
  return result;
}
uint16_t payloadSize() { return payload; }

size_t read(uint8_t* out, size_t max) {
  size_t n = 0;
  portENTER_CRITICAL(&lock);
  while (n < max && rx.used()) out[n++] = rx.bytes[rx.tail++ & (kRing - 1)];
  while (n < max && rxOverflowBoundaryPending) {
    if (rxOverflowMarkerStep == 0) {
      out[n++] = 0xFF;  // ino line parser discards through the synthetic LF
      rxOverflowMarkerStep = 1;
    } else {
      out[n++] = '\n';
      rxOverflowBoundaryPending = false;
      rxOverflowMarkerStep = 0;
    }
  }
  portEXIT_CRITICAL(&lock);
  return n;
}

size_t writable() {
  if (!txChar || txChar->getSubscribedCount() == 0) return 0;
  portENTER_CRITICAL(&lock);
  const size_t room = authenticatedLocked() ? kRing - tx.used() : 0;
  portEXIT_CRITICAL(&lock);
  return room;
}

size_t write(const uint8_t* data, size_t len) {
  if (!txChar || txChar->getSubscribedCount() == 0) return 0;
  size_t n = 0;
  portENTER_CRITICAL(&lock);
  if (!authenticatedLocked()) {
    portEXIT_CRITICAL(&lock);
    return 0;
  }
  while (n < len && tx.used() < kRing) tx.bytes[tx.head++ & (kRing - 1)] = data[n++];
  portEXIT_CRITICAL(&lock);
  return n;
}

void poll() {
  NimBLECharacteristic* const notifyChar = txChar;
  if (!notifyChar || notifyChar->getSubscribedCount() == 0) return;
  const uint32_t now = static_cast<uint32_t>(micros());
  uint8_t chunk[244];
  size_t n = 0;
  uint32_t generation = 0;
  uint16_t handle = 0xFFFF;
  portENTER_CRITICAL(&lock);
  if (!authenticatedLocked() || notifyInFlight || connHandle == 0xFFFF ||
      now - lastNotifyUs < kNotifyIntervalUs) {
    portEXIT_CRITICAL(&lock);
    return;
  }
  generation = bleGeneration;
  handle = connHandle;
  const size_t limit = payload < sizeof(chunk) ? payload : sizeof(chunk);
  while (n < limit && n < tx.used()) {
    chunk[n] = tx.bytes[(tx.tail + n) & (kRing - 1)];
    ++n;
  }
  if (n) {
    notifyInFlight = true;
    notifyInFlightGeneration = generation;
  }
  portEXIT_CRITICAL(&lock);
  if (!n) return;
  // NimBLECharacteristic::notify() drops data silently when mbufs run out.
  // The host call consumes the mbuf either way; bytes stay queued on error.
  os_mbuf* om = ble_hs_mbuf_from_flat(chunk, n);
  if (!om) {
    portENTER_CRITICAL(&lock);
    if (notifyInFlight && notifyInFlightGeneration == generation) notifyInFlight = false;
    portEXIT_CRITICAL(&lock);
    return;
  }

  portENTER_CRITICAL(&lock);
  const bool currentEpoch = bleGeneration == generation && authenticatedLocked() &&
                            connHandle == handle && notifyInFlight &&
                            notifyInFlightGeneration == generation;
  if (currentEpoch) lastNotifyUs = now;
  portEXIT_CRITICAL(&lock);
  if (!currentEpoch || notifyChar->getSubscribedCount() == 0) {
    os_mbuf_free_chain(om);
    portENTER_CRITICAL(&lock);
    if (notifyInFlight && notifyInFlightGeneration == generation) notifyInFlight = false;
    portEXIT_CRITICAL(&lock);
    return;
  }

  const int result = ble_gattc_notify_custom(handle, notifyChar->getHandle(), om);
  portENTER_CRITICAL(&lock);
  if (bleGeneration == generation && authenticatedLocked() && connHandle == handle) {
    if (result == 0) tx.tail += n;
  }
  if (notifyInFlight && notifyInFlightGeneration == generation) notifyInFlight = false;
  portEXIT_CRITICAL(&lock);
}

void disconnect() {
  uint16_t handle = 0xFFFF;
  portENTER_CRITICAL(&lock);
  handle = connHandle;
  portEXIT_CRITICAL(&lock);
  if (server && handle != 0xFFFF) server->disconnect(handle);
}

void forgetBonds() { NimBLEDevice::deleteAllBonds(); }

uint32_t connectionEpoch() {
  portENTER_CRITICAL(&lock);
  const uint32_t epoch = bleConnectionEpoch;
  portEXIT_CRITICAL(&lock);
  return epoch;
}

}  // namespace ble_transport

#endif  // SME105_BLE
