#pragma once

#include <cstddef>
#include <cstdint>

// BLE line transport (Nordic UART Service layout): the phone writes command
// lines to RX and receives bridge output lines as TX notifications.
namespace ble_transport {

void begin(const char* deviceName, uint32_t passkey);
bool connected();
// Received command bytes, filled from the NimBLE host task; drained in loop().
size_t read(uint8_t* out, size_t max);
// Queue output for notification; returns bytes accepted (never blocks).
size_t write(const uint8_t* data, size_t len);
size_t writable();
void poll();

}  // namespace ble_transport
