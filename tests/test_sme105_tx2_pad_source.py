"""Host-side source and physical-waveform regression for the isolated TX2 pad bench.

Does not attach USB, flash ESP32, send serial bytes, or exercise ECU hardware.
Compiles the exact stand-alone RMT decode function from the shared sketch with
mock RMT items, including the captured V5 GPIO17 waveform as negative evidence.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "firmware/sme105_usb_bridge/sme105_usb_bridge.ino"
CAPTURE = ROOT / "captures/SME105_97AB/20261103T163230191091Z-raw-a4.txt"


def rmt_runs_for_word(first: int, second: int) -> list[tuple[int, int]]:
    bits: list[int] = []
    for byte in (first, second):
        bits.extend([0, *((byte >> n) & 1 for n in range(8)), 1])
    runs: list[tuple[int, int]] = []
    for i, level in enumerate(bits):
        begin = round(i * 1250 / 12)
        end = round((i + 1) * 1250 / 12)
        if runs and runs[-1][0] == level:
            runs[-1] = (level, runs[-1][1] + end - begin)
        else:
            runs.append((level, end - begin))
    # Hardware RMT waits through 1500us idle after the final stop bit.
    assert runs[-1][0] == 1
    runs[-1] = (1, runs[-1][1] + 1500)
    return runs


def rmt_items(runs: list[tuple[int, int]]) -> str:
    if len(runs) % 2:
        # The driver's final empty half-item is a sentinel in that case.
        runs = runs + [(1, 0)]
    return "{" + ", ".join(
        "{" + f"{d0}, {l0}, {d1}, {l1}" + "}"
        for (l0, d0), (l1, d1) in zip(runs[::2], runs[1::2])
    ) + "}"


class Tx2SourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = SOURCE.read_text(encoding="utf-8")

    def test_read_authority_remains_bound_to_complete_local_pad_proof(self) -> None:
        code = self.source
        begin = code.split("void beginSession(Stage target, uint8_t kind)", 1)[1]
        bench = code.split("void tx2PadBench()", 1)[1].split("void beginSession(", 1)[0]
        self.assertIn("if (target == CART_READ && !tx2BenchPassed)", begin)
        self.assertIn("tx2BenchPassed = passed && completed == 4 && deLowOnPad()", bench)
        self.assertIn("if (!complete || !rmtFirstExact) passed = false", bench)
        self.assertIn("if (tx2BenchUsed || stage != IDLE", bench)
        self.assertIn("if (!commandFromUSB && !tcpAuthenticated)", bench)
        self.assertIn("otaUpdating() || otaFirstBootPending", bench)
        self.assertIn("tx2BenchUsed = true", bench)
        self.assertNotIn("RMT.conf_ch[", bench)
        self.assertNotIn("GPIO.func_out_sel_cfg[kDE].func_sel = RMT_", bench)

    def test_rx_fifo_diagnostic_measures_cursor_advance(self) -> None:
        bench = self.source.split("void tx2PadBench()", 1)[1].split("void beginSession(", 1)[0]
        for field in ("rxMemBefore", "rxMemMid", "rxMemAfter",
                      "rxCountMid", "rxCountAfter", "READ_PERI_REG(UART_FIFO_REG(2))"):
            self.assertIn(field, bench)
        self.assertIn("WRITE_PERI_REG(UART_FIFO_AHB_REG(2)", bench)

    def test_live_uart2_isr_pop_matches_proven_apb_readback(self) -> None:
        """Regression: real CART TX must not produce a false 0101 pad witness.

        In the 2026-11-04 vehicle trace GPIO16 RO captured 01 B0, but
        UART2.fifo.rw_byte read twice returned 01 01. The DE-low bench
        correctly advances the hardware APB FIFO with READ_PERI_REG.
        """
        live = self.source.split("void IRAM_ATTR uart2ISR(void*) {", 1)[1].split(
            "void IRAM_ATTR observeHeader(", 1
        )[0]
        self.assertEqual(live.count("READ_PERI_REG(UART_FIFO_REG(2))"), 2)
        self.assertNotIn("static_cast<uint8_t>(UART2.fifo.rw_byte)", live)
        self.assertIn("countMid = UART2.status.rxfifo_cnt", live)
        self.assertIn("countAfter = UART2.status.rxfifo_cnt", live)
        self.assertIn("countMid != 1 || countAfter != 0", live)
        self.assertIn("faultISR(PAD_FRAMING)", live)
        self.assertIn("faultISR(PAD_MISMATCH)", live)
        self.assertIn("deOff();", live)
        self.assertIn("WRITE_PERI_REG(UART_FIFO_AHB_REG(2), selected.first)", self.source)
        self.assertIn("WRITE_PERI_REG(UART_FIFO_AHB_REG(2), selected.second)", self.source)

    def test_uart2_txfifo_never_reset_and_module_reset_before_session(self) -> None:
        """Regression: 2026-11-04 OFFLINE_JOIN put 2EBA on the bus for 01B0.

        stopEverything() had set UART2 txfifo_rst, which classic ESP32 cannot
        do safely (IDF uart_ll_txfifo_rst skips UART1/2). A session that joins
        a running stream has no HardwareSerial::begin() module reset.
        """
        self.assertNotIn("UART2.conf0.txfifo_rst = 1", self.source)
        native = self.source.split("bool openNative() {", 1)[1].split("\n}\n", 1)[0]
        reset = native.index("periph_module_reset(PERIPH_UART2_MODULE)")
        self.assertLess(reset, native.index("uart_set_pin(UART_NUM_2"))
        self.assertLess(native.index("uart_param_config(UART_NUM_2, &conf) != ESP_OK) return false"),
                        reset)

    def test_de_gate_rearmed_every_slot_and_witnessed_at_tx_done(self) -> None:
        """Regression: 2026-11-04 KOEO repeat blocks lost DE on channels 2/3."""
        gate = self.source.split("void IRAM_ATTR startDeGate(uint8_t index) {", 1)[1].split("\n}\n", 1)[0]
        order = [gate.index(s) for s in (
            "conf1.tx_start = 0", "data32[0].val = kGateItem", "data32[1].val = 0",
            "mem_rd_rst = 1", "func_sel = RMT_SIG_OUT2_IDX + index", "conf1.tx_start = 1")]
        self.assertEqual(order, sorted(order))
        slot = self.source.split("void IRAM_ATTR slotISR() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn("startDeGate(index);", slot)
        self.assertNotIn("tx_start = 1", slot)
        done = self.source.split("void IRAM_ATTR uart2ISR(void*) {", 1)[1].split("\n}\n", 1)[0]
        self.assertLess(done.index("deWasHigh = (GPIO.in & (1UL << kDE))"), done.index("deOff();"))
        self.assertIn("faultISR(DE_MISSING)", done)
        # 2180us HIGH, level 1; 80us LOW, level 0.
        self.assertIn("kGateItem = 2180u | (1u << 15) | (80u << 16)", self.source)

    def test_cpp_rmt_decoder_positive_and_captured_v5_negative(self) -> None:
        if not shutil.which("g++"):
            self.skipTest("g++ not available for portable pure decoder harness")
        code = self.source
        fn = code.split("bool decodeFirstTx2RmtPair(", 1)[1].split(
            "// Bench the native TX2", 1
        )[0]
        function = "bool decodeFirstTx2RmtPair(" + fn
        # Physical RMT witness from V5: first two data bytes GPIO17=6DCC.
        edges = re.findall(
            r"CART_RAW_DI_EDGE item=(\d+) level0=(\d+) dur0_us=(\d+) "
            r"level1=(\d+) dur1_us=(\d+)",
            CAPTURE.read_text(encoding="utf-8"),
        )
        self.assertGreaterEqual(len(edges), 6)
        self.assertEqual([int(x[0]) for x in edges[:6]], list(range(6)))
        # Preserve chronological RMT0/1 event order; last high is cropped to
        # 1500us as the isolated bench's hardware idle threshold demands.
        measured = []
        for _, l0, d0, l1, d1 in edges[:6]:
            measured.extend([(int(l0), int(d0)), (int(l1), int(d1))])
        self.assertEqual(measured[-1][0], 1)
        measured[-1] = (1, 1500)
        synthetic = rmt_runs_for_word(0x01, 0xB0)
        mutated = rmt_runs_for_word(0x01, 0xB1)
        truncated = synthetic[:-2]  # remove a final low/high pair, including stop evidence
        cxx = f"""
#include <cstddef>
#include <cstdint>
#include <cassert>
struct CmdWord {{ uint8_t first, second; }};
struct rmt_item32_t {{ uint16_t duration0; uint8_t level0; uint16_t duration1; uint8_t level1; }};
{function}
int main() {{
  const rmt_item32_t ideal[] = {rmt_items(synthetic)};
  assert(decodeFirstTx2RmtPair(ideal, sizeof(ideal)/sizeof(ideal[0]), {{0x01,0xB0}}));
  assert(!decodeFirstTx2RmtPair(ideal, sizeof(ideal)/sizeof(ideal[0]), {{0x01,0xB1}}));
  const rmt_item32_t changed[] = {rmt_items(mutated)};
  assert(!decodeFirstTx2RmtPair(changed, sizeof(changed)/sizeof(changed[0]), {{0x01,0xB0}}));
  const rmt_item32_t captured[] = {rmt_items(measured)};
  assert(!decodeFirstTx2RmtPair(captured, sizeof(captured)/sizeof(captured[0]), {{0x01,0xB0}}));
  assert(decodeFirstTx2RmtPair(captured, sizeof(captured)/sizeof(captured[0]), {{0x6D,0xCC}}));
  const rmt_item32_t incomplete[] = {rmt_items(truncated)};
  assert(!decodeFirstTx2RmtPair(incomplete, sizeof(incomplete)/sizeof(incomplete[0]), {{0x01,0xB0}}));
}}
"""
        with tempfile.TemporaryDirectory() as temporary:
            src = Path(temporary) / "tx2_rmt.cpp"
            binary = Path(temporary) / "tx2_rmt"
            src.write_text(cxx, encoding="utf-8")
            built = subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                                    "-o", str(binary), str(src)],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(built.returncode, 0, built.stderr)
            executed = subprocess.run([str(binary)], capture_output=True,
                                      text=True, check=False)
            self.assertEqual(executed.returncode, 0, executed.stderr)


if __name__ == "__main__":
    unittest.main()
