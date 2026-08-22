#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -x "${ROOT}/dist/SME105-DCL-Studio/SME105-DCL-Studio" ]]; then
  exec "${ROOT}/dist/SME105-DCL-Studio/SME105-DCL-Studio" "$@"
fi

exec "${ROOT}/.venv/bin/ford-dcl-gui" "$@"
