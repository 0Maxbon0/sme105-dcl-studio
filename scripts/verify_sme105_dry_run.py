#!/usr/bin/env python3
"""Independently verify four CART timer-only firings against captured ID frames.

Offline forensic tool. Never opens serial, flashes firmware, transmits to ECU,
or claims that a software timer log proves actual RS-485 signal timing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from ford_dcl.cart_reference import CartReferenceError
from ford_dcl.cart_timed import parse_timed_cart

try:
    from .analyze_timed_dtc import (
        NATIVE_DIRECT,
        NATIVE_PLAN,
        NATIVE_SLOT,
        UART1_TIMEBASE,
        align_first_id_zero,
        parse_evidence,
    )
except ImportError:
    from analyze_timed_dtc import (
        NATIVE_DIRECT,
        NATIVE_PLAN,
        NATIVE_SLOT,
        UART1_TIMEBASE,
        align_first_id_zero,
        parse_evidence,
    )

EXPECTED_WORDS = ("01B0", "FF5F", "26A4", "00A0")
REFERENCE_HANDSHAKE = (
    b"REF_TX frame=ECHO_ID bytes=11 cutoff=0",
    b"REF_ACK bytes=12 raw=00 00 00 00 00 01 82 00 00 00 83 01",
    b"ACK_CANDIDATE origin=UNVERIFIED",
    b"REF_TX frame=GO_CART bytes=11 cutoff=0",
)


def verify(raw: bytes) -> dict:
    result = {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "result": "FAIL",
        "timer_only_witness_verified": False,
        "physical_bus_timing_verified": False,
        "ecu_source_authenticated": False,
        "stored_dtc_read_verified": False,
        "b_transmission_occurred": False,
        "individual_slots": [],
    }
    try:
        lines = raw.replace(b"\r\n", b"\n").splitlines()
        records, witness = parse_evidence(raw)
        if witness is not None:
            raise CartReferenceError("unexpected active CART TX witness")
        if tuple(lines[:4]) != REFERENCE_HANDSHAKE:
            raise CartReferenceError("reference handshake witness is incomplete or unexpected")
        if lines.count(UART1_TIMEBASE) != 1:
            raise CartReferenceError("not an experimental direct UART1 capture")
        plans = [m for line in lines if (m := NATIVE_PLAN.fullmatch(line))]
        slots = [m for line in lines if (m := NATIVE_SLOT.fullmatch(line))]
        baselines = [m for line in lines if (m := NATIVE_DIRECT.fullmatch(line))]
        if len(plans) != 1 or len(slots) != 4 or len(baselines) != 1:
            raise CartReferenceError("exactly one plan, one direct baseline and four slots required")
        plan, baseline = plans[0], baselines[0]
        if (
            plan[1] != b"COMPLETE"
            or tuple(int(plan[i]) for i in (2, 3, 4, 6, 7)) != (0, 16, 16, 4, 4)
            or int(plan[5]) not in (0, 4)
            or baseline[1] != b"1"
            or baseline[5] != plan[5]
        ):
            raise CartReferenceError("four-slot timer state incomplete or inconsistent")
        aligned, skipped = align_first_id_zero(records)
        if skipped != int(baseline[4]):
            raise CartReferenceError("raw event alignment disagrees with device baseline")
        frame_count = int(baseline[2])
        if frame_count < 32 or frame_count != int(baseline[3]) * 16:
            raise CartReferenceError("needs at least two fully captured 16-ID cycles")
        if len(aligned) != 4 * frame_count:
            raise CartReferenceError("unexpected extra, truncated or non-ID CART bytes")
        timed = parse_timed_cart(aligned)
        if len(timed.cart.frames) != frame_count or timed.header_gap_bits != int(plan[5]):
            raise CartReferenceError("independent parser disagrees with device timing baseline")
        first_command = 16
        deltas = []
        margins = []
        for frame_id, slot in enumerate(slots):
            index, opcode, target, fired = slot.groups()
            target, fired = int(target), int(fired)
            if int(index) != frame_id or opcode.decode() != EXPECTED_WORDS[frame_id]:
                raise CartReferenceError("unexpected frame or dry-run opcode sequence")
            frame = first_command + frame_id
            sync2_us = aligned[frame * 4 + 1].complete_us
            last_header_us = aligned[frame * 4 + 3].complete_us
            expected_target = sync2_us + 2917
            if target != expected_target:
                raise CartReferenceError("timer target does not match captured ID frame sync2")
            error = fired - target
            lead = target - last_header_us
            if abs(error) > 175 or not 200 <= lead <= 1200:
                raise CartReferenceError("firing error or available lead exceeds timer safety model")
            deltas.append(error)
            margins.append(lead)
            result["individual_slots"].append({
                "frame_id": frame_id,
                "word_not_transmitted": opcode.decode(),
                "sync2_isr_us": sync2_us,
                "target_us": target,
                "fired_isr_us": fired,
                "timer_error_us": error,
                "available_header_lead_us": lead,
            })
        result.update({
            "result": "PASS_TIMER_ONLY",
            "timer_only_witness_verified": True,
            "frames": frame_count,
            "complete_16_id_cycles": frame_count // 16,
            "all_four_timer_error_us": deltas,
            "available_header_lead_us": margins,
            "limits": "UART1 software ISR timestamps only; DE/output waveform unverified",
        })
    except (CartReferenceError, TypeError, ValueError, IndexError) as exc:
        result["reason"] = str(exc)
        result["individual_slots"] = []
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    args = parser.parse_args()
    report = verify(args.capture.read_bytes())
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["timer_only_witness_verified"] else 3


if __name__ == "__main__":
    raise SystemExit(main())
