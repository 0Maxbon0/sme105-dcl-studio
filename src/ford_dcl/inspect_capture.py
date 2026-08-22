"""Read-only summaries for ASCII and binary capture sessions."""

from __future__ import annotations

import json
import statistics
from collections import Counter
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

from .capture import ParsedToken, TextTokenParser
from .transport import (
    Direction,
    RecordType,
    TransportDecodeError,
    TransportRecord,
    TransportStreamDecoder,
)
from .words import ByteAlignment, decode_pairs

_UART_STATUS_FLAGS = {
    0x01: "fifo_overflow",
    0x02: "rx_buffer_full",
    0x04: "frame_error",
    0x08: "parity_error",
    0x10: "break",
    0x20: "break_data_suppressed",
}


def _rate(numerator: int, denominator: int) -> float | None:
    return numerator / denominator if denominator else None


def candidate_pair_alignments(values: bytes) -> list[dict[str, Any]]:
    """Report Ford vertical-nibble parity validity at both byte offsets."""

    candidates: list[dict[str, Any]] = []
    for offset in (0, 1):
        stream = decode_pairs(values, offset)
        pair_count = len(stream.words)
        first_valid = sum(
            word.candidate(ByteAlignment.FIRST_BYTE_HIGH).valid for word in stream.words
        )
        second_valid = sum(
            word.candidate(ByteAlignment.SECOND_LOW_HIGH).valid for word in stream.words
        )
        candidates.append(
            {
                "offset": offset,
                "pair_count": pair_count,
                "valid_word_count": stream.valid_count,
                "invalid_word_count": stream.invalid_count,
                "vertical_nibble_parity_valid_rate": _rate(
                    stream.valid_count, pair_count
                ),
                "first_byte_high_valid_rate": _rate(first_valid, pair_count),
                "second_low_high_valid_rate": _rate(second_valid, pair_count),
                "orphan_byte_count": (
                    len(stream.leading_bytes) + len(stream.trailing_bytes)
                ),
            }
        )
    return candidates


def repeat_summary(values: bytes) -> dict[str, Any]:
    """Summarize adjacent repeats and the longest same-value run."""

    repeats = sum(left == right for left, right in zip(values, values[1:]))
    longest = 0
    current = 0
    prior: int | None = None
    run_value: int | None = None
    for value in values:
        if value == prior:
            current += 1
        else:
            current = 1
            prior = value
        if current > longest:
            longest = current
            run_value = value
    return {
        "adjacent_repeat_count": repeats,
        "adjacent_repeat_rate": _rate(repeats, max(0, len(values) - 1)),
        "longest_run": longest,
        "longest_run_value": f"{run_value:02X}" if run_value is not None else None,
        "most_common": [
            {"value": f"{value:02X}", "count": count}
            for value, count in Counter(values).most_common(8)
        ],
    }


def _load_events(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"invalid JSON at events line {line_number}: {exc}"
                ) from exc
            if not isinstance(event, dict):
                raise ValueError(f"events line {line_number} is not an object")
            events.append(event)
    return events


def _parse_ascii(
    raw_paths: Iterable[Path],
) -> tuple[bytes, dict[str, int], tuple[dict[str, str], ...]]:
    parser = TextTokenParser()
    counts: Counter[str] = Counter()
    parsed = bytearray()
    text_tokens: list[dict[str, str]] = []

    def consume(token: ParsedToken) -> None:
        counts[token.kind] += 1
        if token.value is not None:
            parsed.append(token.value)
        elif len(text_tokens) < 8:
            text_tokens.append(
                {
                    "kind": token.kind,
                    "text": token.raw.decode("ascii", errors="backslashreplace"),
                }
            )

    for path in raw_paths:
        for token in parser.feed(path.read_bytes()):
            consume(token)
    for token in parser.feed(b"", final=True):
        consume(token)
    return bytes(parsed), dict(sorted(counts.items())), tuple(text_tokens)


def _parse_binary(
    raw_paths: Iterable[Path],
) -> tuple[tuple[TransportRecord, ...], tuple[TransportDecodeError, ...]]:
    decoder = TransportStreamDecoder()
    records: list[TransportRecord] = []
    errors: list[TransportDecodeError] = []
    for path in raw_paths:
        batch = decoder.feed(path.read_bytes())
        records.extend(batch.records)
        errors.extend(batch.errors)
    final = decoder.finish()
    records.extend(final.records)
    errors.extend(final.errors)
    return tuple(records), tuple(errors)


def _enum_label(enum_type: type[Direction | RecordType], value: int) -> str:
    try:
        return enum_type(value).name.lower()
    except ValueError:
        return f"unknown_0x{value:02X}"


def _transport_summary(
    records: Sequence[TransportRecord],
    errors: Sequence[TransportDecodeError],
) -> dict[str, Any]:
    type_counts = Counter(
        _enum_label(RecordType, record.record_type) for record in records
    )
    direction_counts = Counter(
        _enum_label(Direction, record.direction) for record in records
    )
    status_counts = Counter(f"0x{record.status:02X}" for record in records)
    status_flag_counts = Counter(
        label
        for record in records
        for bit, label in _UART_STATUS_FLAGS.items()
        if record.status & bit
    )
    uart_status_flags = Counter(
        f"0x{record.status:02X}"
        for record in records
        if record.record_type == RecordType.UART_STATUS
    )
    error_counts = Counter(error.code for error in errors)
    data_records = [
        record for record in records if record.record_type == RecordType.DATA
    ]
    regressions = sum(
        current.timestamp_us < previous.timestamp_us
        for previous, current in zip(data_records, data_records[1:])
    )
    return {
        "validated_record_count": len(records),
        "data_record_count": len(data_records),
        "uart_status_record_count": sum(
            record.record_type == RecordType.UART_STATUS for record in records
        ),
        "error_count": len(errors),
        "crc_error_count": error_counts["crc_mismatch"],
        "error_counts": dict(sorted(error_counts.items())),
        "type_counts": dict(sorted(type_counts.items())),
        "direction_counts": dict(sorted(direction_counts.items())),
        "status_counts": dict(sorted(status_counts.items())),
        "status_flag_counts": dict(sorted(status_flag_counts.items())),
        "uart_status_flag_counts": dict(sorted(uart_status_flags.items())),
        "data_timestamp_regressions": regressions,
    }


def _gap_summary(
    timestamps: Sequence[int],
    *,
    divisor_to_ms: float,
    gap_ms: float,
    basis: str,
) -> dict[str, Any]:
    intervals = [
        current - previous
        for previous, current in zip(timestamps, timestamps[1:])
        if current >= previous
    ]
    threshold = gap_ms * divisor_to_ms
    gaps = [interval for interval in intervals if interval >= threshold]
    return {
        "basis": basis,
        "threshold_ms": gap_ms,
        "interval_count": len(intervals),
        "gap_count": len(gaps),
        "maximum_ms": max(intervals) / divisor_to_ms if intervals else None,
        "median_ms": (
            statistics.median(intervals) / divisor_to_ms if intervals else None
        ),
    }


def inspect_session(session_dir: Path, gap_ms: float = 10.0) -> dict[str, Any]:
    """Return a JSON-serializable, format-aware capture summary."""

    if gap_ms < 0:
        raise ValueError("gap_ms cannot be negative")
    metadata_path = session_dir / "metadata.json"
    events_path = session_dir / "events.jsonl"
    if not metadata_path.is_file() or not events_path.is_file():
        raise FileNotFoundError("session requires metadata.json and events.jsonl")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    capture_format = str(metadata.get("format", "ascii"))
    if capture_format not in {"ascii", "binary"}:
        raise ValueError(f"unsupported capture format: {capture_format!r}")
    raw_paths = sorted(session_dir.glob("usb-*.bin"))
    raw_usb_bytes = sum(path.stat().st_size for path in raw_paths)
    events = _load_events(events_path)
    event_counts = Counter(str(event.get("event", "unknown")) for event in events)
    transport: dict[str, Any] | None = None

    if capture_format == "ascii":
        values, parser_counts, text_tokens = _parse_ascii(raw_paths)
        observed = [
            (int(event["monotonic_ns"]), bytes.fromhex(str(event["data"])))
            for event in events
            if event.get("event") == "hex_bytes"
        ]
        event_values = b"".join(item[1] for item in observed)
        gaps = _gap_summary(
            [item[0] for item in observed],
            divisor_to_ms=1_000_000,
            gap_ms=gap_ms,
            basis="host monotonic timestamps between ASCII hex-byte events",
        )
        event_data_match = event_values == values
    else:
        records, errors = _parse_binary(raw_paths)
        data_records = tuple(
            record for record in records if record.record_type == RecordType.DATA
        )
        values = bytes(record.value for record in data_records)
        parser_counts = {}
        gaps = _gap_summary(
            [record.timestamp_us for record in data_records],
            divisor_to_ms=1_000,
            gap_ms=gap_ms,
            basis="MCU timestamp_us between validated data records",
        )
        transport = _transport_summary(records, errors)
        event_records = [
            (
                int(event["type"]),
                int(event["direction"]),
                int(event["status"]),
                int(event["timestamp_us"]),
                int(event["value"]),
            )
            for event in events
            if event.get("event") == "transport_record"
        ]
        raw_records = [
            (
                record.record_type,
                record.direction,
                record.status,
                record.timestamp_us,
                record.value,
            )
            for record in records
        ]
        event_data_match = event_records == raw_records
        text_tokens = ()

    concern_names = (
        "malformed_text",
        "token_overflow",
        "overflow_concern",
        "transport_error",
        "disconnected",
        "connect_failed",
        "close_error",
    )
    concerns = {
        name: event_counts[name] for name in concern_names if event_counts[name]
    }
    summary: dict[str, Any] = {
        "session": str(session_dir),
        "format": capture_format,
        "metadata": metadata,
        "files": [
            {"name": path.name, "size": path.stat().st_size} for path in raw_paths
        ],
        "raw_usb_bytes": raw_usb_bytes,
        "parsed_byte_count": len(values),
        "event_raw_match": event_data_match,
        "parser_counts": parser_counts,
        "text_tokens": text_tokens,
        "event_counts": dict(sorted(event_counts.items())),
        "concerns": concerns,
        "gaps": gaps,
        "repeats": repeat_summary(values),
        "candidate_pair_alignments": candidate_pair_alignments(values),
        "interpretation": (
            "Pair offsets and vertical-nibble parity are evidence only; USB line "
            "breaks and SLIP record boundaries are not asserted as DCL frames."
        ),
    }
    if transport is not None:
        summary["transport"] = transport
    return summary


def _percent(value: float | None) -> str:
    return "n/a" if value is None else f"{value:.2%}"


def format_summary(summary: dict[str, Any]) -> str:
    """Render a concise human-readable inspection summary."""

    metadata = summary["metadata"]
    gaps = summary["gaps"]
    repeats = summary["repeats"]
    maximum = gaps["maximum_ms"]
    lines = [
        f"Session: {summary['session']}",
        f"Format: {summary['format']}",
        f"Created UTC: {metadata.get('created_utc', 'unknown')}",
        f"Port / baud: {metadata.get('port', 'unknown')} / "
        f"{metadata.get('usb_baudrate', 'unknown')}",
        f"Raw USB: {summary['raw_usb_bytes']} bytes in {len(summary['files'])} file(s)",
        f"Validated DCL bytes: {summary['parsed_byte_count']} "
        f"(event/raw match: {summary['event_raw_match']})",
        f"Gaps >= {gaps['threshold_ms']} ms: {gaps['gap_count']} "
        f"(max: {maximum if maximum is not None else 'n/a'} ms; {gaps['basis']})",
        f"Adjacent repeats: {repeats['adjacent_repeat_count']} "
        f"({_percent(repeats['adjacent_repeat_rate'])}); "
        f"longest run: {repeats['longest_run']} of "
        f"{repeats['longest_run_value'] or 'n/a'}",
    ]
    if "transport" in summary:
        transport = summary["transport"]
        lines.extend(
            (
                f"Transport: {transport['validated_record_count']} valid, "
                f"{transport['error_count']} errors, "
                f"{transport['crc_error_count']} CRC errors",
                f"Directions: {transport['direction_counts']}",
                f"Statuses: {transport['status_counts']} "
                f"({transport['status_flag_counts']}); "
                f"UART status flags: {transport['uart_status_flag_counts']}",
            )
        )
    for token in summary.get("text_tokens", ()):
        lines.append(f"Text token ({token['kind']}): {token['text']!r}")
    for candidate in summary["candidate_pair_alignments"]:
        lines.append(
            f"Pair offset {candidate['offset']}: {candidate['pair_count']} candidates; "
            f"vertical nibble parity valid "
            f"{_percent(candidate['vertical_nibble_parity_valid_rate'])}"
        )
    concerns = summary["concerns"]
    lines.append(
        "Concerns: "
        + (
            ", ".join(f"{name}={count}" for name, count in concerns.items())
            if concerns
            else "none logged"
        )
    )
    lines.append(str(summary["interpretation"]))
    return "\n".join(lines)
