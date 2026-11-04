#!/usr/bin/env bash
# Receive-only USB recorder for the existing passive_binary ESP32 firmware.
# This script never uploads firmware, sends DCL requests, or verifies that the
# vehicle-side electrical interface is safe. Do not attach the raw MAX487
# board to an ECU based on successful operation of this script.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:---desk}"
case "$MODE" in
  --desk) DURATION=4; LABEL=DESK_NO_BUS; IGNITION=off ;;
  --koeo) DURATION=60; LABEL=SME105_KOEO_PASSIVE; IGNITION=koeo ;;
  *) echo "Usage: bash scripts/capture_passive_koeo.sh [--desk|--koeo]" >&2; exit 2 ;;
esac

PY="$ROOT/.venv/bin/python"
if [[ ! -x "$PY" ]]; then
  echo "ERROR: project Python venv missing at $PY" >&2
  exit 1
fi
export PYTHONPATH="$ROOT/src${PYTHONPATH:+:$PYTHONPATH}"
"$PY" -c 'import serial; from ford_dcl.cli import main' || {
  echo "ERROR: capture Python dependencies are missing" >&2
  exit 1
}

# Stable CP2102 USB ID found on this owner's laptop; allow an explicit override.
DEFAULT_PORT='/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0'
PORT="${DCL_PORT:-$DEFAULT_PORT}"
if [[ ! -e "$PORT" ]]; then
  echo "ERROR: ESP32 USB device not found: $PORT" >&2
  echo "Reconnect USB or set DCL_PORT=/dev/ttyUSB0" >&2
  exit 1
fi

if [[ "$MODE" == '--koeo' ]]; then
  printf '%s\n' 'SAFETY: this only records serial data. It does not certify a bare MAX487 board for vehicle use.'
  printf '%s\n' 'Use --koeo only after vehicle loading, electrical protection and connector safety are verified.'
  printf '%s\n' 'Vehicle capture: ignition OFF at start, engine never started; turn key ON during recording.'
fi

OUT="$ROOT/captures/$LABEL"
mkdir -p -- "$OUT"
printf 'Recording %s for %ss on %s (USB 460800; candidate bus 9600 8N2).\n' "$LABEL" "$DURATION" "$PORT"
SESSION="$("$PY" -c 'from ford_dcl.cli import main; raise SystemExit(main())' \
  capture "$PORT" --format binary --baudrate 460800 \
  --dcl-baud 9600 --dcl-format 8N2 --firmware passive_binary \
  --adapter ESP32_MAX487_DE_GROUNDED --ignition-state "$IGNITION" \
  --engine-state stopped --session-label "$LABEL" \
  --duration "$DURATION" --no-reconnect --output "$OUT")"

if [[ ! -f "$SESSION/events.jsonl" ]]; then
  echo "ERROR: recorder did not create the expected session." >&2
  exit 1
fi

"$PY" - "$SESSION" <<'PY'
import json
import sys
from pathlib import Path

directory = Path(sys.argv[1])
events = [json.loads(line) for line in (directory / 'events.jsonl').read_text().splitlines()]
connected = any(e.get('event') == 'connected' for e in events)
end = next((e for e in reversed(events) if e.get('event') == 'session_ended'), {})
print('Saved session:', directory)
print('Serial connected:', 'YES' if connected else 'NO')
print('USB bytes:', end.get('usb_bytes', '?'))
print('Valid DCL receive records:', end.get('parsed_bytes', '?'))
print('Transport errors:', end.get('transport_errors', '?'))
if not connected:
    print('ERROR: serial port could not be opened; check no other monitor is running.')
    sys.exit(1)
if end.get('usb_bytes', 0) == 0:
    print('No received data (expected on a disconnected desk test; possible for request/response DCL).')
PY
