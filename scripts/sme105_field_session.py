#!/usr/bin/env python3
"""Run a bounded SME-105 field console capture, preserving raw serial evidence.

All modes are receive-only except explicitly approved historical CART_REF.
Reference B/G/A DTC/PID commands are never offered for transmission.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

PORT = (
    "/dev/serial/by-id/"
    "usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0"
)
IDENTITY = re.compile(
    rb"^STATUS SME105_FIELD_V1 DE=LOW TX=(ONE_SHOT_CART_REF_ONLY|LOCKED) "
    rb"RX=(HIGH|LOW) watchdog=(READY|FAILED)\r\n$"
)
MONITOR_CHOICES = {
    "monitor2400": b"MON2400\n",
    "monitor2400n1": b"MON2400N1\n",
    "monitor4800": b"MON4800\n",
    "monitor4800n2": b"MON4800N2\n",
    "monitor9600": b"MON9600\n",
    "monitor19200": b"MON19200\n",
    "monitor9600n2": b"MON9600N2\n",
    "monitor19200n2": b"MON19200N2\n",
}
MAX_RAW_BYTES = 900_000


def drain_startup(conn: object, *, max_seconds: float = 6.0,
                  min_seconds: float = 1.4) -> int:
    """Drain only preflight CP2102 startup garbage; fail on ongoing noise."""
    start = time.monotonic()
    latest = start
    discarded = 0
    while time.monotonic() - start < max_seconds:
        pending = int(conn.in_waiting)
        data = conn.read(min(pending, 4096) if pending else 1)
        if data:
            discarded += len(data)
            latest = time.monotonic()
        # The CP2102/ESP32 prints the bootloader banner, pauses, and then
        # prints a late firmware greeting. A short quiet gap during reset is
        # NOT the end of startup.
        if (time.monotonic() - start >= min_seconds and
                time.monotonic() - latest > 0.5):
            return discarded
    raise RuntimeError("USB startup never quieted; no commands sent")


def get_status(conn: object) -> tuple[bool, bool]:
    """Return (driver armable, RX high) only after exact identity checks."""
    time.sleep(0.08)
    if conn.in_waiting:
        raise RuntimeError("unsolicited serial data before STATUS")
    conn.write(b"STATUS\n")
    conn.flush()
    line = conn.read_until(b"\n", size=160)
    match = IDENTITY.fullmatch(line)
    if match is None:
        raise RuntimeError(f"wrong firmware/noisy STATUS: {line[:130]!r}")
    time.sleep(0.08)
    if conn.in_waiting:
        raise RuntimeError("unsolicited serial data after STATUS")
    if match.group(3) != b"READY":
        raise RuntimeError("firmware watchdog unavailable")
    return match.group(1) == b"ONE_SHOT_CART_REF_ONLY", match.group(2) == b"HIGH"


def evaluate_capture(output: bytes, action: str) -> tuple[bool, str]:
    """Reject partial transcripts; do not fabricate DTC or ECU provenance."""
    lines = output.replace(b"\r\n", b"\n").splitlines()
    if action in MONITOR_CHOICES:
        endings = [line for line in lines if line.startswith(b"CAPTURE_END ")]
        if len(endings) != 1:
            return False, "missing or duplicate terminal CAPTURE_END"
        end = endings[0]
        if b"uart_errors=0" not in end or b"capped=0" not in end:
            return False, "UART errors or truncated input"
        if b" stopped=1 " in end:
            return False, "operator STOP interrupted capture"
        return True, "receive-only raw capture completed; no DTC interpretation"
    if action == "cart-ref":
        terminal = [line for line in lines if line.startswith(b"CART_REF_END ")]
        if len(terminal) != 1:
            return False, "missing or duplicate CART_REF_END"
        if terminal[0] != b"CART_REF_END result=COMPLETE TX_LOCKED":
            return False, "guarded reference handshake aborted; no retry"
        if b"TX_FRAME ECHO_ID n=11 timeout=OK" not in lines:
            return False, "missing Echo-ID confirmation"
        if b"TX_FRAME GO_CART n=11 timeout=OK" not in lines:
            return False, "missing Go-CART confirmation"
        endings = [line for line in lines if line.startswith(b"CAPTURE_END ")]
        if len(endings) != 1 or b"uart_errors=0" not in endings[0]:
            return False, "missing CART capture ending or UART errors"
        if b"capped=0" not in endings[0] or b"stopped=0" not in endings[0]:
            return False, "truncated or interrupted CART capture"
        return True, "reference CART capture complete; DTC bytes NOT established"
    return False, "unknown action"


def write_evidence(raw: bytes, action: str, *, root: Path) -> Path:
    target = root / "captures" / "FIELD_CONSOLE"
    target.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = target / f"{stamp}-{action}.txt"
    with path.open("xb") as handle:
        handle.write(raw)
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=PORT)
    parser.add_argument(
        "--action",
        choices=["status", "options", *MONITOR_CHOICES, "cart-ref"],
        default="status",
    )
    args = parser.parse_args()
    try:
        import serial
    except ImportError:
        print("Missing pyserial; use the project .venv Python", file=sys.stderr)
        return 2

    action = args.action
    dispatched = False
    raw = b""
    output = b""
    failure = None
    try:
        with serial.Serial(
            args.port, 115200, timeout=0.12, write_timeout=0.7,
            dsrdtr=False, rtscts=False,
        ) as conn:
            # Do not reset the ESP32 just by opening the host port.
            conn.dtr = False
            conn.rts = False
            n = drain_startup(conn)
            if n:
                print(f"Discarded {n} preflight USB startup bytes.")
            armable, rx_high = get_status(conn)
            print(f"Exact firmware identity PASS: RX={'HIGH' if rx_high else 'LOW'}")
            armable2, rx_high2 = get_status(conn)
            if (armable2, rx_high2) != (armable, rx_high):
                raise RuntimeError("STATUS changed unexpectedly")
            if action == "status":
                print("USB preflight PASS; no vehicle command sent.")
                return 0
            if action == "cart-ref":
                if not armable or not rx_high:
                    raise RuntimeError("RX not ready or one-shot already used")
                print(
                    "This will send historical Echo-ID and Go-CART ONLY; it "
                    "will NOT request diagnostic trouble codes. ECU-source "
                    "and automotive hardware protection remain unverified."
                )
                if input("Type CART_REF to authorize one bounded experiment: ").strip() != "CART_REF":
                    print("Cancelled; no DCL transmission.")
                    return 0
                armable3, rx_high3 = get_status(conn)
                if not armable3 or not rx_high3:
                    raise RuntimeError("final preflight failed")
                command = b"CART_REF\n"
            elif action == "options":
                command = b"OPTIONS\n"
            else:
                command = MONITOR_CHOICES[action]
            conn.write(command)
            dispatched = True
            conn.flush()
            duration = 14.0 if action == "cart-ref" else (7.0 if action in MONITOR_CHOICES else 2.0)
            started = time.monotonic()
            chunks: list[bytes] = []
            while time.monotonic() - started < duration:
                packet = conn.read(2048)
                if packet:
                    chunks.append(packet)
                    if sum(map(len, chunks)) > MAX_RAW_BYTES:
                        failure = "host raw transcript size exceeded bound"
                        break
                    print(packet.decode("ascii", "replace"), end="", flush=True)
                    tail = b"".join(chunks[-4:]).replace(b"\r\n", b"\n")
                    if action in MONITOR_CHOICES and b"NOTE raw quartets are ID-only candidates, NOT fault codes\n" in tail:
                        break
                    if action == "cart-ref" and b"CART_REF_END result=" in tail and tail.endswith(b"\n"):
                        break
                    if action == "options" and b"DENIED C clear codes;" in tail and tail.endswith(b"\n"):
                        break
            output = b"".join(chunks)
    except (OSError, serial.SerialException, RuntimeError) as exc:
        failure = str(exc)
    except KeyboardInterrupt:
        failure = "interrupted; do not blindly retry if CART_REF was sent"

    if not dispatched:
        print(f"ABORT before action dispatch: {failure}", file=sys.stderr)
        return 2
    if action == "options":
        valid = failure is None and b"DTC_REF A 03 81" in output and b"ALL DISABLED" in output
        reason = "reference options displayed" if valid else "options output missing or truncated"
    else:
        valid, reason = evaluate_capture(output, action)
        valid = valid and failure is None
    raw = output
    saved = write_evidence(raw, action, root=Path(__file__).resolve().parents[1])
    print(f"\nEvidence saved: {saved}")
    print(f"SHA256: {hashlib.sha256(raw).hexdigest()}")
    print(f"RESULT: {'PASS' if valid else 'INCOMPLETE'} — {reason}{': '+failure if failure else ''}")
    return 0 if valid else 3


if __name__ == "__main__":
    raise SystemExit(main())
