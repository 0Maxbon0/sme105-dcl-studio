#!/usr/bin/env python3
"""Offline Ford CART reference-pattern audit; NEVER opens serial or transmits.

Usage: ./.venv/bin/python scripts/analyze_cart_once.py <CART_ONCE transcript>
This checks source bytes and parity/ordering, NOT the physical signal origin,
sensor readings, or ECU safety.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

CART_RX = re.compile(
    r"^CART_RX t_ms=(\d+) n=(\d+) hex=([0-9A-Fa-f ]+)$"
)
CART_RX_END = re.compile(
    r"^CART_RX_END n=(\d+) hex=([0-9A-Fa-f ]+)$"
)
DONE = re.compile(r"^CART_DONE bytes=(\d+) uart_errors=(\d+)$")
TRUNCATED_DONE = re.compile(r"^CART_DONE bytes=(\d+) uart_errors$")
REQUIRED_HELLO = (
    "HELLO_RX n=12 hex=00 00 00 00 00 01 82 00 00 00 83 01"
)


def parity_frame_id(index: int) -> bytes:
    """Reference sync word (00 00) followed by parity-coded ID word."""
    return bytes((0, 0, 0, ((index ^ 0x0A) << 4) | index))


REFERENCE_CYCLE = b"".join(parity_frame_id(i) for i in range(16))


def iter_frame_rows(content: str):
    """Emit frames with host *batch* time; not invented per-byte timestamps."""
    accumulated = bytearray()
    index = 0
    batch_idx = 0
    for line in content.splitlines():
        matched = CART_RX.fullmatch(line)
        matched_end = CART_RX_END.fullmatch(line) if not matched else None
        if matched:
            t_ms, declared_count, encoded = matched.groups()
        elif matched_end:
            declared_count, encoded = matched_end.groups()
            t_ms = None  # CART_RX_END has no physical or batch timestamp
        else:
            continue
        payload = bytes.fromhex(encoded)
        if len(payload) != int(declared_count):
            raise ValueError("CART_RX declared count differs from hex payload")
        accumulated.extend(payload)
        while len(accumulated) >= 4:
            raw = bytes(accumulated[:4])
            del accumulated[:4]
            frame_id = raw[-1] & 0x0F
            yield {
                "frame_index": index,
                "host_batch_index": batch_idx,
                "host_batch_t_ms": int(t_ms) if t_ms is not None else "",
                "frame_id": frame_id,
                "sync_and_id_hex": raw.hex(" ").upper(),
                "reference_sync_id_match": raw == parity_frame_id(frame_id),
                "reference_order_match": frame_id == index % 16,
            }
            index += 1
        batch_idx += 1
    if accumulated:
        raise ValueError("incomplete final sync/ID quartet")


def analyze_text(content: str) -> dict:
    lines = content.splitlines()
    samples = []
    invalid_lines = []
    stamps = []
    chunk_sizes = []
    for line in lines:
        match = CART_RX.fullmatch(line)
        if match:
            time_ms, count_text, encoded = match.groups()
            payload = bytes.fromhex(encoded)
            if len(payload) != int(count_text):
                invalid_lines.append(line)
            samples.append(payload)
            chunk_sizes.append(len(payload))
            stamps.append(int(time_ms))
            continue
        match = CART_RX_END.fullmatch(line)
        if match:
            declared, encoded = match.groups()
            payload = bytes.fromhex(encoded)
            if len(payload) != int(declared):
                invalid_lines.append(line)
            samples.append(payload)
            continue
        if line.startswith("CART_RX"):
            invalid_lines.append(line)
    data = b"".join(samples)
    ending = next((line for line in reversed(lines)
                   if line.startswith("CART_DONE")), None)
    done = DONE.fullmatch(ending) if ending else None
    truncated_done = bool(ending and TRUNCATED_DONE.fullmatch(ending))

    frame_count = len(data) // 4
    invalid_frames = 0
    ids = Counter()
    for start in range(0, frame_count * 4, 4):
        four = data[start:start + 4]
        index = four[-1] & 0x0F
        ids[index] += 1
        if four != parity_frame_id(index):
            invalid_frames += 1
    expected = bytes(REFERENCE_CYCLE[i % len(REFERENCE_CYCLE)]
                     for i in range(len(data)))
    complete_cycles, leftover = divmod(len(data), len(REFERENCE_CYCLE))
    deltas = [b - a for a, b in zip(stamps, stamps[1:])]
    exact_cycle = data == expected and not invalid_lines
    id_order = [data[pos + 3] & 0x0F for pos in range(0, frame_count * 4, 4)]
    ordered_ids = all(id_order[i] == i % 16 for i in range(len(id_order)))
    has_header = "CART_MONITOR 9600 8N1 duration_ms=10000 TX_DISABLED" in lines
    reported_byte_count = int(done.group(1)) if done else (
        int(TRUNCATED_DONE.fullmatch(ending).group(1))
        if truncated_done else None
    )
    warnings = []
    if ending is None:
        warnings.append("missing_cart_done_line")
    elif truncated_done:
        warnings.append("uart_error_count_missing_from_truncated_terminal_line")
    elif not done:
        warnings.append("malformed_cart_done_line")
    if reported_byte_count is not None and reported_byte_count != len(data):
        warnings.append("firmware_and_transcript_byte_count_disagree")
    if any(delta <= 0 for delta in deltas):
        warnings.append("non_monotonic_or_repeated_chunk_timestamp")
    if invalid_lines:
        warnings.append("malformed_cart_rx_lines")
    if not has_header:
        warnings.append("missing_cart_monitor_9600_8n1_banner")
    return {
        "hello_exact_candidate": REQUIRED_HELLO in lines,
        "go_cart_sent_reported": "TX_FRAME GO_CART bytes=11 watchdog=OK" in lines,
        "cart_monitor_9600_8n1_reported": has_header,
        "cart_rx_chunk_count": len(stamps),
        "cart_rx_chunk_size_histogram": {str(k): v for k, v in sorted(Counter(chunk_sizes).items())},
        "first_chunk_t_ms": stamps[0] if stamps else None,
        "last_chunk_t_ms": stamps[-1] if stamps else None,
        "mean_chunk_interval_ms": round(sum(deltas) / len(deltas), 3) if deltas else None,
        "inferred_frame_interval_ms": round(sum(deltas) / len(deltas) / 4, 3)
        if deltas and all(size == 16 for size in chunk_sizes) else None,
        "decoded_byte_count": len(data),
        "firmware_reported_byte_count": reported_byte_count,
        "firmware_uart_errors": int(done.group(2)) if done else None,
        "firmware_uart_errors_known": done is not None,
        "truncated_cart_done_line": truncated_done,
        "full_reference_cycles": complete_cycles,
        "remaining_bytes": leftover,
        "frame_count": frame_count,
        "trailing_incomplete_frame_bytes": len(data) % 4,
        "invalid_frame_quartets": invalid_frames,
        "ordered_0_to_15_ids": ordered_ids,
        "exact_16_id_cycle": exact_cycle,
        "sync_and_id_only": exact_cycle,
        "raw_bytes_not_part_of_sync_or_id": 0 if exact_cycle else None,
        "frame_ids": {str(i): ids[i] for i in range(16)},
        "host_chunk_interval_ms": dict(sorted(Counter(deltas).items())),
        "malformed_transcript_lines": invalid_lines,
        "integrity_warnings": warnings,
        "source_is_independently_verified_as_ecu": False,
        "sensor_measurements_present": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--frames-csv", type=Path,
                        help="create-only CSV with frame ID, parity and host batch time")
    args = parser.parse_args()
    content = args.path.read_text(encoding="utf-8", errors="replace")
    result = analyze_text(content)
    result["source_sha256"] = hashlib.sha256(args.path.read_bytes()).hexdigest()
    if args.frames_csv:
        rows = list(iter_frame_rows(content))
        if result["malformed_transcript_lines"]:
            parser.error("refusing to export from malformed UART transcript")
        with args.frames_csv.open("x", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=[
                "frame_index", "host_batch_index", "host_batch_t_ms",
                "frame_id", "sync_and_id_hex", "reference_sync_id_match",
                "reference_order_match",
            ])
            writer.writeheader()
            writer.writerows(rows)
    if args.json:
        print(json.dumps(result, indent=2, sort_keys=True))
    else:
        print(f"Source transcript: {args.path}")
        print("Echo-ID candidate ACK:", result["hello_exact_candidate"])
        print("Go CART TX reported:", result["go_cart_sent_reported"])
        print("CART bytes:", result["decoded_byte_count"])
        print("Full 16-frame cycles:", result["full_reference_cycles"],
              "plus bytes:", result["remaining_bytes"])
        print("Frame count:", result["frame_count"],
              "frame IDs ordered:", result["ordered_0_to_15_ids"])
        print("First/last host batch (ms):", result["first_chunk_t_ms"],
              result["last_chunk_t_ms"])
        print("Mean 16-byte host batch interval (ms):",
              result["mean_chunk_interval_ms"])
        print("Every byte matches the 16-ID zero-payload cycle:",
              result["exact_16_id_cycle"])
        print("Invalid frame quartets:", result["invalid_frame_quartets"])
        print("UART errors:", result["firmware_uart_errors"]
              if result["firmware_uart_errors_known"]
              else "UNKNOWN (terminal CART_DONE line truncated in host log)")
        print("This is reference-compatible CART sync/ID traffic, NOT decoded")
        print("sensor measurements; electrical origin remains unverified.")
        print("Source SHA256:", result["source_sha256"])
        if result["integrity_warnings"]:
            print("Warnings:", ", ".join(result["integrity_warnings"]))
    return 0 if not result["malformed_transcript_lines"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
