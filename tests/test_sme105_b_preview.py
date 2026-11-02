"""Dual-choice preview controls must remain inert (source safety gate)."""

import unittest
from pathlib import Path

from ford_dcl.cart_reference import parity_byte

ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = (ROOT / "firmware" / "sme105_dtc_active_candidate" /
            "sme105_dtc_active_candidate.ino")
MODEL = ROOT / "firmware" / "sme105_dtc_active_candidate" / "cart_b_active_model.h"


class CandidateControlsTests(unittest.TestCase):
    def test_parity_and_full_request_words(self):
        self.assertEqual(parity_byte(0x01, 0), 0xB0)
        self.assertEqual(parity_byte(0xFF, 15), 0x5F)
        self.assertEqual(parity_byte(0x26, 4), 0xA4)
        self.assertEqual(parity_byte(0x26, 14), 0x0E)
        self.assertEqual(parity_byte(0x00, 0), 0xA0)
        model = MODEL.read_text()
        self.assertIn("Word{0x26, 0xA4}", model)
        self.assertIn("Word{0x26, 0x0E}", model)

    def test_preview_never_queues_uart_or_asserts_de(self):
        firmware = FIRMWARE.read_text()
        self.assertIn('#error "Active B build forbidden', firmware)
        preview = firmware.split("void previewB(", 1)[1].split("void command()", 1)[0]
        self.assertIn("driverOff();", preview)
        self.assertIn("PREVIEW_B_A4", firmware)
        self.assertIn("PREVIEW_B_0E", firmware)
        self.assertIn("next_block_response_slot_limit=", preview)
        for forbidden in (
            "gpio_set_level(kDe, 1)", "GPIO.out_w1ts", "UART2.fifo.rw_byte",
            "transmitReference(", "attempt(",
        ):
            self.assertNotIn(forbidden, preview)
        self.assertIn("DENIED COMPILE_LOCK", firmware)


if __name__ == "__main__":
    unittest.main()
