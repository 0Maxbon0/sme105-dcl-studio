#!/usr/bin/env python3
"""Inspect the first 97AB SME-105 DTC attempt OFFLINE, without opening USB.

Do not mistake a 9600 8N1 byte received in a command slot for a diagnostic
code. A partial B request never authorizes a DTC interpretation or a retry.
"""

from __future__ import annotations

import argparse
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIRST_CAPTURE = ROOT / "captures/SME105_97AB/20261103T084338040254Z-dtc-a4.txt"
FIRST_SHA256 = "9b35758ef5c900a8e0bed0c979c923edf4ca9dfb4c90f23276373b1b33e3df2a"
RX_EVENT = re.compile(rb"CART_EVT t_us=(\d+) byte=([0-9A-F]{2})")
FIRST_STATE = re.compile(
    rb"CART_B_STATE stage=(\d+) reason=(\d+) baseline=(\d+) "
    rb"scheduled=(\d+) echoed=(\d+) variant=(26A4|260E)"
)
FIRST_WORD = re.compile(
    rb"CART_TX_ATTEMPT start_us=(\d+) end_us=(\d+) frame=(\d+) "
    rb"slot=1 opcode=([0-9A-F]{4}) uart_errors=(\d+) cutoff=(\d+) echo_verified=(\d+)"
)
SUMMARY = re.compile(
    rb"CART_CAPTURE n=(\d+) uart_errors=(\d+) coalesced=(\d+) "
    rb"dropped=(\d+) capped=(\d+) cutoff=(\d+)"
)
ENDING = re.compile(
    rb"CART_END bytes=(\d+) uart_errors=(\d+) dropped=(\d+) "
    rb"cutoff=(\d+) ecu_verified=(\d+) dtc_verified=(\d+)"
)


@dataclass(frozen=True)
class FirstAttempt:
    source_sha256: str
    expected_first_echo: int
    observed_first_echo: int
    command_start_us: int
    first_rx_us: int
    echo_offset_us: int
    start_after_header_us: int
    slot_target_error_us: int
    baseline_frames: int
    reason_code: int


def parity(first: int, frame: int) -> int:
    return (((first >> 4) ^ (first & 15) ^ frame ^ 10) << 4 | frame) & 255


def inspect(raw: bytes) -> FirstAttempt:
    """Validate the whole first-failure structure and independent baseline."""
    digest = hashlib.sha256(raw).hexdigest()
    if not raw or len(raw) > 30_000 or not raw.endswith(b"\n"):
        raise ValueError("truncated/oversized first-attempt transcript")
    lines = raw.replace(b"\r", b"").splitlines()
    if not all(line.startswith((b"REF_", b"ACK_CANDIDATE ", b"CART_")) for line in lines):
        raise ValueError("unrecognized transcript line")
    if [line for line in lines if line.startswith(b"REF_TX ")] != [
        b"REF_TX frame=ECHO_ID n=11 cutoff=0",
        b"REF_TX frame=GO_CART n=11 cutoff=0",
    ]:
        raise ValueError("no exact reference handshake evidence")
    if b"REF_ACK count=12 raw=00 00 00 00 00 01 82 00 00 00 83 01 uart_errors=0" not in lines:
        raise ValueError("reference ACK not exact")
    if b"CART_RUN mode=ACTIVE_CANDIDATE stopped=0" not in lines:
        raise ValueError("not an uninterrupted active trial")
    if b"CART_TIMEBASE source=UART1_RX_FIFO_ISR time=us latency_uncalibrated=1" not in lines:
        raise ValueError("not a native UART1 timebase")
    state = [FIRST_STATE.fullmatch(x) for x in lines if x.startswith(b"CART_B_STATE ")]
    tx = [FIRST_WORD.fullmatch(x) for x in lines if x.startswith(b"CART_TX_ATTEMPT ")]
    summary = [SUMMARY.fullmatch(x) for x in lines if x.startswith(b"CART_CAPTURE ")]
    ending = [ENDING.fullmatch(x) for x in lines if x.startswith(b"CART_END ")]
    if (len(state) != 1 or len(tx) != 1 or len(summary) != 1 or len(ending) != 1 or
            any(x[0] is None for x in (state, tx, summary, ending))):
        raise ValueError("missing/ambiguous first-failure witness")
    st, word, cap, end = state[0], tx[0], summary[0], ending[0]
    if (tuple(int(st[i]) for i in range(1, 6)) != (4, 9, 16, 1, 0) or
            st[6] != b"26A4" or
            (int(word[2]), int(word[3]), word[4], int(word[5]), int(word[6]), int(word[7])) !=
            (0, 0, b"01B0", 0, 0, 0) or
            any(int(cap[i]) for i in range(2, 7)) or
            tuple(int(end[i]) for i in range(2, 7)) != (0, 0, 0, 0, 0)):
        raise ValueError("capture is not the clean first-word InvalidEcho failure")
    events = []
    for line in lines:
        if line.startswith(b"CART_EVT "):
            matched = RX_EVENT.fullmatch(line)
            if matched is None:
                raise ValueError("bad native RX event")
            events.append((int(matched[1]), int(matched[2], 16)))
    if len(events) != int(cap[1]) or len(events) != int(end[1]) or len(events) != 69:
        raise ValueError("inconsistent RX byte count")
    # 16 baseline frames and the beginning of the next cycle: ID0 again.
    for frame in range(17):
        head = events[frame * 4:frame * 4 + 4]
        t = [x[0] for x in head]
        b = [x[1] for x in head]
        if b != [0, 0, 0, parity(0, frame % 16)]:
            raise ValueError(f"CART frame {frame} parity or ID mismatch")
        if not (860 <= t[1]-t[0] <= 1220 and
                1280 <= t[2]-t[1] <= 1640 and
                860 <= t[3]-t[2] <= 1220):
            raise ValueError(f"CART frame {frame} has invalid native timing")
        if frame and not 9825 <= t[1]-events[(frame-1)*4+1][0] <= 10175:
            raise ValueError(f"CART frame {frame} has invalid cadence")
    start = int(word[1])
    first_rx_us, actual = events[-1]
    after_header = start - events[67][0]
    schedule_error = start - (events[65][0] + 2917)
    offset = first_rx_us - start
    if not (1800 < int(word[1]) and 100 <= after_header <= 1250 and
            -175 <= schedule_error <= 175 and 867 <= offset <= 1217):
        raise ValueError("first-word schedule or RX arrival time invalid")
    if actual == 0x01:
        raise ValueError("there is no first-byte echo mismatch")
    return FirstAttempt(digest, 0x01, actual, start, first_rx_us, offset,
                        after_header, schedule_error, 16, 9)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", type=Path, default=FIRST_CAPTURE)
    args = parser.parse_args()
    try:
        diagnosis = inspect(args.path.read_bytes())
    except (OSError, ValueError) as error:
        parser.exit(2, f"REJECTED incomplete or incompatible first DTC attempt: {error}\n")
    print(f"Original capture SHA256: {diagnosis.source_sha256}")
    print(f"CART synchronized: {diagnosis.baseline_frames} consecutive ID frames")
    print(f"First B word 01B0: slot start {diagnosis.command_start_us}us; "
          f"header-to-start {diagnosis.start_after_header_us}us; "
          f"target jitter {diagnosis.slot_target_error_us:+d}us")
    print(f"UART1 RO first byte: expected 0x{diagnosis.expected_first_echo:02X}, "
          f"received 0x{diagnosis.observed_first_echo:02X} "
          f"at +{diagnosis.echo_offset_us}us (nominal +1042us)")
    print("Fault 9 = InvalidEcho; zero confirmed B words, no real DTC, "
          "no proof yet whether the bus was driven correctly or contended.")
    print("NEXT: investigate GPIO18 DE/UART2 TX vs MAX487 RO at that slot; "
          "do NOT automatically try B variant 0E.")
    if args.path == FIRST_CAPTURE and diagnosis.source_sha256 != FIRST_SHA256:
        parser.exit(2, "REJECTED original first-attempt file hash changed\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
