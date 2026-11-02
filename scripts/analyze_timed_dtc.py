#!/usr/bin/env python3
"""Offline DCL CART timing and stored-code *candidate* analysis.

Expected device-side evidence lines (timestamps are RX interrupt times, not USB):
  CART_EVT t_us=123 byte=00
  CART_TX start_us=123 end_us=2323 frame=2 slot=1 opcode=26A4 uart_errors=0 cutoff=0
  CART_END bytes=64 uart_errors=0 dropped=0

Never labels stored-code candidates as confirmed real ECU DTCs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from dataclasses import asdict
from pathlib import Path

from ford_dcl.cart_dtc_candidates import CartCommandWitness, extract_dtc_candidates
from ford_dcl.cart_reference import CartReferenceError, parity_byte
from ford_dcl.cart_timed import BIT_US, BYTE_US, TimedOctet, parse_timed_cart

EVENT = re.compile(rb"^CART_EVT t_us=([0-9]+) byte=([0-9A-Fa-f]{2})$")
TX = re.compile(
    rb"^CART_TX start_us=([0-9]+) end_us=([0-9]+) frame=([0-9]+) "
    rb"slot=([0-9]+) opcode=([0-9A-Fa-f]{4}) uart_errors=([0-9]+) cutoff=([01])$"
)
END = re.compile(rb"^CART_END bytes=([0-9]+) uart_errors=([0-9]+) dropped=([0-9]+)$")
NATIVE = re.compile(
    rb"^CART_CAPTURE n=([0-9]+) uart_errors=([0-9]+) "
    rb"coalesced=([0-9]+) overflow=([0-9]+) cutoff=([01]) capped=([01])$"
)
NATIVE_TIMEBASE = (
    b"CART_TIMEBASE source=UART2_RX_ISR unit=us event=FIFO_interrupt_after_stop_bit"
)
NATIVE_END = b"CART_END DTC_UNVERIFIED B_TX_LOCKED"
NATIVE_BASELINE = re.compile(
    rb"^CART_BASELINE id_only_cycles=([0-9]+) "
    rb"(?:id_only_frames=([0-9]+) header_phase_bits=(-?[0-9]+) )?validated=([01])$"
)
NATIVE_PLAN = re.compile(
    rb"^CART_B_PLAN stage=(SEEK|BASELINE|COMMAND_CYCLE|COMPLETE|FAILED) "
    rb"reason=([0-9]+) baseline_frames=([0-9]+) command_frames=([0-9]+) "
    rb"phase_bits=(-?[0-9]+) scheduled=([0-9]+) fired=([0-9]+) "
    rb"mode=DRY_RUN tx_bytes=0 ecu_verified=0$"
)
NATIVE_SLOT = re.compile(
    rb"^CART_B_SLOT frame=([0-3]) slot=1 opcode=([0-9A-F]{4}) "
    rb"target_us=([0-9]+) fired_us=([0-9]+) dry_run=1 tx_bytes=0$"
)
NATIVE_BEGIN = (
    b"CART_BEGIN recorded_9600_8N1 RX_ISR duration_ms_max=10000 B_TX=OFF"
)
REFERENCE_TX = re.compile(rb"^REF_TX frame=(ECHO_ID|GO_CART) bytes=11 cutoff=0$")
REFERENCE_ACK = re.compile(rb"^REF_ACK bytes=12 raw=(?:[0-9A-F]{2} ){11}[0-9A-F]{2}$")
REFERENCE_CANDIDATE = b"ACK_CANDIDATE origin=UNVERIFIED"


def parse_evidence(raw: bytes) -> tuple[list[TimedOctet], CartCommandWitness | None]:
    """Reject incomplete or corrupted structured evidence before any decoding."""
    if not isinstance(raw, bytes) or not 0 < len(raw) <= 1_000_000:
        raise CartReferenceError("empty or oversized structured evidence")
    records: list[TimedOctet] = []
    witness: CartCommandWitness | None = None
    endings = []
    native_summary = []
    native_ended = 0
    native_timebase = 0
    native_begin = 0
    native_baseline = 0
    native_plan = 0
    native_slots = 0
    seen_line = False
    structured_started = False
    finished = False
    lines = raw.replace(b"\r\n", b"\n").split(b"\n")
    if len(lines) > 10_000:
        raise CartReferenceError("too many evidence lines")
    for line_index, line in enumerate(lines):
        if not line:
            if line_index != len(lines) - 1 and structured_started:
                raise CartReferenceError("empty line inside capture evidence")
            continue
        if finished:
            raise CartReferenceError("unexpected trailing bytes after CART_END")
        if line.startswith((b"CART_", b"CAPTURE_")):
            structured_started = True
        if line.startswith(b"CART_EVT "):
            match = EVENT.fullmatch(line)
            if match is None:
                raise CartReferenceError("malformed timed byte event")
            records.append(TimedOctet(int(match[1]), int(match[2], 16)))
            seen_line = True
        elif line.startswith(b"CART_TX "):
            match = TX.fullmatch(line)
            if match is None or witness is not None:
                raise CartReferenceError("invalid or duplicate TX witness")
            witness = CartCommandWitness(
                start_us=int(match[1]), completed_us=int(match[2]),
                frame_id=int(match[3]), slot_index=int(match[4]),
                opcode=bytes.fromhex(match[5].decode("ascii")),
                uart_errors=int(match[6]), tx_cutoff_triggered=bool(int(match[7])),
            )
            seen_line = True
        elif line.startswith(b"CART_END "):
            if line == NATIVE_END:
                native_ended += 1
            else:
                match = END.fullmatch(line)
                if match is None:
                    raise CartReferenceError("malformed capture ending")
                endings.append(tuple(int(group) for group in match.groups()))
            seen_line = True
            finished = True
        elif line.startswith(b"CART_CAPTURE "):
            match = NATIVE.fullmatch(line)
            if match is None:
                raise CartReferenceError("malformed hardware UART capture summary")
            native_summary.append(tuple(int(group) for group in match.groups()))
        elif line.startswith(b"CART_BASELINE "):
            if NATIVE_BASELINE.fullmatch(line) is None:
                raise CartReferenceError("malformed native baseline observation")
            native_baseline += 1
        elif line.startswith(b"CART_B_PLAN "):
            if NATIVE_PLAN.fullmatch(line) is None:
                raise CartReferenceError("malformed native dry-run state")
            native_plan += 1
        elif line.startswith(b"CART_B_SLOT "):
            if NATIVE_SLOT.fullmatch(line) is None:
                raise CartReferenceError("malformed native dry-run word")
            native_slots += 1
        elif line == NATIVE_TIMEBASE:
            native_timebase += 1
        elif line == NATIVE_BEGIN:
            native_begin += 1
        elif line.startswith((b"CART_", b"CAPTURE_")):
            # Do not silently ignore unknown structured records.
            raise CartReferenceError("unrecognized structured capture evidence")
        elif structured_started:
            raise CartReferenceError("unexpected line inside structured capture")
        elif not (REFERENCE_TX.fullmatch(line) or REFERENCE_ACK.fullmatch(line) or
                  line == REFERENCE_CANDIDATE):
            raise CartReferenceError("unexpected preface before structured capture")
    if not seen_line or len(endings) + native_ended != 1:
        raise CartReferenceError("missing or duplicate CART_END")
    if endings:
        if (native_summary or native_ended or native_timebase or native_begin or
                native_baseline or native_plan or native_slots):
            raise CartReferenceError("mixed incompatible capture formats")
        expected_count, errors, dropped = endings[0]
        if expected_count != len(records):
            raise CartReferenceError("CART byte count does not match raw events")
        if errors or dropped:
            raise CartReferenceError("UART errors / dropped hardware bytes")
    else:
        if (len(native_summary) != 1 or native_ended != 1 or
                native_begin != 1 or native_timebase != 1 or native_baseline != 1 or
                witness is not None or native_plan > 1 or native_slots > 4):
            raise CartReferenceError("incomplete native UART ISR capture protocol")
        expected_count, errors, coalesced, overflow, cutoff, capped = native_summary[0]
        if expected_count != len(records):
            raise CartReferenceError("native UART capture byte count mismatch")
        if any((errors, coalesced, overflow, capped, cutoff)):
            raise CartReferenceError("UART error / ISR coalescing / capped or TX cutoff")
    return records, witness


def align_first_id_zero(raw_events: list[TimedOctet]) -> tuple[list[TimedOctet], int]:
    """Discard ONLY the unstructured preface before the first ID-0 header.

    An ISR capture begins at an arbitrary point in the CART cycle. Once the
    first eligible ID-0 header is found, all later bytes must pass strict
    parsing; no search past subsequent corruption is allowed.
    """
    for i in range(min(len(raw_events) - 3, 256)):
        a, b, c, d = raw_events[i:i + 4]
        if a.byte or b.byte or d.byte != parity_byte(c.byte, 0):
            continue
        if abs(b.complete_us - a.complete_us - BYTE_US) > 175:
            continue
        header_gap = c.complete_us - b.complete_us - BYTE_US
        if min(abs(header_gap), abs(header_gap - 4 * BIT_US)) > 175:
            continue
        if abs(d.complete_us - c.complete_us - BYTE_US) > 175:
            continue
        return raw_events[i:], i
    raise CartReferenceError("no timestamp-valid CART frame ID0 to start alignment")


def analyze(raw: bytes) -> dict:
    report: dict = {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "is_ecu_source_authenticated": False,
        "is_dtc_read_verified": False,
        "reference_dtc_candidates": [],
    }
    try:
        raw_events, witness = parse_evidence(raw)
        aligned, skipped = align_first_id_zero(raw_events)
        timed = parse_timed_cart(aligned)
        report["frames"] = len(timed.cart.frames)
        report["slots_observed"] = timed.cart.raw_slot_word_count
        report["physical_header_gap_bits_model"] = timed.header_gap_bits
        report["device_timestamped_bytes"] = len(raw_events)
        report["initial_unaligned_bytes_preserved_in_original"] = skipped
        if witness is None:
            report["classification"] = "timed-cart-observation-no-DTC-command"
        else:
            response = extract_dtc_candidates(timed, witness)
            report["classification"] = "reference-compatible-unverified-DTC-candidates"
            report["command_variant"] = response.command_variant
            report["reference_dtc_candidates"] = [asdict(code) for code in response.candidates]
    except (CartReferenceError, ValueError, TypeError) as exc:
        report["classification"] = "incomplete-or-unvalidated-timing-or-response"
        report["reason"] = str(exc)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("transcript", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    raw = args.transcript.read_bytes()
    result = analyze(raw)
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print("Classification:", result["classification"])
        print("Evidence SHA256:", result["sha256"])
        for code in result["reference_dtc_candidates"]:
            print(f"Reference DTC candidate {code['code_text']} "
                  f"(alternate nibble alignment {code['alternate_first_byte_high_text']})  "
                  f"(frame {code['frame_id']:X}, slot {code['slot_index']}, "
                  f"raw {code['raw_hex']})")
        if "reason" in result:
            print("Not validated:", result["reason"])
        print("Verified ECU DTC read: NO (requires independently validated vehicle response)")
    return 0 if result["classification"].startswith("reference-compatible") else 3


if __name__ == "__main__":
    raise SystemExit(main())
