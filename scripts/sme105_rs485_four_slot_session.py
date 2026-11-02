#!/usr/bin/env python3
"""Four synthetic 9600 8N1 words on two isolated RS485 receivers; NEVER ECU.

MAX487 A/B <-> XY-K485 A/B on USB-powered desk only. The operator must
physically remove all vehicle wiring and the previous GPIO test jumpers.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import serial

IDENTITY = b"STATUS SME105_DUAL_RS485_V1 vehicle_tx=LOCKED DE=LOW used="
SAMPLES = ("55AA", "33CC", "0FF0", "6996")
EDGE_COUNTS = (17, 9, 5, 13)
PINS = re.compile(rb"^PINS max16=([01]) xy19=([01]) de21=([01]) DE=LOW no_tx=1$")
CHECK = "DESK_CHECK max_idle=1 xy_idle=1 de_low=1 de_high=1 de_release=1 uart_bytes=0"
BEGIN = "BENCH_BEGIN mode=DUAL_RS485_DESK_ONLY no_vehicle=1"
LIMITS = "LIMITS MAX_UART1_and_XY_RMT6_differential_desk_only no_XY_absolute_timestamp not_ECU_proof no_bus_contention_test no_automotive_transient_protection"
SUMMARY = re.compile(
    r"BENCH_END result=(PASS_DUAL_RS485_DESK_ONLY|FAIL_CLOSED) completed=(\d+) "
    r"irq_errors=(\d+) coalesced=(\d+) B_TX=0 ECU_TX=0 no_auto_retry=1 de_mode=RMT_AUTONOMOUS"
)
WORD = re.compile(
    r"WORD index=(\d+) sample=([A-F0-9]{4}) target_us=(\d+) fired_us=(\d+) done_us=(\d+) "
    r"echo_count=(\d+) echo0_us=(\d+) echo1_us=(\d+) xy_count=(\d+) xy_bytes=([A-F0-9]{4}) "
    r"xy_source=RMT_GPIO19_no_absolute_timestamp xy_rmt_edges=(\d+) xy_decode_err=(\d+) "
    r"tx_done_count=(\d+) cutoff=(\d+) error=(\d+) unexpected_rx=([A-F0-9]{2}) "
    r"expected_rx=([A-F0-9]{2}) rx_position=(\d+) unexpected_at_us=(\d+) fault_uart=(NONE|MAX|XY) "
    r"de_rmt_high_us=(\d+) de_rmt_items=(\d+) tx_rmt_items=(\d+) tx_rmt_edges=(\d+)"
)


def read_until(port: serial.Serial, deadline_s: float, marker: bytes) -> bytes:
    output = bytearray()
    until = time.monotonic() + deadline_s
    while time.monotonic() < until and len(output) < 65536:
        output.extend(port.read(4096))
        if marker in output:
            break
    return bytes(output)


def status_one_shot(raw: bytes) -> bytes | None:
    """Accept only one complete quiet USB STATUS line, never a substring.

    CP2102 startup on this ESP32 has emitted repeated partial STATUS lines
    after uploads. An embedded valid token in such corruption is not an
    authorization to send synthetic data, even on an isolated bench.
    """
    clean = raw.replace(b"\r", b"")
    if clean == IDENTITY + b"0\n":
        return b"0"
    if clean == IDENTITY + b"1\n":
        return b"1"
    return None


def verify_capture(raw: bytes) -> tuple[bool, str]:
    try:
        lines = raw.decode("ascii").splitlines()
    except UnicodeDecodeError:
        return False, "non-ASCII firmware output"
    if lines.count("BENCH_ABORT DESK_WIRING_NOT_VERIFIED no_uart_bytes=1 DE=LOW") == 1:
        return False, "physical MAX/XY/DE preflight denied, no UART data sent"
    summaries = [SUMMARY.fullmatch(x) for x in lines if x.startswith("BENCH_END")]
    if len(summaries) != 1 or summaries[0] is None:
        return False, "no unique complete summary (abort or truncated USB)"
    verdict, completed, errors, coalesced = summaries[0].groups()
    if (verdict, completed, errors, coalesced) != ("PASS_DUAL_RS485_DESK_ONLY", "4", "0", "0"):
        return False, f"firmware FAIL_CLOSED {completed}/4 words, UART errors={errors}, coalesced={coalesced}"
    if len(lines) != 8 or lines[:2] != [CHECK, BEGIN] or lines[-1] != LIMITS:
        return False, "wrong/missing preflight, extra output or truncated record"
    for index, line in enumerate(lines[3:7]):
        matched = WORD.fullmatch(line)
        if not matched:
            return False, f"missing or malformed word {index}"
        v = matched.groups()
        (
            position, sample, target, fired, done, max_count, max0, max1,
            xy_count, xy_bytes, xy_rmt_edges, xy_decode_err, tx_done, cutoff, error, unexpected,
            expected, rx_pos, unexpected_at, fault_uart, de_high, de_items, tx_items, edges,
        ) = v
        nums = [
            target, fired, done, max_count, max0, max1, xy_count, xy_rmt_edges, xy_decode_err,
            tx_done, cutoff, error, rx_pos, unexpected_at, de_high, de_items, tx_items, edges,
        ]
        t, f, d, nc, m0, m1, xc, xe, xd, td, cut, err, rp, ua, de, di, ti, te = map(int, nums)
        if position != str(index) or sample != SAMPLES[index]:
            return False, f"wrong sample/order at {index}"
        if index and t - int(WORD.fullmatch(lines[index + 2]).group(3)) != 10000:
            return False, f"slot {index} not spaced 10ms"
        if not (-100 <= f - t <= 100 and 1900 <= d - f < 2250):
            return False, f"slot {index} timer or TX_DONE timing invalid"
        if not (nc == xc == 2 and xy_bytes == sample and xe == EDGE_COUNTS[index] and xd == 0 and
                td == 1 and cut == err == 0 and
                unexpected == expected == "00" and rp == ua == 0 and fault_uart == "NONE"):
            return False, f"slot {index} max/xy UART mismatch, cutoff or error"
        if not (650 <= m0 - f <= 1400 and 1600 <= m1 - f < 2450):
            return False, f"slot {index} MAX UART1 byte arrival outside 9600 8N1 range"
        if not (1900 <= de < 2250 and di > 0 and ti > 0 and te == EDGE_COUNTS[index]):
            return False, f"slot {index} independent DE RMT witness invalid"
    return True, "PASS 4/4 synthetic words, MAX UART1 + XY RMT6 desk ONLY; not ECU/vehicle authorization"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--action", required=True, choices=("status", "pins", "bench"))
    parser.add_argument("--isolated-confirmed", action="store_true",
                        help="assert car/OBD disconnected; MAX487 and XY-K485 only")
    args = parser.parse_args()
    if args.action == "bench" and not args.isolated_confirmed:
        parser.error("--isolated-confirmed required for ANY RS485 transmission")
    with serial.Serial(args.port, 115200, timeout=0.15, write_timeout=0.8) as port:
        port.dtr = False
        port.rts = False
        time.sleep(1.2)
        port.reset_input_buffer()
        status = b""
        used = None
        for _ in range(4):  # read-only retries, never repeat bench
            port.write(b"STATUS\n")
            port.flush()
            status = read_until(port, 1.2, b"\r\n")
            used = status_one_shot(status)
            if used is not None:
                break
        if used is None:
            print(f"DENIED wrong firmware/USB: {status[-160:]!r}")
            return 2
        print(f"STATUS verified; used={used.decode()}, ECU=B_LOCKED")
        if args.action == "status":
            return 0
        port.write(b"PINS\n")
        port.flush()
        pin_raw = read_until(port, 2, b"\r\n")
        match = PINS.fullmatch(pin_raw.replace(b"\r", b"").strip())
        print(pin_raw.decode("ascii", "backslashreplace").strip())
        if not match:
            print("DENIED missing PINS preflight response")
            return 2
        if args.action == "pins":
            return 0
        if used != b"0" or match.groups() != (b"1", b"1", b"0"):
            print("DENIED used, receiver not idle HIGH, or DE21 not LOW; no UART data")
            return 2
        # One request per operator invocation. No automatic retry.
        port.write(b"BENCH_RS485_ONCE\n")
        port.flush()
        capture = read_until(port, 12, LIMITS.encode() + b"\r\n")
    path = Path(__file__).resolve().parents[1] / "captures" / "ISOLATED_RS485" / (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + "-four-slot.txt"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(capture)
    ok, verdict = verify_capture(capture)
    print(f"Evidence: {path}")
    print(f"SHA256: {hashlib.sha256(capture).hexdigest()}")
    print(capture.decode("ascii", "backslashreplace"))
    print("VERDICT:", verdict)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
