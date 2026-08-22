# SME-105 DCL Diagnostic Studio — project handoff

## New-session instruction

Use this file with `ROADMAP.md` as the first context in a new engineering
session:

> Continue the SME-105 DCL Diagnostic Studio project from `ROADMAP.md` and
> `PROJECT_HANDOFF.md`.
> Preserve the evidence labels and all safety gates. Do not enable active DCL
> transmission or claim a vehicle diagnosis without the missing physical
> evidence. Inspect the current implementation and verification results before
> changing code.

## Project identity

- Application: **SME-105 DCL Diagnostic Studio**
- Attribution: **Made by Eng. Maxim Salib**
- Target vehicle: 1998 European Ford Escort Sedan
- Engine: 1.6 L 16V Zetec
- ECU: Ford EEC-IV, SME-105
- Purpose: preserve, inspect, and reverse-engineer Ford DCL diagnostic traffic,
  retrieve DTCs and live parameters, then support an evidence-based high-idle
  diagnosis.
- Status: experimental independent engineering tool; not affiliated with Ford
  Motor Company.

The application is offline and binds only to `127.0.0.1`. A random token is
required by every API and WebSocket request.

## Evidence rules

Every technical claim must be classified:

- **Observed**: directly present in a preserved project capture or repeatable
  bench/vehicle test.
- **Reference**: stated by an identified external source.
- **Inferred**: a testable interpretation.
- **Unknown**: not established.

No profile, decoder output, DTC catalog match, or example file is vehicle
evidence by itself. Raw capture files are append-only evidence.

## Hardware

- ESP32 DevKit V1
- Silicon Labs CP2102 USB/UART bridge
- Current Linux device: `/dev/ttyUSB0`
- Stable Linux path:
  `/dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0`
- Initial adapter: XY-K485 automatic-direction RS-485 module
- Current physical state at handoff: **ESP32 USB only; K485 is not connected to
  the ECU**

The XY-K485 is restricted to receive-only experiments. It is unsuitable for
active-master work because DE and `/RE` cannot be controlled deterministically.
Active work requires a protected 3.3 V transceiver exposing DE and `/RE`, a
boot-safe DE pull-down, and independently verified complete transactions.

Never use OBD pin 16 as project power. Keep ESP32 TX disconnected during
passive work. Establish vehicle signal ground before A/B.

## Current observations

1. The connected CP2102 was detected successfully.
2. The firmware originally on the ESP32 emitted one literal dot every 500 ms;
   it was unrelated to this project and yielded zero DCL bytes.
3. `passive_binary` was built and flashed successfully.
4. With USB only and the K485/ECU disconnected, the receiver produced a low-line
   `BREAK` condition. This is expected from the unconnected receiver and is not
   ECU evidence.
5. Firmware was hardened to rate-limit break reports, suppress false zero-byte
   floods, and mark the condition. A final three-second bench capture contained
   one zero record and one break status with valid transport CRC.
6. No SME-105 ECU bytes, DTCs, live parameters, framing, polarity, or vehicle
   diagnosis have been observed.

Relevant captures:

- `captures/passive-baseline/20260822T002238.465279Z` — unrelated dot firmware.
- `captures/passive-binary-baseline/20260822T002606.601340Z` — pre-hardening
  continuous break/zero flood.
- `captures/passive-binary-baseline/20260822T002744.851405Z` — intermediate
  break hardening.
- `captures/passive-binary-baseline/20260822T002857.827637Z` — final guarded
  USB-only break observation.

## Implemented Python pipeline

- Exact raw USB preservation before parsing.
- ASCII hex-token and binary SLIP capture formats.
- Create-only timestamped sessions, raw rotation, metadata, JSONL events,
  hashes, reconnect handling, and bounded duration.
- Fixed 15-byte MCU records with CRC16-CCITT-FALSE, direction, status, and
  64-bit microsecond timestamp.
- Initial-partial-frame synchronization and stream recovery.
- UART error/status reporting including break and suppressed break data.
- Candidate 12-bit word and vertical-nibble parity validation.
- Pair-offset, timing-gap, direction, count-field, and 32-byte response
  hypotheses.
- Reference SME-105 profile decoding, DTC catalog, operator markers,
  correlations, safe symbolic command state, and conservative high-idle
  classifier.
- CLI commands: `capture`, `inspect`, `decode`, `frame`, `dtc`, `marker`, and
  `diagnose`.

## Diagnostic Studio application

Source entry point:

```bash
source .venv/bin/activate
ford-dcl-gui
```

The launcher chooses an available localhost port, prints the tokenized URL, and
opens the default browser. The GUI includes:

- System overview and evidence status.
- Six-step question-driven safety/setup wizard.
- Cross-platform serial discovery.
- Complete capture settings and bounded start/stop lifecycle.
- Live WebSocket capture/application/firmware logs.
- One-click synchronized operator markers and a global stop/abort control.
- Session listing and read-only inspection.
- Profile decode and framing hypothesis tools.
- DTC lookup.
- High-idle evidence form and decision record.
- Allow-listed PlatformIO build/upload service.
- Embedded safety, test, protocol, status, and firmware documentation.
- Persistent OS-appropriate user settings.

Active DCL transmission is locked at the API. The GUI may build the
`dcl_master` shell for verification, but it cannot upload it. Only passive ASCII
and passive binary firmware can be uploaded, after an explicit receive-only
confirmation.

## Packaging

Ubuntu:

```bash
./scripts/build_ubuntu.sh
./scripts/launch_ubuntu.sh
```

The validated one-folder bundle is written to:

`dist/SME105-DCL-Studio/`

Windows must be built natively on Windows:

```bat
scripts\build_windows.bat
scripts\launch_windows.bat
```

PyInstaller includes the web assets, profiles, documentation, firmware
projects, and examples. Windows and Ubuntu bundles are separate native builds;
the Ubuntu executable cannot be copied to Windows.

## Main source map

- `src/ford_dcl/capture.py` — acquisition and immutable session writer.
- `src/ford_dcl/transport.py` — SLIP/CRC MCU transport.
- `src/ford_dcl/inspect_capture.py` — capture inspection.
- `src/ford_dcl/words.py` — candidate 12-bit words/parity.
- `src/ford_dcl/framing.py` — evidence-scored frame hypotheses.
- `src/ford_dcl/profile.py`, `decode.py` — profile-based decoding.
- `src/ford_dcl/dtc.py` — reference DTC lookup.
- `src/ford_dcl/diagnosis.py` — high-idle evidence classifier.
- `src/ford_dcl/web/` — local server, services, settings, resources, and GUI.
- `src/ford_dcl/web/static/` — offline browser interface.
- `firmware/` — passive ASCII, passive binary, and locked active-master shell.
- `packaging/` and `scripts/` — portable application build/launch files.

## Safety and protocol constraints

- Public references suggest DCL request/response behavior and 8N2, with 9600
  and 19200 baud candidates. None is verified on this ECU.
- Passive silence is a valid observation because the ECU may wait for a master
  request.
- ASCII USB line breaks are bridge batching, not DCL frame boundaries.
- Exact DCL requests remain unknown. Do not guess, replay partial samples, or
  enable arbitrary bytes.
- No actuator, memory-write, KAM-clear, calibration, or output-state operation
  is implemented.
- Stop on heat, smell, smoke, unstable idle, unexpected actuation,
  communication flooding, ground movement, or loss of operator control.

## Next physical steps

The K485 is **not needed for software implementation or GUI verification**.
When vehicle access is available:

1. Fully quit and reopen Cursor/terminal after confirming `dialout` membership,
   or use a correctly configured native launcher.
2. Read `docs/wiring-safety.md` in full.
3. Keep ESP32 TX disconnected and use the XY-K485 receive-only.
4. With ignition OFF, connect common signal ground first, then the candidate
   DCL A/B pair.
5. Turn ignition ON with engine OFF.
6. Run a short bounded passive-binary session from the Guided Setup and Live
   Capture tabs.
7. If `BREAK` persists, power down before checking polarity, ground, adapter
   voltage, and A/B assignment. Never swap wiring live.
8. If the electrical idle becomes valid but no bytes appear, record the silent
   session; request/response behavior makes silence plausible.
9. Do not proceed to an active master until the XY-K485 is replaced and a
   complete safe transaction is independently verified.

## Remaining engineering tasks

- Validate DCL electrical polarity, baud, stop bits, and word parity on the
  target vehicle.
- Replace the XY-K485 for active use.
- Verify a complete non-mutating request/response transaction.
- Retrieve and validate live data and continuous-memory/KOEO/KOER DTCs.
- Correlate RPM, ECT, TPS, O2, IAC, MAF, fuel correction, and load markers.
- Run cold/warm, throttle, load, and one-sensor stimulus sessions.
- Run three repeatable fully-warm sessions.
- Perform the documented reversible IAC airflow-isolation procedure.
- Produce a final evidence report and only then classify the high-idle cause.

## Verification commands

```bash
source .venv/bin/activate
python -m unittest discover -s tests -v
python -m compileall -q src tests
ruff check --select E4,E7,E9,F,I src tests
ford-dcl-gui --no-browser
pio run --project-dir firmware/passive_ascii
pio run --project-dir firmware/passive_binary
pio run --project-dir firmware/dcl_master
```
