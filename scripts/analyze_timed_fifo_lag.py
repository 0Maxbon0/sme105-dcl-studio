#!/usr/bin/env python3
"""Offline forensic recovery of ID-only CART bytes from delayed UART RX IRQs.

Experimental: observed UART2 FIFO threshold=1 queued the previous byte until
the NEXT receive IRQ. Associate each value with the preceding IRQ timestamp
only to characterize an already-recorded ID-only stream. This NEVER proves
physical bus edges, active B slot scheduling, ECU origin or stored DTCs.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from itertools import pairwise
from pathlib import Path

EVENT = re.compile(rb"^CART_EVT t_us=(\d+) byte=([0-9A-F]{2})$")
SUMMARY = re.compile(
    rb"^CART_CAPTURE n=(\d+) uart_errors=(\d+) coalesced=(\d+) "
    rb"overflow=(\d+) cutoff=(\d+) capped=(\d+)$"
)
EXPECTED_HEADER = (b"CART_BEGIN recorded_9600_8N1 RX_ISR duration_ms_max=10000 B_TX=OFF")
EXPECTED_END = b"CART_END DTC_UNVERIFIED B_TX_LOCKED"


def inspect(raw: bytes) -> dict:
    result = {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "is_ecu_source_authenticated": False,
        "is_dtc_read_verified": False,
        "physical_byte_timing_verified": False,
        "method": "offline_one_irq_lag_hypothesis_not_hardware_verified",
        "validated_full_frames": 0,
        "full_16_id_cycles": 0,
    }
    if not 0 < len(raw) <= 1_000_000:
        result["reason"] = "file empty or oversized"
        return result
    lines = raw.replace(b"\r\n", b"\n").splitlines()
    if lines.count(EXPECTED_HEADER) != 1 or lines.count(EXPECTED_END) != 1:
        result["reason"] = "not one complete native B-locked capture"
        return result
    totals = [m for line in lines if (m := SUMMARY.fullmatch(line))]
    if len(totals) != 1:
        result["reason"] = "missing unique UART health summary"
        return result
    n, *faults = (int(v) for v in totals[0].groups())
    if any(faults):
        result["reason"] = "UART faults, overflow, cap or watchdog cutoff"
        return result
    events = [(int(m[1]), int(m[2], 16)) for line in lines
              if (m := EVENT.fullmatch(line))]
    if len(events) != n or n < 65 or any(
        b[0] <= a[0] for a, b in pairwise(events)
    ):
        result["reason"] = "incomplete, missing or disordered raw UART events"
        return result

    # Characterize one-byte-delayed FIFO IRQ evidence without rewriting its
    # original timestamps. The last reported IRQ has no successor in this
    # purely retrospective model; never fill in or synthesize that sample.
    shifted = [(events[i - 1][0], events[i][1]) for i in range(1, n)]

    def parity(ident: int) -> int:
        return ((ident ^ 10) << 4) | ident

    def near(actual: int, expected: int, tol: int = 175) -> bool:
        return abs(actual - expected) <= tol

    def valid_frame(i: int, frame_id: int, phase: int | None) -> int | None:
        if i + 4 > len(shifted):
            return None
        frame = shifted[i:i + 4]
        if [v for _, v in frame] != [0, 0, 0, parity(frame_id)]:
            return None
        first, second, third, fourth = (t for t, _ in frame)
        if not near(second - first, 1042) or not near(fourth - third, 1042):
            return None
        observed_phase = next((p for p, gap in ((0, 1042), (4, 1458))
                               if near(third - second, gap)), None)
        if observed_phase is None or (phase is not None and observed_phase != phase):
            return None
        return observed_phase

    best = (0, -1, -1)
    for start in range(len(shifted) - 63):
        phase = valid_frame(start, 0, None)
        if phase is None:
            continue
        frames = 0
        while True:
            index = start + frames * 4
            if valid_frame(index, frames & 15, phase) is None:
                break
            if frames:
                delta = shifted[index + 1][0] - shifted[index - 3][0]
                if not near(delta, 10000):
                    break
            frames += 1
        if frames > best[0]:
            best = (frames, start, phase)

    frames, start, phase = best
    if frames < 16:
        result["reason"] = "no sustained exact 16-ID cycles even under FIFO-lag hypothesis"
        return result
    result.update({
        "classification": "reference_compatible_id_only_cart_fifo_lag_forensic",
        "original_raw_uart_events": n,
        "initial_unvalidated_bytes": start + 1,
        "validated_full_frames": frames,
        "full_16_id_cycles": frames // 16,
        "inferred_header_phase_bits": phase,
        "remaining_unvalidated_bytes": len(shifted) - (start + frames * 4),
        "b_request_transmitted": False,
    })
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    args = parser.parse_args()
    report = inspect(args.capture.read_bytes())
    print(json.dumps(report, indent=2))
    return 0 if report.get("validated_full_frames", 0) >= 16 else 3


if __name__ == "__main__":
    raise SystemExit(main())
