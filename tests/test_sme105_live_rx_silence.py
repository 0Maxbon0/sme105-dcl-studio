"""Source-bound C++ regressions for live RX silence and the v23 ISR race fix.

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

    def test_cpp_actual_poll_and_shutdown_with_isr_interleavings(self):
        """Compile real pollActive/stopEverything with simulated clock/hardware.

        The clock hook reproduces an ISR arriving AFTER the timer has sampled
        now but BEFORE it returns to the caller. With v22's expression this
        yields precisely uint32_t(-2); the ordered v23 snapshot cannot do so.
        This does not simulate ECU electronics or prove vehicle operation.
        """
        if not shutil.which("g++"):
            self.skipTest("g++ unavailable")
        sketch = self.sketch

        def function(signature):
            return signature + sketch.split(signature, 1)[1].split("\n}\n", 1)[0] + "\n}\n"

        task = function("void pollActive() {")
        stop = function("void stopEverything(Fault reason) {")
        rearm = function("constexpr bool faultAllowsRearm(Fault reason) {")
        enums = sketch[sketch.index("enum Stage :"):sketch.index("struct RxEvent")]
        variants = sketch[sketch.index("constexpr uint8_t kVariantKoeo"):
                          sketch.index("constexpr bool isSelfTest")]
        limits = "\n".join(line for line in sketch.splitlines() if line.startswith(
            ("constexpr uint32_t kCaptureMs", "constexpr uint32_t kKoeoCaptureMs",
             "constexpr uint32_t kClearCaptureMs", "constexpr uint32_t kPidMapTxCaptureMs",
             "constexpr uint32_t kLiveCaptureMs")))
        cpp = r'''
#include <cstdint>
#include <cassert>
#include <string>
#include "pad_evidence.h"
PadEvidence padEvidence;
#define F(x) x
#define portENTER_CRITICAL(x) ((void)0)
#define portEXIT_CRITICAL(x) ((void)0)
constexpr int HIGH = 1, kRO = 16;
''' + enums + variants + limits + r'''
volatile Stage stage = CART_READ;
volatile uint8_t variant = 2;
volatile uint32_t lastRxAtUs = 0;
uint32_t clockUs = 0, clockMs = 0, captureStartedMs = 0;
bool injectIsr = false;
uint32_t isrAt = 0;
int64_t esp_timer_get_time() {
  const uint32_t sampled = clockUs;
  if (injectIsr) { lastRxAtUs = isrAt; injectIsr = false; }
  return sampled;
}
uint32_t millis() { return clockMs; }
uint32_t reportedErrors = 0, uartErr = 0, reportedLost = 0, lostRx = 0;
uint32_t baselineCount = 0, lastReportedBaseline = 0, rxTotal = 1953, dpsBlocks = 0;
uint8_t wordsStarted = 4, wordsVerified = 4, nextId = 6, armedVariant = 255;
bool slotInFlight = false, slotArmed = false, stopLatched = false;
bool repeatDps = true, captureOnly = false, stopAtBlock = false;
bool deHigh = true, slotTimerOn = true, deTimerOn = true;
bool nativeOpen = true, referenceOpen = true;
bool sessionRetained = false;
uint32_t sessionDetachedAtMs = 0;
bool telemetryReplayActive = false;
Fault failure = NO_FAULT;
struct {
  struct { int tx_done = 1; } int_ena;
  struct { int st_utx_out = 0; } status;
} UART2;
struct Output {
  std::string text;
  void print(const char* v) { text += v; }
  template <class T> void print(T v) { text += std::to_string(v); }
  template <class T> void println(T v) { print(v); text += '\n'; }
} out;
void deOff() { deHigh = false; }
void disableSlotTimer() { slotTimerOn = false; }
void disableDeTimer() { deTimerOn = false; }
void closeNative() { nativeOpen = false; }
void closeReference() { referenceOpen = false; }
int digitalRead(int) { return HIGH; }
''' + stop + rearm + task + r'''
void reset(uint8_t v = 2) {
  variant = v; stage = CART_READ; failure = NO_FAULT; captureStartedMs = 0;
  repeatDps = true; captureOnly = stopAtBlock = stopLatched = false;
  deHigh = slotTimerOn = deTimerOn = nativeOpen = referenceOpen = true;
  slotArmed = slotInFlight = true; armedVariant = v;
  injectIsr = false; out.text.clear(); UART2.int_ena.tx_done = 1;
}
void checkSilenceShutdown() {
  assert(failure == RX_SILENCE && static_cast<int>(failure) == 19);
  assert(stage == FINISHING && stopLatched && armedVariant == 255);
  assert(!sessionRetained && sessionDetachedAtMs == 0 && !telemetryReplayActive);
  assert(!deHigh && !slotTimerOn && !deTimerOn && !slotArmed && !slotInFlight);
  assert(!nativeOpen && !referenceOpen && !UART2.int_ena.tx_done);
  assert(!faultAllowsRearm(failure));
  assert(out.text.find("FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW") != std::string::npos);
  assert(out.text.find("EVENT live_rx_stop_state next_frame=6") != std::string::npos);
}
int main() {
  for (uint8_t v : {2, 6, 11, 12}) {
    reset(v);
    // Field race: ISR publishes 66221618 after clock sampled 66221616.
    // The v22 expression re-reads the volatile timestamp and produces -2.
    clockMs = 5895; clockUs = 66221616; lastRxAtUs = clockUs - 1000;
    isrAt = clockUs + 2; injectIsr = true;
    pollActive();
    assert(lastRxAtUs == 66221618 && failure == NO_FAULT && stage == CART_READ);
    clockUs += 3; pollActive(); // Next poll uses the newly published timestamp.
    assert(failure == NO_FAULT);

    // ISR already completed before snapshot: later clock must include its time.
    lastRxAtUs = clockUs + 2; clockUs += 2; pollActive();
    assert(failure == NO_FAULT);

    // Three-hour LIVE limit remains; run 10M simulated us through counter wrap
    // with 22.5ms frame reception, polling every 1ms including between frames.
    reset(v);
    constexpr uint64_t start = 0xffffffffULL - 2000000;
    for (uint64_t dt = 0; dt <= 10000000; dt += 1000) {
      clockMs = 6000 + dt / 1000;
      lastRxAtUs = static_cast<uint32_t>(start + (dt / 22500) * 22500);
      clockUs = static_cast<uint32_t>(start + dt);
      pollActive();
      assert(stage == CART_READ && failure == NO_FAULT);
    }

    // Boundary at five seconds, including actual uint32 wrap.
    for (uint32_t last : {0u, 0xfffffff0u, 0x7fffffffu}) {
      reset(v); lastRxAtUs = last; clockMs = 12000;
      clockUs = last + 4999999u; pollActive(); assert(failure == NO_FAULT);
      clockUs = last + 5000000u; pollActive(); checkSilenceShutdown();
      assert(out.text.find("last_rx_age_us=5000000") != std::string::npos);
      assert(out.text.find("last_rx_us=" + std::to_string(last)) != std::string::npos);
      reset(v); lastRxAtUs = last; clockMs = 12000;
      clockUs = last + 5000001u; pollActive(); checkSilenceShutdown();
      // Preserve unsigned ages beyond the signed half-range as well.
      // A signed clamp would miss this real silence after a long idle boot.
      reset(v); lastRxAtUs = last; clockMs = 2200000;
      clockUs = last + 0x80000000u; pollActive(); checkSilenceShutdown();
    }
    reset(v); clockMs = 4999; clockUs = 6000000; lastRxAtUs = 0;
    pollActive(); assert(failure == NO_FAULT); // startup grace unchanged
    reset(v); stage = CART_PASSIVE; clockMs = 6000;
    pollActive(); assert(failure == NO_FAULT);
    reset(v); stage = IDLE; clockMs = 12000;
    pollActive(); assert(failure == NO_FAULT);

    // Existing capture timeout remains independent of RX freshness.
    reset(v); clockMs = kLiveCaptureMs; clockUs = lastRxAtUs = 100;
    pollActive(); assert(stopAtBlock && failure == NO_FAULT);
    clockMs += 3000; pollActive(); assert(failure == CAPTURE_TIMEOUT && !deHigh);
  }
  for (uint8_t v : {0, 1, 3, 4, 5, 7, 8, 9, 10, 13, 25, 26, 28}) {
    reset(v); clockMs = 6000; clockUs = 6000000; lastRxAtUs = 0;
    pollActive(); assert(failure != RX_SILENCE);
  }
  // Already-latched faults must never be replaced by the task watchdog.
  reset(); failure = RX_OVERFLOW; clockMs = 6000; clockUs = 6000000;
  lastRxAtUs = 0; pollActive(); assert(failure == RX_OVERFLOW && !deHigh);
}
'''
        with tempfile.TemporaryDirectory() as td:
            src, binary = Path(td) / "watchdog.cpp", Path(td) / "watchdog"
            src.write_text(cpp, encoding="utf-8")
            subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            "-fsanitize=undefined", "-I", str(SKETCH.parent), str(src), "-o", str(binary)],
                           check=True, capture_output=True)
            subprocess.run([str(binary)], check=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
