#!/usr/bin/env python3
"""Explicit, single-shot host control for reference EEC-IV Echo Module ID.

Never use this tool to justify attaching an unqualified interface to a car.
The binary does not attest that the frame is read-only on the SME-105 ECU.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_PORT = (
    "/dev/serial/by-id/"
    "usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0"
)
EXPECTED_STATUS_HIGH = b"STATUS rx2=HIGH tx=WAITING_FOR_EXPLICIT_ECHOID\r\n"
EXPECTED_STATUS_LOW = b"STATUS rx2=LOW tx=WAITING_FOR_EXPLICIT_ECHOID\r\n"


def check_status(connection: object) -> bytes:
    """Verify a single exact line with quiet serial before/after; never send DCL."""

    connection.reset_input_buffer()
    time.sleep(0.12)
    if connection.in_waiting:
        raise RuntimeError("Unsolicited USB data before STATUS (noise/reset?)")
    connection.write(b"STATUS\n")
    connection.flush()
    received = connection.read_until(b"\n", size=256)
    if received not in (EXPECTED_STATUS_HIGH, EXPECTED_STATUS_LOW):
        raise RuntimeError(
            "Unexpected or corrupted firmware STATUS: "
            + repr(received[:120])
        )
    time.sleep(0.12)
    if connection.in_waiting:
        raise RuntimeError("Extra unsolicited USB data after STATUS")
    return received


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=DEFAULT_PORT)
    parser.add_argument("--send", action="store_true", help="allow explicit one-shot request")
    args = parser.parse_args()

    print("Serial preflight; STATUS is USB-only and never drives the DCL bus.")

    echoid_attempted = False
    try:
        import serial
    except ImportError:
        print("pyserial is missing from the project Python environment", file=sys.stderr)
        return 2

    try:
        with serial.Serial(args.port, 115200, timeout=0.8, write_timeout=0.8) as connection:
            time.sleep(1.2)  # Some ESP32 serial-open sequences reset the board.
            preflight = check_status(connection)
            print(preflight.decode("ascii").strip())
            check_status(connection)
            print("PASS: two clean exact STATUS checks. No DCL transmission so far.")
            if not args.send:
                print("SAFE CHECK COMPLETE: No DCL request was sent.")
                return 0

            print("This sends the unverified-for-SME-105 reference Echo Module ID frame.")
            print("Risk includes ECU/bus damage, not merely loss of the MAX487 board.")
            print("Only proceed with a verified, current-limited protected interface, KOEO.")
            if input("Type exactly ECHOID to authorize ONE transmission: ").strip() != "ECHOID":
                print("Cancelled; no DCL request was sent.")
                return 0

            # The human confirmation can take time, so revalidate immediately.
            final_status = check_status(connection)
            if final_status != EXPECTED_STATUS_HIGH:
                print("ABORT: receiver is not HIGH/ready; no TX.")
                return 3

            # Exactly one deliberate host command. Firmware enforces one shot/boot.
            echoid_attempted = True
            connection.write(b"ECHOID\n")
            connection.flush()
            started = time.monotonic()
            chunks: list[bytes] = []
            while time.monotonic() - started < 3.0:
                data = connection.read(2048)
                if data:
                    chunks.append(data)
                    print(data.decode("utf-8", errors="replace"), end="", flush=True)
            raw = b"".join(chunks)
    except (OSError, serial.SerialException, RuntimeError) as exc:
        if echoid_attempted:
            print(f"ERROR: {exc}. ECHOID might have been transmitted; DO NOT RETRY.", file=sys.stderr)
        else:
            print(f"ABORT: {exc}. No ECHOID command sent by this run.", file=sys.stderr)
        return 2

    # Never claim a reply is from the ECU: RO may echo the local transmission.
    log_dir = Path(__file__).resolve().parent.parent / "captures" / "ECHO_ID_ONCE"
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    log_path = log_dir / f"{stamp}.txt"
    with log_path.open("xb") as handle:
        handle.write(preflight)
        handle.write(raw)
    print(f"\nSaved raw serial transcript: {log_path}")
    if b"TX complete bytes=11" not in raw:
        print("WARNING: no confirmation that firmware wrote the expected bytes.")
    print("Even RX bytes may be local echo; an ECU response is not yet verified.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
