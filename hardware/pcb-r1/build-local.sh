#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ "${1:-}" != "--reset-unrouted" ]]; then
    echo "This generator REPLACES the routed PCB. To intentionally RESET to the original unrouted design use:"
    echo "    bash build-local.sh --reset-unrouted"
    echo "To inspect the routed design run: bash verify-local.sh"
    exit 2
fi
ROOT="$PWD/.tools/root"
export PYTHONPATH="$PWD/.tools/py:$ROOT/usr/lib/python3/dist-packages"
export LD_LIBRARY_PATH="$ROOT/usr/lib/x86_64-linux-gnu:$ROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export KICAD_SYMBOL_DIR="$ROOT/usr/share/kicad/symbols"
export KICAD7_SYMBOL_DIR="$ROOT/usr/share/kicad/symbols"
export KICAD7_FOOTPRINT_DIR="$ROOT/usr/share/kicad/footprints"
python3 gen_cad.py
"$ROOT/usr/bin/kicad-cli" sch export netlist --output board.net board.kicad_sch
echo "Reset completed: original schematic and UNROUTED PCB. Reapply routing and planes before any review."
