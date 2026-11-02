"""Offline model of the Ford EEC-IV CART reference, without any I/O.

Reference: doncreat0r/eeciv ``Diag324.c`` (modeInCART, cartTimerService,
USART1_UDRE_vect) and ``tables.h`` (cmdData and VPARITY). This is a model of
that scanner, *not* evidence that these commands work on a specific ECU.

The existing SME-105 recording has only 00 00 + parity-coded status/ID words.
Timed slots with no UART bytes cannot be reconstructed from that stream. For
synthetic payloads a caller must supply independently segmented frame records;
we deliberately never guess their boundaries from a flat UART byte stream.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from math import isfinite


class CartReferenceError(ValueError):
    """A source or structural condition makes this CART candidate untrustworthy."""


@dataclass(frozen=True, slots=True)
class CartTimingAssumptions:
    """Reference scanner timer constants; they are not calibrated ECU timings.

    Timer tick: 24 UART bits; sync re-arms the next slot after 4 bits.
    Host USB batch timestamps must NOT be supplied as frame-edge timestamps.
    """

    baud: int = 9600
    data_bits: int = 8
    stop_bits: int = 1
    uart_parity: str = "none"
    timer_slot_bits: int = 24
    sync_rearm_bits: int = 4
    initial_slot_count: int = 2
    lost_sync_reset_after_slot: int = 30
    # Conservative *candidate* interruption bound, based on the observed
    # ~10 ms four-byte header cadence, not the 2.5 ms timer slot duration.
    max_frame_edge_gap_ms: float = 25.0

    @property
    def timer_slot_ms(self) -> float:
        return self.timer_slot_bits * 1000 / self.baud

    @property
    def sync_rearm_ms(self) -> float:
        return self.sync_rearm_bits * 1000 / self.baud


REFERENCE_TIMING = CartTimingAssumptions()
FRAME_IDS_PER_CYCLE = 16
MAX_OBSERVED_SLOTS_PER_FRAME = 14  # 30-byte reference frBuf: header + 14 pairs


def parity_byte(first_byte: int, low_nibble: int) -> int:
    """Build the reference scanner's second word byte (``VPARITY``)."""
    if type(first_byte) is not int or not 0 <= first_byte <= 255:
        raise ValueError("first_byte must be an octet")
    if type(low_nibble) is not int or not 0 <= low_nibble <= 15:
        raise ValueError("low_nibble must be 0..15")
    high = ((first_byte >> 4) ^ (first_byte & 15) ^ low_nibble ^ 10) & 15
    return (high << 4) | low_nibble


def _valid_word(first: int, second: int) -> bool:
    return parity_byte(first, second & 15) == second


@dataclass(frozen=True, slots=True)
class CartFrame:
    index: int
    frame_id: int
    status_byte: int
    parity_id_byte: int
    # Each entry is the raw two-byte parity-protected *candidate* slot word.
    # The data alignment, meaning and electrical source remain unvalidated.
    slot_words: tuple[bytes, ...]


@dataclass(frozen=True, slots=True)
class CartCapture:
    frames: tuple[CartFrame, ...]
    physical_edge_timing_checked: bool

    @property
    def full_cycles(self) -> int:
        return len(self.frames) // FRAME_IDS_PER_CYCLE

    @property
    def trailing_frames(self) -> int:
        return len(self.frames) % FRAME_IDS_PER_CYCLE

    @property
    def raw_slot_word_count(self) -> int:
        return sum(len(frame.slot_words) for frame in self.frames)

    @property
    def ecu_source_verified(self) -> bool:
        # Reference-shaped UART traffic, including parity, is not authentication.
        return False


def _validate_timing(
    frame_count: int,
    frame_edge_times_ms: Sequence[float] | None,
    *,
    has_slot_payload: bool = False,
) -> bool:
    if frame_edge_times_ms is None:
        return False
    if len(frame_edge_times_ms) != frame_count:
        raise CartReferenceError("frame-edge timestamp count differs from frames")
    previous: float | None = None
    for time in frame_edge_times_ms:
        if isinstance(time, bool) or not isinstance(time, (float, int)) or not isfinite(time):
            raise CartReferenceError("invalid physical frame-edge timestamp")
        if time < 0:
            raise CartReferenceError("negative frame-edge timestamp")
        if previous is not None:
            delta = time - previous
            if delta <= 0:
                raise CartReferenceError("duplicate or out-of-order frame-edge timestamp")
            # The recorded ID-only cadence is ~10 ms. A mode B response
            # can allocate up to 14 24-bit slots, extending a full frame
            # towards 40 ms; the old unconditional 25-ms guard incorrectly
            # rejected valid *candidate* payload timelines.
            bound = 41.0 if has_slot_payload else REFERENCE_TIMING.max_frame_edge_gap_ms
            if delta > bound:
                raise CartReferenceError("frame-edge gap exceeds conservative candidate bound")
        previous = time
    return True


def parse_segmented_cart_frames(
    frame_records: Sequence[bytes],
    *,
    frame_edge_times_ms: Sequence[float] | None = None,
) -> CartCapture:
    """Inspect explicitly segmented frames, preserving any observed slot words.

    Frame wire shape: ``00 00`` sync then 2-byte status+parity/ID word,
    followed by zero to 14 independently segmented two-byte slot words.
    An empty slot never creates two zero bytes by assumption. Requires ID 0
    as the capture's first frame, then consecutive ID 1..15 modulo 16.

    Optional timestamps MUST be measured physical frame edges, not the
    ``CART_RX t_ms`` USB/MCU batch timestamps. Timing cannot prove whether an
    entire 16-frame cycle was lost, especially without physical timestamps.
    """
    if isinstance(frame_records, (bytes, bytearray, str)):
        raise TypeError("frame_records must contain individually segmented bytes")
    if not frame_records:
        raise CartReferenceError("empty CART stream")
    if len(frame_records) > 1_000_000:
        raise CartReferenceError("CART stream too large for reference model")
    frames: list[CartFrame] = []
    for index, record in enumerate(frame_records):
        if not isinstance(record, bytes):
            raise TypeError("each CART frame must be bytes")
        if len(record) < 4 or len(record) % 2:
            raise CartReferenceError(f"frame {index}: incomplete header or slot word")
        if len(record) > 4 + 2 * MAX_OBSERVED_SLOTS_PER_FRAME:
            raise CartReferenceError(f"frame {index}: too many slot bytes")
        if record[:2] != b"\x00\x00":
            raise CartReferenceError(f"frame {index}: missing two-byte sync")
        status, second = record[2], record[3]
        if not _valid_word(status, second):
            raise CartReferenceError(f"frame {index}: invalid status/ID parity")
        frame_id = second & 15
        if frame_id != index % FRAME_IDS_PER_CYCLE:
            raise CartReferenceError(
                f"frame {index}: duplicate, lost or out-of-order ID "
                f"(expected {index % FRAME_IDS_PER_CYCLE}, got {frame_id})"
            )
        slots = tuple(record[offset:offset + 2] for offset in range(4, len(record), 2))
        for slot_index, slot_word in enumerate(slots, start=1):
            if not _valid_word(slot_word[0], slot_word[1]):
                raise CartReferenceError(
                    f"frame {index} slot {slot_index}: invalid vertical parity"
                )
        frames.append(CartFrame(index, frame_id, status, second, slots))
    timing_checked = _validate_timing(
        len(frames), frame_edge_times_ms,
        has_slot_payload=any(frame.slot_words for frame in frames),
    )
    return CartCapture(tuple(frames), timing_checked)


def parse_cart_id_stream(
    raw: bytes,
    *,
    frame_edge_times_ms: Sequence[float] | None = None,
) -> CartCapture:
    """Parse a contiguous *ID-only* raw CART stream without hypothesized slots.

    This matches the 2026-11-02 zero-payload transcript format. It rejects
    every leftover byte and does not silently resynchronize after corruption.
    If additional slot bytes exist, use ``parse_segmented_cart_frames`` with
    separately established framing instead of guessing a stride.
    """
    if not isinstance(raw, bytes):
        raise TypeError("raw CART stream must be bytes")
    if not raw or len(raw) % 4:
        raise CartReferenceError("incomplete CART sync/status/ID quartet")
    frames = [raw[start:start + 4] for start in range(0, len(raw), 4)]
    return parse_segmented_cart_frames(frames, frame_edge_times_ms=frame_edge_times_ms)


@dataclass(frozen=True, slots=True)
class ReadOnlyCandidatePlan:
    command: str
    description: str
    reference_opcode: bytes
    opcode_frame_id: int
    opcode_slot_index: int
    next_block_slot_count: int
    known_reference_conflict: bool
    can_repeat_without_bound: bool
    timing: CartTimingAssumptions = REFERENCE_TIMING

    @property
    def transmit_authorized(self) -> bool:
        return False

    @property
    def vehicle_compatible(self) -> bool:
        return False


# Exact *doncreat0r scanner* cmdData words; no assumed stand-alone UART commands.
# Another GPL scanner source gives B as 26 A4 (4 slots) versus 26 0E here
# (14 slots). Both have valid parity; that discrepancy must be resolved
# independently before any future vehicle protocol implementation. Diag324.c
# explicitly requeues 'G' on each block, so no bounded single-shot behavior
# can be inferred from its nominal 'read PID values' label.
_READ_ONLY_REFERENCE = {
    "A": ("status candidate", b"\x03\x81"),
    "B": ("read codes candidate", b"\x26\x0e"),
    "G": ("PID values candidate", b"\x21\xf6"),
}


def plan_read_only_candidate(command: str, baseline: CartCapture) -> ReadOnlyCandidatePlan:
    """Return an inert reference command-slot *description* for A/B/G only.

    The scanner latches its pending command at ID 0 and places the cmdData
    word at frame ID 2, slot 1. The word's low nibble selects next-block
    slotCount (A=1, B=14, G=6). This function has no transport, device handle,
    serial writer, stateful scheduler, or callable send operation.
    """
    if not isinstance(command, str) or command not in _READ_ONLY_REFERENCE:
        raise CartReferenceError("command denied: only exact A, B, G read candidates")
    if not isinstance(baseline, CartCapture) or baseline.full_cycles < 1:
        raise CartReferenceError("at least one complete validated 0..15 ID cycle required")
    # Do not rely on a caller-supplied, forged CartCapture: rerun structural
    # validation of every frame before making a plan.
    verified = parse_segmented_cart_frames(
        [bytes((0, 0, f.status_byte, f.parity_id_byte)) + b"".join(f.slot_words)
         for f in baseline.frames]
    )
    if verified.full_cycles < 1:
        raise CartReferenceError("no complete ID cycle")
    description, opcode = _READ_ONLY_REFERENCE[command]
    if parity_byte(opcode[0], opcode[1] & 15) != opcode[1]:
        raise CartReferenceError("reference command parity mismatch")
    return ReadOnlyCandidatePlan(
        command=command,
        description=description,
        reference_opcode=opcode,
        opcode_frame_id=2,
        opcode_slot_index=1,
        next_block_slot_count=opcode[1] & 15,
        known_reference_conflict=command == "B",
        can_repeat_without_bound=command == "G",
    )


@dataclass(frozen=True, slots=True)
class CandidateResponseObservation:
    command: str
    # This is only a well-formed 16-frame window, never proof that a request
    # caused the values. Slot words have no established data type or scale.
    structurally_complete_id_cycle: bool
    unvalidated_slot_words: tuple[bytes, ...]
    request_response_link_verified: bool = False
    ecu_source_verified: bool = False
    dtc_values_validated: bool = False
    pid_values_validated: bool = False


def inspect_candidate_response(
    plan: ReadOnlyCandidatePlan,
    response: CartCapture,
) -> CandidateResponseObservation:
    """Preserve raw slot words while refusing unproven DTC/PID interpretation.

    Requires a full ID block and some observed slot bytes. Neither shape nor
    nibble parity establishes request linkage, DTC encoding, PID mapping,
    data alignment, source, units, or that a planned query was transmitted.
    """
    if not isinstance(plan, ReadOnlyCandidatePlan) or plan.command not in _READ_ONLY_REFERENCE:
        raise CartReferenceError("unknown or unsafe candidate plan")
    if plan.reference_opcode != _READ_ONLY_REFERENCE[plan.command][1]:
        raise CartReferenceError("candidate plan opcode is not the reference allowlist word")
    if not isinstance(response, CartCapture) or not response.frames:
        raise CartReferenceError("missing candidate response")
    if response.trailing_frames:
        raise CartReferenceError("incomplete 16-ID candidate response block")
    validated = parse_segmented_cart_frames(
        [b"\x00\x00" + bytes((f.status_byte, f.parity_id_byte)) + b"".join(f.slot_words)
         for f in response.frames]
    )
    if not validated.raw_slot_word_count:
        raise CartReferenceError("candidate response has no observed slot words")
    return CandidateResponseObservation(
        command=plan.command,
        structurally_complete_id_cycle=True,
        unvalidated_slot_words=tuple(word for frame in validated.frames for word in frame.slot_words),
    )
