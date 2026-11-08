# SME105 DCL Studio — release status

**As of 2026-11-09** · Owner-maintained experimental tooling for the 1998 Ford Escort 1.6 Zetec-E EEC-IV SME105 (`97AB-12A650-KA`). The former Python localhost GUI is retired; Android native app + ESP32 direct SoftAP and the offline Python CLI are maintained.

## Currently deployed

| Element | Version / status |
| --- | --- |
| Android | **1.8.17**, versionCode 19, Samsung Galaxy A52s, updated in place |
| ESP32 | **v29 Wi-Fi (`esp32dev`)**, app0 flashed and digest verified |
| Wi-Fi | ESP32 WPA2 Hotspot `SME105-DIRECT-2BF8`; fixed `10.77.13.1:8765` with no router |
| Authentication | One user-entered WPA2 password, internally derived TCP AUTH, native secure storage |
| Bridge safe state | USB `stage=0`, `DE=LOW`, `auto_tx=0`, `fault=0` immediately after deployment and rekey |
| OTA boot state | Running app0, `boot_health=VALID`, accepted firmware build 29 |
| Historical data | Captures, raw evidence and Android IndexedDB preserved; no app uninstall or NVS erase |

**Owner's bench result:** The owner states that the phone successfully connected directly to the ESP32, Wi-Fi remained connected during their experiment, and output indicator LEDs lit when test signals were sent while the car was disconnected. We accept this as **owner-observed isolated bridge bench success**. It is **not** a measured vehicle ECU diagnostic session, output safety qualification, or a recorded long-run RF endurance test. The separate automated phone↔ESP32 testing earlier established authenticated firmware readout but also showed Android no-Internet network selection behavior; this is not contradictory to the owner's later successful retained connection.

## Software verification

- JavaScript offline/native-transport tests: **273 passed, 3 skipped, 0 failed** (current tree on 2026-11-09).
- Python suite before retiring obsolete GUI: **312 passed, 10 skipped**. After retirement: **296 passed, 10 skipped** (current tree on 2026-11-09).
- Android `:app:testDebugUnitTest` and `:app:assembleDebug`: **PASS** on JDK 21; app assets checked byte-for-byte inside debug APK.
- PlatformIO `esp32dev` v29: **PASS**; esptool physical application-slot verify **PASS**. The separate `esp32dev_ble` build remains a legacy alternate, not the currently installed direct-Wi-Fi image.
- Real car/ECU command compatibility: **NOT certified by bench network tests**. Each operation in the DCL Explorer and protocol library retains its evidence classification and safety boundary.

The private device backups from the upgrade are **local only** and not included in this public repository. Old APK binaries are retained in Git history; consult the [archived binary index](docs/ARCHIVED_RELEASE_ARTIFACTS.md) and rebuild current APKs from source.

## Outstanding validation

1. Extended direct SoftAP reliability while Android selects a no-Internet network, including safe disconnect/rejoin after screen and app changes.
2. Review wiring, transceiver protection, power, ground and connector polarity before attaching vehicle DCL.
3. Confirm ECU-specific request/response, memory, sensor map and DTC semantics on this exact controller via immutable raw capture and independent physical events.
4. Do not send automatic ECU commands or clear fault codes as part of Wi-Fi checks.

[Main README](README.md) · [Roadmap](ROADMAP.md) · [Wi-Fi guide](docs/wifi_bridge_architecture_and_setup.md) · [Reference index](docs/REFERENCES.md) · [Earlier historical status](docs/archive/STATUS_REPORT-2026-11-07-historical.md)
