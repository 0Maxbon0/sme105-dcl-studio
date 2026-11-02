"""Fail closed if a device-authored timer report disagrees with raw CART IDs."""

import unittest
from pathlib import Path

from scripts.verify_sme105_dry_run import verify


class IndependentTimerProofTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        file = (Path(__file__).resolve().parents[1] / "captures" / "TIMED_CART" /
                "20261102T195544822297Z-cart-isr.txt")
        cls.raw = file.read_bytes() if file.exists() else None

    def test_real_20261102_timer_witness_matches_each_captured_header(self):
        if self.raw is None:
            self.skipTest("actual field capture not available in checkout")
        result = verify(self.raw)
        self.assertEqual(result["sha256"],
                         "6d1f4ec0fec0d34acc4fe75832bc172bc59f4f96f9188adbbe4fbd16bb3e8cd5")
        self.assertEqual(result["result"], "PASS_TIMER_ONLY")
        self.assertEqual(result["all_four_timer_error_us"], [3, 4, 3, 4])
        self.assertEqual(result["available_header_lead_us"], [417] * 4)
        self.assertEqual(result["frames"], 32)
        for field in ("physical_bus_timing_verified", "ecu_source_authenticated",
                      "stored_dtc_read_verified", "b_transmission_occurred"):
            self.assertFalse(result[field])

    def test_corruption_and_fake_success_never_validate(self):
        if self.raw is None:
            self.skipTest("actual field capture not available in checkout")
        original = self.raw
        for corrupt in (
            original.replace(b"target_us=11641566", b"target_us=11641568", 1),
            original.replace(b"fired_us=11651570", b"fired_us=11651800", 1),
            original.replace(b"frame=2 slot=1", b"frame=1 slot=1", 1),
            original.replace(b"stage=COMPLETE", b"stage=FAILED", 1),
            original.replace(b"scheduled=4", b"scheduled=3", 1),
            original.replace(b"fired=4", b"fired=3", 1),
            original.replace(b"tx_bytes=0", b"tx_bytes=2", 1),
            original.replace(b"source=UART1_RX_ISR", b"source=UART2_RX_ISR", 1),
            original.replace(b"REF_TX frame=GO_CART", b"REF_TX frame=READ_B", 1),
            original.replace(b"CART_CAPTURE n=128", b"CART_CAPTURE n=127", 1),
            original.replace(b"CART_DIRECT_BASELINE valid=1 frames=32",
                             b"CART_DIRECT_BASELINE valid=1 frames=31", 1),
            original.replace(b"CART_EVT t_us=11638649 byte=00",
                             b"CART_EVT t_us=11638699 byte=00", 1),
            original + b"CART_B_SLOT frame=0 slot=1 opcode=01B0 "
                       b"target_us=1 fired_us=1 dry_run=1 tx_bytes=0\n",
        ):
            with self.subTest(corrupt=corrupt[-170:]):
                report = verify(corrupt)
                self.assertEqual(report["result"], "FAIL")
                self.assertFalse(report["timer_only_witness_verified"])

    def test_random_bytes_fail_closed(self):
        self.assertEqual(verify(b"fake")["result"], "FAIL")


if __name__ == "__main__":
    unittest.main()
