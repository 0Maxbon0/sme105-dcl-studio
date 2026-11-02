#!/usr/bin/env python3
"""One-shot GPIO jumper TX/DE bench. NEVER connect MAX487 or vehicle.

Run only with both isolated jumpers: GPIO17--1k--GPIO16, GPIO18--1k--GPIO19.
This script does not know or send any Ford/DCL/CART request opcode.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import serial

IDENTITY = b"STATUS SME105_TX_ISOLATED_V1 vehicle_tx=LOCKED DE=LOW used="
SAMPLES = ("55AA", "33CC", "0FF0", "6996")
WORD = re.compile(
    r"^WORD index=(\d+) sample=([0-9A-F]{4}) target_us=(\d+) fired_us=(\d+) "
    r"done_us=(\d+) echo_count=(\d+) echo0_us=(\d+) echo1_us=(\d+) "
    r"tx_done_count=(\d+) cutoff=(\d+) error=(\d+) de_rmt_high_us=(\d+) "
    r"de_rmt_items=(\d+) tx_rmt_items=(\d+) tx_rmt_edges=(\d+)$"
)
SUMMARY = re.compile(
    r"^BENCH_END result=(PASS_GPIO_JUMPERS_ONLY|FAIL_CLOSED) "
    r"completed=(\d+) irq_errors=(\d+) coalesced=(\d+) "
    r"B_TX=0 ECU_TX=0 no_auto_retry=1 de_mode=RMT_AUTONOMOUS$"
)
AUTONOMOUS = re.compile(
    r"^DE_AUTONOMOUS result=(PASS_RMT_GPIO_PAD_ONLY|FAIL_CLOSED)(?: launch=(TASK|ISR) fired_us=(\d+))? "
    r"high_us=(\d+) rmt_items=(\d+) pad_poll_high_us=(\d+) mux=(\d+) commanded_us=2180 task_delay_ms=8 "
    r"UART_TX=0 B_TX=0 ECU_TX=0 one_shot=1$"
)


def validate_autonomous_de(raw: bytes, expected_launch: str = "TASK") -> tuple[bool, str]:
    try:
        lines = raw.decode("ascii").splitlines()
    except UnicodeDecodeError:
        return False, "invalid DE capture encoding"
    if lines.count("DE_LIMITS RMT_output_and_input_same_GPIO_not_external_bus_proof") != 1:
        return False, "missing hardware proof limitation"
    matches = [AUTONOMOUS.fullmatch(line) for line in lines if line.startswith("DE_AUTONOMOUS")]
    if len(matches) != 1 or matches[0] is None:
        return False, "DE pulse witness missing or malformed"
    verdict, launch, fired, high, count, pad_high, mux = matches[0].groups()
    # Older raw task-launch evidence omitted the launcher fields. Preserve
    # its original bytes, never infer an ISR witness from the legacy format.
    if launch is None and fired is None:
        launch, fired = "TASK", "0"
    if (verdict != "PASS_RMT_GPIO_PAD_ONLY" or launch != expected_launch or
            (int(fired) == 0) == (launch == "ISR") or
            not (2110 <= int(high) < 2250) or int(count) == 0 or
            not (2050 <= int(pad_high) < 2250) or int(mux) != 89):
        return False, "autonomous RMT DE high bound unverified"
    return True, "PASS autonomous one-shot RMT DE pulse at GPIO18 only (not MAX487 A/B)"


def validate_capture(raw: bytes) -> tuple[bool, str]:
    try:
        lines = raw.decode("ascii").splitlines()
    except UnicodeDecodeError:
        return False, "non-ASCII bench capture"
    if "BENCH_ABORT JUMPERS_NOT_VERIFIED no_uart_bytes=1 DE=LOW" in lines:
        if (sum(line.startswith("JUMPER_CHECK ") for line in lines) == 1 and
                not any(line.startswith(("WORD ", "BENCH_BEGIN", "BENCH_END")) for line in lines)):
            return False, "missing/incorrect physical jumpers; firmware aborted BEFORE sending any UART bytes"
        return False, "invalid or inconsistent jumper abort evidence"
    if (len(lines) != 8 or not lines[0].startswith("JUMPER_CHECK ") or
            lines[1] != "BENCH_BEGIN mode=EXTERNAL_JUMPER no_vehicle=1" or
            not lines[2].startswith("BENCH_END ") or
            any(not line.startswith(f"WORD index={i} ") for i, line in enumerate(lines[3:7])) or
            lines[7] != "LIMITS RMT_samples_gpio_pad_only no_RS485_voltage no_collision_proof cutoff_CPU_ISR_only"):
        return False, "unexpected evidence record order or additional lines"
    if lines.count("BENCH_BEGIN mode=EXTERNAL_JUMPER no_vehicle=1") != 1:
        return False, "missing or duplicate external bench begin"
    if lines.count("JUMPER_CHECK tx_high=1 tx_low=1 de_low=1 de_high=1 de_release=1 uart_bytes=0") != 1:
        return False, "two independent external jumper pairs not established"
    if lines.count("LIMITS RMT_samples_gpio_pad_only no_RS485_voltage no_collision_proof cutoff_CPU_ISR_only") != 1:
        return False, "missing or duplicate scope limitation"
    summaries = [SUMMARY.fullmatch(line) for line in lines if line.startswith("BENCH_END")]
    if len(summaries) != 1 or summaries[0] is None:
        return False, "missing or malformed BENCH_END"
    result, completed, errors, coalesced = summaries[0].groups()
    if (result, completed, errors, coalesced) != ("PASS_GPIO_JUMPERS_ONLY", "4", "0", "0"):
        return False, "device failed closed"
    words = [WORD.fullmatch(line) for line in lines if line.startswith("WORD ")]
    if len(words) != 4 or any(w is None for w in words):
        return False, "not exactly four valid word witnesses"
    previous_target = None
    for idx, match in enumerate(words):
        assert match is not None
        values = match.groups()
        index, sample = int(values[0]), values[1]
        target, fired, done, n_echo, echo0, echo1, n_done, cutoff, fault, de_high, de_items, tx_items, edges = map(int, values[2:])
        if index != idx or sample != SAMPLES[idx]:
            return False, "unexpected word order or bytes"
        if previous_target is not None and target - previous_target != 10000:
            return False, "incorrect synthetic slot cadence"
        previous_target = target
        if not (-100 <= fired - target <= 100):
            return False, "timer too far from planned slot"
        if not (1900 <= done - fired < 2250):
            return False, "TX_DONE outside bounded word window"
        if (n_echo, n_done, cutoff, fault) != (2, 1, 0, 0):
            return False, "incomplete echo, extra TX_DONE, cutoff or fault"
        if not (700 <= echo0 - fired <= 1250 and 1750 <= echo1 - fired <= 2250):
            return False, "unexpected echo byte timing"
        if not (1900 <= de_high < 2250 and de_items > 0 and tx_items > 0 and edges >= 8):
            return False, "no bounded independent-pad DE/TX edge witness"
    return True, "PASS_GPIO_JUMPERS_ONLY; no analog RS-485 or ECU proof"


def read_lines(port: serial.Serial, limit_s: float, end: bytes) -> bytes:
    data = bytearray()
    deadline = time.monotonic() + limit_s
    while time.monotonic() < deadline and len(data) < 65536:
        data.extend(port.read(4096))
        if end in data:
            break
    return bytes(data)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--port", default="/dev/ttyUSB0")
    p.add_argument("--action", choices=("status", "pins", "bench", "auto-de", "timed-de"), required=True)
    p.add_argument("--isolated-confirmed", action="store_true", help="explicitly assert ALL vehicle and MAX487 wires are disconnected; GPIO jumpers only")
    args = p.parse_args()
    if args.action in ("bench", "auto-de", "timed-de") and not args.isolated_confirmed:
        p.error("--isolated-confirmed is mandatory before driving GPIO17/18")
    with serial.Serial(args.port, 115200, timeout=0.15, write_timeout=0.8) as port:
        port.dtr = False
        port.rts = False
        time.sleep(1.2)
        port.reset_input_buffer()
        identity = b""
        for _ in range(4):  # read-only retries, NEVER resend bench
            port.write(b"STATUS\n")
            port.flush()
            identity = read_lines(port, 1.2, b"used=")
            if IDENTITY in identity:
                break
        if IDENTITY not in identity:
            print(f"DENIED wrong firmware, serial noise or reset: {identity[-200:]!r}")
            return 2
        used = identity.split(IDENTITY, 1)[1][:1]
        if used not in (b"0", b"1"):
            print("DENIED malformed firmware STATUS")
            return 2
        print(f"STATUS verified; used={used.decode()}, B=COMPILE_LOCKED")
        if args.action == "status":
            return 0
        if args.action in ("auto-de", "timed-de"):
            if used != b"0":
                print("DENIED one-shot already used, no retry")
                return 2
            port.write(b"BENCH_TIMED_RMT_DE_ONCE\n" if args.action == "timed-de" else b"BENCH_AUTONOMOUS_DE_ONCE\n")
            port.flush()
            capture = read_lines(port, 8, b"DE_LIMITS RMT_output_and_input_same_GPIO_not_external_bus_proof\r\n")
            validation = (lambda raw: validate_autonomous_de(raw, "ISR")) if args.action == "timed-de" else validate_autonomous_de
            suffix = "timed-rmt-de-gpio-bench" if args.action == "timed-de" else "autonomous-de-gpio-bench"
        else:
            port.write(b"PIN_CHECK\n")
            port.flush()
            pins = read_lines(port, 2, b"external_jumpers_needed=1")
            print(pins.decode("ascii", "backslashreplace").strip())
            matched = re.search(rb"^PIN_CHECK tx_echo16=(\d) de_sense19=(\d) DE=LOW no_tx=1 external_jumpers_needed=1$", pins.replace(b"\r", b""), re.MULTILINE)
            if not matched:
                print("DENIED missing preflight response")
                return 2
            if args.action == "pins":
                return 0
            if used != b"0" or matched.groups() != (b"1", b"0"):
                print("DENIED already used, missing GPIO17->GPIO16 jumper or bad DE idle; zero test bytes")
                return 2
            # No command prompt nor auto-retry: exact one explicit bench request.
            port.write(b"BENCH_JUMPERS_ONCE\n")
            port.flush()
            capture = read_lines(port, 12, b"LIMITS RMT_samples_gpio_pad_only no_RS485_voltage no_collision_proof cutoff_CPU_ISR_only\r\n")
            validation = validate_capture
            suffix = "tx-de-jumper-bench"
    path = Path(__file__).resolve().parents[1] / "captures" / "ISOLATED_GPIO" / (
        datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + f"-{suffix}.txt"
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(capture)
    ok, reason = validation(capture)
    print(f"Evidence: {path}")
    print(f"SHA256: {hashlib.sha256(capture).hexdigest()}")
    print(capture.decode("ascii", "backslashreplace"))
    print("VERDICT:", reason)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
