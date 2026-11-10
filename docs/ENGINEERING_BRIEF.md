# SME105 DCL Studio — Engineering Brief

**Independent legacy Ford EEC-IV diagnostics research**  
**Maintainer:** [MaximizoTech / @0Maxbon0](https://github.com/0Maxbon0)  
**Target:** European 1998 Ford Escort, 1.6L Zetec-E, manual; EEC-IV SME-105 PCM, engineering number `97AB-12A650-KA`  
**Prepared:** 11 November 2026

> This project is not developed, endorsed or certified by Ford Motor Company. The software is experimental and must not be treated as an authorized diagnostic product.

## Purpose

SME105 DCL Studio studies older Ford Diagnostic Communication Link (DCL) behavior and preserves timestamped raw evidence to make legacy diagnosis more reproducible. It combines embedded software, a locally connected Android application, offline capture/analysis, and experimental protocol research. The objective is **validated, reproducible interpretation**, not to present inferred command tables or decoded sensors as official Ford data.

## System at a glance

| Component | Implemented technology |
| --- | --- |
| Bridge | ESP32 / PlatformIO firmware; MAX487 interface integration, explicit safety gates, bounded UART telemetry |
| Mobile client | Android + Capacitor/JavaScript; local-only WPA2 SoftAP, authenticated TCP, reconnect and heartbeat |
| Evidence store | IndexedDB raw archives, timestamped RX/RXB, sequence deduplication and telemetry-gap accounting |
| Recovery | 8,000-event static ring; 30-second session grace; sequence-aware bounded replay |
| Research tools | Python capture/inspection, DCL experiment notes, host and native regression suites |

The telemetry ring stores `8,000 × 5 = 40,000` bytes of packed event data. The **30-second session retention grace period is not a guarantee of 30 seconds without data loss**: at 960 raw bytes/s the ring covers roughly 8.33 seconds. Overflow is represented by explicit sequence gap notices.

## What has—and has not—been verified

| Evidence | Status |
| --- | --- |
| Phone-to-ESP32 direct network connection | Observed on an isolated bench, documented 9 November 2026 |
| Network recovery, deduplication and archived cursor behavior | Source-reviewed and exercised by host/JVM/Node integration tests in the 11 November revision |
| ESP32 Wi-Fi/BLE firmware and Android debug builds | Reported successful for the 11 November source revision |
| Physical Wi-Fi RF/thermal soak of the updated recovery implementation | **Not yet performed** |
| Vehicle-bus electrical compatibility across EEC-IV revisions | **Not established** |
| Complete OEM DCL command tables, PIDs and scaling | **Not established; mapping candidates retain explicit evidence labels** |
| Root cause of elevated RPM while the vehicle moves | **Unproven diagnostic hypothesis** |
| General road-use or actuator safety | **Not certified** |

Research records distinguish **Observed**, **Reference**, **Inferred** and **Unknown** findings. A source-compiled command or decoded value is not proof that the target ECU supports or interprets it as expected.

## Research question: elevated RPM during movement

The target vehicle has motivated a diagnostic investigation of RPM remaining elevated after releasing the accelerator while moving, with behavior changing during deceleration or at standstill. Candidate explanations include idle-air/dashpot control, throttle and clutch-state inputs, VSS transitions, air leaks and PCM calibration.

No specific ECU defect, superseded calibration or faulty component has been conclusively established. A GPS comparison supports the observed speed scaling but cannot on its own establish the ECU's entire VSS and idle-control behavior. [See the evidence-conscious high-idle diagnostic notes](high-idle-diagnosis.md).

## Technical information requested from Ford or historical service-documentation holders

We would welcome publicly shareable or appropriately licensable documentation, or referral to an official service-information channel, relating to:

1. **PCM identification and calibration:** OEM calibration identification and supersession information applicable to `97AB-12A650-KA` / SME-105 / catch code KALE, subject to private VIN, engine, transmission and build-date confirmation.
2. **Historical idle/drivability bulletins:** applicability and official diagnostic instructions for European Escort Zetec-E idle-hang symptoms; including material sometimes referenced in secondary discussions as TSB 74/2000, **without presuming applicability**.
3. **EEC-IV DCL physical and wire protocol:** published interface requirements, framing, timing, response semantics and error handling.
4. **Diagnostic data definitions:** confirmed identifiers, scaling formulas, parameter validity, strategy differences and safe read-only status queries.
5. **Service tooling:** information about appropriate historical FDS 2000 / WDS / TIS materials and legitimate access paths.

We do **not** request proprietary ECU source code, manufacturer credentials, security bypasses or unauthorized programming methods.

## How to review the code without hardware

With Node.js 22 and Python 3.12+:

```bash
git clone https://github.com/0Maxbon0/sme105-dcl-studio.git
cd sme105-dcl-studio
npm ci && npm test
python -m pip install -e .
PYTHONPATH=src python -m unittest discover -s tests -q
```

The [README](../README.md) links to source, architecture, firmware builds and dated evidence. Private raw captures are not required for the public software-first baseline (capture-dependent tests may skip). No live ECU operation is needed for this review.

## Collaboration and boundaries

Public questions and technical corrections can be discussed in [GitHub Issues](https://github.com/0Maxbon0/sme105-dcl-studio/issues). See [CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md). Never post VINs, registration information, passwords, tokens, device backups or identifying raw captures in a public issue.

**Licensing:** The repository is currently public but has **no explicit open-source license**. Publication alone does not grant permission to reuse or redistribute the code; the maintainer must select a license separately.