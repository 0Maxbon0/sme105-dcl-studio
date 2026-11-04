"""Decode an SME105 bridge LIVE (DIAGMODE 41H/21H) capture into PID values.

Frame layout (LHBH1 ch.13): sync, ID word (IW0), IW1 (DPS/status), IW2..
The bridge loads one PID per frame into IW2; in mode 21H the ECU returns the
value in that same slot. Scaling follows LHBH1 13-29 "PID Code Tables".
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from dataclasses import dataclass
from pathlib import Path

RX = re.compile(r"RX t_us=(\d+) byte=([0-9A-F]{2})")
# Must match kLivePids in firmware/sme105_usb_bridge/sme105_usb_bridge.ino.
LIVE_PIDS = (0x00, 0x01, 0x0F, 0x10, 0x05, 0x06, 0x09, 0x11,
             0x03, 0x04, 0x0C, 0x0D, 0x08, 0x18, 0x27, 0x28)
SLOT_US = 2500


def s8(v: int) -> int:
    v &= 0xFF
    return v - 256 if v & 0x80 else v


def f_to_c(f: float) -> float:
    return (f - 32.0) / 1.8


# name, unit, scaler(raw 12-bit value) per LHBH1 13-29.
PIDS = {
    0x01: ("N", "rpm", lambda v: v * 4),
    0x03: ("BP", "inHg", lambda v: (v & 0xFF) / 8),
    0x04: ("SAFTOT", "deg", lambda v: s8(v) / 4),
    0x05: ("IACT", "A/D", lambda v: v),
    0x06: ("IECT", "A/D", lambda v: v),
    0x08: ("IEGO1", "A/D", lambda v: v),
    0x09: ("ITP", "A/D", lambda v: v),
    0x0C: ("FUELPW1", "ticks", lambda v: v * 32),
    0x0D: ("LAMBSE1", "lambda", lambda v: v / 2048),
    0x0F: ("ACT", "degC", lambda v: round(f_to_c(s8(v) * 2), 1)),
    0x10: ("ECT", "degC", lambda v: round(f_to_c(s8(v) * 2), 1)),
    0x11: ("VBAT", "V", lambda v: (v & 0xFF) / 16),
    0x18: ("VS", "mph", lambda v: v / 32),
    0x27: ("LOAD", "%", lambda v: round(v * 0.0488, 2)),
    0x28: ("KAMRF1", "A/F", lambda v: v / 16),
}


def parity_ok(b0: int, b1: int) -> bool:
    return ((b0 & 15) ^ (b0 >> 4) ^ (b1 & 15) ^ 0xA) == (b1 >> 4)


@dataclass
class Frame:
    t: int
    fid: int
    slots: dict[int, tuple[int, int]]


def frames_from(rx: list[tuple[int, int]]) -> list[Frame]:
    words: list[list[tuple[int, int]]] = []
    for t, b in rx:
        if words and t - words[-1][-1][0] <= 1300 and len(words[-1]) < 2:
            words[-1].append((t, b))
        else:
            words.append([(t, b)])
    frames: list[Frame] = []
    for i, w in enumerate(words[:-1]):
        nxt = words[i + 1]
        # ID word low byte is the RPM/status byte (non-zero when running).
        if ([b for _, b in w] == [0, 0] and len(nxt) == 2
                and parity_ok(nxt[0][1], nxt[1][1])):
            frames.append(Frame(w[0][0], nxt[1][1] & 15, {}))
        elif frames and len(w) == 2:
            slot = round((w[0][0] - frames[-1].t) / SLOT_US)
            frames[-1].slots.setdefault(slot, (w[0][1], w[1][1]))
    return frames


def decode(path: Path, csv_path: Path | None) -> int:
    text = path.read_text(encoding="utf-8", errors="replace")
    start = text.find("EVENT session=READ_CANDIDATE")
    if start < 0:
        print("no READ session in capture", file=sys.stderr)
        return 2
    end = text.find("END reason=", start)
    rx = [(int(t), int(b, 16)) for t, b in RX.findall(text[start:end if end > 0 else None])]
    frames = frames_from(rx)
    rows: list[tuple[float, str, int, float]] = []
    bad = 0
    mode = None
    t0 = frames[0].t if frames else 0
    for fr in frames:
        if fr.fid == 4 and 2 in fr.slots:
            mode = fr.slots[2][0]
        if mode != 0x21 or fr.fid == 0:
            continue
        word = fr.slots.get(3)  # IW2: sync=0, ID=1, IW1=2, IW2=3
        if word is None:
            continue
        if not parity_ok(*word):
            bad += 1
            continue
        pid = LIVE_PIDS[fr.fid]
        raw = ((word[1] & 15) << 8) | word[0]
        rows.append(((fr.t - t0) / 1e6, PIDS[pid][0], raw, PIDS[pid][2](raw)))
    if not rows:
        print("no 21H value slots decoded (ECU never entered mode 21H?)")
        return 1
    print(f"{len(rows)} values, {bad} parity rejects, "
          f"{rows[0][0]:.2f}s .. {rows[-1][0]:.2f}s")
    print(f"{'PID':8} {'unit':6} {'n':>4} {'first':>9} {'min':>9} {'max':>9} {'last':>9}  raw(last)")
    for pid in LIVE_PIDS[1:]:
        name, unit, _ = PIDS[pid]
        vals = [r for r in rows if r[1] == name]
        if not vals:
            print(f"{name:8} {unit:6} {0:>4}")
            continue
        scaled = [v[3] for v in vals]
        print(f"{name:8} {unit:6} {len(vals):>4} {scaled[0]:>9} {min(scaled):>9} "
              f"{max(scaled):>9} {scaled[-1]:>9}  {vals[-1][2]}")
    if csv_path:
        with csv_path.open("w", newline="", encoding="utf-8") as fh:
            writer = csv.writer(fh)
            writer.writerow(["t_s", "pid", "raw", "value"])
            writer.writerows(rows)
        print(f"CSV: {csv_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path, help="bridge USB transcript (.txt)")
    parser.add_argument("--csv", type=Path, help="write time series CSV")
    args = parser.parse_args(argv)
    return decode(args.capture, args.csv)


if __name__ == "__main__":
    raise SystemExit(main())
