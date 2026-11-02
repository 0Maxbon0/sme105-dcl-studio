"""Forensic inspection never turns delayed ID echoes into verified DTCs."""

import unittest
from pathlib import Path

from scripts.analyze_timed_fifo_lag import inspect


class ForensicTests(unittest.TestCase):
    def test_recorded_field_evidence_has_real_multicycle_id_pattern(self):
        path = (Path(__file__).resolve().parents[1] / "captures" / "TIMED_CART" /
                "20261102T182948912742Z-cart-isr.txt")
        if not path.exists():
            self.skipTest("untracked operator capture is not part of clean source checkout")
        original = path.read_bytes()
        parsed = inspect(original)
        self.assertEqual(parsed["sha256"],
                         "d940f221f069fa4bc5ee63ab07ef2e2de606057c5581d49fc581580287edd218")
        self.assertEqual(parsed["validated_full_frames"], 970)
        self.assertEqual(parsed["full_16_id_cycles"], 60)
        self.assertFalse(parsed["is_dtc_read_verified"])
        self.assertFalse(parsed["physical_byte_timing_verified"])
        self.assertFalse(parsed["is_ecu_source_authenticated"])
        for damaged in (original.replace(b"uart_errors=0", b"uart_errors=1", 1),
                        original.replace(b"CART_END DTC_UNVERIFIED B_TX_LOCKED", b""),
                        original.replace(b"CART_EVT ", b"BROKEN ", 1),
                        original.replace(b"byte=A0", b"byte=A1", 1)):
            with self.subTest(damaged=damaged[:100]):
                failed = inspect(damaged)
                self.assertFalse(failed["is_dtc_read_verified"])
                self.assertFalse(failed["is_ecu_source_authenticated"])
        self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
