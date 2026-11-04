#!/usr/bin/env python3
"""One-shot reference Echo-ID -> strictly gated Go-CART capture controller.

Do NOT treat a matching reference handshake as confirmation that an unprotected
MAX487 circuit is electrically safe for an ECU. A/B loading must be qualified.
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PORT = (
    "/dev/serial/by-id/"
    "usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0"
)
READY = b"STATUS rx2=HIGH tx=WAITING_FOR_EXPLICIT_START\r\n"


def wait_until_quiet(conn: object, *, quiet_seconds: float = 0.35,
                     max_seconds: float = 6.0) -> int:
    """Drain *startup-only* USB noise until silence; never send a DCL command.

    This is permitted only once at connection setup, before the first STATUS.
    Later unsolicited bytes are treated as unsafe and abort the transaction.
    """
    started = time.monotonic()
    last_byte = started
    discarded = 0
    tail = b""
    while time.monotonic() - started < max_seconds:
        pending = int(conn.in_waiting)
        data = conn.read(min(pending, 8192) if pending else 1)
        if data:
            discarded += len(data)
            tail = (tail + data)[-48:]
            last_byte = time.monotonic()
            continue
        if time.monotonic() - last_byte >= quiet_seconds:
            return discarded
    raise RuntimeError(
        f"serial did not settle after {max_seconds:g}s; received "
        f"{discarded} unsolicited USB bytes; last_hex={tail.hex(' ')}"
    )


def status(conn: object) -> bytes:
    # Once the startup drain is complete, even one unsolicited byte is a
    # reason to stop, not permission to silently discard it.
    time.sleep(0.1)
    if conn.in_waiting:
        extra = conn.read(min(int(conn.in_waiting), 80))
        raise RuntimeError(f"unexpected USB bytes before STATUS: {extra.hex(' ')}")
    conn.write(b"STATUS\n")
    conn.flush()
    line = conn.read_until(b"\n", size=128)
    if line != READY:
        raise RuntimeError("incorrect firmware or noisy USB STATUS: " + repr(line))
    time.sleep(0.1)
    if conn.in_waiting:
        extra = conn.read(min(int(conn.in_waiting), 80))
        raise RuntimeError(f"unexpected USB bytes after STATUS: {extra.hex(' ')}")
    return line


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=PORT)
    parser.add_argument("--send", action="store_true")
    args = parser.parse_args()

    try:
        import serial
    except ImportError:
        print("Missing pyserial", file=sys.stderr)
        return 2

    sent = False
    try:
        with serial.Serial(args.port, 115200, timeout=0.10, write_timeout=0.6) as conn:
            time.sleep(1.2)  # USB serial connection can reset ESP32
            drained = wait_until_quiet(conn)
            if drained:
                print(f"Discarded {drained} startup USB bytes; link settled.")
            print(status(conn).decode("ascii").strip())
            status(conn)
            print("PASS: two exact STATUS replies; no DCL transmission.")
            if not args.send:
                print("Safe preflight complete. No request sent to car.")
                return 0

            print("Reference experiment; the extra 01 may be noise, not ECU ACK.")
            print("Must have verified interface protection and loading, KOEO.")
            prompt = "Type START_CART_ONCE to authorize at most two bounded reference frames: "
            if input(prompt).strip() != "START_CART_ONCE":
                print("Cancelled: no DCL transaction.")
                return 0
            status(conn)  # Retest immediately after interactive delay
            conn.write(b"START\n")
            sent = True
            conn.flush()
            chunks: list[bytes] = []
            started = time.monotonic()
            while time.monotonic() - started < 13.0:
                data = conn.read(2048)
                if data:
                    chunks.append(data)
                    sys.stdout.write(data.decode("utf-8", "replace"))
                    sys.stdout.flush()
                    # Wait for the complete terminal line, not the beginning
                    # of CART_DONE; the latter truncated uart_errors=<n> in
                    # a real session on 2026-11-02.
                    tail = b"".join(chunks[-8:])
                    if b"DONE one-shot closed; no further TX until reboot\n" in tail.replace(b"\r\n", b"\n"):
                        break
                    if b"DONE no verified candidate ACK; CART NOT SENT\n" in tail.replace(b"\r\n", b"\n"):
                        break
                    if b"ABORT " in tail and b"\n" in tail:
                        break
            raw = b"".join(chunks)
    except (serial.SerialException, OSError, RuntimeError) as exc:
        print(
            f"ERROR: {exc}. "
            + ("START may have reached the device; do NOT blindly retry."
               if sent else "No START was sent."),
            file=sys.stderr,
        )
        return 2

    folder = Path(__file__).resolve().parent.parent / "captures" / "CART_ONCE"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    destination = folder / f"{stamp}.txt"
    with destination.open("xb") as file:
        file.write(raw)
    print(f"\nSAVED: {destination}")
    if b"TX_FRAME GO_CART bytes=11 watchdog=OK" in raw:
        print("GO_CART was sent; any CART_RX is still unverified raw serial data.")
    else:
        print("GO_CART not confirmed; inspect raw log, do not blindly retry.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
