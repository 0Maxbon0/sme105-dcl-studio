#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
ROOT="$HOME/.cache/sme105-pcb-r0-toolchain/root"
PROOT="$HOME/.cache/sme105-pcb-r0-toolchain/proot/usr/bin/proot"
export LD_LIBRARY_PATH="$ROOT/usr/lib/x86_64-linux-gnu:$ROOT/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export PYTHONPATH="$ROOT/usr/lib/python3/dist-packages${PYTHONPATH:+:$PYTHONPATH}"
export KICAD7_SYMBOL_DIR="$ROOT/usr/share/kicad/symbols"
export KICAD7_FOOTPRINT_DIR="$ROOT/usr/share/kicad/footprints"
export KICAD7_3DMODEL_DIR="$ROOT/usr/share/kicad/3dmodels"
export KICAD_PATH="$ROOT/usr/share/kicad"
exec "$PROOT" -b "$ROOT/usr/share/kicad:/usr/share/kicad" "$ROOT/usr/bin/eeschema" "$PWD/board.kicad_sch"
