"""Strict, offline Ford CART byte/slot timeline reconstruction.

Only accepts timestamped UART *byte-completion* events from a device-side
receive interrupt. USB arrival/batch timestamps are NOT suitable inputs.
Reference timing: doncreat0r/eeciv Diag324.c (sync 4 bits, slot 24 bits).
No transport or ECU-transmit function is provided here.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import pairwise

from ford_dcl.cart_reference import (
    CartCapture,
    CartReferenceError,
    parity_byte,
    parse_segmented_cart_frames,
)

BIT_US = 1_000_000 / 9600
BYTE_US = 10 * BIT_US
SLOT_US = 24 * BIT_US
SYNC_REARM_US = 4 * BIT_US
MIN_FRAME_US = 4 * SLOT_US  # observed 10ms ID-only cadence
MAX_FRAME_US = 16 * SLOT_US  # 14 slots + two header slots


@dataclass(frozen=True, slots=True)
class TimedOctet:
    complete_us: int
    byte: int

    def __post_init__(self) -> None:
        if type(self.complete_us) is not int or self.complete_us < 0:
            raise ValueError("complete_us must be a nonnegative integer")
        if type(self.byte) is not int or not 0 <= self.byte <= 255:
            raise ValueError("byte must be an octet")


@dataclass(frozen=True, slots=True)
class TimedCapture:
    cart: CartCapture
    frame_sync_end_us: tuple[int, ...]
    slot_indices: tuple[tuple[int, ...], ...]
    # Timestamp tolerance must be backed by receiver interrupt timing, not USB.
    timing_tolerance_us: int
    header_gap_bits: int


def parse_timed_cart(
    octets: list[TimedOctet] | tuple[TimedOctet, ...],
    *,
    tolerance_us: int = 175,
) -> TimedCapture:
    """Reject incomplete/ambiguous frames, reconstruct occupied physical slots.

    Frame: sync(00 00) + two-byte status/ID + zero or more 2-byte slot
    words. Each slot is 24 bit-times, first transmission starts at 4+24
    bit-times after the end of the *second sync byte*. Missing slots are not
    synthesized; their occupancy is unknown. A complete 16-ID cycle is needed
    to distinguish ID-ordered CART from accidental valid parity. A data block
    can *extend* frame cadence by multiples of 24 bits, so a fixed 10ms
    stride is NOT assumed after the read-code command.
    """
    if type(tolerance_us) is not int or not 0 < tolerance_us <= 250:
        raise ValueError("timestamp tolerance must be integer 1..250 us")
    if not isinstance(octets, (list, tuple)) or len(octets) < 64 or len(octets) > 8192:
        raise CartReferenceError("need 16+ full frames and bounded UART events")
    if any(not isinstance(event, TimedOctet) for event in octets):
        raise TypeError("events must be TimedOctet values")
    times = [event.complete_us for event in octets]
    if any(b <= a for a, b in pairwise(times)):
        raise CartReferenceError("UART byte completion timestamps out of order")

    def near(actual: int, expected: float, label: str) -> None:
        if abs(actual - expected) > tolerance_us:
            raise CartReferenceError(f"{label}: physical UART timing mismatch")

    frames: list[bytes] = []
    frame_times: list[int] = []
    slots: list[tuple[int, ...]] = []
    header_gap_bits: int | None = None
    i = 0
    while i < len(octets):
        if len(octets) - i < 4:
            raise CartReferenceError("incomplete CART header")
        sync_a, sync_b, status, ident = octets[i:i + 4]
        if sync_a.byte != 0 or sync_b.byte != 0:
            raise CartReferenceError("missing two-byte CART sync")
        near(sync_b.complete_us, sync_a.complete_us + BYTE_US, "sync")
        # AVR scanner re-arms its timer four bit-times after 00 00. That
        # does not independently prove ECU inserts a physical four-bit
        # inter-word idle period; accept only the two *explicit* phase models.
        # Keep the same phase for every frame, never silently re-align.
        candidate = min(
            (0, 4),
            key=lambda bits: abs(
                status.complete_us - sync_b.complete_us - BYTE_US - bits * BIT_US
            ),
        )
        if header_gap_bits is None:
            header_gap_bits = candidate
        if candidate != header_gap_bits:
            raise CartReferenceError("CART header timing phase changed")
        phase_us = header_gap_bits * BIT_US
        near(status.complete_us, sync_b.complete_us + phase_us + BYTE_US, "status")
        near(ident.complete_us, sync_b.complete_us + phase_us + 2 * BYTE_US, "frame ID")
        if frame_times:
            delta = sync_b.complete_us - frame_times[-1]
            extra = round((delta - MIN_FRAME_US) / SLOT_US)
            if not 0 <= extra <= 12:
                raise CartReferenceError("frame cadence outside CART slot range")
            near(delta, MIN_FRAME_US + extra * SLOT_US, "frame cadence")
        frame_times.append(sync_b.complete_us)
        record = bytearray((0, 0, status.byte, ident.byte))
        i += 4
        occupied: list[int] = []
        while i < len(octets):
            # A next frame has a two-zero sync followed by a status/ID word.
            # Require the correct physical cadence and ID progression, not
            # simply 00 00 (a legitimate data slot can also be zero).
            offset = octets[i].complete_us - sync_b.complete_us
            if offset > MAX_FRAME_US + tolerance_us:
                raise CartReferenceError("missing next sync or timed slot overflow")
            if i + 3 < len(octets):
                candidate = octets[i:i + 4]
                next_delta = candidate[1].complete_us - sync_b.complete_us
                extra = round((next_delta - MIN_FRAME_US) / SLOT_US)
                cadence = MIN_FRAME_US + extra * SLOT_US
                if (
                    candidate[0].byte == candidate[1].byte == 0
                    and 0 <= extra <= 12
                    and abs(next_delta - cadence) <= tolerance_us
                ):
                    if candidate[3].byte != parity_byte(candidate[2].byte,
                                                          (len(frames) + 1) % 16):
                        raise CartReferenceError("next frame ID or parity invalid")
                    break
            if len(octets) - i < 2:
                raise CartReferenceError("incomplete CART slot word")
            first, second = octets[i:i + 2]
            slot = round((offset - SYNC_REARM_US - BYTE_US) / SLOT_US)
            if not 1 <= slot <= 14 or slot in occupied:
                raise CartReferenceError("ambiguous, duplicate or invalid CART slot")
            near(first.complete_us, sync_b.complete_us + SYNC_REARM_US + slot * SLOT_US + BYTE_US,
                 "slot first byte")
            near(second.complete_us, first.complete_us + BYTE_US, "slot second byte")
            if second.complete_us > sync_b.complete_us + MAX_FRAME_US:
                raise CartReferenceError("slot exceeds maximum CART frame")
            record.extend((first.byte, second.byte))
            occupied.append(slot)
            i += 2
        frames.append(bytes(record))
        slots.append(tuple(occupied))

    if len(frames) < 16:
        raise CartReferenceError("no complete 16-frame CART cycle")
    # Structural parity and ID progression are checked again by existing model.
    # Reuse the reference model's explicit physical-edge checked flag, but
    # this certifies consistency of device ISR timestamps ONLY, not analog
    # edge accuracy or provenance of the ECU source.
    parsed = parse_segmented_cart_frames(
        frames, frame_edge_times_ms=[t / 1000 for t in frame_times],
    )
    return TimedCapture(
        parsed, tuple(frame_times), tuple(slots), tolerance_us,
        header_gap_bits if header_gap_bits is not None else -1,
    )
