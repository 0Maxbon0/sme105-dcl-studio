"""No auto-trying on the ECU; prove the header timing gate using real traces."""

import unittest
from pathlib import Path

from scripts.check_sme105_b_variants import evaluate


class ReadCodeVariantsTests(unittest.TestCase):
    def test_real_field_data_blocks_both_candidates(self):
        folder = Path(__file__).resolve().parents[1] / "captures" / "TIMED_CART"
        for name in (
            "20261102T182948912742Z-cart-isr.txt",
            "20261102T184936186271Z-cart-isr.txt",
        ):
            with self.subTest(name=name):
                file = folder / name
                if not file.exists():
                    self.skipTest("original vehicle evidence not in clean repository")
                report = evaluate(file.read_bytes())
                self.assertFalse(report["bus_tx_authorized"])
                self.assertFalse(report["ecu_dtc_verified"])
                self.assertEqual(
                    [v["name"] for v in report["variants"]], ["26 A4", "26 0E"]
                )
                self.assertEqual(
                    [v["requested_slots"] for v in report["variants"]], [4, 14]
                )
                self.assertTrue(all(not v["can_send_on_car"] for v in report["variants"]))
                self.assertGreater(report["timing"]["late_us"], 0)

    def test_corrupted_evidence_fails_closed(self):
        report = evaluate(b"fake bytes do not qualify as ECU evidence")
        self.assertEqual(report["variants"], [])
        self.assertFalse(report["bus_tx_authorized"])


if __name__ == "__main__":
    unittest.main()
