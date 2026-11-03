"""Real 97AB-KA first-attempt evidence; never open serial or invent DTCs."""

from __future__ import annotations

import hashlib
import unittest

from scripts.inspect_sme105_first_dtc_attempt import (
    FIRST_CAPTURE,
    FIRST_SHA256,
    inspect,
)


class FirstVehicleAttemptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw = FIRST_CAPTURE.read_bytes()

    def test_real_captured_failure_pinpoints_echo_content_not_slot_timing(self):
        self.assertEqual(hashlib.sha256(self.raw).hexdigest(), FIRST_SHA256)
        report = inspect(self.raw)
        self.assertEqual((report.expected_first_echo, report.observed_first_echo),
                         (0x01, 0x6D))
        self.assertEqual(report.reason_code, 9)
        self.assertEqual(report.baseline_frames, 16)
        self.assertEqual(report.start_after_header_us, 421)
        self.assertEqual(report.slot_target_error_us, 4)
        self.assertEqual(report.echo_offset_us, 994)
        self.assertEqual(report.source_sha256, FIRST_SHA256)

    def test_first_attempt_rejects_malformed_or_nonmatching_data(self):
        alterations = (
            (b"byte=6D", b"byte=01"),
            (b"reason=9", b"reason=7"),
            (b"opcode=01B0", b"opcode=260E"),
            (b"byte=A0\r\nCART_EVT t_us=18728950", b"byte=A1\r\nCART_EVT t_us=18728950"),
            (b"byte=5F\r\nCART_EVT t_us=18723993", b"byte=50\r\nCART_EVT t_us=18723993"),
            (b"n=69 uart_errors=0", b"n=68 uart_errors=0"),
            (b"start_us=18727956", b"start_us=18729000"),
        )
        for old, new in alterations:
            with self.subTest(change=(old, new)):
                self.assertIn(old, self.raw)
                with self.assertRaises(ValueError):
                    inspect(self.raw.replace(old, new, 1))
        with self.assertRaises(ValueError):
            inspect(self.raw[:-100])

    def test_parser_does_not_classify_wrong_echo_as_dtc(self):
        from scripts.analyze_timed_dtc import analyze

        report = analyze(self.raw)
        self.assertEqual(report["reference_dtc_candidates"], [])
        self.assertFalse(report["is_dtc_read_verified"])
        self.assertEqual(report["classification"],
                         "incomplete-or-unvalidated-timing-or-response")


if __name__ == "__main__":
    unittest.main()
