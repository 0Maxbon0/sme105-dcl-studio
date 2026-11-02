"""Non-mutating, provenance-aware DCL stored-code candidate extraction.

Decode rules are corroborated by flxkrmr/eec-iv-reader-arduino
(Cart.cpp, Cart.h, EecIvReader.cpp) and babroval/ford-eec-iv-diagnostic.
The content is a *reference-compatible candidate*, NOT a demonstrated
SME-105 DTC: only independent bus and request/response evidence can
upgrade that distinction.
"""

from __future__ import annotations

from dataclasses import dataclass

from ford_dcl.cart_reference import CartReferenceError
from ford_dcl.cart_timed import BIT_US, SLOT_US, SYNC_REARM_US, TimedCapture


@dataclass(frozen=True, slots=True)
class CartCommandWitness:
    """Device-side timestamped witness, supplied by a real bounded TX path."""

    start_us: int
    completed_us: int
    frame_id: int
    slot_index: int
    opcode: bytes
    uart_errors: int
    tx_cutoff_triggered: bool


@dataclass(frozen=True, slots=True)
class DtcCandidate:
    # The first display format is used by two Ford CART reader references,
    # but this exact ECU has not proved the nibble orientation.
    code_text: str
    alternate_first_byte_high_text: str
    alignment_hypothesis: str
    raw_hex: str
    frame_id: int
    slot_index: int
    cycle_index: int


@dataclass(frozen=True, slots=True)
class DtcCandidateRead:
    command_variant: str
    candidates: tuple[DtcCandidate, ...]
    status_frame5_next_diag_mode: int
    status_frame7_error_flags_high: int
    # Software reference words alone do not establish DTC/ECU authenticity.
    is_ecu_source_authenticated: bool = False
    is_dtc_read_verified: bool = False


def extract_dtc_candidates(capture: TimedCapture, witness: CartCommandWitness) -> DtcCandidateRead:
    """Fail closed on any missing command and B-response anchors.

    Only physical DATA slots (slot >=2, frame ID 4..15) are eligible.
    Frame 5 slot 1 must show mode 0x26 and frame 7 slot 1 bit 6 must
    show 'self-test complete' before we report even reference candidates.
    This cannot turn synthetic data into proven ECU trouble codes.
    """
    if not isinstance(capture, TimedCapture) or not isinstance(witness, CartCommandWitness):
        raise TypeError("timed capture and command witness required")
    if witness.opcode not in (b"\x26\x0e", b"\x26\xa4"):
        raise CartReferenceError("only the two documented read-code reference variants are allowed")
    if (witness.frame_id, witness.slot_index) != (2, 1):
        raise CartReferenceError("B opcode not witnessed in CART ID 2 slot 1")
    if (witness.start_us < 0 or witness.completed_us <= witness.start_us or
            abs(witness.completed_us - witness.start_us - 20 * BIT_US)
            > capture.timing_tolerance_us):
        raise CartReferenceError("invalid command transmit duration")
    if witness.uart_errors or witness.tx_cutoff_triggered:
        raise CartReferenceError("failed command transmit / UART health")
    if capture.cart.full_cycles < 3:
        raise CartReferenceError("baseline, command and response cycles required")
    if len(capture.slot_indices) != len(capture.cart.frames):
        raise CartReferenceError("inconsistent slot evidence")
    if capture.frame_sync_end_us[-1] <= witness.completed_us:
        raise CartReferenceError("no CART frames after witnessed TX")
    # Local echo is NOT ECU evidence, but it proves the entire four-word
    # reference command block was observed in proper CART slots: preamble,
    # idle, B operation, and close. Sending just 26 A4/26 0E is not proven
    # sufficient to enter diagnostics mode.
    # Require a full baseline 0..F cycle before the matched ID2 frame.
    witnessed_index = None
    for index in range(18, len(capture.cart.frames)):
        frame = capture.cart.frames[index]
        if frame.frame_id != 2:
            continue
        predicted_start = (capture.frame_sync_end_us[index]
                           + SYNC_REARM_US + SLOT_US)
        if abs(witness.start_us - predicted_start) <= capture.timing_tolerance_us:
            witnessed_index = index
            expected_command = (
                b"\x01\xb0", b"\xff\x5f", witness.opcode, b"\x00\xa0",
            )
            for command_id, expected_word in enumerate(expected_command):
                member = index - 2 + command_id
                if 1 not in capture.slot_indices[member]:
                    raise CartReferenceError("missing local RX echo in four-word command block")
                slot_pos = capture.slot_indices[member].index(1)
                if capture.cart.frames[member].slot_words[slot_pos] != expected_word:
                    raise CartReferenceError("four-word CART command echo mismatch")
            break
    if witnessed_index is None:
        raise CartReferenceError("B TX not bound to a physical CART ID2 slot after baseline")

    # A command needs a post-TX complete response *cycle*. We do not
    # use any bytes from the cycle containing local TX echo.
    response_cycles = []
    for start in range(0, capture.cart.full_cycles * 16, 16):
        if start > witnessed_index and capture.frame_sync_end_us[start] > witness.completed_us:
            response_cycles.append(start)
    if not response_cycles:
        raise CartReferenceError("no full post-command response cycle")
    results: list[DtcCandidate] = []
    next_mode: int | None = None
    errors_high: int | None = None
    for start in response_cycles:
        ids = capture.cart.frames[start:start + 16]
        positions = capture.slot_indices[start:start + 16]
        for frame_id in (5, 7):
            if not positions[frame_id] or positions[frame_id][0] != 1:
                raise CartReferenceError("missing DCL status slot in post-command block")
        mode = ids[5].slot_words[0][0]
        flags = ids[7].slot_words[0][0]
        if mode != 0x26:
            raise CartReferenceError("frame 5 does not confirm read-codes diagnostic mode")
        next_mode, errors_high = mode, flags
        # Frame 7's high status marks completion. Frames 8..15 occur after
        # that signal and must not be included in a finished-code response.
        final_frame_exclusive = 8 if flags & 0x40 else 16
        for frame in ids[4:final_frame_exclusive]:
            indices = positions[frame.frame_id]
            if len(indices) != len(frame.slot_words):
                raise CartReferenceError("slot time / word count mismatch")
            for idx, data in zip(indices, frame.slot_words):
                if idx <= 1:
                    continue  # status word, never DTC
                code_number = ((data[1] & 0x0F) << 8) | data[0]
                other_number = (data[0] << 4) | (data[1] & 0x0F)
                # Reference text format is three hex digits, not a decimal
                # conversion, and not a universal OBD-II P-code. Preserve the
                # competing byte-order hypothesis from ford_dcl.words.
                results.append(DtcCandidate(
                    f"{code_number:03X}", f"{other_number:03X}",
                    "SECOND_LOW_HIGH_flx_reference", data.hex(" ").upper(),
                    frame.frame_id, idx, start // 16,
                ))
        if flags & 0x40:
            break
    if errors_high is None or not errors_high & 0x40:
        raise CartReferenceError("DCL status never signaled completed stored-code read")
    if not results:
        raise CartReferenceError("no eligible CART response DATA slot words")
    return DtcCandidateRead(
        command_variant=witness.opcode.hex(" ").upper(),
        candidates=tuple(results),
        status_frame5_next_diag_mode=next_mode if next_mode is not None else -1,
        status_frame7_error_flags_high=errors_high,
    )
