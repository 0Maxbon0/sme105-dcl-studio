#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD/.tools/root"
export LD_LIBRARY_PATH="$ROOT/usr/lib/x86_64-linux-gnu:$ROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PYTHONPATH="$PWD/.tools/py:$ROOT/usr/lib/python3/dist-packages"
"$ROOT/usr/bin/kicad-cli" sch export netlist --output board-final.net board.kicad_sch
python3 - <<'PY'
import pcbnew as p
b=p.LoadBoard('board.kicad_pcb')
assert p.WriteDRCReport(b,'post-bundle-drc.txt',p.EDA_UNITS_MILLIMETRES,True)
PY
python3 verify_design.py
