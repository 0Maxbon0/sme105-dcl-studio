"""Source-bound regression for the v21 five-second live RX-stop ambiguity.

This is a host simulation of the exact C++ guard, NOT an ECU or electrical test.
The field capture contained 2,462 consecutive RX bytes, then END reason=7
without a FAULT line. The old task-level watchdog used CART_HEADER (7), which
made silence indistinguishable from a malformed header in the ISR.
"""

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SKETCH = Path(__file__).resolve().parents[1] / "firmware/sme105_usb_bridge/sme105_usb_bridge.ino"


class LiveRxSilenceSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sketch = SKETCH.read_text(encoding="utf-8")

    def test_watchdog_is_a_distinct_fail_closed_reason(self):
        sketch = self.sketch
        task = sketch.split("void pollActive() {", 1)[1].split("void reportEnd() {", 1)[0]
        faults = sketch.split("enum Fault : uint8_t {", 1)[1].split("};", 1)[0]
        self.assertRegex(faults, r"DE_MISSING,\s*RX_SILENCE")
        self.assertIn("stopEverything(RX_SILENCE);", task)
        self.assertNotIn("stopEverything(CART_HEADER);", task)
        self.assertIn('EVENT live_rx_silence elapsed_ms=', task)
        self.assertIn('last_rx_age_us=', task)
        self.assertIn('words_started=', task)
        self.assertIn('words_verified=', task)
        self.assertIn('EVENT live_rx_stop_state next_frame=', task)
        self.assertIn('slot_in_flight=', task)
        self.assertIn('uart2_busy=', task)
        self.assertIn('ro_pin_high=', task)
        self.assertIn('FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW', task)
        self.assertLess(task.index("stopEverything(RX_SILENCE);"),
                        task.index('FAULT reason=19'))
        # A real ISR header failure continues using its original reason.
        isr = sketch.split("void IRAM_ATTR observeHeader(", 1)[1].split("void IRAM_ATTR uart1ISR", 1)[0]
        self.assertIn("faultISR(CART_HEADER)", isr)
        # Silence is not an allowed retry/re-arm reason.
        rearm = sketch.split("constexpr bool faultAllowsRearm(", 1)[1].split("}", 1)[0]
        self.assertNotIn("RX_SILENCE", rearm)

    def test_actual_source_guard_requires_five_seconds_without_rx(self):
        if not shutil.which("g++"):
            self.skipTest("g++ unavailable")
        task = self.sketch.split("void pollActive() {", 1)[1].split("void reportEnd() {", 1)[0]
        match = re.search(
            r"if\s*\((isLiveVariant\(variant\)\s*&&\s*stage\s*==\s*CART_READ\s*&&"
            r"\s*elapsed\s*>=\s*5000\s*&&\s*rxAgeUs\s*>=\s*5000000UL)\s*\)\s*\{",
            task,
        )
        self.assertIsNotNone(match, "watchdog guard drifted; inspect safety contract")
        cpp = '''#include <cstdint>
constexpr int CART_READ = 6;
bool isLiveVariant(int v) { return v == 6 || v == 7 || v == 11 || v == 12; }
bool trips(int variant, int stage, uint32_t elapsed, uint32_t rxAgeUs) {
  if (''' + match.group(1) + ''') return true;
  return false;
}
int main() {
  if (trips(12, CART_READ, 5000, 1000)) return 1;         // active RX: no stop
  if (trips(6, CART_READ, 3000, 5000001)) return 2;      // startup grace
  if (!trips(12, CART_READ, 10500, 5000001)) return 3;   // truly silent
  if (!trips(6, CART_READ, 10500, 5000001)) return 4;    // legacy LIVE
  if (trips(1, CART_READ, 10500, 5000001)) return 5;     // code read
  if (trips(12, 0, 10500, 5000001)) return 6;            // no active session
  if (trips(12, CART_READ, 100000, 4999999)) return 7;  // no false timer
  return 0;
}
'''
        with tempfile.TemporaryDirectory() as td:
            src, out = Path(td) / "guard.cpp", Path(td) / "guard"
            src.write_text(cpp, encoding="utf-8")
            subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            str(src), "-o", str(out)], check=True, capture_output=True)
            subprocess.run([str(out)], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
