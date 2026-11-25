# EscortScope — engineering brief

**Independent automotive diagnostics and embedded-systems research**

- **Target under study:** European Ford Escort 1998, 1.6 Zetec-E, Ford EEC-IV SME-105 PCM (`97AB-12A650-KA`)
- **Software source:** Android `2.1.1` / build `29`; ESP32 bridge firmware `30`
- **Maintainer:** Basita (بسيطة) · **Status:** experimental research, not a certified diagnostic instrument

**25 November update:** The v30 BLE bridge passed the isolated TX2 self-test and initial DCL transmission with the ECU disconnected. Android v2.1.1 was installed and its brand motion verified. Vehicle ECU response is not established by these checks. See [current release notes](BRANDING_RELEASE.md).

## The problem

Legacy EEC-IV vehicles can expose data through Ford's Diagnostic Communication Link
(DCL), but generic modern OBD-II apps cannot be assumed to understand this ECU's
physical layer, data framing, commands or sensor scaling. Public material for
other EEC-IV variants is useful research evidence, **not** proof of this PCM's
capabilities.

The aim is to capture the **original bytes and timing first**, make the transport
and storage robust, and keep unverified interpretations explicitly labeled.

## What we built

1. **Embedded bridge:** classic ESP32 with a MAX487-based DCL experiment
   interface, receive-default safety controls, authenticated direct Wi-Fi
   transport and a separately compiled BLE transport option.
2. **Android field app:** offline-capable Capacitor/JavaScript UI with native
   Android networking, connection/recovery handling, diagnostic sessions,
   inspection tools, recorded experiment history and export.
3. **Protocol and data tooling:** fixed-candidate DCL experiments, parsers,
   timestamped telemetry, offline Python utilities, and regression tests.
4. **Provisional PCB work:** editable KiCad R0 and more compact R1 concepts;
   **neither design has been electrically qualified for vehicle use**.

### System at a glance

    Android UI / IndexedDB
      -> native Android Wi-Fi plugin -> local-only WPA2 + TCP :8765
      -> ESP32 firmware (auth, session state, safety gates, telemetry)
      -> GPIO16/17/18 -> 5 V MAX487 interface -> candidate Ford DCL pair
      -> only with vehicle-specific electrical and safety qualification

The BLE build (`esp32dev_ble`) is a *separate firmware image* and uses
NimBLE UART-style GATT transport; the primary deployed profile is
Wi-Fi (`esp32dev`). An established direct Wi-Fi bench demonstration does
not validate post-bench recovery changes against a moving vehicle.

## Engineering highlights

| Challenge | Implementation approach | Evidence boundary |
| --- | --- | --- |
| Direct phone-to-device link without router | ESP32 SoftAP at `10.77.13.1:8765`, Android native network binding | Direct pairing observed on isolated bench |
| Network drop / WebView recreation | Native link ownership, connection epochs, heartbeat and bounded reconnect | Source and simulated regression, no full in-car RF soak |
| Avoid missing or duplicated samples | 8,000-event firmware telemetry ring, session IDs, sequence-aware bounded resume | Finite replay window; **never** promises lossless recovery |
| Defensible diagnostic conclusions | RAW + timestamps + metadata + archive hashes; qualify inferred PID meanings | ECU support/scaling remains vehicle-specific research |
| Actuator/ECU bus safety | DE LOW by default, pad witness, per-boot bench proof, named and explicitly armed commands, STOP/fault shutdown | Bench proof cannot replace vehicle-side electrical qualification |
| Reproducible engineering | JS/Python/JVM test harnesses, PlatformIO compile profiles and CI | Software PASS does not establish ECU or automotive safety |

## Hardware: prototype versus proposal

**Experimented hardware:** ESP32 development board with USB-UART, a
5 V MAX487 board, 5 V-to-3.3 V RO translation, defined driver-enable
pull-down and separate regulated/USB bench power. This is the existing
hand-wired research interface; part variants and vehicle wiring must
be re-verified physically.

**PCB R1 (22 November 2026):** an approximately 95 × 60 mm four-layer
KiCad **review design**, proposing an ESP32-WROOM-32UE module, MAX487,
candidate LM5164-Q1/TPS62160 regulators, protected 12 V input and
antenna/service connections. The PCB has **not** been fabricated,
assembled, powered, or automotive qualified. The BOM contains
unselected supplier parts; the OBD connector is a header placeholder;
vehicle-facing resistor links remain **DNP**. See
[hardware guide](HARDWARE_GUIDE.md) and [R1 review](../hardware/pcb-r1/README.md).

## Verification and uncertainty

- **Observed:** a recorded raw vehicle capture or a specifically described
  physical bench test; state its date, setup and exact observed behavior.
- **Reference:** an external publication; compatibility with SME-105 is
  still unconfirmed.
- **Inferred:** a hypothesis or derived signal requiring independent proof.
- **Unknown:** a feature, command, physical pin or scaling not verified.

The latest **local** source is ahead of GitHub's `origin/main` and differs
from historical installed/built packages. Android `1.8.21`/build `23` is a
source version, **not** a claim that a v1.8.21 APK was installed on the
phone. Existing November 11 build artifacts for `1.8.18` are historical.

## Open work before any wider hardware claim

- Verify the exact diagnostic connector pins, physical signal direction,
  pair polarity, grounding and termination using equipment and
  vehicle-specific documentation.
- Validate the proposed protected automotive power supply (transients,
  reverse polarity, thermal, cranking, sleep current) and R1 fabrication
  constraints.
- Record firmware + phone model + run duration and raw results for
  repeatable on-vehicle connection/drop recovery experiments.
- Independently confirm ECU commands, DTC meanings, PID addresses,
  timebases and units. Never use speculative mappings for vehicle control.
- Complete a deliberate source/secret/license review before an external
  repository release. This repository does **not** currently grant an
  open-source redistribution license.

## Reader's map

[System architecture](ARCHITECTURE.md) ·
[Application and firmware code walkthrough](CODE_WALKTHROUGH.md) ·
[Hardware and parts](HARDWARE_GUIDE.md) ·
[Local development](DEVELOPER_SETUP.md) ·
[Evidence and references](REFERENCES.md) ·
[Publication checklist](PUBLICATION_CHECKLIST.md)

**Disclaimer:** Independent engineering project; not endorsed or supported
by Ford Motor Company. It is not a driver aid, certified scanner,
safe-to-plug-in automotive PCB, or validated diagnostic/actuator controller.
