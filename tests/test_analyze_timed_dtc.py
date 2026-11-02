"""Witness parser must not accept fabricated/incomplete/USB-timestamp captures."""

from __future__ import annotations

import unittest

from ford_dcl.cart_reference import CartReferenceError
from ford_dcl.cart_timed import BYTE_US, SLOT_US, SYNC_REARM_US, parse_timed_cart
from scripts.analyze_timed_dtc import analyze, parse_evidence
from tests.test_cart_timed_dtc import events


def transcript(response=True, *, tx=True, count_offset=0):
    incoming = events(cycles=4, response=response,
                      include_command=response and tx, offset=10_000)
    lines = [f"CART_EVT t_us={e.complete_us} byte={e.byte:02X}" for e in incoming]
    if tx:
        timed = parse_timed_cart(incoming)
        start = round(timed.frame_sync_end_us[18] + SYNC_REARM_US + SLOT_US)
        end = round(start + 2 * BYTE_US)
        lines.append(
            f"CART_TX start_us={start} end_us={end} "
            "frame=2 slot=1 opcode=26A4 uart_errors=0 cutoff=0"
        )
    lines.append(f"CART_END bytes={len(incoming) + count_offset} uart_errors=0 dropped=0")
    return ("\n".join(lines) + "\n").encode()


def native_transcript(*, coalesced=0, prefix_frames=0):
    incoming = events(cycles=3)
    if prefix_frames:
        incoming = incoming[prefix_frames * 4:]
    lines = [
        "CART_BEGIN recorded_9600_8N1 RX_ISR duration_ms_max=10000 B_TX=OFF",
        (
            f"CART_CAPTURE n={len(incoming)} uart_errors=0 coalesced={coalesced} "
            "overflow=0 cutoff=0 capped=0"
        ),
        "CART_BASELINE id_only_cycles=1 id_only_frames=16 header_phase_bits=4 validated=0",
        "CART_TIMEBASE source=UART2_RX_ISR unit=us event=FIFO_interrupt_after_stop_bit",
        *[f"CART_EVT t_us={e.complete_us} byte={e.byte:02X}" for e in incoming],
        "CART_END DTC_UNVERIFIED B_TX_LOCKED",
    ]
    return ("\n".join(lines) + "\n").encode()


class EvidenceParserTests(unittest.TestCase):
    def test_reference_candidates_preserve_unverified_label(self):
        result = analyze(transcript())
        self.assertEqual(result["classification"],
                         "reference-compatible-unverified-DTC-candidates")
        self.assertEqual([c["code_text"] for c in result["reference_dtc_candidates"]],
                         ["116", "538"])
        self.assertFalse(result["is_ecu_source_authenticated"])
        self.assertFalse(result["is_dtc_read_verified"])

    def test_passive_data_cannot_prove_dtc(self):
        result = analyze(transcript(tx=False))
        self.assertEqual(result["classification"], "timed-cart-observation-no-DTC-command")
        self.assertFalse(result["reference_dtc_candidates"])

    def test_native_isr_capture_and_nonzero_phase_alignment(self):
        result = analyze(native_transcript(prefix_frames=5))
        self.assertEqual(result["classification"], "timed-cart-observation-no-DTC-command")
        self.assertEqual(result["initial_unaligned_bytes_preserved_in_original"], 11 * 4)
        self.assertFalse(result["is_dtc_read_verified"])
        self.assertEqual(result["physical_header_gap_bits_model"], 4)

    def test_native_coalesced_fifo_and_wrong_end_fail_closed(self):
        for raw in (
            native_transcript(coalesced=1),
            native_transcript().replace(b"capped=0", b"capped=1"),
            native_transcript().replace(b"B_TX_LOCKED", b"B_TX_ENABLED"),
            native_transcript() + b"trailing garbage\n",
        ):
            self.assertEqual(analyze(raw)["classification"],
                             "incomplete-or-unvalidated-timing-or-response")

    def test_error_or_missing_end_always_incomplete(self):
        good = transcript()
        for raw in (
            good.replace(b"dropped=0", b"dropped=1"),
            good.replace(b"uart_errors=0 dropped=0", b"uart_errors=1 dropped=0"),
            good.replace(b"CART_END bytes=", b"WRONG_END bytes="),
            good.replace(b"CART_END bytes=", b"CART_END bytes=0\nCART_END bytes="),
            transcript(count_offset=1),
            good.replace(b"CART_EVT t_us=", b"CART_EVT t_ms=", 1),
            good + b"UNEXPECTED_TRAILING_DATA\n",
            good.replace(b"CART_EVT t_us=", b"USB_CORRUPTION\nCART_EVT t_us=", 1),
        ):
            with self.subTest(raw=raw[-85:]):
                self.assertEqual(analyze(raw)["classification"],
                                 "incomplete-or-unvalidated-timing-or-response")

    def test_conflicting_command_and_duplicate_witness_rejected(self):
        bad = transcript().replace(b"opcode=26A4", b"opcode=0291")
        self.assertEqual(analyze(bad)["classification"],
                         "incomplete-or-unvalidated-timing-or-response")
        second = b"CART_TX start_us=500 end_us=2700 frame=2 slot=1 opcode=260E uart_errors=0 cutoff=0\n"
        with self.assertRaisesRegex(CartReferenceError, "trailing"):
            parse_evidence(transcript() + second)

    def test_parse_reports_count(self):
        captured, witness = parse_evidence(transcript())
        self.assertEqual(len(captured), 4 * 16 * 4 + 2 * (12 * 2) + 4 + 8)
        self.assertEqual(witness.opcode, b"\x26\xa4")


if __name__ == "__main__":
    unittest.main()
