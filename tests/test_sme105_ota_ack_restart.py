"""Run the real firmware OTA reboot branch with a mocked TCP send cursor.

An ESP32 nonblocking send() success only means lwIP accepted bytes. In
particular, the OTA_OK frame can remain unacknowledged when the ESP restarts.
The host C++ fixture executes the firmware branch itself with fake time and
socket cursors; it never touches a device or network interface.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

FIRMWARE = (Path(__file__).resolve().parents[1] / "firmware" /
            "sme105_usb_bridge" / "sme105_usb_bridge.ino")


def reboot_pending_branch(source: str) -> str:
    service = source.split("void serviceOtaHealthAndRestart() {", 1)[1]
    start = service.index("if (signedOta.phase == OtaPhase::RebootPending) {")
    opening = service.index("{", start)
    depth = 0
    for pos in range(opening, len(service)):
        if service[pos] == "{":
            depth += 1
        elif service[pos] == "}":
            depth -= 1
            if depth == 0:
                return service[start:pos + 1]
    raise AssertionError("unclosed OTA reboot branch")


@unittest.skipUnless(shutil.which("g++"), "host C++ compiler required")
class TestSignedOtaOkReboot(unittest.TestCase):
    def test_real_reboot_branch_waits_after_full_tcp_send_and_has_hard_deadline(self) -> None:
        source = FIRMWARE.read_text(encoding="utf-8")
        branch = reboot_pending_branch(source)
        self.assertIn("signedOta.otaOkQueuedAt = out.queued();", source)
        self.assertIn("signedOta.restartDeadlineMs = millis() + kOtaRebootMaxDelayMs;", source)
        self.assertIn("signedOta.otaOkDrainedAtMs = now;", branch)
        self.assertIn("esp_restart();", branch)

        constants = []
        for name in ("kOtaOkDrainGraceMs", "kOtaRebootMaxDelayMs"):
            match = re.search(r"constexpr uint32_t " + name + r" = \d+;", source)
            self.assertIsNotNone(match, name)
            constants.append(match.group(0))

        fixture = """
#include <cassert>
#include <cstdint>
#include <climits>
""" + "\n".join(constants) + """
enum class OtaPhase : uint8_t { Idle, Receiving, RebootPending };
struct State {
  OtaPhase phase = OtaPhase::RebootPending;
  uint32_t restartDeadlineMs = 0;
  uint32_t otaOkQueuedAt = 0;
  uint32_t otaOkDrainedAtMs = 0;
  bool otaOkDrained = false;
} signedOta;
struct Output { uint32_t cursor = 0; uint32_t tcpCursor() const { return cursor; } } out;
struct Client { bool active = true; bool connected() const { return active; } } wifiClient;
bool tcpAuthenticated = true;
uint32_t nowMs = 0;
unsigned restarts = 0, deOffCalls = 0;
uint32_t millis() { return nowMs; }
void deOff() { ++deOffCalls; }
void esp_restart() { ++restarts; }
void step() {
""" + branch + """
}
void fresh(uint32_t startMs) {
  signedOta = State{};
  signedOta.otaOkQueuedAt = 100;
  signedOta.restartDeadlineMs = startMs + kOtaRebootMaxDelayMs;
  out.cursor = 0;
  nowMs = startMs;
  wifiClient.active = true;
  tcpAuthenticated = true;
  restarts = deOffCalls = 0;
}
int main() {
  // Non-final progress ACK drained is insufficient to start grace.
  fresh(100);
  out.cursor = 99;
  step();
  assert(!signedOta.otaOkDrained && restarts == 0);
  nowMs += 2000;
  step();
  assert(!signedOta.otaOkDrained && restarts == 0);

  // A complete send() to the local stack is not remote receipt.
  out.cursor = 100;
  step();
  assert(signedOta.otaOkDrained && signedOta.otaOkDrainedAtMs == nowMs);
  assert(restarts == 0);
  nowMs += kOtaOkDrainGraceMs - 1;
  step();
  assert(restarts == 0);
  nowMs += 1;
  step();
  assert(restarts == 1 && deOffCalls == 1);

  // Peer disconnect or closed socket cannot hold the committed boot forever.
  fresh(300);
  out.cursor = 100;
  tcpAuthenticated = false;
  nowMs = 300 + kOtaRebootMaxDelayMs - 1;
  step();
  assert(!signedOta.otaOkDrained && restarts == 0);
  ++nowMs;
  step();
  assert(restarts == 1 && deOffCalls == 1);

  fresh(900);
  out.cursor = 100;
  wifiClient.active = false;
  step();
  assert(!signedOta.otaOkDrained);
  nowMs = signedOta.restartDeadlineMs;
  step();
  assert(restarts == 1);

  // millis() wraps without skipping the drain grace or the hard deadline.
  fresh(UINT32_MAX - 500);
  out.cursor = 100;
  step();
  nowMs += kOtaOkDrainGraceMs - 1;
  step();
  assert(restarts == 0);
  ++nowMs;
  step();
  assert(restarts == 1);

  // An undrained OTA_OK also times out across wraparound.
  fresh(UINT32_MAX - 500);
  out.cursor = 99;
  nowMs += kOtaRebootMaxDelayMs - 1;
  step();
  assert(restarts == 0);
  ++nowMs;
  step();
  assert(restarts == 1);
}
"""
        with tempfile.TemporaryDirectory(prefix="ota-ok-reboot-") as temp:
            fixture_path = Path(temp) / "reboot.cpp"
            program = Path(temp) / "reboot"
            fixture_path.write_text(fixture, encoding="utf-8")
            compiled = subprocess.run(
                ["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                 str(fixture_path), "-o", str(program)],
                capture_output=True, text=True, check=False,
            )
            self.assertEqual(compiled.returncode, 0, compiled.stderr)
            exercised = subprocess.run(
                [str(program)], capture_output=True, text=True, check=False,
            )
            self.assertEqual(exercised.returncode, 0, exercised.stderr)


if __name__ == "__main__":
    unittest.main()
