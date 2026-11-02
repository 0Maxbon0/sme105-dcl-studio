"""UART1 experiment keeps an exact source identity and no active B authority."""

import unittest
from pathlib import Path

from scripts import sme105_uart1_session as host


class FakePort:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.sent: list[bytes] = []

    def write(self, payload: bytes) -> int:
        self.sent.append(payload)
        return len(payload)

    def flush(self) -> None:
        pass

    def read(self, n: int) -> bytes:
        result, self.data = self.data[:n], self.data[n:]
        return result


class Uart1CaptureTests(unittest.TestCase):
    def test_actual_ack_overflow_evidence_reports_precise_reason_no_retry(self):
        file = (Path(__file__).resolve().parents[1] / "captures" / "TIMED_CART" /
                "20261102T194847373892Z-cart-isr.txt")
        if not file.exists():
            self.skipTest("field ACK overflow evidence absent in checkout")
        raw = file.read_bytes()
        self.assertEqual(len(raw), 107)
        port = FakePort(raw)
        with self.assertRaisesRegex(host.CaptureIncomplete, "ACK overflow") as caught:
            host.capture(port, action="PLAN_B_ONCE", deadline_seconds=1)
        self.assertEqual(caught.exception.raw, raw)
        self.assertEqual(port.sent, [b"PLAN_B_ONCE\n"])
        self.assertNotIn(b"GO_CART", raw)

    def test_prehandshake_busy_reason_retains_forensic_evidence(self):
        raw = (b"PREHANDSHAKE_BUSY rx_bytes=2 uart_errors=0 rx_idle_high=1 "
               b"first=00 8A DE=LOW no_reference_tx=1\r\n"
               b"CART_ABORT prehandshake_busy TX_LOCKED\r\n")
        port = FakePort(raw)
        with self.assertRaisesRegex(host.CaptureIncomplete, "before Echo-ID") as caught:
            host.capture(port, action="PLAN_B_ONCE", deadline_seconds=1)
        self.assertEqual(caught.exception.raw, raw)
        self.assertEqual(port.sent, [b"PLAN_B_ONCE\n"])

    def test_uart1_reference_preflight_and_b_lock_are_source_enforced(self):
        code = (Path(__file__).resolve().parents[1] / "firmware" /
                "sme105_dtc_uart1_capture" / "sme105_dtc_uart1_capture.ino").read_text()
        self.assertIn("bool observeQuiet2400()", code)
        self.assertIn("PREHANDSHAKE_BUSY rx_bytes=", code)
        self.assertIn("ACK_FORENSIC count_at_least=", code)
        self.assertIn("ACK_REJECT overflow", code)
        self.assertIn("if (!observeQuiet2400())", code)
        self.assertIn("CART_ABORT prehandshake_busy TX_LOCKED", code)
        self.assertIn("SME105_ENABLE_CART_B_TX != 0", code)
        self.assertNotIn("GPIO.out_w1ts", code)

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
        self.assertIn("planSlotIsr()", code)
        self.assertIn("PLAN_B_ONCE", code)
        plan_only = code.split("void IRAM_ATTR planSlotIsr()", 1)[1].split("// IDF4.4", 1)[0]
        self.assertIn("bPlan.onTimer(nowUs)", plan_only)
        self.assertNotIn("gpio_set_level(kDe, 1)", plan_only)
        self.assertNotIn("UART1.fifo.rw_byte =", plan_only)

    def test_uart1_dry_run_host_can_report_timer_only_result(self):
        direct = (
            b"CART_B_PLAN stage=COMPLETE reason=0 baseline_frames=16 "
            b"command_frames=16 phase_bits=4 scheduled=4 fired=4 "
            b"mode=DRY_RUN tx_bytes=0 ecu_verified=0\n"
            b"CART_DIRECT_BASELINE valid=1 frames=32 cycles=2 prefix=0 phase=4 "
            b"edge_verified=0 b_tx=0\n"
        )
        slot_us = [(0, "01B0", 100000), (1, "FF5F", 110000),
                   (2, "26A4", 120000), (3, "00A0", 130000)]
        for frame, opcode, at_us in slot_us:
            direct += (f"CART_B_SLOT frame={frame} slot=1 opcode={opcode} "
                       f"target_us={at_us} fired_us={at_us} dry_run=1 tx_bytes=0\n").encode()
        ok, msg = host.inspect_dry_run(direct)
        self.assertTrue(ok, msg)
        self.assertIn("B was NOT transmitted", msg)
        self.assertIn("Direct UART1 ISR timestamps", host.inspect_direct_id_baseline(direct))


if __name__ == "__main__":
    unittest.main()
