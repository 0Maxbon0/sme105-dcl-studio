"""Bench firmware cannot accidentally transmit to the vehicle."""

import unittest
from pathlib import Path

from scripts.sme105_uart_edge_bench import IDENTITY, PINS


class UsbOnlyBenchTests(unittest.TestCase):
    def test_dedicated_identity_rejects_vehicle_v5_and_used_state(self):
        good = b"STATUS SME105_UART_EDGE_BENCH_V2 DE=LOW ECU_TX=DISABLED used=0"
        self.assertIsNotNone(IDENTITY.fullmatch(good))
        for bad in (
            good.replace(b"BENCH_V2", b"BENCH_V3"),
            good.replace(b"DE=LOW", b"DE=HIGH"),
            good.replace(b"ECU_TX=DISABLED", b"ECU_TX=ENABLED"),
            b"STATUS SME105_DTC_ONE_SHOT_V5 DE=LOW B_TX=COMPILE_LOCKED used=0",
        ):
            self.assertIsNone(IDENTITY.fullmatch(bad))
        self.assertEqual(IDENTITY.fullmatch(good.replace(b"used=0", b"used=1"))[1], b"1")

    def test_pin_check_requires_all_idle_high(self):
        pin_line = b"PIN_CHECK tx17=1 rx16=1 trace19=1 ready=1 DE=LOW no_test_bytes=1"
        self.assertIsNotNone(PINS.fullmatch(pin_line))
        for bad in (
            pin_line.replace(b"rx16=1", b"rx16=0"),
            pin_line.replace(b"trace19=1", b"trace19=0"),
            pin_line.replace(b"DE=LOW", b"DE=HIGH"),
            pin_line.replace(b"no_test_bytes=1", b"no_test_bytes=0"),
        ):
            if b"rx16=0" in bad or b"trace19=0" in bad:
                self.assertIsNotNone(PINS.fullmatch(bad))
            else:
                self.assertIsNone(PINS.fullmatch(bad))

    def test_bench_contains_no_vehicle_commands_or_de_high(self):
        fw = (Path(__file__).resolve().parents[1] / "firmware" /
              "sme105_uart_edge_bench" / "sme105_uart_edge_bench.ino").read_text()
        self.assertIn("BENCH_GPIO_ONCE", fw)
        self.assertIn("PIN_CHECK", fw)
        self.assertIn("digitalWrite(kDe, LOW)", fw)
        self.assertIn("GPIO17", fw)
        self.assertIn("kMaxRx", fw)
        for forbidden in (
            "digitalWrite(kDe, HIGH)",
            "GPIO.out_w1ts",
            "gpio_set_level(kDe, 1)",
            "GO_CART", "ECHO_ID", "READ_B_ONCE", "26A4", "260E",
            "SME105_ACTIVE_B_TX", "BENCH_B_A4_ONCE", "BENCH_B_0E_ONCE",
        ):
            self.assertNotIn(forbidden, fw)


if __name__ == "__main__":
    unittest.main()
