import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PATH = ROOT / "scripts" / "sme105_rs485_four_slot_session.py"
spec = importlib.util.spec_from_file_location("isolated_rs485_four", PATH)
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def good_capture() -> bytes:
    lines = [
        bench.CHECK,
        bench.BEGIN,
        (
            "BENCH_END result=PASS_DUAL_RS485_DESK_ONLY completed=4 "
            "irq_errors=0 coalesced=0 B_TX=0 ECU_TX=0 no_auto_retry=1 de_mode=RMT_AUTONOMOUS"
        ),
    ]
    for i, word in enumerate(bench.SAMPLES):
        start = 10_000 + i * 10_000
        f = start + 4
        lines.append(
            f"WORD index={i} sample={word} target_us={start} fired_us={f} "
            f"done_us={f+2087} echo_count=2 echo0_us={f+995} echo1_us={f+2035} "
            f"xy_count=2 xy0_us={f+1001} xy1_us={f+2042} tx_done_count=1 "
            f"cutoff=0 error=0 unexpected_rx=00 expected_rx=00 rx_position=0 "
            f"unexpected_at_us=0 de_rmt_high_us=2085 de_rmt_items=1 "
            f"tx_rmt_items=9 tx_rmt_edges={bench.EDGE_COUNTS[i]}"
        )
    lines.append(bench.LIMITS)
    return ("\r\n".join(lines) + "\r\n").encode()


class DualRs485BenchTests(unittest.TestCase):
    def test_four_word_dual_echo(self):
        self.assertTrue(bench.verify_capture(good_capture())[0])

    def test_adversarial_witnesses(self):
        raw = good_capture()
        for old, new in (
            (b"xy_count=2", b"xy_count=1"),
            (b"echo_count=2", b"echo_count=1"),
            (b"xy1_us=12046", b"xy1_us=15000"),
            (b"de_rmt_high_us=2085", b"de_rmt_high_us=2290"),
            (b"completed=4", b"completed=3"),
            (b"irq_errors=0", b"irq_errors=1"),
            (b"coalesced=0", b"coalesced=1"),
            (b"sample=55AA", b"sample=26A4"),
            (b"cutoff=0", b"cutoff=1"),
            (b"error=0", b"error=6"),
            (b"tx_done_count=1", b"tx_done_count=0"),
            (b"tx_rmt_edges=17", b"tx_rmt_edges=9"),
            (b"B_TX=0", b"B_TX=1"),
            (b"max_idle=1", b"max_idle=0"),
            (b"no_vehicle=1", b"no_vehicle=0"),
        ):
            with self.subTest(old=old, new=new):
                self.assertFalse(bench.verify_capture(raw.replace(old, new, 1))[0])
        self.assertFalse(bench.verify_capture(raw + raw)[0])
        self.assertFalse(bench.verify_capture(raw[:-20])[0])
        self.assertFalse(bench.verify_capture(b"BENCH_ABORT DESK_WIRING_NOT_VERIFIED no_uart_bytes=1 DE=LOW\r\n")[0])

    def test_isolation_and_pins_firmware_source(self):
        source = (ROOT / "firmware" / "sme105_rs485_four_slot_isolated"
                  / "sme105_rs485_four_slot_isolated.ino").read_text()
        assert '#error "This bench must never be compiled with vehicle transmission enabled"' in source
        for required in (
            'samples[kWords][2] = {{0x55, 0xAA}, {0x33, 0xCC}',
            'constexpr int kOldEcho = 19;',
            'constexpr int kExternalDeSense = 21;',
            'UART2.fifo.rw_byte = samples[index][0]',
            'RMT_SIG_OUT2_IDX + index',
            'BENCH_RS485_ONCE',
            'oneShotUsed = true;',
        ):
            self.assertIn(required, source)
        self.assertNotIn('BENCH_INTERNAL_ONCE', source)
        self.assertNotIn('runAutonomousDe(', source)


if __name__ == "__main__":
    unittest.main()
