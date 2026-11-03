"""Exercise the *original* ESP32 BridgeOutput class with a blocked USB port.

This runs on the host only: no firmware upload, Wi-Fi access or ECU traffic.
The code is extracted from the real .ino, not replaced by a Python model.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = (Path(__file__).resolve().parents[1] / "firmware" /
          "sme105_usb_bridge" / "sme105_usb_bridge.ino")


@unittest.skipUnless(shutil.which("g++"), "host C++ compiler required")
class TestBridgeOutputFanout(unittest.TestCase):
    def test_authenticated_tcp_capture_does_not_depend_on_usb_monitor(self) -> None:
        source = SOURCE.read_text(encoding="utf-8")
        capacity = re.search(r"constexpr size_t kWireQueueSize = \d+;", source)
        self.assertIsNotNone(capacity)
        start = source.index("class BridgeOutput : public Print {")
        stop = source.index("\nBridgeOutput out;", start)
        original_class = source[start:stop]
        self.assertIn("return tcpEnabled_ ? write_ - tcpRead_ : write_ - usbRead_;",
                      original_class)
        self.assertIn("usbSkipped_", original_class)

        fixture = r"""
#include <algorithm>
#include <cassert>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <sys/socket.h>
#include <unistd.h>
#include <vector>

struct Print {
  virtual ~Print() = default;
  virtual size_t write(uint8_t byte) = 0;
  virtual size_t write(const uint8_t* buffer, size_t count) {
    size_t written = 0;
    while (written < count && write(buffer[written])) ++written;
    return written;
  }
};
struct SerialStub {
  bool blocked = true;
  std::vector<uint8_t> received;
  int availableForWrite() const { return blocked ? 0 : 256; }
  size_t write(const uint8_t* bytes, size_t count) {
    if (blocked) return 0;
    received.insert(received.end(), bytes, bytes + count);
    return count;
  }
} Serial;
struct WiFiClient {
  int socket = -1;
  int fd() const { return socket; }
};
""" + "\n" + capacity.group(0) + "\n" + original_class + r"""

int main() {
  int sockets[2] = {-1, -1};
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) == 0);
  WiFiClient client{sockets[0]};
  BridgeOutput bridge;
  bridge.markTcpAuthenticated();
  std::vector<uint8_t> expected, delivered;
  // Far larger than the real 16 KiB fan-out buffer, simulating the car's
  // 9600-baud RX stream with physically closed USB Serial monitor.
  for (size_t i = 0; i < kWireQueueSize * 8; ++i) {
    const uint8_t value = static_cast<uint8_t>(i * 13 + 7);
    assert(bridge.freeBytes() > 128);
    assert(bridge.write(value) == 1);
    expected.push_back(value);
    if (i % 64 == 63) {
      while (bridge.tcpCursor() != bridge.queued()) {
        const uint32_t previous = bridge.tcpCursor();
        bridge.drainTCP(client);
        assert(!bridge.tcpSendFailed());
        assert(bridge.tcpCursor() > previous);
      }
      uint8_t incoming[512];
      while (true) {
        const ssize_t count = recv(sockets[1], incoming,
                                   sizeof(incoming), MSG_DONTWAIT);
        if (count > 0) delivered.insert(delivered.end(), incoming, incoming + count);
        else { assert(count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)); break; }
      }
      bridge.drainUSB();
    }
  }
  assert(delivered == expected);
  assert(bridge.overflow() == 0);
  assert(bridge.usbSkipped() > 0);
  bridge.dropTcpAtCurrent();
  assert(bridge.freeBytes() >= 512);

  // With no authenticated network client, USB is the mandatory consumer.
  BridgeOutput usbOnly;
  for (size_t i = 0; i < kWireQueueSize; ++i)
    assert(usbOnly.write(static_cast<uint8_t>(i)) == 1);
  assert(usbOnly.freeBytes() == 0);
  usbOnly.drainUSB();
  assert(usbOnly.freeBytes() == 0);
  assert(usbOnly.usbSkipped() == 0);

  // A slow authenticated TCP receiver must still be bounded/fail-closed.
  BridgeOutput stalledNetwork;
  stalledNetwork.markTcpAuthenticated();
  for (size_t i = 0; i < kWireQueueSize - 127; ++i)
    assert(stalledNetwork.write(static_cast<uint8_t>(i)) == 1);
  assert(stalledNetwork.freeBytes() == 127);
  assert(stalledNetwork.overflow() == 0);

  close(sockets[0]);
  close(sockets[1]);
  return 0;
}
"""

        with tempfile.TemporaryDirectory(prefix="sme105-fanout-") as work:
            cpp = Path(work) / "fanout.cpp"
            binary = Path(work) / "fanout"
            cpp.write_text(fixture, encoding="utf-8")
            subprocess.run(["g++", "-std=c++17", "-O2", "-Wall", "-Wextra",
                            "-Werror", str(cpp), "-o", str(binary)],
                           check=True, capture_output=True, text=True, timeout=30)
            subprocess.run([str(binary)], check=True, capture_output=True,
                           text=True, timeout=30)


if __name__ == "__main__":
    unittest.main()
