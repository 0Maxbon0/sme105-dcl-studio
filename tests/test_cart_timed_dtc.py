"""Synthetic physical-slot timeline tests; NEVER proof of a real SME-105 DTC."""

from __future__ import annotations

import unittest

from ford_dcl.cart_dtc_candidates import CartCommandWitness, extract_dtc_candidates
from ford_dcl.cart_reference import CartReferenceError, parity_byte
from ford_dcl.cart_timed import (
    BIT_US,
    BYTE_US,
    MIN_FRAME_US,
    SLOT_US,
    SYNC_REARM_US,
    TimedOctet,
    parse_timed_cart,
)


def events(*, cycles=1, response=False, offset=0, include_command=False,
           header_gap_bits=4, extra_response_slot=None):
    out: list[TimedOctet] = []
    sync_second_us = offset + 2000
    for number in range(cycles * 16):
        frame_id = number % 16
        words = {}
        if include_command and 16 <= number <= 19:
            command_words = ((0x01, 0), (0xFF, 0x0F), (0x26, 4), (0x00, 0))
            words[1] = command_words[frame_id]
        if response and number >= 32 and frame_id >= 4:
            words[1] = (
                0x26 if frame_id == 5 else
                0x40 if frame_id == 7 and number >= 48 else 0x00,
                0,
            )
        if response and frame_id == 8 and 32 <= number < 48:
            words[2] = (0x16, 1)  # reference candidate text 116
            words[4] = (0x38, 5)  # reference candidate text 538; sparse slots
            if extra_response_slot is not None:
                words[extra_response_slot] = (0x39, 6)  # 5 or 14, beyond A4's 4
        def add(t, byte):
            out.append(TimedOctet(round(t), byte))
        add(sync_second_us - BYTE_US, 0)
        add(sync_second_us, 0)
        add(sync_second_us + header_gap_bits * BIT_US + BYTE_US, 0)
        add(sync_second_us + header_gap_bits * BIT_US + 2 * BYTE_US,
            parity_byte(0, frame_id))
        for slot, (first, hi) in sorted(words.items()):
            start = sync_second_us + SYNC_REARM_US + slot * SLOT_US
            add(start + BYTE_US, first)
            add(start + 2 * BYTE_US, parity_byte(first, hi))
        # Variable gap after slot 4. Mode B response may extend frames.
        sync_second_us += MIN_FRAME_US + max(0, max(words, default=2) - 2) * SLOT_US
    return out


class PhysicalCartTimingTests(unittest.TestCase):
    def test_id_only_cadence_is_complete_and_physically_segmented(self):
        stream = parse_timed_cart(events(cycles=2))
        self.assertEqual(stream.cart.full_cycles, 2)
        self.assertTrue(stream.cart.physical_edge_timing_checked)
        self.assertEqual(stream.header_gap_bits, 4)
        self.assertFalse(any(stream.slot_indices))
        self.assertFalse(stream.cart.ecu_source_verified)
        self.assertEqual(parse_timed_cart(events(header_gap_bits=0)).header_gap_bits, 0)
        finite = parse_timed_cart(events(cycles=2)[:16 * 4 + 4 * 4])
        self.assertEqual((finite.cart.full_cycles, finite.cart.trailing_frames), (1, 4))

    def test_variable_cadence_and_sparse_slots_preserve_absolute_ownership(self):
        timed = parse_timed_cart(events(cycles=4, response=True, include_command=True))
        self.assertEqual(timed.slot_indices[40], (1, 2, 4))
        self.assertEqual(timed.cart.frames[40].slot_words[1][0], 0x16)
        self.assertGreater(timed.frame_sync_end_us[41] - timed.frame_sync_end_us[40], 10_000)

    def test_reject_byte_time_jitter_and_reordering(self):
        base = events()
        for index, drift in ((6, 700), (17, -5000)):
            broken = list(base)
            broken[index] = TimedOctet(broken[index].complete_us + drift, broken[index].byte)
            with self.subTest(index=index), self.assertRaises(CartReferenceError):
                parse_timed_cart(broken)

    def test_reject_corrupt_id_parity_sync_and_missing_frame(self):
        base = events()
        for broken in (
            base[:5] + [TimedOctet(base[5].complete_us, 1)] + base[6:],
            base[:3] + [TimedOctet(base[3].complete_us, 0)] + base[4:],
            base[:4] + base[8:],
        ):
            with self.subTest(first=broken[:4]), self.assertRaises(CartReferenceError):
                parse_timed_cart(broken)

    def test_uart_input_limits_and_tolerance_misuse(self):
        with self.assertRaises(ValueError):
            parse_timed_cart(events(), tolerance_us=1000)
        with self.assertRaises(CartReferenceError):
            parse_timed_cart(events()[:50])
        with self.assertRaises(ValueError):
            TimedOctet(1, 256)


class StoredCodeCandidateTests(unittest.TestCase):
    @staticmethod
    def witness(**changes):
        args = {
            "start_us": 0, "completed_us": 0,
            "frame_id": 2, "slot_index": 1, "opcode": b"\x26\xa4",
            "uart_errors": 0, "tx_cutoff_triggered": False,
        }
        args.update(changes)
        return CartCommandWitness(**args)

    @staticmethod
    def timeline():
        return parse_timed_cart(events(cycles=4, response=True,
                                      include_command=True, offset=10_000))

    def actual_witness(self, timed, **changes):
        start = round(timed.frame_sync_end_us[18] + SYNC_REARM_US + SLOT_US)
        args = {"start_us": start, "completed_us": round(start + 2 * BYTE_US)}
        args.update(changes)
        return self.witness(**args)

    def test_reference_codes_only_after_observed_mode_and_complete_flag(self):
        timed = self.timeline()
        result = extract_dtc_candidates(timed, self.actual_witness(timed))
        self.assertEqual([(d.code_text, d.frame_id, d.slot_index) for d in result.candidates],
                         [("116", 8, 2), ("538", 8, 4)])
        self.assertEqual([d.alternate_first_byte_high_text for d in result.candidates],
                         ["161", "385"])
        self.assertEqual(result.status_frame5_next_diag_mode, 0x26)
        self.assertEqual(result.status_frame7_error_flags_high, 0x40)
        self.assertFalse(result.is_dtc_read_verified)
        self.assertFalse(result.is_ecu_source_authenticated)

    def test_response_slot_limit_is_bound_to_selected_B_variant(self):
        for last_slot in (5, 14):
            with self.subTest(last_slot=last_slot):
                from_both = events(
                    cycles=4, response=True, include_command=True,
                    offset=10_000, extra_response_slot=last_slot,
                )
                a4 = parse_timed_cart(from_both)
                with self.assertRaisesRegex(CartReferenceError, "more slots than selected B"):
                    extract_dtc_candidates(a4, self.actual_witness(a4))
                # 0E is a distinct parity-protected command word, not a
                # relabeling of an A4 witness. Recreate the ID2 local echo.
                zero_e = [TimedOctet(e.complete_us, 0x0E if e.byte == 0xA4 else e.byte)
                          for e in from_both]
                e_timed = parse_timed_cart(zero_e)
                response = extract_dtc_candidates(
                    e_timed, self.actual_witness(e_timed, opcode=b"\x26\x0e")
                )
                self.assertEqual(response.command_variant, "26 0E")
                self.assertEqual([c.code_text for c in response.candidates],
                                 ["116", "538", "639"])
                self.assertFalse(response.is_dtc_read_verified)
                self.assertFalse(response.is_ecu_source_authenticated)

    def test_id_only_and_unwitnessed_command_must_never_become_dtc(self):
        for timed in (parse_timed_cart(events(cycles=4, offset=10_000)),
                      parse_timed_cart(events(cycles=4, response=True, offset=10_000))):
            with self.assertRaises(CartReferenceError):
                extract_dtc_candidates(timed, self.actual_witness(timed))

    def test_reject_wrong_opcodes_locations_and_tx_faults(self):
        timed = self.timeline()
        for kwargs in (
            {"opcode": b"\x02\x91"}, {"frame_id": 3},
            {"slot_index": 2}, {"uart_errors": 1},
            {"tx_cutoff_triggered": True}, {"completed_us": 10_000},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaises(CartReferenceError):
                extract_dtc_candidates(timed, self.actual_witness(timed, **kwargs))


if __name__ == "__main__":
    unittest.main()
