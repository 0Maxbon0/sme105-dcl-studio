"""Witness parser must not accept fabricated/incomplete/USB-timestamp captures."""

from __future__ import annotations

import unittest
from pathlib import Path

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


def active_candidate_transcript(*, variant="26A4", stopped=0):
    """Native *synthetic* active prototype trace, not physical ECU evidence."""
    incoming = events(cycles=4, response=True, include_command=True, offset=10_000)
    if variant == "260E":
        incoming = [type(e)(e.complete_us, 0x0E if e.byte == 0xA4 else e.byte)
                    for e in incoming]
    timed = parse_timed_cart(incoming)
    words = ["01B0", "FF5F", variant, "00A0"]
    witnesses = []
    for frame, opcode in enumerate(words):
        start = round(timed.frame_sync_end_us[16 + frame] + SYNC_REARM_US + SLOT_US)
        witnesses.append(
            f"CART_TX start_us={start} end_us={round(start + 2 * BYTE_US)} "
            f"frame={frame} slot=1 opcode={opcode} uart_errors=0 cutoff=0 echo_verified=1"
        )
    lines = [
        "REF_TX frame=ECHO_ID n=11 cutoff=0",
        "ACK_CANDIDATE echo_11_plus_01 origin=UNVERIFIED",
        "REF_TX frame=GO_CART n=11 cutoff=0",
        f"CART_RUN mode=ACTIVE_CANDIDATE stopped={stopped}",
        (f"CART_CAPTURE n={len(incoming)} uart_errors=0 coalesced=0 "
         "dropped=0 capped=0 cutoff=0"),
        f"CART_B_STATE stage=3 reason=0 baseline=16 scheduled=4 echoed=4 variant={variant}",
        *witnesses,
        "CART_TIMEBASE source=UART2_RX_FIFO_ISR time=us latency_uncalibrated=1",
        *[f"CART_EVT t_us={e.complete_us} byte={e.byte:02X}" for e in incoming],
        (f"CART_END bytes={len(incoming)} uart_errors=0 dropped=0 "
         "cutoff=0 ecu_verified=0 dtc_verified=0"),
    ]
    return ("\n".join(lines) + "\n").encode()


class EvidenceParserTests(unittest.TestCase):
    def test_real_uart1_capture_preserves_one_partial_next_sync(self):
        path = (Path(__file__).resolve().parents[1] / "captures" / "TIMED_CART" /
                "20261102T194029616678Z-cart-isr.txt")
        if not path.exists():
            self.skipTest("real UART1 vehicle evidence absent from checkout")
        raw = path.read_bytes()
        result = analyze(raw)
        self.assertEqual(result["sha256"],
                         "c0bc2f6922525e13263ad4957581c85a799182dfdbfcaeb76ddb80a376779aeb")
        self.assertEqual(result["classification"],
                         "reference-compatible-direct-UART1-ID-only-no-DTC-command")
        self.assertEqual(result["frames"], 996)
        self.assertEqual(result["complete_16_id_cycles"], 62)
        self.assertEqual(result["device_timestamped_bytes"], 3985)
        self.assertEqual(result["trailing_next_header_bytes_preserved_in_original"], 1)
        margin = result["nominal_slot1_isr_margin_us"]
        self.assertEqual(margin["minimum"], 415)
        self.assertEqual(margin["maximum"], 418)
        self.assertEqual(margin["sample_count"], 252)
        self.assertFalse(margin["hardware_timer_firing_verified"])
        self.assertFalse(margin["physical_bus_phase_verified"])
        self.assertEqual(result["reference_dtc_candidates"], [])
        for key in ("physical_byte_timing_verified", "b_request_transmitted",
                    "is_ecu_source_authenticated", "is_dtc_read_verified"):
            self.assertFalse(result[key], key)
        for bad in (
            raw.replace(b"CART_EVT t_us=21528255 byte=00",
                        b"CART_EVT t_us=21528255 byte=FF", 1),
            raw.replace(b"CART_EVT t_us=21528255 byte=00",
                        b"CART_EVT t_us=21530255 byte=00", 1),
            raw.replace(b"CART_DIRECT_BASELINE valid=1 frames=996",
                        b"CART_DIRECT_BASELINE valid=1 frames=995", 1),
        ):
            self.assertEqual(analyze(bad)["classification"],
                             "incomplete-or-unvalidated-timing-or-response")

    def test_uart1_only_trims_timed_exact_next_header_prefix(self):
        good = native_transcript().replace(
            b"CART_TIMEBASE source=UART2_RX_ISR",
            b"CART_DIRECT_BASELINE valid=1 frames=48 cycles=3 prefix=0 phase=4 edge_verified=0 b_tx=0\n"
            b"CART_TIMEBASE source=UART1_RX_ISR",
        )
        incoming = events(cycles=3)
        next_start = round(incoming[-3].complete_us + 10000 - BYTE_US)
        tail = f"CART_EVT t_us={next_start} byte=00\n".encode()
        version = good.replace(b"CART_CAPTURE n=192", b"CART_CAPTURE n=193")
        version = version.replace(b"CART_END DTC_UNVERIFIED", tail + b"CART_END DTC_UNVERIFIED")
        self.assertEqual(analyze(version)["trailing_next_header_bytes_preserved_in_original"], 1)
        self.assertEqual(analyze(version)["frames"], 48)
        for invalid in (
            version.replace(tail, tail.replace(b"byte=00", b"byte=99")),
            version.replace(tail, tail.replace(str(next_start).encode(),
                                               str(next_start + 250).encode())),
            version.replace(tail, tail + tail),
        ):
            self.assertEqual(analyze(invalid)["classification"],
                             "incomplete-or-unvalidated-timing-or-response")

    def test_uart1_direct_is_separate_receive_only_capture_mode(self):
        native = native_transcript()
        raw = native.replace(
            b"CART_TIMEBASE source=UART2_RX_ISR",
            b"CART_DIRECT_BASELINE valid=1 frames=48 cycles=3 prefix=0 phase=4 edge_verified=0 b_tx=0\n"
            b"CART_TIMEBASE source=UART1_RX_ISR",
        )
        result = analyze(raw)
        self.assertEqual(result["classification"],
                         "reference-compatible-direct-UART1-ID-only-no-DTC-command")
        self.assertEqual(result["frames"], 48)
        self.assertFalse(result["physical_byte_timing_verified"])
        self.assertFalse(result["b_request_transmitted"])
        self.assertFalse(result["is_dtc_read_verified"])
        self.assertEqual(analyze(raw.replace(b"frames=48", b"frames=49", 1))["classification"],
                         "incomplete-or-unvalidated-timing-or-response")
        self.assertEqual(analyze(raw.replace(b"source=UART1_RX_ISR",
                                             b"source=UART2_RX_ISR", 1))["classification"],
                         "incomplete-or-unvalidated-timing-or-response")

    def test_real_v5_fifo_lag_transcript_is_legitimate_id_only_not_dtc(self):
        file_path = (Path(__file__).resolve().parents[1] / "captures" / "TIMED_CART" /
                     "20261102T184936186271Z-cart-isr.txt")
        if not file_path.exists():
            self.skipTest("live vehicle witness not shipped with clean repository")
        raw = file_path.read_bytes()
        result = analyze(raw)
        self.assertEqual(result["sha256"],
                         "8aacce685758676ed17338c5b28b747937598a36fcba1926fe8ac2855f760f9e")
        self.assertEqual(result["classification"],
                         "reference-compatible-id-only-CART-observation-no-DTC-command")
        self.assertEqual(result["frames"], 970)
        self.assertEqual(result["complete_16_id_cycles"], 60)
        self.assertEqual(result["device_timestamped_bytes"], 3985)
        for claim in ("is_ecu_source_authenticated", "is_dtc_read_verified",
                      "physical_byte_timing_verified", "b_request_transmitted"):
            self.assertFalse(result[claim], claim)
        self.assertEqual(result["reference_dtc_candidates"], [])
        tampered = raw.replace(b"CART_LAG_BASELINE valid=1 frames=970",
                               b"CART_LAG_BASELINE valid=1 frames=971", 1)
        self.assertEqual(analyze(tampered)["classification"],
                         "incomplete-or-unvalidated-timing-or-response")
        # Native capture health and exact witness values, not only the
        # booleans, are required before the forensic classification.
        self.assertEqual(analyze(raw.replace(b" uart_errors=0 coalesced=0",
                                             b" uart_errors=1 coalesced=0", 1))["classification"],
                         "incomplete-or-unvalidated-timing-or-response")

    def test_active_candidate_four_word_native_trace_remains_unverified(self):
        for variant in ("26A4", "260E"):
            with self.subTest(variant=variant):
                result = analyze(active_candidate_transcript(variant=variant))
                self.assertEqual(result["classification"],
                                 "reference-compatible-unverified-DTC-candidates")
                self.assertEqual(result["command_variant"].replace(" ", ""), variant)
                self.assertEqual([c["code_text"] for c in result["reference_dtc_candidates"]],
                                 ["116", "538"])
                self.assertFalse(result["is_ecu_source_authenticated"])
                self.assertFalse(result["is_dtc_read_verified"])

    def test_active_candidate_fails_closed_for_partial_corrupt_or_mixed_trace(self):
        good = active_candidate_transcript()
        invalid = (
            active_candidate_transcript(stopped=1),
            good.replace(b"REF_TX frame=ECHO_ID n=11 cutoff=0\n", b"", 1),
            good.replace(b"ACK_CANDIDATE echo_11_plus_01", b"ACK_CANDIDATE echo_11_plus_02", 1),
            good.replace(b"REF_TX frame=GO_CART n=11", b"REF_TX frame=GO_CART n=10", 1),
            good.replace(b"REF_TX frame=ECHO_ID", b"REF_TX frame=GO_CART", 1),
            good.replace(b"stage=3", b"stage=4", 1),
            good.replace(b"echoed=4", b"echoed=3", 1),
            good.replace(b"scheduled=4", b"scheduled=3", 1),
            good.replace(b"variant=26A4", b"variant=260E", 1),
            good.replace(b"frame=0 slot=1", b"frame=1 slot=1", 1),
            good.replace(b"echo_verified=1", b"echo_verified=0", 1),
            good.replace(b"CART_TX start_us=", b"CART_TX_ATTEMPT start_us=", 1),
            good.replace(b" uart_errors=0 coalesced=0", b" uart_errors=1 coalesced=0", 1),
            good.replace(b"dropped=0 capped=0", b"dropped=1 capped=0", 1),
            good.replace(b"cutoff=0 ecu_verified=0", b"cutoff=1 ecu_verified=0", 1),
            good.replace(b" ecu_verified=0 dtc_verified=0", b" ecu_verified=1 dtc_verified=1", 1),
            good.replace(b"CART_TIMEBASE source=UART2_RX_FIFO_ISR", b"CART_TIMEBASE source=USB"),
            good.replace(b"opcode=FF5F", b"opcode=FF50", 1),
            good.replace(b"frame=3 slot=1", b"frame=2 slot=1", 1),
            good.replace(b"CART_TX start_us=", b"REF_TX start_us=", 1),
            good.replace(b"CART_EVT t_us=", b"CART_EVT t_ms=", 1),
            good.replace(b"CART_END bytes=", b"CART_END bytes=0\nCART_END bytes=", 1),
            good + b"junk\n",
        )
        for raw in invalid:
            with self.subTest(reason=raw[:130]):
                self.assertEqual(analyze(raw)["classification"],
                                 "incomplete-or-unvalidated-timing-or-response")

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
