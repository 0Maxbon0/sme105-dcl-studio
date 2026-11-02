#!/usr/bin/env python3
"""Validate a SME105_FIELD_V1 raw transcript without guessing fault codes.

Input is an immutable capture from scripts/sme105_field_session.py.
Frame IDs/vertical parity are only a structural *candidate* for Ford CART.
No UART transcript authenticates source, physical timing or DTC identity.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

START = re.compile(rb"^CAPTURE_START mode=([A-Z0-9_]+) duration_ms=(\d+)$")
DATA = re.compile(rb"^(?:RAW t_ms=\d+|RAW_END) n=(\d+) hex=([0-9A-F ]+)$")
END = re.compile(
    rb"^CAPTURE_END bytes=(\d+) uart_errors=(\d+) headers4=(\d+) "
    rb"invalid4=(\d+) order_errors=(\d+) partial4=(\d+) "
    rb"started_id0=([01]) stopped=([01]) capped=([01])$"
)


def analyze(raw: bytes) -> dict:
    """Return evidence classification. All rejected/incomplete data stays raw."""
    if not isinstance(raw, bytes):
        raise TypeError("raw capture must be bytes")
    if not raw or len(raw) > 1_000_000:
        raise ValueError("empty or oversized field capture")
    lines = raw.replace(b"\r\n", b"\n").splitlines()
    starts = [START.fullmatch(line) for line in lines if line.startswith(b"CAPTURE_START ")]
    ends = [END.fullmatch(line) for line in lines if line.startswith(b"CAPTURE_END ")]
    if len(starts) != 1 or starts[0] is None or len(ends) != 1 or ends[0] is None:
        raise ValueError("missing or duplicate structured CAPTURE_START/CAPTURE_END")
    start, end = starts[0], ends[0]
    parts = []
    for line in lines:
        if line.startswith((b"RAW ", b"RAW_END ")):
            match = DATA.fullmatch(line)
            if match is None:
                raise ValueError("invalid/truncated RAW line")
            try:
                segment = bytes.fromhex(match.group(2).decode("ascii"))
            except ValueError as exc:
                raise ValueError("invalid HEX data") from exc
            if len(segment) != int(match.group(1)):
                raise ValueError("declared RAW byte count mismatch")
            if not segment or len(segment) > 16:
                raise ValueError("RAW line must contain 1..16 bytes")
            parts.append(segment)
    data = b"".join(parts)
    values = list(map(int, end.groups()))
    (
        declared_bytes, uart_errors, headers, invalid, ordering,
        partial, started_zero, stopped, capped,
    ) = values
    if declared_bytes != len(data):
        raise ValueError("CAPTURE_END byte count does not match raw UART bytes")
    if headers + invalid != len(data) // 4 or partial != len(data) % 4:
        raise ValueError("CAPTURE_END quartet accounting mismatch")
    if not lines or not any(b"NOTE raw quartets are ID-only candidates" in item for item in lines):
        raise ValueError("firmware completion note missing")
    complete = uart_errors == stopped == capped == 0
    # This segmentation is only permissible as an ID-only hypothesis if the
    # entirety of the received data aligns to complete zero-payload quartets.
    valid_quartets = invalid == ordering == partial == 0 and started_zero == 1
    id_only = bool(data) and complete and valid_quartets
    for index in range(0, len(data), 4) if id_only else []:
        head = data[index:index+4]
        ident = head[3] & 15
        parity = (((head[2] >> 4) ^ (head[2] & 15) ^ ident ^ 10) & 15) << 4 | ident
        if head[:2] != b"\x00\x00" or head[3] != parity or ident != ((index // 4) & 15):
            id_only = False
            break
    if not complete:
        classification = "incomplete-or-uart-error"
    elif id_only:
        classification = "candidate-cart-id-only-no-dtc-words"
    elif not data:
        classification = "silent-capture"
    else:
        classification = "unsegmented-raw-data-no-validated-dtc"
    return {
        "mode": start.group(1).decode("ascii"),
        "duration_ms_requested": int(start.group(2)),
        "total_bytes": len(data),
        "uart_errors": uart_errors,
        "capped": bool(capped),
        "operator_stopped": bool(stopped),
        "quartets": headers,
        "parity_or_header_invalid": invalid,
        "id_order_errors": ordering,
        "partial_quartet_bytes": partial,
        "classification": classification,
        "is_dtc_read": False,
        "is_ecu_source_authenticated": False,
        "raw_hex_preview": data[:64].hex(" ").upper(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = analyze(args.capture.read_bytes())
    except (OSError, TypeError, ValueError) as exc:
        print(f"Invalid capture: {exc}", file=sys.stderr)
        return 2
    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(
            f"{result['mode']}: {result['total_bytes']} bytes, "
            f"UART errors={result['uart_errors']}, "
            f"{result['classification']}; DTC not verified"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
