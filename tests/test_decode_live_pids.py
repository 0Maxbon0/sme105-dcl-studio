from __future__ import annotations

import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import decode_live_pids as dl  # noqa: E402


def word(data: int) -> tuple[int, int]:
    b0, nib = data & 0xFF, (data >> 8) & 15
    par = (b0 & 15) ^ (b0 >> 4) ^ nib ^ 0xA
    return b0, (par << 4) | nib


def synthetic_capture(values: dict[int, int]) -> str:
    lines = ["EVENT session=READ_CANDIDATE"]
    t = 1_000_000
    for _block in range(3):
        for frame in range(16):
            slots = {1: word(frame << 8)}  # ID word: rpm byte 0, frame id in bits 8-11
            if frame == 4:
                slots[2] = word(0x621)  # current DIAGMODE 21H, length 6
            pid = dl.LIVE_PIDS[frame]
            if pid:
                slots[3] = word(values[pid])
            lines += [f"RX t_us={t} byte=00", f"RX t_us={t + 1042} byte=00"]
            for slot, (b0, b1) in slots.items():
                start = t + slot * 2500 - 2
                lines += [f"RX t_us={start} byte={b0:02X}", f"RX t_us={start + 1042} byte={b1:02X}"]
            t += 22_500
    lines.append("END reason=16")
    return "\n".join(lines) + "\n"


class DecodeLivePidsTests(unittest.TestCase):
    def test_scaling_and_slot_mapping(self) -> None:
        raw = {pid: 0 for pid in dl.LIVE_PIDS[1:]}
        raw.update({0x01: 200, 0x05: 1020, 0x0F: 0xEC, 0x10: 95, 0x11: 200, 0x03: 236})
        with tempfile.TemporaryDirectory() as tmp:
            cap = Path(tmp) / "live.txt"
            cap.write_text(synthetic_capture(raw), encoding="utf-8")
            out = io.StringIO()
            with redirect_stdout(out):
                self.assertEqual(dl.decode(cap, Path(tmp) / "live.csv"), 0)
            rows = (Path(tmp) / "live.csv").read_text(encoding="utf-8").splitlines()
        text = out.getvalue()
        self.assertIn("0 parity rejects", text)
        last = {r.split(",")[1]: r.split(",")[3] for r in rows[1:]}
        self.assertEqual(last["N"], "800")          # 200 * 4 rpm
        self.assertEqual(last["IACT"], "1020")      # raw A/D counts
        self.assertEqual(last["ACT"], "-40.0")      # -20 * 2 degF = -40 degC
        self.assertEqual(last["ECT"], "87.8")       # 190 degF
        self.assertEqual(last["VBAT"], "12.5")      # 200 / 16 V
        self.assertEqual(last["BP"], "29.5")        # 236 / 8 inHg

    def test_no_values_without_mode_21h(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cap = Path(tmp) / "none.txt"
            cap.write_text("EVENT session=READ_CANDIDATE\nRX t_us=1 byte=00\nEND reason=16\n",
                           encoding="utf-8")
            with redirect_stdout(io.StringIO()):
                self.assertEqual(dl.decode(cap, None), 1)


if __name__ == "__main__":
    unittest.main()
