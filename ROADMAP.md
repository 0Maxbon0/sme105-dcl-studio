# SME105 DCL Studio — engineering roadmap

**Updated:** 2026-11-09 · **Target:** 1998 Ford Escort 1.6 Zetec-E, EEC-IV SME105 (`97AB-12A650-KA`). This is an experimental, evidence-led plan rather than a diagnosis or approved ECU command specification.

## Current position

The native Android **v1.8.17** and ESP32 **Wi-Fi v29** have been built and physically installed; the owner confirms direct phone-to-ESP32 hotspot connection and an LED/output demonstration while the vehicle ECU was **not connected**. A single user-visible WPA2 password is used, without a router or token input. Hardware-enforced command gates remain. The prior Python localhost GUI has been retired; the offline Android app and CLI are the supported workflows.

## Stages and acceptance gates

| Phase | Current status | Evidence required to accept |
| --- | --- | --- |
| 1 — Stable direct mobile link | **Bench proof reported; extended run pending** | Android authenticated session, bridge status, manual disconnection/rejoin test, no stale write replay, owner-observed RF stability |
| 2 — Safe hardware/electrical path | **Partial pad proof; vehicle electrical qualification pending** | Ground, supply, transceiver protection, connector pin identities, A/B idle levels, external-de driver isolation and fail-safe DE LOW |
| 3 — DCL command discovery | **Research and prepared candidates; ECU-specific confidence varies** | Bounded fixed requests, unmodified bus response recording, per-candidate timestamp and repeat trials, no assumed sensor IDs |
| 4 — Correct frame/parity model | **Working hypotheses** | Raw byte-aligned reconstruction, parity and timing regression, independent repeated capture |
| 5 — DTC, MEM and live sensor maps | **Partially implemented, not fully verified** | Confirmed supported IDs, offsets, units and scaling with independent physical events on SME105 |
| 6 — High-idle diagnosis support | **Evidence workflow ready; diagnosis not established** | Vehicle operating-state captures, reliable RPM/IAC/TPS/VSS correlation, external mechanical checks, safe repeatability |
| 7 — Release qualification | **Source/build verification passed; vehicle field approval pending** | Data preservation checks, production signing/release process, long-run radio/stability logs and explicit vehicle commissioning acceptance |

No phase is automatically completed because a command compiles, an LED lights, a code looks familiar on a related Ford ECU or a single observation seems plausible.

## Current priorities

1. Preserve and export raw bench and vehicle recordings; never reformat original source files or reset Android IndexedDB during releases.
2. Document a sustained, isolated phone↔ESP32 SoftAP session and network-loss recovery, including Android's no-Internet decision behavior.
3. Maintain exact source-pinned command catalogue and distinguish `LEVEL_1` (untested) through meaningful evidence levels; **never** promote candidate memory addresses or sensor names automatically.
4. Before vehicle testing, complete power/ground/protected-transceiver/pinout checks and authorize each individual read-only or active request procedure. `TX2_BENCH` validates a local GPIO path, **not** the differential bus.
5. Independently reproduce discovered request/response frames and decode them into documented, version-specific SME105 observations. Keep published Ford EEC-IV reverse-engineering projects in a **Reference** category.

## Safety gates that must not change

- No general-purpose arbitrary ECU TX, burst/mode scans or automatic commands at boot/network association.
- `DE=LOW` at idle, `auto_tx=0`, per-boot pad proof, explicit `ARM_*` and bounded `READ_*` with transport session isolation.
- DTC clear, engine/output/idle interventions, K-Line and unverified physical pins require their own explicitly authorized safe test plan.
- Failed authentication cannot write; a disconnected session never replays previously queued ECU commands.
- WPA2 owner secret, OTA keys and NVS snapshots stay outside Git and public logs.

## Navigation

- [Current README](README.md), [implementation status](docs/implementation-status.md), [Wi-Fi setup](docs/wifi_bridge_architecture_and_setup.md), [wiring safety](docs/wiring-safety.md)
- [Experiment matrix](docs/sme105-dcl-experiment-plan-2026-11-07.md), [protocol structure](docs/SME105-DCL-protocol-structure-analysis-2026-11-07.md), [reference index](docs/REFERENCES.md)
- [Historical August engineering roadmap](docs/archive/ROADMAP-2026-08-22-historical.md) — retained **only as a dated snapshot**; its old GUI/firmware instructions are superseded
