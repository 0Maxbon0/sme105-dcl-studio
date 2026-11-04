"""Replay real vehicle CART captures through the firmware header parser.

The parser functions are extracted verbatim from the bridge sketch and run
on the host with simulated slot/TX_DONE interrupts, so frame locking, the
adaptive frame-period gate and repeated DPS scheduling are exercised on the
exact byte timing recorded from the SME105 ECU.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKETCH = ROOT / "firmware" / "sme105_usb_bridge" / "sme105_usb_bridge.ino"
CAPTURES = ROOT / "captures" / "SME105_97AB"
NORMAL_STREAM = CAPTURES / "20261104T135427026967Z-usb-bridge.txt"
LONG_BLOCK_STREAM = CAPTURES / "20261104T143804949449Z-usb-bridge.txt"
RX = re.compile(r"RX t_us=(\d+) byte=([0-9A-F]{2})")

HARNESS = r"""
#include <cstdint>
#include <cstdio>
#include <vector>
#define IRAM_ATTR
enum Stage : uint8_t { IDLE, QUIET, ECHO_TX, ACK_WAIT, GO_TX,
                       CART_PASSIVE, CART_READ, FINISHING, FAULTED };
enum Fault : uint8_t { NO_FAULT, BAD_IDLE, HSK_TX, HSK_TIMEOUT, HSK_ACK,
                       CART_INIT, CART_ERR, CART_HEADER, CART_PHASE,
                       CART_CADENCE, CART_TIMER, PAD_MISMATCH, PAD_FRAMING,
                       DE_TIMEOUT, RX_OVERFLOW, HOST_STOP, CAPTURE_TIMEOUT };
struct HeaderByte { uint32_t at; uint8_t value; };
constexpr uint32_t kGapToleranceUs = 175;
constexpr uint32_t kSlotMinLeadUs = 180, kSlotMaxLeadUs = 1250;
%(constants)s
volatile Stage stage = CART_READ;
volatile Fault failure = NO_FAULT;
volatile bool slotInFlight = false, slotArmed = false;
volatile uint32_t targetUs = 0;
volatile uint8_t pendingSlot = 0, wordsStarted = 0, wordsVerified = 0, padCount = 0;
volatile uint32_t txStartUs[4] = {};
volatile bool frameLocked = false, captureOnly = false;
volatile bool joinMode = %(join)s, repeatDps = %(repeat)s, stopAtBlock = false;
volatile uint32_t dpsBlocks = 0;
volatile uint8_t headerUsed = 0, baselineCount = 0, phase = 255, nextId = 0;
volatile uint32_t lastSyncUs = 0, framePeriodUs = 10000;
HeaderByte header[4] = {};
uint32_t simNow = 0;
uint64_t esp_timer_get_time() { return simNow; }
bool armTimer(uint8_t, uint32_t) { return true; }
void faultISR(Fault why) {
  slotArmed = false; slotInFlight = false;
  if (failure == NO_FAULT) failure = why;
  stage = FAULTED;
}
%(nearus)s
%(parity)s
%(headervalid)s
%(parser)s
struct Rx { uint32_t at; uint8_t b; };
static const Rx kRx[] = { %(rx)s };
int main() {
  uint32_t txDoneAt = 0, lastTarget = 0;
  int words = 0, longPeriods = 0, shortPeriods = 0;
  for (const Rx& r : kRx) {
    if (stage == FAULTED) break;
    if (slotArmed && targetUs <= r.at) {
      const uint8_t index = wordsStarted++;
      txStartUs[index] = targetUs;
      slotArmed = false; slotInFlight = true;
      txDoneAt = targetUs + 2089; lastTarget = targetUs; ++words;
      std::printf("TX word=%%u at=%%u\n", index, targetUs);
    }
    if (slotInFlight && txDoneAt <= r.at) {
      slotInFlight = false;
      ++wordsVerified;
      if (wordsVerified == 4 && !repeatDps) captureOnly = true;
    }
    simNow = r.at + 20;
    const uint32_t before = framePeriodUs;
    observeHeader(r.b, r.at);
    if (before == 0 && framePeriodUs != 0) {
      std::printf("PERIOD %%u\n", framePeriodUs);
      if (framePeriodUs > 30000) ++longPeriods; else ++shortPeriods;
    }
  }
  std::printf("RESULT fault=%%u words=%%d verified=%%u blocks=%%u long=%%d short=%%d last=%%u\n",
              failure, words, wordsVerified, dpsBlocks, longPeriods, shortPeriods, lastTarget);
}
"""


def extract(source: str, start: str, end: str) -> str:
    return start + source.split(start, 1)[1].split(end, 1)[0]


def rx_bytes(path: Path, skip_until_us: int = 0) -> list[tuple[int, int]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return [(int(t), int(b, 16)) for t, b in RX.findall(text) if int(t) >= skip_until_us]


@unittest.skipUnless(shutil.which("g++"), "g++ required for parser replay")
class CartJoinParserReplay(unittest.TestCase):
    source = SKETCH.read_text(encoding="utf-8")

    def run_parser(self, rx: list[tuple[int, int]], *, join: bool, repeat: bool) -> dict[str, int]:
        constants = "\n".join(
            line for line in self.source.splitlines()
            if line.startswith(("constexpr uint32_t kJoin", "constexpr uint8_t kVariantKoeo"))
        )
        code = HARNESS % {
            "constants": constants,
            "join": "true" if join else "false",
            "repeat": "true" if repeat else "false",
            "nearus": extract(self.source, "bool IRAM_ATTR nearUs(", "\nbool IRAM_ATTR headerValid("),
            "parity": extract(self.source, "constexpr uint8_t parity(", "\nstatic_assert(parity("),
            "headervalid": extract(self.source, "bool IRAM_ATTR headerValid(", "\nvoid IRAM_ATTR slotISR("),
            "parser": extract(self.source, "void IRAM_ATTR slideHeader(", "\nvoid IRAM_ATTR uart1ISR("),
            "rx": ",".join(f"{{{t}u,0x{b:02X}}}" for t, b in rx),
        }
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "replay.cpp"
            exe = Path(tmp) / "replay"
            src.write_text(code, encoding="utf-8")
            subprocess.run(["g++", "-std=c++17", "-O1", "-o", str(exe), str(src)],
                           check=True, capture_output=True, text=True)
            out = subprocess.run([str(exe)], check=True, capture_output=True, text=True).stdout
        result = re.search(r"RESULT (.*)", out)
        assert result is not None, out
        return {k: int(v) for k, v in (kv.split("=") for kv in result[1].split())}

    def test_offline_join_on_normal_stream_sends_one_dps(self) -> None:
        result = self.run_parser(rx_bytes(NORMAL_STREAM), join=True, repeat=False)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["words"], 4)
        self.assertEqual(result["verified"], 4)
        # Learned in the baseline block, relearned at the TX block's frame 0.
        self.assertEqual(result["short"], 2)
        self.assertEqual(result["long"], 0)

    def test_repeated_dps_survives_long_diagnostic_block(self) -> None:
        # Real 0E session: 10 ms frames, one 42.5 ms diagnostic block, 10 ms again.
        result = self.run_parser(rx_bytes(LONG_BLOCK_STREAM), join=True, repeat=True)
        self.assertEqual(result["fault"], 0)
        self.assertGreaterEqual(result["long"], 1)
        self.assertGreaterEqual(result["short"], 2)
        self.assertGreaterEqual(result["blocks"], 10)

    def test_offline_join_mid_stream_locks_on_long_block(self) -> None:
        rx = rx_bytes(LONG_BLOCK_STREAM)
        long_block_start = next(
            t for (t, b), (t2, b2) in zip(rx, rx[1:])
            if b == 0x22 and b2 == 0xB1
        ) - 40000
        result = self.run_parser([r for r in rx if r[0] >= long_block_start],
                                 join=True, repeat=False)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["words"], 4)
        self.assertEqual(result["long"], 1)

    def test_fixed_period_path_unchanged_for_a4_0e(self) -> None:
        result = self.run_parser(rx_bytes(NORMAL_STREAM), join=False, repeat=False)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["words"], 4)
        self.assertEqual(result["verified"], 4)


if __name__ == "__main__":
    unittest.main()
