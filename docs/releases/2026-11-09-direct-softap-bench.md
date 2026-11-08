# SME105 DCL Studio — direct SoftAP bench delivery

**Date:** 2026-11-09
**Target:** Ford Escort 1998 1.6 Zetec-E, Ford EEC-IV SME105 (`97AB-12A650-KA`)
**Scope:** Android↔ESP32 local-only connectivity and **isolated bench**, not a connected-vehicle ECU acceptance report.

## Installed baseline

| Component | Version / verification |
| --- | --- |
| Android | v1.8.17, `versionCode=19`, installed using `adb install -r` on Samsung Galaxy A52s without clearing application data |
| Wi-Fi bridge | ESP32 `esp32dev` **firmware v29**, flashed at app0 `0x10000` and esptool image digest verified |
| SoftAP | WPA2 `SME105-DIRECT-2BF8`, `10.77.13.1:8765`, one client, **no router** |
| Credential UX | One user-entered password; WPA2 join and internally derived authenticated TCP `AUTH`; no separate token field |
| Legacy data | Historical RAW and app IndexedDB preserved; old NVS AP keys and OTA partitions preserved for recovery |
| Post-upgrade safety | USB `STATUS` read `stage=0 DE=LOW auto_tx=0 fault=0 fw=29`; OTA reported `running=app0 boot_health=VALID accepted_version=29` |

The real passphrase, prior passphrase, previous token, private NVS image and Android app backup **are not published**. The new AP profile was provisioned with the explicit USB-only `--ap --ap-rekey` option, after backing up old NVS and firmware app0. The ESP32 reported active AP state with WPA2 enabled. Older firmware and AP settings remain recoverable by an appropriate supervised USB rollback.

## Independent software checks recorded at deployment

- JavaScript: **275 total, 272 passed, 3 skipped, 0 failed**.
- Python before legacy localhost GUI retirement: **322 total, 312 passed, 10 skipped, 0 failed**. After retirement the GUI-only tests were removed; run and document current suite separately.
- Android JDK 21: `:app:testDebugUnitTest` and `:app:assembleDebug` **PASS**.
- Capacitor: **105 packaged web files** compared equal to source after sync.
- ESP32 PlatformIO: `esp32dev` build **SUCCESS**; v29 flash and `verify_flash` digest **SUCCESS**.

Source-build artifact checks recorded at deployment:

| Output | SHA-256 |
| --- | --- |
| Native Android debug APK v1.8.17 (local, not committed) | `779108e4f25023da6e27454ef346c621bb8f575033ee8efc8b776c9494d69d75` |
| ESP32 v29 `firmware.bin` (local, not committed) | `28eca1926955ae67a50b50ec120f5c1efe72b1c4f4f7222f9a8415d9dde82f5b` |

These checksums describe the **specific installed/debug build at the time of test**, not a promise that a new local build has the same hash or a production-signed distribution artifact.

## Hardware evidence and limitations

The owner explicitly reported that the phone connected directly to the ESP32, the Wi-Fi did not disconnect during their test, and sending test signals while the vehicle was **not connected** illuminated indicator LEDs. The owner accepted the bench integration as successful. This report classifies that as **owner-observed, isolated bridge/output bench success**, not an independently timestamped RF soak test and **not** proof of any DCL ECU response.

Earlier software-driven Android probes also observed successful authenticated readout of bridge firmware `v29`; some subsequent probes showed Android dropping the network because the AP does not supply Internet. The owner's later manual successful connection confirms that a working path exists, but extended connection retention, loss/rejoin and vehicle-side timing must still be validated separately.

**Not tested here:** live KOEO/KOER, DTC clear, ECU actuator/idle commands, vehicle wiring polarity/protection, or any support/meaning for experimental MEM/PID/DMR data on this particular EEC-IV ECU. No autonomous ECU command is authorized by this release report.

## Repository cleanup accompanying this delivery

- Retired the distinct, obsolete **Python localhost GUI** (not the `app/` source bundled in Android), GUI-only launchers and web-server dependencies; kept CLI and source-capture functionality.
- Removed obsolete pre-v1.8.17 **debug APKs** from current Git HEAD. They remain recoverable by exact historic commit and SHA-256; see [artifact archive index](../ARCHIVED_RELEASE_ARTIFACTS.md).
- Reworked [README](../../README.md), [roadmap](../../ROADMAP.md), [setup](../setup.md), [status](../../STATUS_REPORT.md), [handoff](../../PROJECT_HANDOFF.md), and [source index](../REFERENCES.md).
- Added contribution/security policies, bug/feature/PR templates and source test CI; no private credentials, OTA signing keys, phone backups or NVS images were published.

## Future acceptance

A dedicated sustained phone↔ESP32 link-loss test and physically authorized vehicle DCL experiment must include observed station/session state, exact software/hardware versions, electrical safety check, original raw logs with digests, and recovery behavior. [Wi-Fi engineering guide](../wifi_bridge_architecture_and_setup.md) · [DCL experiment plan](../sme105-dcl-experiment-plan-2026-11-07.md) · [electrical safety](../wiring-safety.md).
