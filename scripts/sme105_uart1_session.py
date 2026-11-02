#!/usr/bin/env python3
"""USB controller for experimental SME105_UART1_CAPTURE_V1 CART reception.

The firmware does not transmit stored-code B. This host runs the single
documented reference handshake ONLY with an explicit operator opt-in.
No automatic retry, arbitrary UART bytes, or ECU modification commands.
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
    rb"^STATUS SME105_UART1_CAPTURE_V1 DE=LOW B_TX=COMPILE_LOCKED "
    rb"used=([01]) deadline_timer=([01])\r\n$"
)
END = b"CART_END DTC_UNVERIFIED B_TX_LOCKED\n"
MAX_EVIDENCE_BYTES = 1_000_000
PLAN = re.compile(
    rb"CART_B_PLAN stage=(SEEK|BASELINE|COMMAND_CYCLE|COMPLETE|FAILED) "
    rb"reason=(\d+) baseline_frames=(\d+) command_frames=(\d+) "
    rb"phase_bits=(-?\d+) scheduled=(\d+) fired=(\d+) "
    rb"mode=DRY_RUN tx_bytes=0 ecu_verified=0"
)
SLOT = re.compile(
    rb"CART_B_SLOT frame=([0-3]) slot=1 opcode=([0-9A-F]{4}) "
    rb"target_us=(\d+) fired_us=(\d+) dry_run=1 tx_bytes=0"
)
DIRECT_BASELINE = re.compile(
    rb"^CART_DIRECT_BASELINE valid=([01]) frames=([0-9]+) cycles=([0-9]+) "
    rb"prefix=([0-9]+) phase=(0|4|255) edge_verified=0 b_tx=0$"
)
ABORT_LINE = re.compile(rb"^(?:CART_ABORT|ABORT) [ -~]{1,180}$")
RX_SELFTEST = re.compile(
    rb"^RAW_ISR_SELFTEST PASS irq=READY rx_events=([0-9]+) "
    rb"uart_errors=([0-9]+) B_TX_LOCKED\r\n$"
)


class CaptureIncomplete(RuntimeError):
    def __init__(self, message: str, raw: bytes) -> None:
        super().__init__(message)
        self.raw = raw


def drain_boot(conn: object, *, minimum: float = 1.4, maximum: float = 6) -> int:
    began = time.monotonic()
    last = began
    discarded = 0
    while time.monotonic() - began < maximum:
        n = int(conn.in_waiting)
        data = conn.read(min(4096, n) if n else 1)
        if data:
            discarded += len(data)
            last = time.monotonic()
        if time.monotonic() - began >= minimum and time.monotonic() - last > 0.5:
            return discarded
    raise RuntimeError("USB startup remained noisy")


def status(conn: object) -> bool:
    time.sleep(0.08)
    if conn.in_waiting:
        raise RuntimeError("unexpected USB bytes before status")
    conn.write(b"STATUS\n")
    conn.flush()
    response = conn.read_until(b"\n", size=180)
    match = IDENTITY.fullmatch(response)
    if match is None:
        raise RuntimeError(f"wrong firmware identity or serial corruption: {response[:100]!r}")
    time.sleep(0.08)
    if conn.in_waiting:
        raise RuntimeError("unsolicited bytes after status")
    if match.group(2) != b"1":
        raise RuntimeError("TX cutoff timer missing")
    return match.group(1) == b"0"


def capture(conn: object, *, deadline_seconds: float = 60,
            action: str = "CAPTURE_CART_ONCE") -> bytes:
    if action not in ("CAPTURE_CART_ONCE", "PLAN_B_ONCE"):
        raise ValueError("only fixed reference handshake or timing-only dry-run is allowed")
    conn.write(action.encode("ascii") + b"\n")
    conn.flush()
    began = time.monotonic()
    stream = bytearray()
    while time.monotonic() - began < deadline_seconds:
        data = conn.read(4096)
        if not data:
            continue
        stream.extend(data)
        if b"Guru Meditation Error" in stream or b"Backtrace:" in stream:
            raise CaptureIncomplete(
                "ESP32 PANIC/REBOOT after reference request (see saved backtrace)",
                bytes(stream),
            )
        if len(stream) > MAX_EVIDENCE_BYTES:
            raise CaptureIncomplete(
                "capture transcript exceeds host bound; no automatic retry",
                bytes(stream),
            )
        normalized = bytes(stream[-256:]).replace(b"\r\n", b"\n")
        if any(ABORT_LINE.fullmatch(line) for line in normalized.split(b"\n")[:-1]):
            raise CaptureIncomplete("firmware aborted its one-shot session", bytes(stream))
        if END in normalized:
            if not normalized.endswith(END):
                raise CaptureIncomplete("extra data after CART_END", bytes(stream))
            return bytes(stream)
    raise CaptureIncomplete("timed CART capture timeout; no automatic retry", bytes(stream))


def selftest_receiver(conn: object) -> tuple[int, int]:
    """Exercise native RX IRQ registration; never send a vehicle bus frame."""
    conn.write(b"SELFTEST_RX_ISR\n")
    conn.flush()
    result = conn.read_until(b"\n", size=200)
    match = RX_SELFTEST.fullmatch(result)
    if not match:
        raise RuntimeError(f"RX ISR selftest failed, old firmware or USB corruption: {result[:150]!r}")
    return int(match[1]), int(match[2])


def write_evidence(raw: bytes, root: Path) -> Path:
    target = root / "captures" / "TIMED_CART"
    target.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    path = target / f"{stamp}-cart-isr.txt"
    with path.open("xb") as handle:
        handle.write(raw)
    return path


def inspect_dry_run(raw: bytes) -> tuple[bool, str]:
    """Only a local four-slot timer observation; never an ECU DTC result."""
    lines = raw.replace(b"\r\n", b"\n").splitlines()
    plans = [m for line in lines if (m := PLAN.fullmatch(line)) is not None]
    slots = [m for line in lines if (m := SLOT.fullmatch(line)) is not None]
    if len(plans) != 1:
        return False, "PLAN incomplete: no unique timer-model result"
    stage, reason, baseline, command, phase, scheduled, fired = plans[0].groups()
    fields = (stage, int(reason), int(baseline), int(command), int(phase),
              int(scheduled), int(fired))
    if fields[0] != b"COMPLETE" or fields[1:4] != (0, 16, 16) or fields[4] not in (0, 4) or fields[5:] != (4, 4):
        lagged = [m for line in lines if (m := DIRECT_BASELINE.fullmatch(line))]
        detail = f"PLAN incomplete: stage={stage.decode()} reason={int(reason)} scheduled={int(scheduled)} fired={int(fired)}"
        if len(lagged) == 1 and lagged[0][1] == b"1":
            detail += (f"; recorded CART ID-only frames={int(lagged[0][2])}, "
                       f"complete 16-ID cycles={int(lagged[0][3])} "
                       "(one-byte FIFO-lag inference, NOT validated active slot timing)")
        return False, detail
    words = (b"01B0", b"FF5F", b"26A4", b"00A0")
    if len(slots) != 4:
        return False, "PLAN incomplete: missing four timed opportunities"
    for index, match in enumerate(slots):
        frame, opcode, target, fired_at = match.groups()
        if (int(frame) != index or opcode != words[index] or
                abs(int(fired_at) - int(target)) > 175):
            return False, "PLAN incomplete: incorrect slot word or timing"
    return True, "PLAN timing observed for 4/4 slots; B was NOT transmitted, no DTC read"


def inspect_direct_id_baseline(raw: bytes) -> str:
    """UART1 direct ID capture witness, not yet independently verified on ECU."""
    matches = [m for line in raw.replace(b"\r\n", b"\n").splitlines()
               if (m := DIRECT_BASELINE.fullmatch(line))]
    if len(matches) != 1 or matches[0][1] != b"1":
        return "CART ID-only baseline not validated by receiver"
    return (f"UART1 CART ID-only baseline observed: {int(matches[0][2])} frames, "
            f"{int(matches[0][3])} full cycles. FIFO-lag inferred; "
            "physical slot timing and DTC reading NOT verified")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=PORT)
    parser.add_argument("--action", choices=("status", "rx-isr-selftest", "capture-cart-once"),
                        default="status")
    args = parser.parse_args()
    try:
        import serial
    except ImportError:
        print("pyserial missing; run using project .venv", file=sys.stderr)
        return 2
    dispatched = False
    raw = b""
    reason = None
    try:
        with serial.Serial(args.port, baudrate=115200, timeout=0.15,
                           write_timeout=0.8, dsrdtr=False, rtscts=False) as conn:
            conn.dtr = False
            conn.rts = False
            discarded = drain_boot(conn)
            print(f"Discarded {discarded} USB startup bytes.")
            armable = status(conn)
            if status(conn) != armable:
                raise RuntimeError("firmware state changed unexpectedly")
            if args.action == "status":
                print(f"STATUS PASS; B diagnostic TX is locked, reference attempt unused={armable}")
                return 0
            if args.action == "rx-isr-selftest":
                received, errors = selftest_receiver(conn)
                print(f"RX ISR SELFTEST PASS; received={received} uart_errors={errors}; zero bus TX")
                return 0
            if not armable:
                raise RuntimeError("reference handshake already consumed this boot")
            command = "CAPTURE_CART_ONCE"
            print("Only historical Echo-ID/Go-CART will transmit, once. "
                  "B DTC TX is COMPILE-LOCKED; PLAN_B_ONCE exercises timer-only dry run.")
            if input(f"Type {command} to authorize reference handshake: ").strip() != command:
                print("Cancelled; no bus transmission.")
                return 0
            if not status(conn):
                raise RuntimeError("final one-shot status denied")
            dispatched = True
            raw = capture(conn, action=command)
    except CaptureIncomplete as exc:
        raw = exc.raw
        reason = str(exc)
    except (OSError, serial.SerialException, RuntimeError, KeyboardInterrupt) as exc:
        reason = str(exc) or type(exc).__name__
    if not dispatched:
        print(f"ABORT before bus dispatch: {reason}", file=sys.stderr)
        return 2
    # A byte stream that was lost mid-acquisition is not discarded: save the
    # partial raw evidence as-is, but NEVER claim a complete read.
    saved = write_evidence(raw, Path(__file__).resolve().parents[1])
    print(f"Evidence: {saved}")
    print(f"SHA256: {hashlib.sha256(raw).hexdigest()}")
    if reason:
        print(f"INCOMPLETE: {reason}; no automatic retry")
        return 3
    print(inspect_direct_id_baseline(raw))
    print("RAW UART1 CART capture complete. Analyze with scripts/analyze_timed_dtc.py.")
    print("Stored-code DTCs NOT requested by this firmware.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
