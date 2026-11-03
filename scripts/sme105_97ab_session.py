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
    rb"^STATUS SME105_97AB_READER_V([1234]) ecu=97AB-12A650-KA DE=LOW "
    rb"auto_tx=0 attempt_used=([01]) timers=2 gate4=1"
    rb"( ro_scope=1)?( di_scope=1 first_probe=1)?( raw_a4=1)?\r?\n$"
)
PINS = re.compile(
    rb"^PINS ro16=1 de18=0 gate4=1( ro_scope=1)?( di_scope=1)? "
    rb"DE=LOW no_tx=1\r?\n$"
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
    "probe-first": b"PROBE_B_FIRST_ONCE\n",
    "raw-a4": b"RAW_A4_ONCE\n",
}
EXPLICIT = {"desk", "observe-cart", "dtc-a4", "dtc-0e", "probe-first", "raw-a4"}
VEHICLE = {"observe-cart", "dtc-a4", "dtc-0e", "probe-first", "raw-a4"}
ENDING = re.compile(rb"^CART_END [^\r\n]+\r?$", re.MULTILINE)
ABORT = re.compile(rb"^(?:ABORT |CART_ABORT |DENIED |ACK_REJECT |REF_ACK_OVERFLOW )", re.MULTILINE)
DESK_WORD = re.compile(
    rb"^DESK_WORD index=([0-3]) expected=([0-9A-F]{4}) rx_count=2 "
    rb"tx_done=1 delta_us=([0-9]+) match=1$"
)
DESK_SAMPLES = (b"55AA", b"33CC", b"0FF0", b"01B0")
DESK_BEGIN = b"DESK_BEGIN MAX_UART1_RX16_UART2_TX17_RMT_DE18 no_car=1"
DESK_SCOPE = re.compile(rb"^DESK_RO_SCOPE items=([0-9]+) complete_packet=1 overflow=0$")
DESK_DI_SCOPE = re.compile(rb"^DESK_DI_SCOPE items=([0-9]+) complete_packet=1 overflow=0$")
DESK_END = (
    b"DESK_END PASS completed=4 uart_errors=0 cutoff=0 "
    b"B_TX=0 ECU_TX=0 DE=LOW"
)


def verify_desk(raw: bytes) -> bool:
    rows = raw.replace(b"\r", b"").splitlines()
    if len(rows) != 8 or rows[0] != DESK_BEGIN or rows[-1] != DESK_END:
        return False
    ro_scope = DESK_SCOPE.fullmatch(rows[-3])
    di_scope = DESK_DI_SCOPE.fullmatch(rows[-2])
    if (ro_scope is None or int(ro_scope[1]) == 0 or
            di_scope is None or int(di_scope[1]) == 0):
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
    while time.monotonic() < deadline and len(output) < 2_000_000:
        chunk = port.read(min(4096, 2_000_000 - len(output)))
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


def quiet_status(port: serial.Serial, *, require_v4: bool = False) -> bool:
    for _ in range(5):  # Read-only retries; NEVER retry an active command.
        port.reset_input_buffer()
        port.write(COMMANDS["status"])
        port.flush()
        raw = read_record(port, 1.1)
        match = STATUS.fullmatch(raw)
        if match:
            print(raw.decode("ascii").strip())
            is_v4 = (match[1] == b"4" and match[3] == b" ro_scope=1" and
                     match[4] == b" di_scope=1 first_probe=1" and
                     match[5] == b" raw_a4=1")
            is_v3 = (match[1] == b"3" and match[3] == b" ro_scope=1" and
                     match[4] == b" di_scope=1 first_probe=1" and
                     match[5] is None)
            is_v2 = (match[1] == b"2" and match[3] == b" ro_scope=1" and
                     match[4] is None and match[5] is None)
            is_old_v1 = (match[1] == b"1" and match[3] is None and
                         match[4] is None and match[5] is None)
            if not (is_v4 or is_v3 or is_v2 or is_old_v1):
                raise RuntimeError("version/scope identity mismatch; no command sent")
            if require_v4 and not is_v4:
                raise RuntimeError(
                    "V4 RAW firmware not installed; flash the current firmware "
                    "before diagnostic test"
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


def save_ro_binary(raw: bytes, transcript: Path) -> Path | None:
    """Save the exact captured RO UART bytes, in order, without decoding them.

    Frames containing our own local TX echo cannot be source-attributed by RO.
    Keep the original timestamped transcript separately and unchanged.
    """
    match = re.search(rb"^CART_CAPTURE n=(\d+)\b", raw, re.MULTILINE)
    if match is None:
        return None
    values = re.findall(rb"^CART_EVT t_us=\d+ byte=([0-9A-F]{2})\r?$",
                        raw, re.MULTILINE)
    if len(values) != int(match[1]):
        print("RAW RO binary withheld: transcript event count mismatch")
        return None
    result = bytes(int(value, 16) for value in values)
    destination = transcript.with_suffix(".bin")
    with destination.open("xb") as target:
        target.write(result)
    print(f"Raw UART1 RO bytes: {destination} ({len(result)} bytes)")
    print(f"RO BIN SHA256: {hashlib.sha256(result).hexdigest()}")
    return destination


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
        if action == "raw-a4":
            print("KOEO RAW capture: one A4 reference request, saving every UART1 RO byte.")
        else:
            print("Experimental command: one manual attempt, engine off, external interface must be qualified.")
            print("Never retry after uncertain send or a failed capture; first inspect original evidence.")
    try:
        with serial.Serial(args.port, 115200, timeout=0.15, write_timeout=0.8,
                           dsrdtr=False, rtscts=False) as port:
            port.dtr = False
            port.rts = False
            time.sleep(1.5)
            port.reset_input_buffer()
            unused = quiet_status(port, require_v4=action in EXPLICIT)
            if action == "status":
                return 0
            if action in EXPLICIT and not unused:
                raise RuntimeError("one-shot already used on current ESP32 boot")
            port.reset_input_buffer()
            port.write(COMMANDS["pins"])
            port.flush()
            pins = read_record(port, 1.1)
            pin_match = PINS.fullmatch(pins)
            if (not pin_match or
                    (action in EXPLICIT and
                     (pin_match[1] != b" ro_scope=1" or
                      pin_match[2] != b" di_scope=1"))):
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
                if not quiet_status(port, require_v4=True):
                    raise RuntimeError("status changed before one-shot dispatch")
            port.reset_input_buffer()
            port.write(COMMANDS[action])
            port.flush()
            if action in VEHICLE:
                # 16384 timed UART event lines over a 115200bps USB serial
                # link may take much longer to drain than the 10s ECU
                # observation interval. Never truncate before CART_END.
                raw = read_record(port, 120.0, end=b" ecu_verified=0 dtc_verified=0\r\n")
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
        raw_ro = save_ro_binary(raw, path) if action == "raw-a4" else None
        if action in VEHICLE:
            if action == "raw-a4":
                state = re.search(
                    rb"^CART_RAW_B source=flxkrmr_A4 fixed_words=4 started=(\d+) "
                    rb"tx_done=(\d+) scheduled=(\d+) next_id=(\d+) fault=(\d+) "
                    rb"no_echo_gate=1 no_decode=1\r?$", raw, re.MULTILINE,
                )
                raw_capture = re.search(
                    rb"^CART_CAPTURE n=(\d+) uart_errors=(\d+) coalesced=(\d+) "
                    rb"dropped=(\d+) capped=([01]) cutoff=([01])\r?$",
                    raw, re.MULTILINE,
                )
                raw_end = re.search(
                    rb"^CART_END bytes=(\d+) uart_errors=(\d+) dropped=(\d+) "
                    rb"cutoff=([01]) ecu_verified=0 dtc_verified=0\r?$",
                    raw, re.MULTILINE,
                )
                print("UART1 RO bytes saved without any DTC interpretation.")
                print("Possible local transmit echo is INCLUDED in the raw stream.")
                if state:
                    print(f"Fixed A4 words: {state[2].decode()}/4 TX_DONE; "
                          f"fault={state[5].decode()}")
                valid_capture = (
                    raw_capture is not None and raw_end is not None and
                    raw_capture[1] == raw_end[1] and
                    raw_capture[2] == raw_end[2] and
                    raw_capture[4] == raw_end[3] and
                    raw_capture[6] == raw_end[4] and
                    all(value == b"0" for value in raw_capture.groups()[1:]) and
                    b"CART_RUN mode=RAW_SOURCE_A4 stopped=0" in raw
                )
                if (ENDING.search(raw) is None or state is None or
                        raw_ro is None or not valid_capture or
                        state[1] != b"4" or state[2] != b"4" or
                        state[3] != b"4" or state[5] != b"0"):
                    print("RAW capture / TX may be incomplete. Files retained; no retry.")
                    return 3
                return 0
            if ENDING.search(raw) is None:
                print("Incomplete/aborted session, preserve raw evidence and do NOT auto-retry")
                return 3
            if action == "probe-first":
                probe = re.search(
                    rb"^CART_PROBE_RESULT first_word_confirmed=([01]) "
                    rb"transmitted_words=(\d+) confirmed_words=(\d+) reason=(\d+) "
                    rb"no_full_B=1 no_dtc_claim=1\r?$",
                    raw, re.MULTILINE,
                )
                if probe is None:
                    print("First B-word probe missing its report; preserve capture, do not retry")
                    return 3
                print("First B word echo:", "CONFIRMED" if probe[1] == b"1" else "FAILED")
                print("B command complete: NO. DTC codes read: NO.")
                return (0 if probe[1] == b"1" and probe[2] == b"1" and
                        probe[3] == b"1" else 3)
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
