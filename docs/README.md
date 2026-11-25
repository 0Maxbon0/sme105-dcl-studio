# Documentation index

Start here rather than reading the complete dated experiment history in
alphabetical order. The project's **current local source** is Android
`2.2.1` (build 31), ESP32 firmware v30; verify those versions in code
and read [release/validation limits](ENGINEERING_BRIEF.md).

## Start with these guides

| Read | For |
| --- | --- |
| [Engineering brief](ENGINEERING_BRIEF.md) | What was built, why it exists, evidence boundaries and remaining work |
| [Architecture](ARCHITECTURE.md) | Android ↔ native plug-in ↔ ESP32 ↔ DCL layers, session and data flows |
| [Hardware guide](HARDWARE_GUIDE.md) | Existing ESP32/MAX487/level shifting, GPIO, connector caveats and proposed PCB |
| [Code walkthrough](CODE_WALKTHROUGH.md) | JavaScript, native Android, C++ firmware, Python tooling, runtime state |
| [Developer setup](DEVELOPER_SETUP.md) | Reproducible compile-only build and test instructions |
| [Publication checklist](PUBLICATION_CHECKLIST.md) | GitHub/LinkedIn review, secrets, release artifacts, hardware claims |
| [LinkedIn draft](LINKEDIN_SHOWCASE.md) | English/Arabic wording and suggested evidence-safe visual assets |
| [Branding and release notes](BRANDING_RELEASE.md) | Product identity, Basita assets, Android data continuity and release validation |

## Working-level technical references

- [Direct Wi-Fi architecture and setup](wifi_bridge_architecture_and_setup.md)
- [Wi-Fi, BLE stability and RF analysis](wifi_ble_stability_and_rf_report.md)
- [Firmware description](../firmware/sme105_usb_bridge/README.md)
- [Android source notes and durable capture format](../app/README.md)
- [Protocol and interpretation notes](protocol-notes.md)
- [Candidate command discovery](SME105-DCL-command-discovery-2026-11-07.md)
- [DCL framing research](SME105-DCL-protocol-structure-analysis-2026-11-07.md)
- [Experiment and safety plan](sme105-dcl-experiment-plan-2026-11-07.md)
- [External source index](REFERENCES.md)
- [Wiring safety](wiring-safety.md)

## Historical evidence and decisions

Older dated files (Wi-Fi v7, bridge v9, Android v1.8.7/1.8.9,
capture analyses, previous handoffs and experiments) are kept in
`docs/` and `docs/archive/` as **historical provenance**, not
instructions for the latest active firmware. Use the current
architecture/setup guide instead of following obsolete provisioning
commands. Original private RAW captures are not part of the public
documentation.

The KiCad work has its own [hardware index](../hardware/README.md).
**R0 and R1 are not manufactured or vehicle-qualified.** There is
no default instruction here to flash firmware, transmit commands to
the ECU or clear/reset any stored capture data.
