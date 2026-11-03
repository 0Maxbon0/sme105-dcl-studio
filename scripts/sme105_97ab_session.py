#!/usr/bin/env python3
"""97AB SME-105 native reader: explicit commands, immutable raw USB logs.

The MCU owns CART time slots; this program NEVER attempts Python-timed
ECU UART words and NEVER repeats a dispatched diagnostic attempt.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import serial

if __package__:
    from .analyze_timed_dtc import analyze
else:
    from analyze_timed_dtc import analyze

ROOT = Path(__file__).resolve().parents[1]
STATUS = re.compile(
    rb"^STATUS SME105_97AB_READER_V([12]) ecu=97AB-12A650-KA DE=LOW "
    rb"auto_tx=0 attempt_used=([01]) timers=2 gate4=1( ro_scope=1)?\r?\n$"
)
PINS = re.compile(
    rb"^PINS ro16=1 de18=0 gate4=1( ro_scope=1)? DE=LOW no_tx=1\r?\n$"
)
COMMANDS = {
    "status": b"STATUS\n",
    "pins": b"PINS\n",
    "rx-test": b"RX_TEST\n",
    "preview-a4": b"PREVIEW_B_A4\n",
    "preview-0e": b"PREVIEW_B_0E\n",
    "desk": b"DESK_MAX_ONCE\n",
    "observe-cart": b"OBSERVE_CART_ONCE\n",
    "dtc-a4": b"READ_DTC_A4_ONCE\n",
    "dtc-0e": b"READ_DTC_0E_ONCE\n",
}
EXPLICIT = {"desk", "observe-cart", "dtc-a4", "dtc-0e"}
VEHICLE = {"observe-cart", "dtc-a4", "dtc-0e"}
ENDING = re.compile(rb"^CART_END [^\r\n]+\r?$", re.MULTILINE)
ABORT = re.compile(rb"^(?:ABORT |CART_ABORT |DENIED |ACK_REJECT |REF_ACK_OVERFLOW )", re.MULTILINE)
DESK_WORD = re.compile(
    rb"^DESK_WORD index=([0-3]) expected=([0-9A-F]{4}) rx_count=2 "
    rb"tx_done=1 delta_us=([0-9]+) match=1$"
)
DESK_SAMPLES = (b"55AA", b"33CC", b"0FF0", b"01B0")
DESK_BEGIN = b"DESK_BEGIN MAX_UART1_RX16_UART2_TX17_RMT_DE18 no_car=1"
DESK_SCOPE = re.compile(rb"^DESK_RO_SCOPE items=([0-9]+) complete_packet=1 overflow=0$")
DESK_END = (
    b"DESK_END PASS completed=4 uart_errors=0 cutoff=0 "
    b"B_TX=0 ECU_TX=0 DE=LOW"
)


def verify_desk(raw: bytes) -> bool:
    rows = raw.replace(b"\r", b"").splitlines()
    if len(rows) != 7 or rows[0] != DESK_BEGIN or rows[-1] != DESK_END:
        return False
    scope = DESK_SCOPE.fullmatch(rows[-2])
    if scope is None or int(scope[1]) == 0:
        return False
    for i, row in enumerate(rows[1:5]):
        matched = DESK_WORD.fullmatch(row)
        if (matched is None or int(matched[1]) != i or
                matched[2] != DESK_SAMPLES[i] or
                not 1900 <= int(matched[3]) < 2250):
            return False
    return True


def read_record(port: serial.Serial, seconds: float, *, end: bytes | None = None) -> bytes:
    output = bytearray()
    deadline = time.monotonic() + seconds
    last_received = time.monotonic()
    while time.monotonic() < deadline and len(output) < 1_000_000:
        chunk = port.read(min(4096, 1_000_000 - len(output)))
        output += chunk
        if chunk:
            last_received = time.monotonic()
        if end and end in output:
            break
        if end and time.monotonic() - last_received > 1.2 and (
            b"ABORT " in output or b"ACK_REJECT " in output or
            b"CART_ABORT " in output or b"REF_ACK_OVERFLOW " in output
        ):
            break
        if end is None and output.endswith(b"\n"):
            break
    return bytes(output)


def quiet_status(port: serial.Serial, *, require_v2: bool = False) -> bool:
    for _ in range(5):  # Read-only retries; NEVER retry an active command.
        port.reset_input_buffer()
        port.write(COMMANDS["status"])
        port.flush()
        raw = read_record(port, 1.1)
        match = STATUS.fullmatch(raw)
        if match:
            print(raw.decode("ascii").strip())
            is_v2 = match[1] == b"2" and match[3] == b" ro_scope=1"
            is_old_v1 = match[1] == b"1" and match[3] is None
            if not (is_v2 or is_old_v1):
                raise RuntimeError("version/scope identity mismatch; no command sent")
            if require_v2 and not is_v2:
                raise RuntimeError(
                    "old V1 firmware still installed; flash V2 off-vehicle "
                    "before any new desk/vehicle diagnostic attempt"
                )
            return match[2] == b"0"
    raise RuntimeError("incorrect/noisy firmware STATUS; no command sent")


def save_raw(raw: bytes, action: str) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    folder = ROOT / "captures" / "SME105_97AB"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{stamp}-{action}.txt"
    with path.open("xb") as target:
        target.write(raw)
    print(f"Raw capture: {path}")
    print(f"SHA256: {hashlib.sha256(raw).hexdigest()}")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--action", choices=tuple(COMMANDS), default="status")
    parser.add_argument("--isolated-confirmed", action="store_true",
                        help="required for desk echo with A/B physically isolated from any ECU")
    parser.add_argument("--vehicle-confirmed", action="store_true",
                        help="required for explicit vehicle requests; no automatic retries")
    args = parser.parse_args()
    action = args.action
    if action == "desk" and not args.isolated_confirmed:
        parser.error("desk requires --isolated-confirmed and A/B disconnected from the car")
    if action in VEHICLE and not args.vehicle_confirmed:
        parser.error("vehicle DCL command requires --vehicle-confirmed")
    if action in VEHICLE:
        print("Experimental command: one manual attempt, engine off, external interface must be qualified.")
        print("Never retry after uncertain send or a failed capture; first inspect original evidence.")
    try:
        with serial.Serial(args.port, 115200, timeout=0.15, write_timeout=0.8,
                           dsrdtr=False, rtscts=False) as port:
            port.dtr = False
            port.rts = False
            time.sleep(1.5)
            port.reset_input_buffer()
            unused = quiet_status(port, require_v2=action in EXPLICIT)
            if action == "status":
                return 0
            if action in EXPLICIT and not unused:
                raise RuntimeError("one-shot already used on current ESP32 boot")
            port.reset_input_buffer()
            port.write(COMMANDS["pins"])
            port.flush()
            pins = read_record(port, 1.1)
            pin_match = PINS.fullmatch(pins)
            if not pin_match or (action in EXPLICIT and pin_match[1] != b" ro_scope=1"):
                raise RuntimeError(f"GPIO/DE preflight failed: {pins[-120:]!r}")
            if action == "pins":
                print(pins.decode("ascii").strip())
                return 0
            if action in EXPLICIT:
                expected = COMMANDS[action].decode("ascii").strip()
                if action in VEHICLE:
                    if input(f"Type {expected} to dispatch exactly ONCE: ").strip() != expected:
                        print("Cancelled, nothing sent.")
                        return 2
                else:
                    print(f"Sending ONE isolated DESK command: {expected}")
                if not quiet_status(port, require_v2=True):
                    raise RuntimeError("status changed before one-shot dispatch")
            port.reset_input_buffer()
            port.write(COMMANDS[action])
            port.flush()
            if action in VEHICLE:
                # 8192 timed UART event lines over a 115200bps USB serial
                # link may take much longer to drain than the 10s ECU
                # observation interval. Never truncate before CART_END.
                raw = read_record(port, 80.0, end=b" ecu_verified=0 dtc_verified=0\r\n")
                # Early reference failure may not print CART_END.
                if b"ABORT " in raw and b"CART_RUN " not in raw:
                    pass
            elif action == "desk":
                raw = read_record(port, 12.0, end=b" B_TX=0 ECU_TX=0 DE=LOW\r\n")
            else:
                raw = read_record(port, 4.0)
                if action.startswith("preview"):
                    for _ in range(4):
                        raw += read_record(port, 0.6)
    except (serial.SerialException, OSError, RuntimeError, KeyboardInterrupt) as exc:
        print(f"STOP: {exc}", file=sys.stderr)
        return 2
    print(raw.decode("ascii", "backslashreplace")[-25000:])
    if action in EXPLICIT:
        path = save_raw(raw, action)
        if action in VEHICLE:
            if ENDING.search(raw) is None:
                print("Incomplete/aborted session, preserve raw evidence and do NOT auto-retry")
                return 3
            try:
                report = analyze(raw)
                print("Offline analysis:", report["classification"])
                print("DTC candidates:", report["reference_dtc_candidates"][:25])
                print("ECU code verified:", report["is_dtc_read_verified"])
                expected_class = (
                    "timed-cart-observation-no-DTC-command" if action == "observe-cart"
                    else "reference-compatible-unverified-DTC-candidates"
                )
                if report["classification"] != expected_class:
                    return 3
            except (ValueError, TypeError) as exc:
                print("Analysis rejected:", exc)
                return 3
        elif action == "desk":
            if not verify_desk(raw):
                print("Isolated desk FAIL; no claim of UART/RS485 success")
                return 3
        print(f"Evidence retained: {path}")
    elif ABORT.search(raw):
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
