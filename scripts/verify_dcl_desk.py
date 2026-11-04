#!/usr/bin/env python3
"""USB-only internal UART desk attestation; never transmits on MAX487 A/B."""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = "/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0"
STATUS = b"STATUS BENCH_ONLY DE=LOW NO_DCL_TX_TO_AB\r\n"
EXPECTED = (
    b"PASS UART_2400_8N2_ECHO_ID sent=11 recv=11",
    b"PASS UART_9600_8N1_CART64 sent=64 recv=64",
    b"PASS CART16_REFERENCE_PARITY",
    b"SELFTEST PASS",
)


def exchange(serial_port: object, command: bytes, deadline: float) -> bytes:
    if command not in (b"STATUS\n", b"SELFTEST\n"):
        raise ValueError("only safe internal bench USB commands accepted")
    if serial_port.in_waiting:
        raise RuntimeError("unexpected unsolicited USB bytes: no command sent")
    serial_port.write(command)
    serial_port.flush()
    result = bytearray()
    started = time.monotonic()
    last_byte_at = started
    while time.monotonic() - started < deadline:
        chunk = serial_port.read(512)
        if chunk:
            result.extend(chunk)
            last_byte_at = time.monotonic()
            if len(result) > 2048:
                raise RuntimeError("unexpectedly large USB response")
        elif result and time.monotonic() - last_byte_at >= .15:
            break
    return bytes(result)


def verify_reply(first: bytes, trial: bytes, last: bytes) -> None:
    if first != STATUS or last != STATUS:
        raise RuntimeError("BENCH_ONLY DE=LOW firmware identity mismatch")
    lines = tuple(line for line in trial.replace(b"\r\n", b"\n").split(b"\n") if line)
    if lines != EXPECTED:
        raise RuntimeError("UART bench self-test failed or produced unexpected lines: "
                           + repr(lines))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=PORT)
    args = parser.parse_args()
    try:
        import serial
    except ImportError:
        print("ERROR: pyserial not installed", file=sys.stderr)
        return 2
    try:
        # The owner's CP2102 sometimes produces a continuous corrupted
        # startup stream on its FIRST open after flashing. A fresh open has
        # cleared that condition on multiple read-only observations. Reopen
        # at most once, and NEVER send a command while bytes are streaming.
        discarded = 0
        for attempt in range(2):
            with serial.Serial(args.port, 115200, timeout=.05, write_timeout=.5) as device:
                time.sleep(.6)
                started = time.monotonic()
                quiet_start = started
                settled = False
                while time.monotonic() - started < 5.0:
                    data = device.read(min(max(device.in_waiting, 1), 4096))
                    if data:
                        discarded += len(data)
                        quiet_start = time.monotonic()
                        continue
                    if time.monotonic() - quiet_start >= .3:
                        settled = True
                        break
                if not settled:
                    if attempt == 0:
                        continue
                    raise RuntimeError("USB stream did not settle after two opens")
                first = exchange(device, b"STATUS\n", 1.5)
                trial = exchange(device, b"SELFTEST\n", 2.0)
                last = exchange(device, b"STATUS\n", 1.5)
                verify_reply(first, trial, last)
                break
    except (serial.SerialException, RuntimeError, OSError) as err:
        print(f"FAIL: {err}. No car-side transmission requested.", file=sys.stderr)
        return 2
    transcript = ROOT / "captures/CART_ONCE/20261102T150417765534Z.txt"
    report = {
        "utc": datetime.now(timezone.utc).isoformat(),
        "test": "USB-only ESP32 UART internal loopback",
        "status": "PASS",
        "startup_discarded_usb_bytes": discarded,
        "usb_port": args.port,
        "baud": 115200,
        "hello_uart_2400_8n2": "PASS",
        "cart_uart_9600_8n1": "PASS",
        "reference_16_id_parity": "PASS",
        "de_reported_held_low": True,
        "max487_physical_path_tested_in_this_test": False,
        "car_ecu_tested_in_this_test": False,
        "fault_codes_obtained": False,
        "pid_readings_obtained": False,
        "prior_capture_sha256": (
            hashlib.sha256(transcript.read_bytes()).hexdigest()
            if transcript.exists() else None
        ),
    }
    output = ROOT / "captures/DESK_READINESS"
    output.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = output / f"{stamp}.json"
    with path.open("x", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2)
        handle.write("\n")
    print(first.decode("ascii").rstrip())
    print(trial.decode("ascii").rstrip())
    print(last.decode("ascii").rstrip())
    print(f"PASS: USB-only desk readiness. Report: {path}")
    print("ECU command slot timing and MAX487 vehicle electrical safety NOT validated.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
