# SME-105 DCL Diagnostic Studio — updated roadmap

**Made by Eng. Maxim Salib**  
**Date:** 2026-08-22  
**Status:** software and GUI complete; vehicle DCL evidence not started  
**Vehicle:** 1998 European Ford Escort Sedan, 1.6 L 16V Zetec, EEC-IV ECU SME-105  
**Symptom target:** persistent warm high idle (> 1000 RPM)

This file is the operational roadmap. Use it with `PROJECT_HANDOFF.md` to start
a new session. It is not a diagnosis and is not affiliated with Ford Motor
Company.

## How to read this document

Every claim stays in one evidence class until a preserved capture moves it:

| Label | Meaning |
|---|---|
| **Observed** | Present in an unmodified project capture or repeatable bench/vehicle test |
| **Reference** | Stated by an identified external source |
| **Inferred** | Testable interpretation of observations and references |
| **Unknown** | Not established |

Do not promote a GUI decode, DTC catalog match, Java formula, or example JSON
to vehicle fact.

---

## Current snapshot

| Item | State |
|---|---|
| Host pipeline | Complete and unit-tested |
| Local GUI (Ubuntu/Windows) | Complete, localhost-only, token-protected |
| Ubuntu portable bundle | Built at `dist/SME105-DCL-Studio/` |
| Windows portable bundle | Scripts ready; must be built on Windows |
| ESP32 passive binary firmware | Built, flashed, break/flood hardened |
| Active DCL transmit | Locked. No request bytes enabled |
| CP2102 | **Observed** at `/dev/ttyUSB0`, VID:PID `10C4:EA60`, serial `0001` |
| `dialout` | Account is a member; Cursor-launched GUI may lack the group until relaunch |
| XY-K485 to ECU | **Not connected** |
| SME-105 DCL bytes | **None observed** |
| DTCs / live data / idle cause | **Unknown** |

Immediate operator action: keep K485 disconnected until a receive-only KOEO
session is intentionally started. For serial access from this login, fully quit
Cursor or launch:

```bash
sg dialout -c 'ford-dcl-gui'
```

---

## Objective

Build a safe reverse-engineering and diagnostic path that can:

1. Intercept Ford DCL over RS-485 without damaging the ECU.
2. Preserve raw USB/MCU bytes before interpretation.
3. Identify framing, word/parity, request/response behaviour, live parameters,
   and DTCs on SME-105.
4. Combine telemetry with reversible physical tests to classify the high idle
   as electronic (sensor/IAC command) or mechanical (unmetered air / plate).

The product is evidence. A branch from `ford-dcl diagnose` is a decision
record, not a repair instruction.

---

## Architecture (intended)

```text
Vehicle DCL A/B + signal GND
        │
        ▼
Receive-only transceiver now (XY-K485, TX disconnected)
Protected DE/RE transceiver later (active master, gated)
        │
        ▼
ESP32 UART  (DCL candidate 9600 or 19200, 8N2)
        │  USB 115200 ASCII or 460800 binary SLIP
        ▼
Host capture  → immutable session  → inspect / frame / decode / DTC
        │
        ▼
Diagnostic Studio GUI  +  CLI  +  high-idle evidence classifier
```

Two separate serial domains exist and must not be mixed:

- USB host link: 115200 (ASCII firmware) or 460800 (binary firmware).
- DCL bus candidate: 9600 or 19200, 8N2. **Reference**, not SME-105 verified.

---

## Completed phases

### Phase 0 — Project constraints and safety  [done]

- Evidence labels, no-raw-SQL-equivalent here: no invented DCL bytes.
- Wiring limits documented: never OBD pin 16 as project power; ground first;
  XY-K485 receive-only; no blind 120 Ω termination.
- Active master deferred until a protected 3.3 V DE/`/RE` transceiver exists.
- KOER, KAM clear, actuators, memory writes, and output-state tests remain
  forbidden until independently verified.

Sources: `docs/wiring-safety.md`, `docs/protocol-notes.md`.

### Phase 1 — Host capture pipeline  [done]

- Create-only timestamped sessions under a chosen output directory.
- Exact `usb-*.bin` preservation, rotation, SHA-256, `metadata.json`,
  `events.jsonl`.
- ASCII hex-token parser (line breaks are not DCL frames).
- Binary SLIP 15-byte MCU records, CRC16-CCITT-FALSE, 64-bit µs timestamps,
  direction, UART status.
- Stream recovery: discard initial partial frames; recover after CRC errors.
- Bounded duration, reconnect policy, operator markers.

CLI: `ford-dcl capture|inspect|marker`.

### Phase 2 — Protocol analysis tools (unverified)  [done]

- 12-bit word + vertical-nibble parity candidates (`words.py`).
- Gap/direction/count/32-byte-response scoring (`framing.py`).
- Reference SME-105 profile decode (`profiles/sme_105.json`).
- Reference DTC catalog (`dtc.py`).
- Correlation helpers (`analyze.py`).
- Symbolic command FSM with unverified encoding gate (`commands.py`).
- Conservative high-idle classifier (`diagnosis.py`).

CLI: `ford-dcl frame|decode|dtc|diagnose`.

### Phase 3 — ESP32 firmware  [done, bench-verified USB only]

| Sketch | USB baud | Role | TX to DCL |
|---|---|---|---|
| `firmware/passive_ascii` | 115200 | Hex token bridge | None |
| `firmware/passive_binary` | 460800 | Timestamped SLIP logger | None |
| `firmware/dcl_master` | 115200 | Allow-listed shell | Disabled as shipped |

Bench observations:

1. Factory/other firmware emitted one `.` every 500 ms. Zero DCL bytes.
2. `passive_binary` flashed to ESP32-D0WD-V3, MAC `00:4b:12:3b:2b:f8`.
3. USB-only RX produced continuous UART `BREAK` and a false zero-byte flood.
4. Firmware now rate-limits break reports, suppresses implausible zero floods,
   and flags `0x10` break / `0x20` suppressed data.
5. Guarded 3 s capture:
   `captures/passive-binary-baseline/20260822T002857.827637Z`
   — one `00` data record, one break status, CRC valid.

This is **Observed** electrical-idle behaviour of an unconnected receiver, not
ECU traffic.

### Phase 4 — Diagnostic Studio GUI and packaging  [done]

Local web application, branded **SME-105 DCL Diagnostic Studio**, offline,
`127.0.0.1` only, per-launch API token.

Tabs:

- Overview and evidence status
- Guided setup (six question/safety gates + wiring map)
- Live capture, progress bar, markers, abort
- Sessions and analysis
- DTC lookup
- High-idle evidence record
- Firmware build/upload (passive only; master upload locked)
- Live application/capture/firmware logs
- Reference library
- Persistent settings (all capture, identity, and threshold variables)

Launch:

```bash
source .venv/bin/activate
ford-dcl-gui
# or, if Cursor was started before dialout:
sg dialout -c 'ford-dcl-gui'
```

Ubuntu bundle:

```bash
./scripts/build_ubuntu.sh
./scripts/launch_ubuntu.sh
```

Windows (native machine only):

```bat
scripts\build_windows.bat
scripts\launch_windows.bat
```

Verified: 29 host tests, firmware compile of all three sketches, source GUI
smoke test, packaged Ubuntu bundle serving UI + docs.

### Phase 4b — Serial permission  [workaround in place]

- `/dev/ttyUSB0` is `crw-rw---- root:dialout`.
- User `maxim` is in group `dialout`.
- A GUI started from a pre-login Cursor session reports
  `Permission denied` even though the device is detected.
- Workaround: `sg dialout -c 'ford-dcl-gui'` or fully quit/reopen Cursor.
- GUI now reports whether `dialout` is configured vs active in this process.

---

## Remaining phases

Do not skip gates. A later phase is blocked until its entry criteria are
**Observed**.

### Phase 5 — Receive-only vehicle connection  [next physical work]

**Entry:** ESP32 USB working; TX disconnected; ignition OFF.

**Work:**

1. Read `docs/wiring-safety.md` and complete Guided Setup gates.
2. Common signal ground first.
3. XY-K485 A/B to OBD pins 3 / 11 as polarity candidates.
4. Ignition ON, engine OFF (KOEO).
5. Bounded passive-binary capture (10–30 s) from the Studio.
6. Seal the session (`SHA256SUMS`, read-only).

**Exit — one of:**

- Idle line (no break, no flood) with **silence**: valid; DCL may be
  request/response. Preserve the session.
- Idle line with unexpected bytes: preserve, do not interpret as frames yet.
- Persistent `BREAK` or flood: power down, then check ground, 3.3 V, A/B
  assignment, and RO wiring. Never swap live.

**Do not:** enable TX, add termination, or send any DCL request.

### Phase 6 — Electrical and UART candidates

**Entry:** Phase 5 produced a non-break KOEO capture.

**Work:** treat 9600 and 19200 as separate labelled sessions. Keep 8N2 as the
first candidate. Score pair offsets and vertical-nibble parity. Record UART
status (`frame`, `parity`, `break`, overflow).

**Exit:** one baud/format has a repeatable, higher valid-word rate than the
other, documented with two captures. Until then both remain **Unknown**.

### Phase 7 — Framing hypotheses

**Entry:** byte stream exists without constant break.

**Work:** gap timing, direction if later available, length/count fields,
32-byte live-data response hypothesis. Promote a frame only after repeat
runs.

**Exit:** documented candidate frame boundaries with capture IDs. Still not a
protocol specification.

### Phase 8 — Protected active master (hardware change required)

**Entry:** receive-only electrical idle understood; XY-K485 replaced.

**Required hardware:** 3.3 V transceiver with explicit DE and `/RE`, boot-safe
DE pull-down, bounded TX (firmware already caps 32 bytes / 50 ms).

**Work:** enable only independently verified complete request/response
transactions. Keep an allow-list. No guessed bytes, no replay of partial
samples.

**Exit:** one non-mutating request/response pair captured twice, CRC/parity
validated, labelled **Observed**.

**Blocked today:** exact DCL request bytes are **Unknown**. `dcl_master` upload
and `/api/commands/transmit` stay locked.

### Phase 9 — Live data and DTCs

**Entry:** Phase 8 verified transaction.

**Work:** retrieve continuous-memory, KOEO, and (only after safety gate) KOER
codes. Map RPM, ECT, TPS, IAC, O2, fuel correction, MAF/load against
stimulus. Keep `sme_105.json` as **Reference** until each field is validated.

**Exit:** at least RPM, ECT, closed-throttle, and IAC command are **Observed**
on SME-105 with conversion notes.

### Phase 10 — Stimulus correlation

**Entry:** live fields exist.

**Work:** follow `docs/test-protocol.md`:

- cold-to-warm
- TPS sweep and holds
- electrical loads
- O2 window
- one-sensor unplug (reversible)
- operator markers synchronized with capture

**Exit:** three repeatable warm-idle sessions with source capture IDs.

### Phase 11 — High-idle physical isolation

**Entry:** Phase 10 telemetry plus fully warm engine.

**Work:** `docs/high-idle-diagnosis.md` and Studio High-Idle tab.

Decision order:

1. ECT plausible vs independent temperature.
2. TPS closed / plate actually shut.
3. Electrical load effect.
4. IAC command vs RPM.
5. Reversible IAC airflow isolation (blanking).
6. Smoke / unmetered-air check if RPM stays high with IAC isolated.
7. O2 / fuel trim as supporting, not primary, evidence.

**Exit:** classifier may become `definitive` only after airflow isolation plus
three warm sessions plus capture IDs. Current example file correctly returns
`insufficient_evidence`.

### Phase 12 — Evidence report

**Work:** freeze captures, hashes, protocol notes updates, diagnosis branch,
and remaining unknowns. No silent substitution of missing tests.

---

## High-idle branches (classifier, not a verdict)

| Branch | Meaning |
|---|---|
| `insufficient_evidence` | Missing telemetry, repeats, captures, or physical tests |
| `temperature_input` | ECT remains implausibly cold when warm |
| `throttle_input_or_plate` | TPS/plate not closed |
| `iac_bypass_confirmed` | RPM dropped/stalled when IAC air was isolated |
| `non_iac_airflow_confirmed` | RPM stayed high with IAC isolated |
| others | See `src/ford_dcl/diagnosis.py` |

Default thresholds are **unverified**: 1000 RPM, 80 °C ECT, 10% IAC.

---

## Safety gates that never expire

- No OBD pin 16 as project power.
- Ground before A/B. Power down before polarity changes.
- ESP32 GPIO17 TX disconnected during all XY-K485 work.
- XY-K485 is not an active master.
- No unverified DCL bytes on the wire.
- No KOER, actuator, KAM-clear, or memory-write operations yet.
- Abort on heat, smell, smoke, unstable idle, unexpected actuation,
  communication flooding, ground movement, or loss of control.
- Restore vehicle connectors and covers after the session.

---

## Captures already on disk

| Session | Meaning |
|---|---|
| `captures/passive-baseline/20260822T002238.465279Z` | Unrelated ASCII-dot firmware |
| `captures/passive-binary-baseline/20260822T002606.601340Z` | Unhardened BREAK/zero flood |
| `captures/passive-binary-baseline/20260822T002744.851405Z` | Intermediate break handling |
| `captures/passive-binary-baseline/20260822T002857.827637Z` | Guarded USB-only BREAK |

Treat as append-only. Do not edit.

---

## Tooling cheat-sheet

```bash
source .venv/bin/activate
ford-dcl-gui
sg dialout -c 'ford-dcl-gui'          # if permission denied on CP2102

ford-dcl capture /dev/ttyUSB0 --format binary --baudrate 460800 \
  --duration 15 --output captures --session-label KOEO_BASELINE
ford-dcl inspect captures/<session> --json
ford-dcl diagnose examples/high_idle_evidence.example.json --json

python -m unittest discover -s tests -v
ruff check --select E4,E7,E9,F,I src tests
pio run --project-dir firmware/passive_binary
```

---

## Source map

| Path | Role |
|---|---|
| `src/ford_dcl/web/` | Studio server, capture manager, firmware runner, GUI |
| `src/ford_dcl/capture.py` | Immutable USB capture |
| `src/ford_dcl/transport.py` | SLIP/CRC MCU records |
| `firmware/` | ESP32 sketches |
| `profiles/sme_105.json` | Unverified live-data map |
| `docs/` | Safety, protocol ledger, test protocol, diagnosis |
| `PROJECT_HANDOFF.md` | New-session context |
| `packaging/`, `scripts/` | Ubuntu/Windows bundles |
| `dist/SME105-DCL-Studio/` | Built Ubuntu application |

---

## New-session prompt

> Continue from `ROADMAP.md` and `PROJECT_HANDOFF.md`. Preserve evidence
> labels and safety gates. Do not enable DCL transmission. Do not claim a
> vehicle diagnosis. Next physical work is Phase 5 receive-only KOEO capture
> after TX is disconnected and ground is connected first. Serial access may
> require `sg dialout -c 'ford-dcl-gui'` until Cursor is fully restarted.
