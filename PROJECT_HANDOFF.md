# SME105 DCL Studio — engineering handoff

**Current baseline: 2026-11-09** · `main` · Ford Escort 1998 1.6 Zetec-E / EEC-IV SME105 `97AB-12A650-KA` · ESP32+MAX487 · Android v1.8.17 / firmware v29.

This is the active short engineering context. Read [README](README.md), [ROADMAP](ROADMAP.md), [wiring safety](docs/wiring-safety.md), [experiment matrix](docs/sme105-dcl-experiment-plan-2026-11-07.md) and [references](docs/REFERENCES.md) before modifying protocol or vehicle code. Keep all uncertain ECU behavior explicitly labelled.

## Completed integration milestones

- Native Android `WifiBridgePlugin` now uses direct ESP32 SoftAP as its primary transport, one user-visible WPA2 password, Keystore-backed secure persistence, a derived TCP `AUTH` and source-locked SSID network selection.
- ESP32 Wi-Fi firmware v29 uses safe physical-USB password rekey (`WIFI_AP_REKEY`) with one atomic NVS profile, retaining old legacy AP keys and OTA state. Flash verified at app0; safe idle and boot health verified after installation.
- User confirms phone↔ESP32 direct connection and a disconnected-car output LED demonstration. This is bench confirmation, **not** ECU command/physical actuator qualification.
- App v1.8.17 installed on Samsung Galaxy A52s using `adb install -r`; Android WebView data/IndexedDB and captured historical evidence not cleared.
- Previous tests: JavaScript **273 passing/3 skipped**, Python **312 passing/10 skipped** before retiring GUI, Android JVM/Gradle APK build and PlatformIO v29 build passing.
- Retired the old independent localhost Python web GUI and launchers. `app/` is **still the canonical Android UI assets** via Capacitor `webDir`, and must not be deleted as an old web site. GitHub Pages was not configured at the repository inspection. Historic debug APKs are indexed and absent from the active tree.

## Working areas and command entrypoints

- `app/`: native Android HTML/JS UI, indexed capture store, DCL Explorer, archives and offline assets.
- `android/`: Capacitor Android native Wi-Fi transport + Java tests; target SDK36, build with JDK21.
- `firmware/sme105_usb_bridge/`: v29 Wi-Fi bridge image (`esp32dev`) and separate BLE (`esp32dev_ble`).
- `scripts/sme105_wifi_setup.py`: physical-USB SoftAP provision/rekey; `--ap --ap-rekey` asks password privately, will not silently overwrite from ordinary `--ap`.
- `src/ford_dcl/`: CLI host capture/inspection (`ford-dcl`) rather than retired `ford-dcl-gui`.
- `captures/`: immutable archived evidence; `docs/`: experiment/wiring/reference dossiers.

## Operating invariants

Do **not** erase historical RAW captures or Android app-private storage, leak Wi-Fi passwords or tokens in a public commit, omit Git source checks, reset NVS wholesale, alter OTA accepted versions casually, or enable arbitrary ECU TX. Maintain `DE=LOW` at idle, `auto_tx=0`, explicit `TX2_BENCH`, named source-pinned `ARM_*`/`READ_*` gates, session-generation fencing, no automatic replays or DTC clearing. An LED indication on a disconnected bench says nothing about the Ford ECU accepting bytes. Don’t conflate other Ford EEC-IV reverse-engineering sources with target ECU support.

## Validation and next engineering work

Run `npm test`, `PYTHONPATH=src python -m unittest discover -s tests -q`, Android Gradle JVM tests + APK build, and PlatformIO `esp32dev` before releases. Validate live radio with read-only HELLO/PINS/STATUS, then separate authorized vehicle electrical and protocol acceptance. Stage unsafe experiments individually only after explicit operator approval and intact evidence. Do not silently advance evidence levels or formula mappings.

For original conversations and dated historical baseline details, see [legacy project handoff](docs/archive/PROJECT_HANDOFF-pre-2026-11-09-historical.md) and previous dated release reports. Those old versions and GUI instructions are **superseded** by this document; their raw observations remain historical facts.
