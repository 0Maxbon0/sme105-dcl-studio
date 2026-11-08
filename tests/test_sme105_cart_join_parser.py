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
#define DRAM_ATTR
#include "live_all_map.h"
enum Stage : uint8_t { IDLE, QUIET, ECHO_TX, ACK_WAIT, GO_TX,
                       CART_PASSIVE, CART_READ, FINISHING, FAULTED };
enum Fault : uint8_t { NO_FAULT, BAD_IDLE, HSK_TX, HSK_TIMEOUT, HSK_ACK,
                       CART_INIT, CART_ERR, CART_HEADER, CART_PHASE,
                       CART_CADENCE, CART_TIMER, PAD_MISMATCH, PAD_FRAMING,
                       DE_TIMEOUT, RX_OVERFLOW, HOST_STOP, CAPTURE_TIMEOUT };
struct HeaderByte { uint32_t at; uint8_t value; };
%(cmdword)s
constexpr uint32_t kGapToleranceUs = 175;
constexpr uint32_t kSlotMinLeadUs = 180, kSlotMaxLeadUs = 1250;
%(constants)s
volatile Stage stage = CART_READ;
volatile uint8_t variant = %(variant)s;
volatile bool extraArmed = false, extraInFlight = false;
volatile uint32_t extraTargetUs = 0, extraStartUs = 0;
volatile uint8_t extraGate = 0, extraFrame = 0, extraColumn = 0;
volatile uint8_t pidWordsStarted = 0, pidWordsVerified = 0;
CmdWord extraWord = {0, 0};
volatile Fault failure = NO_FAULT;
volatile bool slotInFlight = false, slotArmed = false;
volatile uint32_t targetUs = 0;
volatile uint8_t pendingSlot = 0, wordsStarted = 0, wordsVerified = 0, padCount = 0;
volatile uint32_t txStartUs[4] = {};
volatile bool frameLocked = false, captureOnly = false;
volatile bool joinMode = %(join)s, repeatDps = %(repeat)s, stopAtBlock = false;
volatile uint32_t dpsBlocks = 0;
volatile uint32_t lastSyncUs = 0, framePeriodUs = 10000;
volatile uint8_t headerUsed = 0, baselineCount = 0, phase = 255, nextId = 0;
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
%(headervalid)s
%(live)s
%(parser)s
struct Rx { uint32_t at; uint8_t b; };
static const Rx kRx[] = { %(rx)s };
int main() {
  uint32_t txDoneAt = 0, lastTarget = 0, extraDoneAt = 0;
  int words = 0, longPeriods = 0, shortPeriods = 0, pids = 0;
  for (const Rx& r : kRx) {
    if (stage == FAULTED) break;
    if (extraArmed && extraTargetUs <= r.at) {
      extraArmed = false; extraInFlight = true; extraStartUs = extraTargetUs;
      extraDoneAt = extraTargetUs + 2089; ++pidWordsStarted; ++pids;
      std::printf("PID frame=%%u pid=%%02X at=%%u\n", extraFrame, extraWord.first, extraTargetUs);
    }
    if (extraInFlight && extraDoneAt <= r.at) { extraInFlight = false; ++pidWordsVerified; }
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
      const uint8_t index = wordsStarted - 1;
      if (wordsVerified == 4 && !repeatDps) captureOnly = true;
      if (index >= 1 && liveMapFrame(index)) armExtra(index, txStartUs[index] + 2500);
    }
    simNow = r.at + 20;
    const uint32_t before = framePeriodUs;
    observeHeader(r.b, r.at);
    if (before == 0 && framePeriodUs != 0) {
      std::printf("PERIOD %%u\n", framePeriodUs);
      if (framePeriodUs > 30000) ++longPeriods; else ++shortPeriods;
    }
  }
  std::printf("RESULT fault=%%u words=%%d verified=%%u blocks=%%u long=%%d short=%%d last=%%u pids=%%d pidok=%%u\n",
              failure, words, wordsVerified, dpsBlocks, longPeriods, shortPeriods, lastTarget,
              pids, pidWordsVerified);
}
"""


def parity(first: int, nibble: int) -> int:
    return ((((first >> 4) ^ (first & 15) ^ nibble ^ 10) << 4) | nibble) & 0xFF


def extract(source: str, start: str, end: str) -> str:
    return start + source.split(start, 1)[1].split(end, 1)[0]


def rx_bytes(path: Path, skip_until_us: int = 0) -> list[tuple[int, int]]:
    text = path.read_text(encoding="utf-8", errors="replace")
    return [(int(t), int(b, 16)) for t, b in RX.findall(text) if int(t) >= skip_until_us]


@unittest.skipUnless(shutil.which("g++"), "g++ required for parser replay")
class CartJoinParserReplay(unittest.TestCase):
    source = SKETCH.read_text(encoding="utf-8")

    def run_parser(self, rx: list[tuple[int, int]], *, join: bool, repeat: bool,
                   variant: int = 1) -> dict[str, int]:
        constants = "\n".join(
            line for line in self.source.splitlines()
            if line.startswith(("constexpr uint32_t kJoin",))
        )
        code = HARNESS % {
            "constants": constants,
            "join": "true" if join else "false",
            "variant": str(variant),
            "cmdword": extract(self.source, "struct CmdWord {", "\nconst __FlashStringHelper* variantName("),
            "live": extract(self.source, "uint8_t IRAM_ATTR livePid(", "\nvoid IRAM_ATTR slotISR("),
            "repeat": "true" if repeat else "false",
            "nearus": extract(self.source, "bool IRAM_ATTR nearUs(", "\nbool IRAM_ATTR headerValid("),
            "headervalid": extract(self.source, "bool IRAM_ATTR headerValid(", "\n// Live data: the first TX block"),
            "parser": extract(self.source, "void IRAM_ATTR slideHeader(", "\nvoid IRAM_ATTR uart1ISR("),
            "rx": ",".join(f"{{{t}u,0x{b:02X}}}" for t, b in rx),
        }
        with tempfile.TemporaryDirectory() as tmp:
            src = Path(tmp) / "replay.cpp"
            exe = Path(tmp) / "replay"
            src.write_text(code, encoding="utf-8")
            subprocess.run(["g++", "-std=c++17", "-O1", "-I", str(SKETCH.parent),
                            "-o", str(exe), str(src)],
                           check=True, capture_output=True, text=True)
            out = subprocess.run([str(exe)], check=True, capture_output=True, text=True).stdout
        result = re.search(r"RESULT (.*)", out)
        assert result is not None, out
        return {k: int(v) for k, v in (kv.split("=") for kv in result[1].split())}

    def test_offline_join_on_normal_stream_sends_one_dps(self) -> None:
        result = self.run_parser(rx_bytes(NORMAL_STREAM), join=True, repeat=False, variant=1)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["words"], 4)
        self.assertEqual(result["verified"], 4)
        # Learned in the baseline block, relearned at the TX block's frame 0.
        self.assertEqual(result["short"], 2)
        self.assertEqual(result["long"], 0)


    def test_variant_0e_join_sends_exactly_four_words_then_stops(self) -> None:
        # Same 2026-11-04 running CART capture. Variant 1 is a single DPS
        # (26 0E): join mode must emit one 4-word block and then go quiet.
        result = self.run_parser(rx_bytes(NORMAL_STREAM), join=True, repeat=False, variant=1)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["words"], 4)
        self.assertEqual(result["verified"], 4)
        self.assertEqual(result["blocks"], 0)

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

    def test_live_sends_no_pid_words_if_ecu_never_enters_41h(self) -> None:
        # Recorded ECU stays at 10 ms frames: the PID map must never go out.
        result = self.run_parser(rx_bytes(NORMAL_STREAM), join=True, repeat=True, variant=2)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["pids"], 0)
        self.assertGreaterEqual(result["blocks"], 10)

    def test_live_sends_pid_map_once_after_41h_takes_effect(self) -> None:
        # Synthetic ECU: 2 blocks of 10 ms frames (baseline + 41H request
        # block), then 22.5 ms frames (DIAGMODE 41H/21H, frame length 6).
        rx, t = [], 1_000_000
        for block in range(8):
            period = 10_000 if block < 2 else 22_500
            for frame in range(16):
                for dt, b in ((0, 0x00), (1042, 0x00), (2498, 0x00), (3540, parity(0, frame))):
                    rx.append((t + dt, b))
                t += period
        result = self.run_parser(rx, join=True, repeat=True, variant=2)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["pids"], 15)
        self.assertEqual(result["pidok"], 15)

    def test_live2_sends_second_pid_set(self) -> None:
        rx, t = [], 1_000_000
        for block in range(6):
            period = 10_000 if block < 2 else 22_500
            for frame in range(16):
                for dt, b in ((0, 0x00), (1042, 0x00), (2498, 0x00), (3540, parity(0, frame))):
                    rx.append((t + dt, b))
                t += period
        result = self.run_parser(rx, join=True, repeat=True, variant=6)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["pids"], 15)

    def test_fixed_period_path_unchanged_for_a4_0e(self) -> None:
        result = self.run_parser(rx_bytes(NORMAL_STREAM), join=False, repeat=False)
        self.assertEqual(result["fault"], 0)
        self.assertEqual(result["words"], 4)
        self.assertEqual(result["verified"], 4)


if __name__ == "__main__":
    unittest.main()
