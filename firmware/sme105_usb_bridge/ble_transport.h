#pragma once

#include <cstddef>
#include <cstdint>

// BLE line transport (Nordic UART Service layout): the phone writes command
// lines to RX and receives bridge output lines as TX notifications. Both
// characteristics require an authenticated (passkey-paired) encrypted link.
namespace ble_transport {

void begin(const char* deviceName, uint32_t passkey);
// Link up AND the current peer completed authenticated pairing.
bool authenticatedLink();
bool connected();
uint32_t connectionEpoch();
// Received command bytes from the authenticated peer; drained in loop().
size_t read(uint8_t* out, size_t max);
// Queue output for notification; returns bytes accepted (never blocks).
size_t write(const uint8_t* data, size_t len);
size_t writable();
// Sends at most one notification, rate limited; call from loop().
void poll();
void disconnect();
void forgetBonds();
uint16_t payloadSize();

}  // namespace ble_transport
