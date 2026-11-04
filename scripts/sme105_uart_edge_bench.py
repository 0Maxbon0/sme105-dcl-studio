#!/usr/bin/env python3
"""USB-only GPIO UART timing experiment. NEVER connect to vehicle or MAX487.

Bench wiring: GPIO17->GPIO16 and GPIO17->GPIO19 (ideally 1k resistors).
All GPIOs are 3.3 V on the isolated ESP32; no OBD pins or car wires.
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

IDENTITY = re.compile(
    rb"^STATUS SME105_UART_EDGE_BENCH_V2 DE=LOW ECU_TX=DISABLED used=([01])$"
)
PINS = re.compile(
    rb"^PIN_CHECK tx17=([01]) rx16=([01]) trace19=([01]) "
    rb"ready=([01]) DE=LOW no_test_bytes=1$"
)


def pin_check(port: serial.Serial) -> bool:
    """USB-only pin idle probe, never sends bench test bytes."""
    port.write(b"PIN_CHECK\n")
    port.flush()
    response = b""
    deadline = time.monotonic() + 2.5
    while time.monotonic() < deadline:
        response = (response + port.read(256))[-2048:]
        for line in response.splitlines():
            match = PINS.fullmatch(line.strip())
            if match:
                tx, rx, trace, ready = (int(value) for value in match.groups())
                print(f"PIN_CHECK: TX2/GPIO17={tx}, RX2/GPIO16={rx}, D19/GPIO19={trace}")
                if not ready:
                    print("PIN CHECK FAILED: check both TX2 jumpers and the actual board pin labels; no test bytes sent")
                return ready == 1 and tx == rx == trace == 1
    print(f"PIN CHECK INCOMPLETE: no validated reply, raw={response[-350:]!r}")
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--action", required=True, choices=("status", "pins", "bench"))
    args = parser.parse_args()
    port = serial.Serial(args.port, baudrate=115200, timeout=0.15, write_timeout=0.8)
    try:
        port.dtr = False
        port.rts = False
        time.sleep(0.85)
        dropped = port.read(port.in_waiting)
        print(f"Discarded {len(dropped)} USB startup bytes")
        # CP2102 DTR/RTS may reset ESP32 on USB open; a STATUS sent while
        # the sketch is still booting may be ignored or mixed with startup
        # bytes, producing a misleading DENIED unknown_command. Repeat only
        # the strictly read-only STATUS probe (never BENCH_GPIO_ONCE).
        status = b""
        identified = False
        consumed = False
        for _ in range(4):
            port.write(b"STATUS\n")
            port.flush()
            deadline = time.monotonic() + 1.25
            while time.monotonic() < deadline:
                status = (status + port.read(1024))[-8192:]
                for line in status.splitlines():
                    match = IDENTITY.fullmatch(line.strip())
                    if match:
                        identified = True
                        consumed = match[1] == b"1"
                        break
                if identified:
                    break
            if identified:
                break
        if not identified:
            print(f"ABORT wrong firmware, used state, or bad serial: {status[-500:]!r}")
            return 3
        print(f"BENCH STATUS PASS: USB-only firmware, DE=LOW, no vehicle TX, used={int(consumed)}")
        if args.action == "status":
            return 0
        if args.action == "pins":
            return 0 if pin_check(port) else 3
        if consumed:
            print("ABORT: one-shot bench already consumed this boot. Check pins with --action pins")
            return 3
        print("ONLY if MAX487 and every car wire are disconnected from ESP32.")
        print("GPIO17 -> GPIO16 and GPIO17 -> GPIO19, each ideally via 1k resistor.")
        if not pin_check(port):
            return 3
        if input("Type BENCH_GPIO_ONCE to run isolated GPIO UART test: ").strip() != "BENCH_GPIO_ONCE":
            print("ABORT: confirmation not given; no GPIO TX")
            return 2
        port.write(b"BENCH_GPIO_ONCE\n")
        port.flush()
        transcript = bytearray()
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline and len(transcript) < 250_000:
            data = port.read(8192)
            transcript.extend(data)
            if b"BENCH_END DCL_TX=0 ECU_TX=0 DE=LOW" in transcript:
                break
            if b"BENCH_DENIED" in transcript or b"BENCH_FAIL" in transcript:
                break
        folder = Path(__file__).resolve().parents[1] / "captures" / "ISOLATED_GPIO"
        folder.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        file = folder / f"{stamp}-uart-edge-bench.txt"
        file.write_bytes(transcript)
        print(f"Evidence: {file}")
        print(f"SHA256: {hashlib.sha256(transcript).hexdigest()}")
        for line in transcript.decode("ascii", errors="replace").splitlines():
            if line.startswith(("BENCH_", "STATUS ", "PIN_")):
                print(line)
        if b"BENCH_END DCL_TX=0 ECU_TX=0 DE=LOW" not in transcript:
            print("INCOMPLETE. Do not auto-repeat; inspect evidence.")
            return 3
        if len(re.findall(rb"^BENCH_TRIAL mode=[12] .*", transcript, re.MULTILINE)) != 2:
            print("INCOMPLETE: missing two distinct local bench modes")
            return 3
        print("BENCH RECORDED. Send this output; no real-car B TX was tested.")
        return 0
    finally:
        port.close()


if __name__ == "__main__":
    sys.exit(main())
