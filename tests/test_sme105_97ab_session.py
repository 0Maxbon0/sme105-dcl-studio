"""Bounded host protocol and same-pin reader source invariants."""

from __future__ import annotations

import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import sme105_97ab_session as reader
from scripts.analyze_timed_dtc import analyze
from tests.test_analyze_timed_dtc import active_candidate_transcript

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "firmware" / "sme105_97ab_dcl_reader" /
          "sme105_97ab_dcl_reader.ino")


class HostAndSourceTests(unittest.TestCase):
    def test_status_requires_one_exact_clean_complete_line(self):
        good = (b"STATUS SME105_97AB_READER_V1 ecu=97AB-12A650-KA DE=LOW "
                b"auto_tx=0 attempt_used=0 timers=2 gate4=1\r\n")
        self.assertEqual(reader.STATUS.fullmatch(good)[1], b"0")
        for bad in (
            good[:-2], b"noise" + good, good + good,
            good.replace(b"gate4=1", b"gate4=0"),
            good.replace(b"DE=LOW", b"DE=HIGH"),
            good.replace(b"auto_tx=0", b"auto_tx=1"),
            good.replace(b"attempt_used=0", b"attempt_used=3"),
        ):
            with self.subTest(bad=bad[:25]):
                self.assertIsNone(reader.STATUS.fullmatch(bad))

    def test_timed_ack_for_new_uart1_releases_provisional_codes_only(self):
        raw = active_candidate_transcript()
        raw = raw.replace(
            b"ACK_CANDIDATE echo_11_plus_01 origin=UNVERIFIED",
            b"REF_ACK count=12 raw=00 00 00 00 00 01 82 00 00 00 83 01 "
            b"uart_errors=0\nACK_CANDIDATE echo_11_plus_01 origin=UNVERIFIED",
        )
        raw = raw.replace(b"source=UART2_RX_FIFO_ISR", b"source=UART1_RX_FIFO_ISR")
        result = analyze(raw)
        self.assertEqual(result["classification"],
                         "reference-compatible-unverified-DTC-candidates")
        self.assertFalse(result["is_dtc_read_verified"])
        self.assertEqual(
            analyze(raw.replace(
                b"REF_ACK count=12 raw=00 00 00 00 00 01 82 00 00 00 83 01 uart_errors=0\n",
                b"",
            ))["classification"],
            "incomplete-or-unvalidated-timing-or-response",
        )
        for bad in (b"uart_errors=1", b"00 00 00 00 00 01 82 00 00 00 83 02"):
            with self.subTest(bad=bad):
                damaged = raw.replace(b"uart_errors=0" if bad == b"uart_errors=1" else
                                      b"00 00 00 00 00 01 82 00 00 00 83 01",
                                      bad, 1)
                self.assertEqual(analyze(damaged)["classification"],
                                 "incomplete-or-unvalidated-timing-or-response")

    def test_passive_cart_after_handshake_accepts_only_full_sane_capture(self):
        active = active_candidate_transcript()
        raw = active.replace(
            b"ACK_CANDIDATE echo_11_plus_01 origin=UNVERIFIED",
            b"REF_ACK count=12 raw=00 00 00 00 00 01 82 00 00 00 83 01 "
            b"uart_errors=0\nACK_CANDIDATE echo_11_plus_01 origin=UNVERIFIED",
        )
        raw = raw.replace(b"source=UART2_RX_FIFO_ISR", b"source=UART1_RX_FIFO_ISR")
        raw = raw.replace(b"CART_RUN mode=ACTIVE_CANDIDATE",
                          b"CART_RUN mode=PASSIVE_AFTER_HANDSHAKE")
        raw = b"\n".join(
            line for line in raw.split(b"\n")
            if not line.startswith((b"CART_TX ", b"CART_B_STATE "))
        )
        # The synthetic request-cycle local echo cannot appear in a truly
        # receive-only CART capture. Use proper 4-byte, ID-only cycles.
        from tests.test_cart_timed_dtc import events
        timeline = events(cycles=3, offset=10_000)
        event_lines = b"\n".join(
            f"CART_EVT t_us={e.complete_us} byte={e.byte:02X}".encode()
            for e in timeline
        )
        capture = raw.replace(
            b"CART_CAPTURE n=316", b"CART_CAPTURE n=192"
        )
        capture = capture.replace(
            b"\n".join(line for line in capture.split(b"\n")
                       if line.startswith(b"CART_EVT ")),
            event_lines,
        )
        capture = capture.replace(b"CART_END bytes=316", b"CART_END bytes=192")
        result = analyze(capture)
        self.assertEqual(result["classification"], "timed-cart-observation-no-DTC-command")
        self.assertEqual(result["reference_dtc_candidates"], [])
        self.assertEqual(
            analyze(capture.replace(b"mode=PASSIVE_AFTER_HANDSHAKE",
                                    b"mode=ACTIVE_CANDIDATE"))["classification"],
            "incomplete-or-unvalidated-timing-or-response",
        )

    def test_current_gpio_and_exclusivity(self):
        code = SOURCE.read_text()
        self.assertIn("UART_NUM_1, UART_PIN_NO_CHANGE, kRx", code)
        self.assertIn("UART_NUM_2, kTx, UART_PIN_NO_CHANGE", code)
        self.assertIn("RMT_SIG_OUT2_IDX + request.completed", code)
        self.assertIn("rmtChannelsReady != 4", code)
        self.assertIn("oneShotConsumed = true;", code)
        self.assertIn("void deskMaxOnce()", code)
        self.assertIn("READ_DTC_A4_ONCE", code)
        self.assertIn("READ_DTC_0E_ONCE", code)
        self.assertNotIn("SME105_ACTIVE_B_TX=1", code)
        for unsafe in ("CLEAR_DTC_ONCE", "KOER_ONCE", "RAW_WRITE", "AUTO_RETRY"):
            self.assertNotIn(unsafe, code)

    def test_desk_verifier_requires_all_four_native_words(self):
        rows = [
            reader.DESK_BEGIN,
            *(
                f"DESK_WORD index={i} expected={word.decode()} rx_count=2 "
                f"tx_done=1 delta_us=2088 match=1".encode()
                for i, word in enumerate(reader.DESK_SAMPLES)
            ),
            reader.DESK_END,
        ]
        good = b"\r\n".join(rows) + b"\r\n"
        self.assertTrue(reader.verify_desk(good))
        for bad in (
            good.replace(b"expected=55AA", b"expected=26A4", 1),
            good.replace(b"index=2", b"index=1", 1),
            good.replace(b"delta_us=2088", b"delta_us=2288", 1),
            good.replace(b"match=1", b"match=0", 1),
            good.replace(b"coalesced=0", b"coalesced=1", 1),
            good + b"extra\n",
            good.replace(b" rx_count=2", b" rx_count=1", 1),
        ):
            with self.subTest(bad=bad[:26]):
                if bad != good:
                    self.assertFalse(reader.verify_desk(bad))

    def test_command_selection_never_auto_retries(self):
        self.assertEqual(reader.COMMANDS["dtc-a4"], b"READ_DTC_A4_ONCE\n")
        self.assertEqual(reader.COMMANDS["dtc-0e"], b"READ_DTC_0E_ONCE\n")
        self.assertTrue(reader.VEHICLE.issubset(reader.EXPLICIT))
        with patch.object(reader, "read_record", return_value=b"wrong\n"):
            class DummyPort:
                def reset_input_buffer(self):
                    pass

                def write(self, _: bytes):
                    return 7

                def flush(self):
                    pass

            with self.assertRaisesRegex(RuntimeError, "incorrect/noisy"):
                reader.quiet_status(DummyPort())


if __name__ == "__main__":
    unittest.main()
