#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-python3}"
VENV="${VENV:-${ROOT}/.venv}"

if [[ ! -x "${VENV}/bin/python" ]]; then
  "${PYTHON}" -m venv "${VENV}"
fi

"${VENV}/bin/python" -m pip install --upgrade pip
"${VENV}/bin/python" -m pip install -e "${ROOT}[build]"
"${VENV}/bin/pyinstaller" --clean --noconfirm "${ROOT}/packaging/ford_dcl_gui.spec"

printf 'Bundle: %s\n' "${ROOT}/dist/SME105-DCL-Studio/"
