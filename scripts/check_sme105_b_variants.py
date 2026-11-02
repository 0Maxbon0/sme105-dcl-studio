#!/usr/bin/env python3
"""Evaluate both non-clearing CART B candidates against recorded FIFO timing.

This is an offline preflight, not a vehicle transmit/enable/flash tool.
The full header word arrives late through V5 RXFIFO_FULL=1; never let a
reference-compatible byte stream masquerade as a collision-free TX schedule.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

if __package__:
    from .analyze_timed_fifo_lag import inspect
else:
    from analyze_timed_fifo_lag import inspect

EVENT = re.compile(rb"^CART_EVT t_us=(\d+) byte=([0-9A-F]{2})$")
VARIANTS = {
    "A4": ("01B0", "FF5F", "26A4", "00A0"),
    "0E": ("01B0", "FF5F", "260E", "00A0"),
}


def evaluate(raw: bytes) -> dict:
    forensic = inspect(raw)
    result = {
        "sha256": forensic["sha256"],
        "bus_tx_authorized": False,
        "ecu_dtc_verified": False,
        "variants": [],
    }
    if forensic.get("validated_full_frames", 0) < 32:
        result["reason"] = "capture lacks 32 validated ID-only frames"
        return result
    lines = raw.replace(b"\r\n", b"\n").splitlines()
    events = [(int(m[1]), int(m[2], 16)) for line in lines
              if (m := EVENT.fullmatch(line))]
    # First confirmed frame after the unvalidated prefix. The fourth header
    # word is physically preceded by a pending UART full-threshold IRQ; the
    # application learns its byte value only on the *next* interrupt.
    start = forensic["initial_unvalidated_bytes"]
    if start + 4 > len(events):
        result["reason"] = "incomplete first confirmed ID0"
        return result
    header = events[start:start + 4]
    if [v for _, v in header] != [0, 0, 0, 0xA0]:
        result["reason"] = "ID0 bytes do not match confirmed forensic offset"
        return result
    # V5's one-event-late ISR: index=start+1 holds sync2 IRQ timestamp,
    # observed parity value isn't supplied to software until index=start+3
    # IRQ, i.e. after another frame sync.
    sync2_us = events[start][0]
    nominal_first_slot_us = sync2_us + 2917
    parity_available_us = events[start + 3][0]
    late_us = parity_available_us - nominal_first_slot_us
    result["timing"] = {
        "first_id0_sync2_irq_us": sync2_us,
        "first_slot_candidate_us": nominal_first_slot_us,
        "header_parity_available_to_software_us": parity_available_us,
        "late_us": late_us,
        "source": "V5 FIFO threshold=1 observed timestamps, not independent bus edges",
    }
    for name, words in VARIANTS.items():
        result["variants"].append({
            "name": "26 " + name,
            "read_codes_candidate": True,
            "four_command_words": list(words),
            "requested_slots": 4 if name == "A4" else 14,
            "can_send_on_car": False,
            "reason": "header parity not available in time to safely arm slot1"
            if late_us > 0 else
            "physical DE, contention and ECU-variant proof missing",
        })
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    args = parser.parse_args()
    result = evaluate(args.capture.read_bytes())
    print(json.dumps(result, indent=2))
    return 0 if "timing" in result else 3


if __name__ == "__main__":
    raise SystemExit(main())
