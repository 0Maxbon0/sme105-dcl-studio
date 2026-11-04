"""Host proofs for the continuous map and lossless packed evidence."""
import io
import json
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from scripts import decode_live_pids as decoder
from scripts import sme105_usb_bridge as bridge
from scripts.rx_batch import parse_rx_batch

ROOT = Path(__file__).resolve().parents[1]


class AllLiveTests(unittest.TestCase):
    def test_native_map_has_45_verified_words_and_matches_both_decoders(self):
        if not shutil.which("g++"):
            self.skipTest("native compiler unavailable")
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "map.cpp"
            binary = Path(tmp) / "map"
            source.write_text('''#include <cstdio>
#define DRAM_ATTR
#define IRAM_ATTR
#include "live_all_map.h"
int main() {
  if (allLivePid(16,0) || allLivePid(1,3) || kAllLiveMapWords != 45) return 1;
  for (int f=0; f<16; ++f) for (int c=0; c<3; ++c)
    std::printf("%u\\n", allLivePid(f,c));
}
''')
            subprocess.run(["g++", "-std=c++17", "-I", str(ROOT / "firmware/sme105_usb_bridge"),
                            str(source), "-o", str(binary)], check=True, capture_output=True)
            values = list(map(int, subprocess.check_output([str(binary)], text=True).splitlines()))
        self.assertEqual(values, [v for row in decoder.ALL_LIVE_MAP for v in row])
        browser = json.loads(subprocess.check_output([
            "node", "--input-type=module", "-e",
            "import { ALL_LIVE_MAP } from './app/js/pids.js'; console.log(JSON.stringify(ALL_LIVE_MAP.flat()));"
        ], cwd=ROOT, text=True))
        self.assertEqual(values, browser)
        self.assertEqual(len(set(values) - {0}), 39)

    def test_packed_recorder_preserves_exact_bytes_and_original_transcript(self):
        wire = b"RXB t_us=100 data=00F8A5 dt=0,1042,2500\n"
        with tempfile.TemporaryDirectory() as tmp:
            recorder = bridge.EvidenceRecorder(Path(tmp), "all")
            for byte in wire:
                recorder.feed(bytes([byte]))
            self.assertEqual(recorder.rx_bytes, 3)
            self.assertIsNone(recorder.fault)
            recorder.close()
            self.assertEqual(recorder.bin_path.read_bytes(), bytes([0, 0xF8, 0xA5]))
            self.assertEqual(recorder.txt_path.read_bytes(), wire)
        self.assertEqual(parse_rx_batch(b"RXB t_us=4294967290 data=00FF dt=0,10"),
                         [(4294967290, 0), (4, 255)])
        for wire in [b"RXB t_us=1 data=00FF dt=0", b"RXB t_us=1 data=00 dt=1",
                     b"RXB t_us=1 data=00FFAA dt=0,30,20"]:
            with self.assertRaises(ValueError):
                parse_rx_batch(wire)

    def test_all_capture_offline_decoder_preserves_three_columns(self):
        def word(raw):
            lo, hi = raw & 255, raw >> 8
            return [lo, (((lo & 15) ^ (lo >> 4) ^ hi ^ 10) << 4) | hi]
        events = []
        t = 100000
        for mode in [0x21, 0x41, 0x21, 0x21]:
            for frame in range(16):
                def add(offset, pair):
                    events.extend((t + offset + i*1042, byte) for i, byte in enumerate(pair))
                add(0, [0, 0]); add(2500, word((frame << 8) | 0xF8))
                add(5000, word(0x600 | mode) if frame == 4 else word(0))
                if frame and mode == 0x21:
                    for column, pid in enumerate(decoder.ALL_LIVE_MAP[frame]):
                        add(7500 + column*2500, word(pid*11+1))
                t += 22500
        lines = ["EVENT read_armed variant=ALL", "EVENT session=READ_CANDIDATE"]
        for i in range(0, len(events), 16):
            chunk = events[i:i+16]
            lines.append(f"RXB t_us={chunk[0][0]} data=" + ''.join(f'{v:02X}' for _, v in chunk)
                         + ' dt=' + ','.join(str(at-chunk[0][0]) for at, _ in chunk))
        lines.append("END reason=16")
        with tempfile.TemporaryDirectory() as tmp:
            cap, csv = Path(tmp)/"all.txt", Path(tmp)/"all.csv"
            cap.write_text('\n'.join(lines)+'\n')
            with redirect_stdout(io.StringIO()):
                self.assertEqual(decoder.decode(cap, csv), 0)
            rows = [r.split(',') for r in csv.read_text().splitlines()[1:]]
        self.assertEqual(len({r[1] for r in rows}), 39)
        self.assertGreater(min(float(r[0]) for r in rows), .36)
        for row in rows:
            name, raw = row[1], int(row[2])
            pid = next(pid for pid, spec in decoder.PIDS.items() if spec[0] == name)
            self.assertEqual(raw, pid*11+1)

    def test_map_chaining_keeps_each_word_guarded_and_checks_map_completion(self):
        source = (ROOT / "firmware/sme105_usb_bridge/sme105_usb_bridge.ino").read_text()
        self.assertIn("extraTargetUs + 2500, extraColumn + 1", source)
        self.assertIn("pidWordsStarted != kAllLiveMapWords || pidWordsVerified != kAllLiveMapWords", source)
        verified = source[source.index("} else if (extra) {"):source.index("void IRAM_ATTR slideHeader")]
        self.assertLess(verified.index("++pidWordsVerified"), verified.index("armExtra("))
        for command in ["ARM_ALL", "READ_ALL"]:
            self.assertIn(command, source)
            self.assertIn(command, bridge.WIRE_COMMANDS)
        self.assertIn("REQUEST_ALL", bridge.CAR_TRANSMIT)


if __name__ == "__main__":
    unittest.main()
