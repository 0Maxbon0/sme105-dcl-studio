# Application and Ubuntu setup

These commands assume a zero-state Ubuntu installation and a shell opened at
the project root.

## Install Python prerequisites

```bash
cd "/media/maxim/MAX/Docs/Maxim Docs/escort scanning"
sudo apt update
sudo apt install -y python3-venv python3-pip
```

## Create and activate the virtual environment

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -e .
```

For application packaging and API tests:

```bash
pip install -e ".[build]"
```

The prompt normally gains a `(.venv)` prefix. Verify that the project uses the
virtual-environment interpreter:

```bash
which python
python --version
python -m pip --version
```

For every new terminal:

```bash
cd "/media/maxim/MAX/Docs/Maxim Docs/escort scanning"
source .venv/bin/activate
```

## Launch the Diagnostic Studio

```bash
ford-dcl-gui
```

The process binds only to `127.0.0.1`, chooses another local port if 8765 is
busy, prints a tokenized URL, and opens the default browser. Keep the process
running while using the GUI. Settings and captures are stored in
OS-appropriate per-user directories unless changed in the Settings tab.

Ubuntu portable bundle:

```bash
./scripts/build_ubuntu.sh
./scripts/launch_ubuntu.sh
```

Windows must build its own native bundle:

```bat
scripts\build_windows.bat
scripts\launch_windows.bat
```

The Windows application discovers `COM` ports through pyserial. Install the
USB/UART vendor driver if Windows does not expose the CP2102 as a COM port.
The Linux and Windows bundles are not interchangeable.

## Grant serial-port access

Add the current login user to `dialout`:

```bash
sudo usermod -aG dialout "$USER"
```

Completely log out of the Ubuntu desktop session and log in again. Opening a
new terminal alone is not sufficient. Then verify membership:

```bash
id
id -nG
getent group dialout
```

`dialout` must appear in `id -nG`, and the current username should appear in
the `getent` result. Do not run the capture program with `sudo`; fix group
membership or device rules instead.

An IDE already running during the group change retains its old process groups.
Fully quit and reopen Cursor after the logout/login cycle before launching the
application from its integrated terminal.

## Identify the adapter

Disconnect the USB serial adapter, run:

```bash
sudo dmesg --follow
```

Connect the adapter and note the new device name. Press `Ctrl+C`. For a typical
USB serial adapter, verify `/dev/ttyUSB0`:

```bash
ls -l /dev/ttyUSB0
udevadm info --query=property --name=/dev/ttyUSB0
python -m serial.tools.list_ports -v
```

The device can instead be `/dev/ttyUSB1`, `/dev/ttyACM0`, or another number.
Use the device reported for the specific adapter. Recheck after each unplug;
Linux numbering is not a permanent adapter identity. Prefer a stable
`/dev/serial/by-id/...` path when one exists:

```bash
ls -l /dev/serial/by-id/
```

Before vehicle connection, ensure no terminal, modem manager, IDE serial
monitor, or previous capture owns the port:

```bash
fuser /dev/ttyUSB0
```

No output means no process currently has the device open.

## Capture examples

Keep the two serial links distinct:

- The host CLI reads the ESP USB serial stream at 115200 baud.
- The ESP's vehicle-side UART uses the DCL candidate setting. Public references
  suggest 8 data bits, no UART parity, two stop bits (8N2), with 9600 and 19200
  baud candidates. These DCL settings are not yet verified on SME-105.

The `ford-dcl capture --baudrate` option configures only the host-to-ESP USB
link. It does not change the DCL UART. Use one firmware-side DCL candidate per
capture and name the output parent accordingly.

DCL 9600 candidate, with USB at 115200:

```bash
mkdir -p captures
ford-dcl capture /dev/ttyUSB0 \
  --baudrate 115200 \
  --output captures/SME105_KOEO_PASSIVE_DCL9600_20260822T030000Z \
  --no-reconnect
```

DCL 19200 candidate, using firmware separately configured for 19200 8N2:

```bash
ford-dcl capture /dev/ttyUSB0 \
  --baudrate 115200 \
  --output captures/SME105_KOEO_PASSIVE_DCL19200_20260822T031000Z \
  --no-reconnect
```

Timestamped binary firmware uses USB at 460800 baud:

```bash
ford-dcl capture /dev/ttyUSB0 \
  --format binary \
  --baudrate 460800 \
  --session-label SME105_KOEO_BINARY_DCL9600 \
  --dcl-baud 9600 \
  --dcl-format 8N2 \
  --firmware passive_binary-v1 \
  --adapter MAX3485-DE-RE \
  --ignition-state koeo \
  --output captures/SME105_KOEO_BINARY_DCL9600_20260822T032000Z \
  --no-reconnect
```

Do not use `--format binary` with the ASCII sketch or `--format ascii` with
the binary sketch. A format mismatch is preserved in the raw files but cannot
produce valid parsed events.

Stop capture with `Ctrl+C`. The command prints its create-only timestamped
session directory when it exits. Use that exact directory for inspection and
hash verification.

Passive RX likely receives nothing because DCL is request/response. A silent
capture is a valid observation, not proof of a failed interface.

If an ESP or bridge prints hexadecimal text terminated by CR/LF, capture that
text only as bridge output. This project's host capture preserves exact USB
bytes and parses whitespace-separated uppercase `XX` tokens. The ASCII line
endings are not DCL frame boundaries, and the tokens are not raw DCL frames.

## Inspect without changing evidence

Set `SESSION_DIR` to the directory printed by the completed capture:

```bash
SESSION_DIR="captures/SME105_KOEO_PASSIVE_DCL9600_20260822T030000Z/<timestamped-session>"
ford-dcl inspect "$SESSION_DIR"
ford-dcl inspect "$SESSION_DIR" --gap-ms 25
```

Inspection must read the source capture and write derived output elsewhere:

```bash
mkdir -p analysis
ford-dcl inspect "$SESSION_DIR" --json \
  > analysis/SME105_KOEO_PASSIVE_DCL9600_20260822T030000Z.inspect.json
```

The reported gaps use host monotonic observation times. Candidate pair
alignments and parity rates are exploratory statistics, not DCL framing.

Verify the installed interface with:

```bash
ford-dcl --help
ford-dcl capture --help
ford-dcl inspect --help
ford-dcl decode --help
ford-dcl frame --help
ford-dcl dtc --help
ford-dcl marker --help
ford-dcl diagnose --help
```

Read-only analysis examples:

```bash
ford-dcl frame "FF 5F 00 A0" --json
ford-dcl decode "00000000000000000000000000000000000000000000FF003090000000000000" --json
ford-dcl dtc 0x116 0x121 0x551 --source continuous_memory --json
ford-dcl marker TPS_SWEEP_START --output analysis/operator-markers.jsonl
ford-dcl diagnose examples/high_idle_evidence.example.json --json
```

All profile conversions and DTC catalog matches remain reference hypotheses
until reproduced on the target ECU.

Stop if the installed CLI does not match the documented interface. Do not use
an interactive serial terminal to guess active DCL requests.

## Developer and firmware verification

Host checks use only the project venv:

```bash
python -m unittest discover -s tests -v
python -m compileall -q src tests
python -m pip install --upgrade ruff
ruff check --select E4,E7,E9,F,I src tests
```

Optional ESP32 board compilation:

```bash
python -m pip install --upgrade platformio
pio ci firmware/passive_ascii/passive_ascii.ino \
  --board esp32dev --project-option="framework=arduino"
pio ci firmware/passive_binary/passive_binary.ino \
  --board esp32dev --project-option="framework=arduino"
pio ci firmware/dcl_master/dcl_master.ino \
  --board esp32dev --project-option="framework=arduino"
```

Each firmware directory now also contains a PlatformIO project. Build or
upload the receive-only binary firmware with:

```bash
pio run --project-dir firmware/passive_binary
pio run --project-dir firmware/passive_binary \
  --target upload --upload-port /dev/ttyUSB0
```

The GUI Firmware tab runs the same allow-listed projects and streams the output
to the live log. It requires explicit confirmation before uploading passive
firmware. Active-master upload is locked.

## Seal the capture

The capture's terminal event records SHA-256 for each raw segment. Also create
and protect a complete session manifest:

```bash
(cd "$SESSION_DIR" && sha256sum metadata.json events.jsonl usb-*.bin > SHA256SUMS)
chmod a-w \
  "$SESSION_DIR"/metadata.json \
  "$SESSION_DIR"/events.jsonl \
  "$SESSION_DIR"/usb-*.bin \
  "$SESSION_DIR"/SHA256SUMS
(cd "$SESSION_DIR" && sha256sum --check SHA256SUMS)
```

