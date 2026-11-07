"""Self-contained synthetic tests of the inert CART reference model."""

from __future__ import annotations

import math
import unittest

from ford_dcl.cart_reference import (
    REFERENCE_TIMING,
    CandidateResponseObservation,
    CartReferenceError,
    ReadOnlyCandidatePlan,
    inspect_candidate_response,
    parity_byte,
    parse_cart_id_stream,
    parse_segmented_cart_frames,
    plan_read_only_candidate,
)


def frame(index: int, *, status: int = 0, slots: tuple[bytes, ...] = ()) -> bytes:
    frame_id = index % 16
    return b"\x00\x00" + bytes((status, parity_byte(status, frame_id))) + b"".join(slots)


def cycle(*, slots: tuple[bytes, ...] = ()) -> tuple[bytes, ...]:
    return tuple(frame(index, slots=slots) for index in range(16))


def baseline():
    return parse_cart_id_stream(b"".join(cycle()))


class CartReferenceParserTests(unittest.TestCase):
    def test_reference_cycle_uses_exact_16_id_order_and_vertical_parity(self):
        parsed = baseline()
        self.assertEqual(parsed.full_cycles, 1)
        self.assertEqual(parsed.trailing_frames, 0)
        self.assertEqual([f.frame_id for f in parsed.frames], list(range(16)))
        self.assertEqual(parsed.frames[0].parity_id_byte, 0xA0)
        self.assertEqual(parsed.frames[-1].parity_id_byte, 0x5F)
        self.assertFalse(parsed.ecu_source_verified)
        self.assertFalse(parsed.physical_edge_timing_checked)
        self.assertEqual(parsed.raw_slot_word_count, 0)

    def test_multiple_cycles_and_trailing_id_frames_are_explicit(self):
        parsed = parse_cart_id_stream(b"".join(cycle() + cycle() + cycle()[:4]))
        self.assertEqual(parsed.full_cycles, 2)
        self.assertEqual(parsed.trailing_frames, 4)

    def test_nonzero_status_can_be_parity_valid_without_decoded_meaning(self):
        words = tuple(frame(index, status=0x18) for index in range(16))
        parsed = parse_cart_id_stream(b"".join(words))
        self.assertEqual({f.status_byte for f in parsed.frames}, {0x18})
        self.assertFalse(parsed.ecu_source_verified)

    def test_sync_corruption_is_rejected_without_resynchronizing(self):
        data = bytearray(b"".join(cycle()))
        data[17] = 0x01
        with self.assertRaisesRegex(CartReferenceError, "sync"):
            parse_cart_id_stream(bytes(data))

    def test_id_parity_corruption_and_header_status_corruption_are_rejected(self):
        for bad_offset in (3, 2):
            with self.subTest(offset=bad_offset):
                data = bytearray(b"".join(cycle()))
                data[bad_offset] ^= 0x10
                with self.assertRaisesRegex(CartReferenceError, "parity"):
                    parse_cart_id_stream(bytes(data))

    def test_missing_or_duplicate_frame_is_rejected(self):
        records = list(cycle())
        for damaged in (records[:6] + records[7:], records[:7] + [records[6]] + records[7:]):
            with self.subTest(damaged=damaged[:3]), self.assertRaisesRegex(
                CartReferenceError, "duplicate, lost or out-of-order"
            ):
                parse_cart_id_stream(b"".join(damaged))

    def test_partial_id_word_or_payload_is_not_silently_discarded(self):
        for payload in (b"", b"\x00\x00", b"".join(cycle()) + b"\x00"):
            with self.subTest(payload=payload), self.assertRaisesRegex(
                CartReferenceError, "incomplete"
            ):
                parse_cart_id_stream(payload)

    def test_explicit_frame_segmentation_preserves_validated_raw_slot_pairs(self):
        slot = bytes((0x18, parity_byte(0x18, 1)))
        parsed = parse_segmented_cart_frames(cycle(slots=(slot,)))
        self.assertEqual(parsed.raw_slot_word_count, 16)
        self.assertEqual(parsed.frames[0].slot_words, (slot,))
        self.assertFalse(parsed.ecu_source_verified)

    def test_corrupted_or_truncated_slot_word_is_rejected(self):
        good = bytes((0x18, parity_byte(0x18, 1)))
        for extra, expected in ((good[:1], "incomplete"), (bytes((0x18, good[1] ^ 0x10)), "parity")):
            damaged = list(cycle())
            damaged[7] += extra
            with self.subTest(extra=extra), self.assertRaisesRegex(CartReferenceError, expected):
                parse_segmented_cart_frames(damaged)

    def test_unsegmented_slot_stream_is_not_mistaken_for_id_quartets(self):
        slot = bytes((0x18, parity_byte(0x18, 1)))
        raw = b"".join(cycle(slots=(slot,)))
        with self.assertRaises(CartReferenceError):
            parse_cart_id_stream(raw)

    def test_physical_frame_timestamp_gap_duplicate_and_mismatch_fail_closed(self):
        good_stamps = [float(index * 10) for index in range(16)]
        parsed = parse_cart_id_stream(b"".join(cycle()), frame_edge_times_ms=good_stamps)
        self.assertTrue(parsed.physical_edge_timing_checked)
        bad_stamp_sets = [
            good_stamps[:8] + [good_stamps[7]] + good_stamps[9:],
            good_stamps[:8] + [good_stamps[8] + 30] + good_stamps[9:],
            good_stamps[:15],
            good_stamps[:8] + [math.nan] + good_stamps[9:],
            good_stamps[:8] + [-1] + good_stamps[9:],
        ]
        for stamps in bad_stamp_sets:
            with self.subTest(stamps=stamps), self.assertRaises(CartReferenceError):
                parse_cart_id_stream(b"".join(cycle()), frame_edge_times_ms=stamps)

    def test_timer_constants_are_reference_assumptions_not_bus_proof(self):
        self.assertEqual(REFERENCE_TIMING.baud, 9600)
        self.assertEqual(REFERENCE_TIMING.data_bits, 8)
        self.assertEqual(REFERENCE_TIMING.stop_bits, 1)
        self.assertEqual(REFERENCE_TIMING.uart_parity, "none")
        self.assertAlmostEqual(REFERENCE_TIMING.timer_slot_ms, 2.5)
        self.assertAlmostEqual(REFERENCE_TIMING.sync_rearm_ms, 4 / 9600 * 1000)
        self.assertEqual(REFERENCE_TIMING.initial_slot_count, 2)
        self.assertEqual(REFERENCE_TIMING.lost_sync_reset_after_slot, 30)

    def test_extended_14_slot_cart_response_can_have_40ms_frame_cadence(self):
        # B=26 0E reserves 14 slots; do not use idle-only 25ms gap for
        # payload-mode frame clocks (physical timestamps still mandatory).
        word = bytes((0x11, parity_byte(0x11, 1)))
        frames = cycle(slots=(word,))
        stamps = [40.0 * index for index in range(16)]
        parsed = parse_segmented_cart_frames(frames, frame_edge_times_ms=stamps)
        self.assertTrue(parsed.physical_edge_timing_checked)
        with self.assertRaisesRegex(CartReferenceError, "gap"):
            parse_segmented_cart_frames(
                frames, frame_edge_times_ms=[42.0 * index for index in range(16)]
            )


class GuardedReadOnlyPlanningTests(unittest.TestCase):
    def test_only_A_B_G_match_reference_map_and_placement(self):
        parsed = baseline()
        expectations = {
            "A": (b"\x03\x81", 1, False, False),
            "B": (b"\x26\x0e", 14, True, False),
            "G": (b"\x21\xf6", 6, False, True),
        }
        for name, (raw, slots, conflict, repeats) in expectations.items():
            with self.subTest(name=name):
                planned = plan_read_only_candidate(name, parsed)
                self.assertEqual(planned.reference_opcode, raw)
                self.assertEqual(planned.next_block_slot_count, slots)
                self.assertEqual((planned.opcode_frame_id, planned.opcode_slot_index), (2, 1))
                self.assertEqual(planned.known_reference_conflict, conflict)
                self.assertEqual(planned.can_repeat_without_bound, repeats)
                self.assertFalse(planned.transmit_authorized)
                self.assertFalse(planned.vehicle_compatible)

    def test_clear_codes_KOEO_test_and_map_upload_are_denied(self):
        for denied in (
            "C", "D", "E", "F", "H", "I", "J", "K", "L", "M", "Q", "R", "Z",
            "c", "b", "g", "KOEO", "CLEAR", "MAP_UPLOAD", "A ", " A", "A\n", "0x03",
            b"\x02\x91", None, "",
        ):
            with self.subTest(denied=denied), self.assertRaisesRegex(
                CartReferenceError, "denied"
            ):
                plan_read_only_candidate(denied, baseline())

    def test_guard_needs_one_complete_valid_id_cycle(self):
        partial = parse_cart_id_stream(b"".join(cycle()[:15]))
        self.assertEqual(partial.full_cycles, 0)
        with self.assertRaisesRegex(CartReferenceError, "complete validated"):
            plan_read_only_candidate("B", partial)

    def test_partial_last_cycle_after_full_cycle_may_be_used_as_evidence(self):
        parsed = parse_cart_id_stream(b"".join(cycle() + cycle()[:4]))
        self.assertEqual(plan_read_only_candidate("A", parsed).command, "A")

    def test_missing_or_incomplete_response_is_refused(self):
        plan = plan_read_only_candidate("B", baseline())
        no_payload = baseline()
        partial_response = parse_segmented_cart_frames(cycle()[:15])
        for response in (no_payload, partial_response):
            with self.subTest(response=response.raw_slot_word_count), self.assertRaisesRegex(
                CartReferenceError, "incomplete|no observed"
            ):
                inspect_candidate_response(plan, response)

    def test_DTC_candidate_remains_raw_and_never_becomes_a_verified_code(self):
        # Valid nibble parity does not prove 0x111 is a Ford diagnostic code.
        raw_word = bytes((0x11, parity_byte(0x11, 1)))
        response = parse_segmented_cart_frames(cycle(slots=(raw_word,)))
        plan = plan_read_only_candidate("B", baseline())
        observed = inspect_candidate_response(plan, response)
        self.assertIsInstance(observed, CandidateResponseObservation)
        self.assertEqual(observed.unvalidated_slot_words, (raw_word,) * 16)
        self.assertTrue(observed.structurally_complete_id_cycle)
        self.assertFalse(observed.dtc_values_validated)
        self.assertFalse(observed.request_response_link_verified)
        self.assertFalse(observed.ecu_source_verified)

    def test_PID_candidate_preserves_raw_bytes_without_units_or_conversion(self):
        raw_word = bytes((0xA2, parity_byte(0xA2, 3)))
        response = parse_segmented_cart_frames(cycle(slots=(raw_word,)))
        plan = plan_read_only_candidate("G", baseline())
        observed = inspect_candidate_response(plan, response)
        self.assertEqual(observed.unvalidated_slot_words[0], raw_word)
        self.assertFalse(observed.pid_values_validated)
        self.assertFalse(observed.request_response_link_verified)

    def test_forged_plan_cannot_claim_clear_codes_as_A(self):
        original = plan_read_only_candidate("A", baseline())
        forged = ReadOnlyCandidatePlan(
            command="A", description="status", reference_opcode=b"\x02\x91",
            opcode_frame_id=original.opcode_frame_id,
            opcode_slot_index=original.opcode_slot_index,
            next_block_slot_count=original.next_block_slot_count,
            known_reference_conflict=False, can_repeat_without_bound=False,
        )
        slot = bytes((0, parity_byte(0, 0)))
        response = parse_segmented_cart_frames(cycle(slots=(slot,)))
        with self.assertRaisesRegex(CartReferenceError, "allowlist"):
            inspect_candidate_response(forged, response)


class CartCommandParityCatalogueTests(unittest.TestCase):
    """Mechanically verify all A-R source commands, parity, and variants."""

    # Upstream doncreat0r/eeciv tables.h A-R words:
    UPSTREAM_AR = {
        "A": "0381",  # ECU status
        "B": "260E",  # Read stored DTC
        "C": "0291",  # Clear DTC
        "D": "253E",  # KOEO / KOER
        "E": "4196",  # Load/transmit PID map
        "F": "005E",  # Read PID map (published literal)
        "G": "21F6",  # Read PID values
        "H": "01A1",  # Clear DCL flags
        "I": "42A6",  # Load/transmit DMR map
        "J": "242E",  # Read DMR map
        "K": "22C6",  # Read DMR values
        "L": "271E",  # Read combined PID/DMR values
        "M": "8174",  # Baud-rate change
        "Q": "411E",  # Stop PID flow
        "R": "FF5F",  # Idle/control block
    }

    # Alternate variants from flxkrmr and local investigations:
    ALTERNATES_WITH_VALID_VPARITY = {
        "B_ALT": "26A4",  # Alternative stored-code read
        "D_ALT": "2594",  # Alternative KOEO profile
        "H_ALT": "01F4",  # Alternative DCL flag-clear profile
        "MEM_HDR": "42F3",  # Local memory-read sequence header
        "OFF_HDR": "80CE",  # Offline mode control
        "OFF_QUAL": "7F20",  # Offline qualifier word
        "ENV_SEL": "01B0",  # Request envelope module-select word
        "ENV_END": "00A0",  # Request envelope trailer word
    }

    def test_generic_vparity_matches_exactly_14_of_15_ar_words(self):
        matches = {}
        for letter, hexword in self.UPSTREAM_AR.items():
            first = int(hexword[:2], 16)
            second = int(hexword[2:], 16)
            low_nibble = second & 0x0F
            expected_second = parity_byte(first, low_nibble)
            matches[letter] = (expected_second == second)

        matching_keys = [k for k, v in matches.items() if v]
        mismatch_keys = [k for k, v in matches.items() if not v]

        self.assertEqual(len(matching_keys), 14)
        self.assertEqual(mismatch_keys, ["F"])

    def test_pidmap_005e_parity_mismatch_and_no_automatic_fallback(self):
        first = 0x00
        second = 0x5E
        low_nibble = second & 0x0F
        derived_second = parity_byte(first, low_nibble)
        derived_hex = f"{first:02X}{derived_second:02X}"

        # Generic parity for data nibble E with first=00 is 004E:
        self.assertEqual(derived_hex, "004E")
        self.assertNotEqual("005E", derived_hex)

        # Distinguish 004E received as frame-ID E vs transmitted command:
        # A received CART frame ID E with status 0 has byte pair: 00 4E
        rx_status = 0x00
        rx_frame_id = 0x0E
        rx_parity_id_byte = parity_byte(rx_status, rx_frame_id)
        self.assertEqual(f"{rx_status:02X}{rx_parity_id_byte:02X}", "004E")
        # That is frame header syntax, NOT evidence of a transmitted diagnostic command.

    def test_known_alternate_profiles_satisfy_vparity(self):
        for name, hexword in self.ALTERNATES_WITH_VALID_VPARITY.items():
            first = int(hexword[:2], 16)
            second = int(hexword[2:], 16)
            low_nibble = second & 0x0F
            expected_second = parity_byte(first, low_nibble)
            self.assertEqual(
                expected_second, second,
                f"Alternate profile {name} ({hexword}) must satisfy VPARITY"
            )

    def test_mem_sequence_words_and_blocking_justification(self):
        # 42F3 has valid VPARITY:
        self.assertEqual(parity_byte(0x42, 0x03), 0xF3)
        # 22D3 differs from generic parity (which is 2293):
        self.assertEqual(parity_byte(0x22, 0x03), 0x93)
        self.assertNotEqual(parity_byte(0x22, 0x03), 0xD3)


if __name__ == "__main__":
    unittest.main()
