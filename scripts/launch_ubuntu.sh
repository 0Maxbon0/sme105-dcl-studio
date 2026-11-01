#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -x "${ROOT}/dist/SME105-DCL-Studio/SME105-DCL-Studio" ]]; then
  exec "${ROOT}/dist/SME105-DCL-Studio/SME105-DCL-Studio" "$@"
fi

if [[ ! -x "${ROOT}/.venv/bin/python" ]]; then
  echo "Create the project venv first (see docs/setup.md)." >&2
  exit 1
fi

if ! "${ROOT}/.venv/bin/python" -c "import websockets" >/dev/null 2>&1; then
  "${ROOT}/.venv/bin/python" -m pip install -e "${ROOT}"
fi

if ! "${ROOT}/.venv/bin/python" -c "import platformio" >/dev/null 2>&1; then
  "${ROOT}/.venv/bin/python" -m pip install platformio
fi

exec "${ROOT}/.venv/bin/ford-dcl-gui" "$@"
