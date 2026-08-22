"""Read-only analysis and capture command-line entry point."""

from __future__ import annotations

import argparse
import json
import re
import sys
import threading
from collections.abc import Sequence
from pathlib import Path

from .capture import CaptureConfig, SerialCapture
from .decode import decode_payload
from .diagnosis import classify_high_idle, load_evidence
from .dtc import DTCSource, decode_dtcs
from .framing import analyze_framing
from .inspect_capture import format_summary, inspect_session
from .markers import append_marker
from .profile import load_profile
from .serializers import REFERENCE_NOTICE, dtc_document, framing_document

_SIZE_PATTERN = re.compile(r"^([1-9][0-9]*)([KMG]?I?B)?$", re.IGNORECASE)
_SIZE_MULTIPLIERS = {
    None: 1,
    "B": 1,
    "KB": 1000,
    "MB": 1000**2,
    "GB": 1000**3,
    "KIB": 1024,
    "MIB": 1024**2,
    "GIB": 1024**3,
}


def parse_size(value: str) -> int:
    """Parse a positive byte size such as ``1048576`` or ``64MiB``."""

    match = _SIZE_PATTERN.fullmatch(value.strip())
    if match is None:
        raise argparse.ArgumentTypeError(f"invalid size: {value!r}")
    number = int(match.group(1))
    suffix = match.group(2)
    multiplier = _SIZE_MULTIPLIERS.get(suffix.upper() if suffix else None)
    if multiplier is None:
        raise argparse.ArgumentTypeError(f"invalid size suffix: {suffix!r}")
    return number * multiplier


def parse_payload_hex(value: str) -> bytes:
    """Parse whitespace-tolerant, complete hexadecimal bytes."""

    compact = "".join(value.split())
    if len(compact) % 2:
        raise ValueError("hex payload must contain complete bytes")
    try:
        return bytes.fromhex(compact)
    except ValueError as exc:
        raise ValueError("payload contains non-hexadecimal characters") from exc


def parse_dtc_code(value: str) -> int:
    """Parse a decimal printed code or explicit hexadecimal 12-bit value."""

    text = value.strip()
    base = (
        16
        if text.lower().startswith("0x")
        or any(character in "ABCDEFabcdef" for character in text)
        else 10
    )
    try:
        code = int(text, base)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"invalid DTC code: {value!r}") from exc
    if not 0 <= code <= 0xFFF:
        raise argparse.ArgumentTypeError("DTC code must be between 0 and 0xFFF")
    return code


def build_parser() -> argparse.ArgumentParser:
    """Construct the CLI parser."""

    parser = argparse.ArgumentParser(
        prog="ford-dcl",
        description="Capture and read-only analysis for Ford EEC-IV DCL observations.",
    )
    subcommands = parser.add_subparsers(dest="command", required=True)

    capture = subcommands.add_parser(
        "capture",
        help="preserve and parse an ESP USB stream",
        description=(
            "Write exact USB bytes before parsing ASCII tokens or validated binary "
            "SLIP records. No DCL transmission is performed."
        ),
    )
    capture.add_argument("port", help="serial device, for example /dev/ttyACM0")
    capture.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("captures"),
        help="parent directory for immutable timestamped sessions",
    )
    capture.add_argument("--baudrate", type=int, default=115_200)
    capture.add_argument(
        "--format",
        choices=("ascii", "binary"),
        default="ascii",
        help="ESP USB content format (default: ascii)",
    )
    capture.add_argument(
        "--rotate-size",
        type=parse_size,
        default=64 * 1024 * 1024,
        help="maximum raw file size, for example 64MiB",
    )
    capture.add_argument("--read-size", type=parse_size, default=16 * 1024)
    capture.add_argument("--reconnect-delay", type=float, default=1.0)
    capture.add_argument(
        "--no-reconnect",
        action="store_true",
        help="stop after an open failure or disconnect",
    )
    capture.add_argument("--session-label")
    capture.add_argument("--dcl-baud", type=int)
    capture.add_argument("--dcl-format", default="8N2")
    capture.add_argument("--firmware")
    capture.add_argument("--adapter")
    capture.add_argument(
        "--ignition-state",
        choices=("off", "koeo", "cranking", "running"),
    )
    capture.add_argument("--engine-state")
    capture.add_argument(
        "--duration",
        type=float,
        help="stop cleanly after this many seconds",
    )

    inspect = subcommands.add_parser(
        "inspect",
        help="summarize a completed or interrupted capture",
    )
    inspect.add_argument("session", type=Path, help="timestamped session directory")
    inspect.add_argument(
        "--gap-ms",
        type=float,
        default=10.0,
        help="host or MCU interval reported as a gap",
    )
    inspect.add_argument("--json", action="store_true", help="emit JSON")

    decode = subcommands.add_parser(
        "decode",
        help="decode payload fields using an unverified/reference profile",
    )
    decode.add_argument("payload_hex")
    decode.add_argument("--profile", type=Path, help="decoder profile JSON path")
    decode.add_argument("--json", action="store_true", help="emit JSON")

    frame = subcommands.add_parser(
        "frame",
        help="score framing and parity hypotheses without asserting frames",
    )
    frame.add_argument("payload_hex")
    frame.add_argument("--json", action="store_true", help="emit JSON")

    dtc = subcommands.add_parser(
        "dtc",
        help="decode 12-bit codes against a common reference catalog",
    )
    dtc.add_argument("code", nargs="+", type=parse_dtc_code)
    dtc.add_argument(
        "--source",
        required=True,
        choices=tuple(source.value for source in DTCSource),
    )
    dtc.add_argument("--json", action="store_true", help="emit JSON")

    marker = subcommands.add_parser(
        "marker",
        help="append a timestamped operator event from another terminal",
    )
    marker.add_argument("label")
    marker.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path("markers.jsonl"),
    )
    marker.add_argument("--detail")
    marker.add_argument("--json", action="store_true", help="emit JSON")

    diagnose = subcommands.add_parser(
        "diagnose",
        help="classify a warm-idle evidence JSON without inventing missing tests",
    )
    diagnose.add_argument("evidence", type=Path)
    diagnose.add_argument("--json", action="store_true", help="emit JSON")
    return parser


def _capture(args: argparse.Namespace) -> int:
    if args.duration is not None and args.duration <= 0:
        raise ValueError("duration must be positive")
    session_metadata = {
        key: str(value)
        for key, value in {
            "label": args.session_label,
            "dcl_baud": args.dcl_baud,
            "dcl_uart_format": args.dcl_format,
            "firmware": args.firmware,
            "adapter": args.adapter,
            "ignition_state": args.ignition_state,
            "engine_state": args.engine_state,
        }.items()
        if value is not None
    }
    config = CaptureConfig(
        port=args.port,
        output_dir=args.output,
        baudrate=args.baudrate,
        rotate_size=args.rotate_size,
        read_size=args.read_size,
        reconnect_delay=args.reconnect_delay,
        reconnect=not args.no_reconnect,
        format=args.format,
        session_metadata=session_metadata,
    )
    runner = SerialCapture(config)
    timer = (
        threading.Timer(args.duration, runner.stop)
        if args.duration is not None
        else None
    )
    if timer is not None:
        timer.start()
    try:
        print(runner.run())
    finally:
        if timer is not None:
            timer.cancel()
    return 0


def _inspect(args: argparse.Namespace) -> int:
    summary = inspect_session(args.session, gap_ms=args.gap_ms)
    print(
        json.dumps(summary, indent=2, sort_keys=True)
        if args.json
        else format_summary(summary)
    )
    return 0


def _decode(args: argparse.Namespace) -> int:
    profile = load_profile(args.profile)
    result = decode_payload(parse_payload_hex(args.payload_hex), profile)
    document = result.to_dict()
    document.update(
        {
            "protocol_confidence": profile.protocol_confidence.value,
            "mapping_confidence": profile.mapping_confidence.value,
            "profile_source": profile.source,
            "confidence_notice": REFERENCE_NOTICE,
        }
    )
    if args.json:
        print(json.dumps(document, indent=2, sort_keys=True))
        return 0
    print(
        f"Profile: {result.profile_id}\n"
        f"Payload: {result.payload.hex().upper()}\n"
        f"Valid: {result.valid}; protocol confidence: "
        f"{profile.protocol_confidence.value}; mapping confidence: "
        f"{profile.mapping_confidence.value}\n"
        f"Confidence: {REFERENCE_NOTICE}"
    )
    for name, field in result.fields.items():
        engineering = (
            f"{field.engineering_value} {field.unit or ''}".rstrip()
            if field.engineering_value is not None
            else "unavailable"
        )
        print(
            f"{name}: raw={field.raw_hex or 'n/a'} engineering={engineering} "
            f"confidence={field.confidence.value} "
            f"verification={field.verification.value}"
        )
    return 0


def _frame(args: argparse.Namespace) -> int:
    document = framing_document(analyze_framing(parse_payload_hex(args.payload_hex)))
    if args.json:
        print(json.dumps(document, indent=2, sort_keys=True))
        return 0
    print(f"Confidence: unverified. {REFERENCE_NOTICE}")
    for score in document["pair_offsets"]:
        print(
            f"Offset {score['offset']}: valid={score['valid_words']} "
            f"invalid={score['invalid_words']} parity="
            f"{score['vertical_nibble_parity_valid_rate']:.2%} "
            f"score={score['score']:.3f}"
        )
    print(f"Candidate frames: {len(document['candidates'])}")
    for hypothesis in document["hypotheses"]:
        print(f"Hypothesis: {hypothesis}")
    return 0


def _dtc(args: argparse.Namespace) -> int:
    decoded = decode_dtcs(args.code, source=args.source)
    document = {
        "codes": [dtc_document(item) for item in decoded],
        "confidence_notice": REFERENCE_NOTICE,
    }
    if args.json:
        print(json.dumps(document, indent=2, sort_keys=True))
        return 0
    print(f"Confidence: {REFERENCE_NOTICE}")
    for item in decoded:
        print(
            f"{item.raw_hex}: display={item.display_code if item.display_code is not None else 'n/a'} "
            f"source={item.source.value} kind={item.kind.value} "
            f"class={item.code_class.value} "
            f"confidence={item.catalog_confidence} "
            f"summary={item.summary or 'unknown'}"
        )
    return 0


def _marker(args: argparse.Namespace) -> int:
    record = append_marker(args.output, args.label, args.detail)
    if args.json:
        print(json.dumps(record, indent=2, sort_keys=True))
    else:
        print(f"{record['utc']} {record['label']} -> {args.output}")
    return 0


def _diagnose(args: argparse.Namespace) -> int:
    result = classify_high_idle(load_evidence(args.evidence))
    document = result.to_dict()
    if args.json:
        print(json.dumps(document, indent=2, sort_keys=True))
    else:
        print(f"Branch: {result.branch.value}")
        print(f"Definitive: {result.definitive}")
        print(f"Conclusion: {result.conclusion}")
        for item in result.supporting_evidence:
            print(f"Evidence: {item}")
        for item in result.missing_evidence:
            print(f"Missing: {item}")
        for item in result.next_checks:
            print(f"Next: {item}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """Run the CLI and return a process exit code."""

    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "capture":
            return _capture(args)
        if args.command == "inspect":
            return _inspect(args)
        if args.command == "decode":
            return _decode(args)
        if args.command == "frame":
            return _frame(args)
        if args.command == "dtc":
            return _dtc(args)
        if args.command == "marker":
            return _marker(args)
        if args.command == "diagnose":
            return _diagnose(args)
    except (OSError, RuntimeError, TypeError, ValueError) as exc:
        print(f"ford-dcl: {exc}", file=sys.stderr)
        return 2
    parser.error(f"unknown command: {args.command}")
    return 2
