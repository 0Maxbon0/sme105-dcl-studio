import importlib.util
import unittest
from itertools import pairwise
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / "scripts" / "sme105_tx_isolated_session.py"
SPEC = importlib.util.spec_from_file_location("tx_bench", PATH)
bench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bench)


def good_capture():
    parts = ["JUMPER_CHECK tx_high=1 tx_low=1 de_low=1 de_high=1 de_release=1 uart_bytes=0",
             "BENCH_BEGIN mode=EXTERNAL_JUMPER no_vehicle=1",
             "BENCH_END result=PASS_GPIO_JUMPERS_ONLY completed=4 irq_errors=0 coalesced=0 B_TX=0 ECU_TX=0 no_auto_retry=1 de_mode=RMT_AUTONOMOUS"]
    for i, word in enumerate(bench.SAMPLES):
        target = 10000 + i * 10000
        fired = target + 4
        parts.append(
            f"WORD index={i} sample={word} target_us={target} fired_us={fired} "
            f"done_us={fired+2086} echo_count=2 echo0_us={fired+1042} "
            f"echo1_us={fired+2083} tx_done_count=1 cutoff=0 error=0 "
            f"unexpected_rx=00 expected_rx=00 rx_position=0 unexpected_at_us=0 "
            f"de_rmt_high_us=2086 de_rmt_items=1 tx_rmt_items=12 tx_rmt_edges={bench.EXPECTED_TX_RMT_SEGMENTS[i]}"
        )
    parts.append("LIMITS RMT_samples_gpio_pad_only no_RS485_voltage no_collision_proof cutoff_CPU_ISR_only")
    return ("\r\n".join(parts) + "\r\n").encode()


class BenchCaptureTests(unittest.TestCase):
    def test_rmt_edge_expectations_are_derived_from_uart_8n1_bits(self):
        # RMT includes the start + data runs, not the unbounded final
        # stop/idle HIGH. Recompute independently instead of trusting the
        # hardcoded, data-dependent edge thresholds used by the host.
        observed = []
        for sample in bench.SAMPLES:
            octets = bytes.fromhex(sample)
            levels = [1]
            for byte in octets:
                levels.extend([0] + [(byte >> n) & 1 for n in range(8)] + [1])
            transitions = sum(a != b for a, b in pairwise(levels))
            observed.append(transitions - 1)
        self.assertEqual(tuple(observed), bench.EXPECTED_TX_RMT_SEGMENTS)

    def test_isolated_firmware_keeps_vehicle_build_locked(self):
        source = (
            PATH.parents[1] / "firmware" / "sme105_dtc_tx_isolated"
            / "sme105_dtc_tx_isolated.ino"
        ).read_text()
        self.assertIn('#error "This bench must never be compiled with vehicle transmission enabled"', source)
        self.assertIn("UART2.fifo.rw_byte = samples[index][0]", source)
        self.assertIn("const int gateChannel = 2 + index;", source)
        self.assertIn("UART1.int_ena.rxfifo_full = 1;", source)

    def test_idle_gpio16_zero_does_not_falsely_deny_jumper_preflight(self):
        # At idle GPIO17 is INPUT; a connected GPIO16 can read LOW.
        for input_level in (b"0", b"1"):
            with self.subTest(input_level=input_level):
                allowed, reason = bench.may_start_jumper_preflight(
                    b"0", input_level, b"0"
                )
                self.assertTrue(allowed, reason)

    def test_jumper_preflight_denies_used_high_de_and_bad_input(self):
        for status in ((b"1", b"0", b"0"), (b"0", b"1", b"1"), (b"0", b"invalid", b"0")):
            with self.subTest(status=status):
                self.assertFalse(bench.may_start_jumper_preflight(*status)[0])

    def test_preflight_abort_preserves_no_uart_claim(self):
        observed = (b"JUMPER_CHECK tx_high=1 tx_low=0 de_low=1 de_high=0 de_release=1 uart_bytes=0\r\n"
                    b"BENCH_ABORT JUMPERS_NOT_VERIFIED no_uart_bytes=1 DE=LOW\r\n")
        ok, reason = bench.validate_capture(observed)
        self.assertFalse(ok)
        self.assertIn("BEFORE sending any UART bytes", reason)
        self.assertFalse(bench.validate_capture(observed + b"WORD index=0 sample=55AA\r\n")[0])

    def test_de_autonomous_gpio_pulse(self):
        raw = (b"DE_AUTONOMOUS result=PASS_RMT_GPIO_PAD_ONLY launch=TASK fired_us=0 high_us=2180 rmt_items=1 pad_poll_high_us=2180 mux=89 "
               b"commanded_us=2180 task_delay_ms=8 UART_TX=0 B_TX=0 ECU_TX=0 one_shot=1\r\n"
               b"DE_LIMITS RMT_output_and_input_same_GPIO_not_external_bus_proof\r\n")
        self.assertTrue(bench.validate_autonomous_de(raw)[0])
        self.assertFalse(bench.validate_autonomous_de(raw, "ISR")[0])
        timed = raw.replace(b"launch=TASK fired_us=0", b"launch=ISR fired_us=12345")
        self.assertTrue(bench.validate_autonomous_de(timed, "ISR")[0])
        self.assertFalse(bench.validate_autonomous_de(timed)[0])
        for wrong in (b"high_us=2250", b"rmt_items=0", b"FAIL_CLOSED", b"UART_TX=1", b"B_TX=1"):
            base = wrong.split(b"=", 1)[0] + b"=" if b"=" in wrong else b"PASS_RMT_GPIO_PAD_ONLY"
            invalid = raw.replace(base + (b"2180" if base == b"high_us=" else b"1" if base == b"rmt_items=" else b"0"), wrong)
            if wrong == b"FAIL_CLOSED":
                invalid = raw.replace(b"PASS_RMT_GPIO_PAD_ONLY", wrong)
            with self.subTest(wrong=wrong):
                self.assertFalse(bench.validate_autonomous_de(invalid)[0])

    def test_complete_eight_byte_witness(self):
        self.assertTrue(bench.validate_capture(good_capture())[0])

    def test_reject_adversarial_modifications(self):
        base = good_capture()
        alterations = (
            (b"de_high=1", b"de_high=0"),
            (b"completed=4", b"completed=3"),
            (b"irq_errors=0", b"irq_errors=1"),
            (b"coalesced=0", b"coalesced=1"),
            (b"sample=55AA", b"sample=26A4"),
            (b"index=1", b"index=0"),
            (b"fired_us=10004", b"fired_us=10304"),
            (b"done_us=12090", b"done_us=12300"),
            (b"echo_count=2", b"echo_count=1"),
            (b"tx_done_count=1", b"tx_done_count=2"),
            (b"cutoff=0", b"cutoff=1"),
            (b"error=0", b"error=9"),
            (b"unexpected_rx=00", b"unexpected_rx=55"),
            (b"de_rmt_high_us=2086", b"de_rmt_high_us=2500"),
            (b"de_rmt_items=1", b"de_rmt_items=0"),
            (b"tx_rmt_items=12", b"tx_rmt_items=0"),
            (b"tx_rmt_edges=17", b"tx_rmt_edges=0"),
            (b"B_TX=0", b"B_TX=1"),
            (b"mode=EXTERNAL_JUMPER", b"mode=INTERNAL_GPIO_MATRIX"),
        )
        for original, changed in alterations:
            with self.subTest(change=changed):
                self.assertFalse(bench.validate_capture(base.replace(original, changed))[0])
        self.assertFalse(bench.validate_capture(base + base)[0])
        self.assertFalse(bench.validate_capture(base.replace(b"\r\n", b"\r\n", 0)[:-60])[0])


if __name__ == "__main__":
    unittest.main()
