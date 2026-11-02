"""No bus access: native field host identity, endings and immutable files."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts import sme105_timed_session as host


class FakePort:
    def __init__(self, *, response=b"", data=b""):
        self.response = response
        self.rx = bytearray(data)
        self.sent: list[bytes] = []

    @property
    def in_waiting(self):
        return len(self.rx)

    def read(self, count=1):
        chunk = bytes(self.rx[:count])
        del self.rx[:count]
        return chunk

    def read_until(self, marker=b"\n", size=180):
        return self.response[:size]

    def write(self, raw):
        self.sent.append(raw)
        return len(raw)

    def flush(self):
        pass


class TimedHostTests(unittest.TestCase):
    def test_safe_and_candidate_uart_isrs_use_driver_independent_registration(self):
        root = Path(__file__).resolve().parents[1] / "firmware"
        for name, source, handler in (
            ("sme105_dtc_one_shot", "sme105_dtc_one_shot.ino", "rawUartHandle"),
            ("sme105_dtc_active_candidate", "sme105_dtc_active_candidate.ino", "rawHandle"),
        ):
            with self.subTest(firmware=name):
                code = (root / name / source).read_text()
                self.assertIn("esp_intr_alloc(ETS_UART2_INTR_SOURCE", code)
                self.assertIn(f"esp_intr_free({handler})", code)
                self.assertNotIn("if (uart_isr_register(", code)
                self.assertIn("#error", code)  # B TX remains compile-locked
                if name == "sme105_dtc_one_shot":
                    self.assertIn("UART2.conf1.rxfifo_full_thrhd = 1;", code)
                    self.assertNotIn("UART2.conf1.rxfifo_full_thrhd = 0;", code)

    def test_dry_run_requires_four_complete_local_timer_slots(self):
        plan = (b"CART_B_PLAN stage=COMPLETE reason=0 baseline_frames=16 "
                b"command_frames=16 phase_bits=4 scheduled=4 fired=4 "
                b"mode=DRY_RUN tx_bytes=0 ecu_verified=0\n")
        slots = b"".join(
            f"CART_B_SLOT frame={index} slot=1 opcode={opcode} "
            f"target_us={5000 + 10000 * index} fired_us={5009 + 10000 * index} "
            "dry_run=1 tx_bytes=0\n".encode()
            for index, opcode in enumerate(("01B0", "FF5F", "26A4", "00A0"))
        )
        good = plan + slots
        self.assertTrue(host.inspect_dry_run(good)[0])
        for raw in (
            b"", plan, good + plan,
            good.replace(b"stage=COMPLETE", b"stage=FAILED"),
            good.replace(b"reason=0", b"reason=1"),
            good.replace(b"opcode=26A4", b"opcode=260E"),
            good.replace(b"frame=3", b"frame=1"),
            good.replace(b"fired_us=5009", b"fired_us=6009"),
            good.replace(b"fired=4", b"fired=3"),
        ):
            with self.subTest(raw=raw[:60]):
                self.assertFalse(host.inspect_dry_run(raw)[0])

    def test_dry_run_reports_real_id_capture_without_fake_timer_success(self):
        content = (
            b"CART_B_PLAN stage=SEEK reason=0 baseline_frames=0 command_frames=0 "
            b"phase_bits=255 scheduled=0 fired=0 mode=DRY_RUN tx_bytes=0 ecu_verified=0\n"
            b"CART_LAG_BASELINE valid=1 frames=970 cycles=60 prefix=105 phase=4 "
            b"edge_verified=0 b_tx=0\n"
        )
        ok, message = host.inspect_dry_run(content)
        self.assertFalse(ok)
        self.assertIn("complete 16-ID cycles=60", message)
        self.assertIn("NOT validated active slot timing", message)
        self.assertIn("970 frames", host.inspect_lagged_id_baseline(content))
        self.assertIn("NOT verified", host.inspect_lagged_id_baseline(content))

    def test_status_requires_exact_native_firmware_identity_and_timer(self):
        correct = (b"STATUS SME105_DTC_ONE_SHOT_V5 DE=LOW B_TX=COMPILE_LOCKED "
                   b"used=0 deadline_timer=1\r\n")
        self.assertTrue(host.status(FakePort(response=correct)))
        for wrong in (
            correct.replace(b"V5", b"V4"),
            correct.replace(b"deadline_timer=1", b"deadline_timer=0"),
            correct.replace(b"COMPILE_LOCKED", b"ENABLED"),
        ):
            with self.subTest(wrong=wrong), self.assertRaises(RuntimeError):
                host.status(FakePort(response=wrong))
        self.assertFalse(host.status(FakePort(response=correct.replace(b"used=0", b"used=1"))))

    def test_post_arduino_uart_native_receiver_test_is_receive_only(self):
        device = FakePort(response=(b"RAW_ISR_SELFTEST PASS irq=READY "
                                    b"rx_events=0 uart_errors=0 B_TX_LOCKED\r\n"))
        self.assertEqual(host.selftest_receiver(device), (0, 0))
        self.assertEqual(device.sent, [b"SELFTEST_RX_ISR\n"])
        for wrong in (b"DENIED unknown_command\r\n",
                      b"Guru Meditation Error\r\n",
                      b"RAW_ISR_SELFTEST FAIL irq=UNAVAILABLE B_TX_LOCKED\r\n"):
            with self.subTest(wrong=wrong), self.assertRaises(RuntimeError):
                host.selftest_receiver(FakePort(response=wrong))

    def test_panics_raise_immediately_and_preserve_crash_evidence(self):
        raw = (b"REF_TX frame=GO_CART bytes=11 cutoff=0\r\n"
               b"Guru Meditation Error: Core 1 panic'ed (StoreProhibited)\r\n")
        device = FakePort(data=raw)
        with self.assertRaisesRegex(host.CaptureIncomplete, "ESP32 PANIC") as context:
            host.capture(device, deadline_seconds=1, action="PLAN_B_ONCE")
        self.assertEqual(context.exception.raw, raw)
        self.assertEqual(device.sent, [b"PLAN_B_ONCE\n"])

    def test_finished_capture_does_not_issue_more_requests(self):
        device = FakePort(data=b"CART_EVT t_us=1 byte=00\r\n"
                          b"CART_END DTC_UNVERIFIED B_TX_LOCKED\r\n")
        content = host.capture(device, deadline_seconds=1)
        self.assertIn(b"CART_END ", content)
        self.assertEqual(device.sent, [b"CAPTURE_CART_ONCE\n"])
        dry_run = FakePort(data=b"CART_END DTC_UNVERIFIED B_TX_LOCKED\r\n")
        self.assertEqual(host.capture(dry_run, action="PLAN_B_ONCE"),
                         b"CART_END DTC_UNVERIFIED B_TX_LOCKED\r\n")
        self.assertEqual(dry_run.sent, [b"PLAN_B_ONCE\n"])
        with self.assertRaises(ValueError):
            host.capture(FakePort(), action="READ_B_ONCE")

    def test_partial_and_trailing_garbage_are_not_silently_discarded(self):
        for raw in (
            b"CART_EVT t_us=1 byte=00\r\n",
            b"CART_END DTC_UNVERIFIED B_TX_LOCKED\r\nUNEXPECTED\n",
            b"CART_ABORT handshake_or_ack_failed TX_LOCKED\r\n",
        ):
            with self.subTest(raw=raw):
                device = FakePort(data=raw)
                with self.assertRaises(host.CaptureIncomplete) as context:
                    host.capture(device, deadline_seconds=0.001)
                self.assertEqual(context.exception.raw, raw)
                if b"CART_ABORT" in raw:
                    self.assertIn("firmware aborted", str(context.exception))

    def test_evidence_is_create_only(self):
        with tempfile.TemporaryDirectory() as target:
            original = b"timed CART bytes\r\n"
            path = host.write_evidence(original, Path(target))
            self.assertEqual(path.read_bytes(), original)
            with self.assertRaises(FileExistsError), path.open("xb"):
                pass


if __name__ == "__main__":
    unittest.main()
