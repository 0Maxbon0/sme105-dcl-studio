"""UART1 experiment keeps an exact source identity and no active B authority."""

import unittest
from pathlib import Path

from scripts import sme105_uart1_session as host


class Uart1CaptureTests(unittest.TestCase):
    def test_exact_firmware_usb_identity_is_distinct_from_v5(self):
        good = b"STATUS SME105_UART1_CAPTURE_V1 DE=LOW B_TX=COMPILE_LOCKED used=0 deadline_timer=1\r\n"
        self.assertIsNotNone(host.IDENTITY.fullmatch(good))
        self.assertIsNone(host.IDENTITY.fullmatch(good.replace(b"UART1_CAPTURE_V1", b"DTC_ONE_SHOT_V5")))
        self.assertIsNone(host.IDENTITY.fullmatch(good.replace(b"B_TX=COMPILE_LOCKED", b"B_TX=OPEN")))

    def test_firmware_uses_uart1_only_for_receive_and_b_is_compiled_out(self):
        code = (Path(__file__).resolve().parents[1] / "firmware" /
                "sme105_dtc_uart1_capture" / "sme105_dtc_uart1_capture.ino").read_text()
        self.assertIn("HardwareSerial dcl(2)", code)  # original 2400 reference handshake
        self.assertIn("uart_param_config(UART_NUM_1", code)
        self.assertIn("esp_intr_alloc(ETS_UART1_INTR_SOURCE", code)
        self.assertIn("UART1.conf1.rxfifo_full_thrhd = 1", code)
        self.assertIn("CART_DIRECT_BASELINE", code)
        self.assertIn("#if SME105_ENABLE_CART_B_TX != 0", code)
        self.assertIn('#error "No safe B transmitter:', code)
        self.assertNotIn("UART2.int_ena", code)


if __name__ == "__main__":
    unittest.main()
