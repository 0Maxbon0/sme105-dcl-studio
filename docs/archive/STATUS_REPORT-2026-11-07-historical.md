# SME-105 DCL Diagnostic Studio — situation report

## Release update 2026-11-07

The coordinated release is **firmware v25** (`esp32dev_ble`) with **Android
app v1.8.12** (versionCode 14). The binary hashes and recorded verification
results are in the [release report](artifacts/releases/2026-11-07-v25-release-report.md).

The current authoritative A–R matrix, parity analysis, experiment evidence
levels, alternate commands, and candidate sequence are in the
[2026-11-07 experiment plan](docs/sme105-dcl-experiment-plan-2026-11-07.md).
The app records per-operation metadata and ordered raw/CSV chunks in IndexedDB;
`exportExperimentArchive(id)` creates a ZIP containing `metadata.json`,
`raw.txt`, `events.jsonl`, `ro.bin`, `ro-timestamps.csv`, `tx-pad.jsonl`, and
verified `SHA256SUMS`.

Firmware v25 has fixed named active profiles behind a fail-closed per-boot
electrical qualification gate. `TX2_BENCH` must complete once per boot before
an active read, and each operation requires its matching explicit arm. The
bench proves only the local GPIO17 pad path with DE LOW and independent RMT
observation; it does not prove the differential transceiver path, vehicle
wiring, or ECU acceptance. A hardware deployment still requires the separate
electrical pre-checks in the release report and
`firmware/sme105_usb_bridge/README.md`.

The sections below retain the **2026-08-22** situation snapshot as historical
baseline context. Use this release update for the coordinated release details.

**Date:** 2026-08-22
**Author / attribution:** Eng. Maxim Salib
**Vehicle target:** 1998 European Ford Escort Sedan, 1.6 L 16V Zetec, EEC-IV ECU SME-105
**Symptom under investigation:** persistent warm high idle (> 1000 RPM)
**Document type:** current-state report. Not a diagnosis. Not affiliated with Ford Motor Company.

Use this file with `ROADMAP.md` and `PROJECT_HANDOFF.md`. Every technical claim below is labelled **Observed**, **Reference**, **Inferred**, or **Unknown**.

---

## 1. One-page snapshot

| Item | State | Evidence |
|---|---|---|
| Host capture / analysis pipeline | Complete; 31 unit tests passing on this Windows venv | **Observed** |
| Diagnostic Studio GUI | Running on Windows, localhost-only, token-protected | **Observed** |
| Live capture duration | Runs until **Stop** (no 30 s auto-timeout) | **Observed** |
| PlatformIO Core | Installed in project `.venv` (6.1.19); first ESP32 toolchain download completed | **Observed** |
| CP2102 USB-UART | Same adapter `VID:PID 10C4:EA60` serial `0001`. Linux `/dev/ttyUSB0`. Windows **COM7** after Silicon Labs VCP install | **Observed** |
| Desk loopback (ESP32 ↔ XY-K485) | **PASS** after differential A+/B− stimulus | **Observed** |
| Module TTL pin that feeds GPIO16 | Operator-confirmed as module **RXD** = TTL receiver output (RO) | **Observed** (this clone) |
| ESP32 listen pin | UART2 **GPIO16** only. GPIO17 unused | **Observed** (firmware + wiring intent) |
| Vehicle DCL bytes, baud, stop bits, polarity | None captured from SME-105 | **Unknown** |
| OBD pin 3 = DCL+, pin 11 = DCL− | Public/other-EEC-IV candidate pair; not proven on this car | **Reference** |
| High-idle cause | No evidence record that can be called a diagnosis | **Unknown** |
| Active DCL transmit | Locked in software. XY-K485 not approved as a master | **Observed** (code) / policy |

**Phase:** hardware path proven on the desk. First **receive-only KOEO** capture on the vehicle is the next evidence gate. No ECU diagnosis is permitted until raw sessions exist.

---

## 2. What changed since the morning handoff

The morning state was: ESP32 USB only, K485 **not** on the ECU, `passive_binary` on the chip, Windows not set up, vehicle evidence zero.

Since then, on this Windows PC (`MAXIM`):

1. **Windows host is operational.** Python 3.14 venv, editable `ford-dcl` install, double-click `Launch Studio.bat`, desktop shortcut.
2. **CP2102 driver.** Device was present as Code 28 (no COM port). Official Silicon Labs CP210x Universal Windows Driver installed. Adapter now enumerates as **Silicon Labs CP210x USB to UART Bridge (COM7)**.
3. **GUI defects fixed.** Missing `websockets` library (live logs failed with “Unsupported upgrade request”); capture no longer auto-stops at 30 s; stale-JS crash after removing the duration field.
4. **PlatformIO** installed into `.venv` so Firmware / Bench Test can build and upload.
5. **Desk bench test** added, failed while B− was tied to GND (invalid RS-485 start bit), then **passed** with GPIO4→A+ and GPIO21→B− as a differential pair.
6. **Operator-confirmed TTL mapping** for this XY-K485 clone: **RXD = RO → GPIO16**. Module **TXD** is not used as an ESP transmit pin.
7. **Production listen-only sketch** added: `firmware/sniffer/sniffer.ino` — GPIO16, 9600 **8N1**, USB 115200 hex. Compiled for `esp32dev`.

Linux `dialout` / `/dev/ttyUSB0` notes remain valid when work returns to Ubuntu. Windows does not use `dialout`.

---

## 3. Hardware — confirmed desk pinout

### 3.1 USB

Laptop USB → ESP32 DevKit V1 (on-board CP2102). Host sees COM7 (Windows) or `/dev/ttyUSB0` (Linux). USB baud is **not** the DCL baud.

### 3.2 UART side (ESP32 ↔ XY-K485) — **Observed** on the bench

| XY-K485 pin | Connection | Role |
|---|---|---|
| **VCC** | ESP32 **3V3** | Logic supply. Not 5 V / VIN. Not OBD pin 16 |
| **GND** | ESP32 **GND** | Common reference |
| **RXD** | **GPIO16** (UART2 RX) | **Observed** on this clone as TTL **RO** (receiver output) |
| **TXD** | **Not connected to any ESP TX pin** | Treat as DI. **Do not leave floating on the vehicle** — pull to **3V3 via 10 kΩ** so auto-direction stays receive |
| ESP32 **GPIO17** | **No wire** | Sniffer TX remains disconnected |

Silk-screen `TXD`/`RXD` is clone-dependent. An earlier bench document assumed TXD=RO. **This clone was proven the other way: RXD=RO.** Do not “correct” GPIO16 off RXD without a new loopback test.

### 3.3 Vehicle side (planned, not yet an SME-105 observation)

Ignition **off** to connect. **Ground first, disconnect last.**

| XY-K485 | Vehicle | Status |
|---|---|---|
| Bus **GND** | OBD **pin 4 or 5** | Correct class of signal/chassis ground. Exact pin choice is operator-selected |
| **A+** | OBD **pin 3** | **Reference** DCL+ candidate |
| **B−** | OBD **pin 11** | **Reference** DCL− candidate |
| — | OBD **pin 16** | **Must stay isolated.** Never power ESP, K485, or laptop from it |

If KOEO shows persistent BREAK or inverted-looking garbage, power down, then swap A+/B− and start a **new** capture. Never swap live.

120 Ω termination jumper: leave **open** until bus loading is measured.

---

## 4. Bench test — what PASS does and does not mean

**Observed:** after switching from single-ended A+ / B−=GND to differential GPIO4 (UART TX) and GPIO21 (inverted UART TX), the desk loopback scored **PASS**. That proves, for this ESP32 + this K485 + 3.3 V + GPIO16:

- 3.3 V supply and common ground work
- The transceiver can recover UART-framed 9600 data from a differential pair into GPIO16
- USB can return that path to the host

**It does not prove:**

- SME-105 idle voltage, polarity, or pinout
- 9600 vs 19200
- 8N1 vs 8N2 on the car (the passing bench sketch used **8N2** internally; the vehicle sniffer was later requested as **8N1**)
- That the ECU will emit anything without a DCL master (**Inferred / Reference:** DCL is request/response; **silence is a valid KOEO result**)

The bench sketch **drives A+/B−**. It must **not** remain on the ESP32 when the adapter is on the car. Flash `firmware/sniffer` (or `passive_ascii` / `passive_binary`) before vehicle connection.

---

## 5. Firmware map

| Sketch | USB | DCL UART | TX to bus | Use |
|---|---|---|---|---|
| `firmware/bench_test` | 115200 ASCII PASS/FAIL | 9600 8N2 generated on GPIO4/21 | **Yes (desk only)** | Loopback. Remove before the car |
| `firmware/sniffer` | 115200 hex tokens | 9600 **8N1**, GPIO16 RX, TX pin disabled | **No** | Operator-requested KOEO sniffer |
| `firmware/passive_ascii` | 115200 hex tokens | 9600 **8N2**, GPIO16; begin() still names GPIO17 | **No writes**, but UART TX pin is configured | Compatibility / 8N2 candidate |
| `firmware/passive_binary` | **460800** SLIP+CRC | 9600 **8N2**, GPIO16 | **No writes** | Best timestamped logger once UART format is trusted |
| `firmware/dcl_master` | 115200 | 9600/19200 shell | **Disabled** as shipped | Build only in the GUI. Upload locked |

Studio **Firmware** tab can upload receive-only sketches after confirmation. **Desk Bench Test** is a separate nav page. Active-master upload stays locked.

**8N1 vs 8N2:** public EEC-IV material is **8N2** (**Reference**). The production `sniffer` sketch is **8N1** because that was the explicit vehicle-session request. If KOEO yields only framing errors or BREAK, run a second labelled session with `passive_ascii` or `passive_binary` (8N2). Do not mix both formats in one session directory.

---

## 6. Host software (Windows, 2026-08-22)

- Launch: `Launch Studio.bat` or Desktop **SME-105 DCL Studio**
- Binds `127.0.0.1` only; URL includes a one-time token
- Live capture: **Start** runs until **Stop** / **STOP ABORT**
- Settings: duration `0` = until stop
- Live logs require the `websockets` package (now a declared dependency)
- PlatformIO discovery: `pio.exe` next to venv Python, `python -m platformio`, or `~/.platformio/penv`
- Host tests: `python -m unittest discover -s tests -v` — last run **OK**

Ubuntu launch remains `ford-dcl-gui` / `scripts/launch_ubuntu.sh` with `dialout` inherited by the process.

---

## 7. Safety (unchanged, still binding)

- Receive-only until a protected 3.3 V DE/`/RE` transceiver exists and a complete safe transaction is independently verified.
- XY-K485 auto-direction is **not** a DCL master.
- Pull DI idle-high. Do not float the module TXD/DI on the vehicle.
- Ground before A/B. Ignition off to connect or swap polarity.
- No OBD pin 16 as project power.
- No guessed DCL request bytes, KAM clear, actuators, or memory writes.
- Stop on heat, smell, smoke, warm ground lead, USB drop, unstable idle, or loss of control.

---

## 8. Evidence still missing (vehicle)

None of the following has been **Observed** on SME-105:

- Any ECU DCL byte
- Valid idle (non-BREAK) vs BREAK on KOEO
- Baud 9600 vs 19200
- 8N1 vs 8N2
- A/B polarity vs pins 3/11
- Framing, 12-bit words, live PIDs, DTCs
- Warm-idle telemetry or IAC airflow-isolation result
- A diagnosis branch other than `insufficient_evidence`

Example JSON and the DTC catalog remain **Reference** only.

---

## 9. Immediate next work — first KOEO session

**Entry:** bench PASS; `sniffer` (or chosen 8N2 sketch) on the ESP32; bench GPIO4/21 **removed** from A+/B−; DI pulled high; pin 16 isolated.

1. Ignition off, park/neutral, parking brake, wheels secured.
2. Vehicle signal ground → K485 GND.
3. A+ → pin 3, B− → pin 11 (candidates). Record that assignment.
4. USB to the laptop. Studio or CLI using the **CP2102** port only (not Bluetooth COM, not a phone modem).
5. Start capture **before** ignition ON.

Ubuntu (ASCII sniffer, USB 115200, until Ctrl+C):

```bash
cd "/media/maxim/MAX/Docs/Maxim Docs/escort scanning"
source .venv/bin/activate
mkdir -p captures
ford-dcl capture /dev/ttyUSB0 \
  --format ascii \
  --baudrate 115200 \
  --dcl-baud 9600 \
  --dcl-format 8N1 \
  --firmware sniffer-gpio16-9600-8n1 \
  --adapter XY-K485-receive-only \
  --ignition-state koeo \
  --engine-state stopped \
  --session-label SME105_KOEO_ASCII_DCL9600_8N1 \
  --output captures \
  --no-reconnect
```

Windows Studio: **Live Capture**, COM7, ASCII 115200 if using `sniffer`; **binary 460800** only if `passive_binary` is loaded.

6. Ignition ON, engine **OFF**. Short session is enough. Silence is acceptable. Ctrl+C or **Stop**.
7. Seal the printed session directory (hashes, read-only). Do not edit raw files.
8. Persistent BREAK: ignition off, then check ground, 3.3 V, DI pull-up, A/B assignment. New session after any wiring change.

---

## 10. After a usable KOEO capture

Only then:

- Compare 8N1 vs 8N2 in **separately named** sessions
- Score words/parity/framing in the Studio without promoting GUI output to vehicle fact
- Replace XY-K485 before any active master
- Three warm-idle sessions and reversible IAC isolation before a high-idle branch is allowed to become definitive

---

## 11. Source map (current)

| Path | Role |
|---|---|
| `STATUS_REPORT.md` | This situation report |
| `ROADMAP.md` | Phase plan and remaining gates |
| `PROJECT_HANDOFF.md` | Session bootstrap (hardware paragraph may lag this report) |
| `firmware/sniffer/` | Listen-only 9600 8N1 hex sniffer |
| `firmware/bench_test/` | Desk differential loopback |
| `firmware/passive_binary/` | Timestamped SLIP sniffer (8N2, USB 460800) |
| `Launch Studio.bat` | Windows GUI launcher |
| `docs/wiring-safety.md` | Electrical limits |

---

## 12. Bottom line

The **desk electrical path is proven**. The **vehicle DCL path is not**. Software is ready to preserve a KOEO session. The next artefact that matters is an unmodified capture directory from ignition-on, engine-off, receive-only wiring — including a silent session, if that is what the ECU does.
