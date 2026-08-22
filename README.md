# SME-105 DCL Diagnostic Studio

**Made by Eng. Maxim Salib**

Evidence-first tooling and procedures for capturing and analysing the Ford
EEC-IV Data Communications Link (DCL) on the SME-105 vehicle.

The project includes a professional offline local web application for Windows
and Ubuntu plus the original command-line tools. It is an independent
engineering tool and is not affiliated with Ford Motor Company.

## Current status

The project is experimental. No command, address, scaling formula, wiring
polarity, baud rate, or SME-105 parameter mapping is treated as verified until
it is reproduced on the target vehicle and recorded with an immutable capture.

Every technical statement must carry one of these labels:

- **Observed** — directly present in this project's unmodified capture or
  repeatable bench/vehicle observation.
- **Reference** — stated or implemented by a cited external source.
- **Inferred** — a testable interpretation of observations and references.
- **Unknown** — not established; do not silently substitute an assumption.

Important corrections:

- Passive receive will likely show no traffic. DCL is believed to be
  request/response, so silence does not prove bad wiring, the wrong baud rate,
  or absence of DCL.
- Lines printed by an ESP or serial bridge are transport/debug text, not DCL
  frames. ASCII line breaks do not define frame boundaries.
- Public reference material uses 8N2 and contains 9600 and 19200 baud
  candidates. Both remain candidates for SME-105 validation.
- A referenced decoder describes each two-byte word as 12 data bits plus a
  four-bit parity nibble. Byte order, parity handling, framing, commands, and
  parameter meanings must still be validated on SME-105.

No capture or document in this repository is a diagnosis.

## Architecture

The intended data path is:

1. The vehicle DCL pair and vehicle ground reach a protected transceiver.
2. A receive-only adapter is used for initial electrical and passive checks.
3. A separately approved active-master adapter controls driver enable and
   sends bounded requests.
4. The host CLI records timestamped raw bytes and explicit operator events.
5. Inspection code derives candidate words and signals without modifying the
   source capture.
6. A human compares repeated events before promoting any claim to
   **Observed**.

Repository areas:

- `src/ford_dcl/web/` — localhost-only GUI server and live services.
- `scripts/` — Ubuntu and Windows launch/build commands.
- `ROADMAP.md` — full updated phase roadmap and next physical gates.
- `PROJECT_HANDOFF.md` — complete context for a new engineering session.
- `docs/setup.md` — Ubuntu zero-state installation and serial access.
- `docs/wiring-safety.md` — electrical limits and interface requirements.
- `docs/protocol-notes.md` — evidence ledger and public references.
- `docs/test-protocol.md` — repeatable vehicle session procedure.
- `docs/high-idle-diagnosis.md` — evidence-led high-idle decision process.
- `docs/implementation-status.md` — verified software state and external
  vehicle blockers.
- `captures/` — raw session artifacts when created; treat as append-only.
- `profiles/` — candidate ECU definitions; never evidence by themselves.

## Setup and commands

Perform the complete setup in [docs/setup.md](docs/setup.md). The host captures
the ESP USB stream at 115200 baud. The ESP-side DCL UART is separately
configured for the candidate DCL rate and 8N2:

Launch the guided application:

```bash
source .venv/bin/activate
ford-dcl-gui
```

The application opens a token-protected localhost URL and provides guided
safety/setup questions, serial discovery, bounded capture, live logs, session
inspection, decode/framing tools, DTC lookup, high-idle evidence records,
firmware build/upload controls, and embedded documentation. Active DCL
transmission remains locked.

Build or launch the Ubuntu portable bundle:

```bash
./scripts/build_ubuntu.sh
./scripts/launch_ubuntu.sh
```

Windows bundles must be built natively with `scripts\build_windows.bat` and
started with `scripts\launch_windows.bat`.

CLI use remains available:

```bash
ford-dcl capture /dev/ttyUSB0 \
  --baudrate 115200 \
  --output captures/SME105_KOEO_PASSIVE_DCL9600_20260822T030000Z \
  --no-reconnect

ford-dcl inspect \
  captures/SME105_KOEO_PASSIVE_DCL9600_20260822T030000Z/<timestamped-session>
```

The command's `--baudrate` is the USB link rate, not the DCL bus rate. Select
the DCL candidate in firmware and identify it in the output-directory name.
Use DCL 19200 only as a separately labelled candidate run. Do not switch DCL
rates inside one session.

For `firmware/passive_binary`, use its 460800 USB rate and fixed transport
decoder:

```bash
ford-dcl capture /dev/ttyUSB0 \
  --format binary \
  --baudrate 460800 \
  --output captures/SME105_KOEO_BINARY_DCL9600_20260822T032000Z \
  --no-reconnect
```

Read-only protocol tools preserve uncertainty:

```bash
ford-dcl frame "FF 5F 00 A0" --json
ford-dcl decode "<32-byte-live-response-hex>" --json
ford-dcl dtc 0x116 0x121 0x551 --source continuous_memory --json
ford-dcl diagnose examples/high_idle_evidence.example.json --json
```

The shipped active-master firmware contains no enabled DCL transaction. It
cannot transmit guessed request bytes.

## Immutable captures

Raw captures are evidence. Never clean, edit, reformat, concatenate, or
overwrite them. Corrections belong in a new derived file with a reference to
the original SHA-256.

After each session, set `SESSION_DIR` to the directory printed by
`ford-dcl capture` when it exits:

```bash
SESSION_DIR="captures/SME105_KOEO_PASSIVE_DCL9600_20260822T030000Z/<timestamped-session>"
(cd "$SESSION_DIR" && sha256sum metadata.json events.jsonl usb-*.bin > SHA256SUMS)
chmod a-w \
  "$SESSION_DIR"/metadata.json \
  "$SESSION_DIR"/events.jsonl \
  "$SESSION_DIR"/usb-*.bin \
  "$SESSION_DIR"/SHA256SUMS
(cd "$SESSION_DIR" && sha256sum --check SHA256SUMS)
```

Copy captures before analysis. Preserve UTC timestamps, CLI version, adapter
identity, serial settings, wiring state, ignition state, engine state, and
operator event markers.

## Safety

This work connects a computer to a vehicle ECU. Wrong polarity, accidental
transmission, ground faults, inappropriate termination, or use of an
unprotected transceiver can damage the ECU, adapter, or computer and can cause
unexpected engine operation.

Read [docs/wiring-safety.md](docs/wiring-safety.md) before connection. Do not
use OBD pin 16 as project power. With no test equipment available, limit work
to the documented KOEO and bounded fail-safe procedure; do not commission an
active DCL master. Stop on heat, smell, smoke, unstable idle, unexpected
actuation, communication flooding, ground movement, or loss of operator
control.

