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
    rb"^STATUS SME105_UART_EDGE_BENCH_V1 DE=LOW ECU_TX=DISABLED used=0$"
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--action", required=True, choices=("status", "bench"))
    args = parser.parse_args()
    port = serial.Serial(args.port, baudrate=115200, timeout=0.15, write_timeout=0.8)
    try:
        port.dtr = False
        port.rts = False
        time.sleep(0.85)
        dropped = port.read(port.in_waiting)
        print(f"Discarded {len(dropped)} USB startup bytes")
        port.write(b"STATUS\n")
        port.flush()
        status = b""
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            status += port.read(1024)
            if any(IDENTITY.fullmatch(line.strip()) for line in status.splitlines()):
                break
        else:
            print(f"ABORT wrong firmware, used state, or bad serial: {status[-500:]!r}")
            return 3
        print("BENCH STATUS PASS: USB-only firmware, DE=LOW, no vehicle TX")
        if args.action == "status":
            return 0
        print("ONLY if MAX487 and every car wire are disconnected from ESP32.")
        print("GPIO17 -> GPIO16 and GPIO17 -> GPIO19, each ideally via 1k resistor.")
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
            if line.startswith(("BENCH_", "STATUS ")):
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
