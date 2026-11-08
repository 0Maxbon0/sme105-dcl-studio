# SME105 DCL Studio — Android application

**Current installed release:** Android **v1.8.17 / build 19**, ESP32 Wi-Fi bridge **v29** (`esp32dev`). This directory is the **canonical HTML/CSS/JavaScript source for the native Android app** packaged through Capacitor `webDir: "app"` in [`capacitor.config.json`](../capacitor.config.json). **It must not be removed as a legacy web site.** The obsolete *separate Python localhost GUI* was retired; no standalone hosted PWA is offered as the supported current product.

**Target:** Ford Escort 1998 1.6 Zetec-E / EEC-IV SME105 `97AB-12A650-KA`. Experimental diagnostic research tool; do not infer validated ECU support from successful network connection or a lit local output LED.

## Direct ESP32 Wi-Fi — no router

1. Flash/use the Wi-Fi firmware v29, not the separate legacy `esp32dev_ble` variant. ESP32 provides a WPA2 2.4 GHz SoftAP, typically `SME105-DIRECT-2BF8`, with a fixed `10.77.13.1:8765` listener (one associated client).
2. In Android **Settings → Wi-Fi Bridge**, confirm the actual board SSID, enter the **one WPA2 passphrase**, and tap **Save Passphrase**. It is encrypted in Android Keystore-backed private storage, **not** browser localStorage or the source files.
3. Tap **Connect** and accept the Android local-only Wi-Fi request. Because this hotspot has no Internet access, Android may display a network preference/no-Internet warning; maintain the device network association.
4. The Android native plugin derives the existing 32-hex `AUTH` value from this single user-entered secret (PBKDF2-HMAC-SHA256 with an SSID-bound salt) and must receive exact `AUTH OK` before using the bridge. There is **no manually entered bridge token**.
5. The app then requests read-only `HELLO`, `PINS` and `STATUS`. It never automatically starts an ECU read, arms an output, clears codes or replays a stale write after a disconnected session.

See [direct Wi-Fi provisioning](../docs/wifi_bridge_architecture_and_setup.md) for USB setup, the safe explicit `WIFI_AP_REKEY` procedure, verification and rollback. Keep real Wi-Fi credentials out of Git, terminal histories and exported logs. The legacy STA/token path remains a compatibility layer in native code; it is not visible in the current direct-link Android settings.

## Build / test

Prerequisites: Node.js 22, Java JDK 21, Android SDK platform 36 and the project lockfile.

```bash
npm ci
npm test
npm run android:sync
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug --offline
```

Windows users run `gradlew.bat`. The debug APK is `android/app/build/outputs/apk/debug/app-debug.apk`; install it **in place** with `adb install -r ...` to retain private WebView data and long-running captures. Never uninstall/clear app data as a routine update. A production-signed release requires an additional signing/distribution process; debug APKs are not published as active releases in Git.

The previous v1.8.17 acceptance run reported **273 passing JavaScript tests / 3 skipped**, successful Android native JVM tests and APK build, and **105 bundled web assets verified byte-for-byte**. These are software/packaging checks, not a field-radio endurance test or ECU certification. The owner later reported direct phone pairing and a bench LED/output demonstration with the vehicle disconnected; record it as **owner-observed bench evidence**.

## Features and experimental scope

The native app includes an engineering Dashboard; status and electrical gates; live read views; KOEO/KOER and DTC workstreams; DCL Explorer for fixed candidate commands; MEM experimentation; raw frame inspection; review/comparison; offline diagnostics; session history; and verified ZIP/CSV export. Older Ford projects and formula tables are reference candidates, not confirmed SME105 sensor addresses or commands.

Active reads retain `TX2_BENCH` (per boot) and an explicit matching `ARM_*` before bounded `READ_*`. The firmware has no general arbitrary ECU byte transmitter. `DE` must be LOW in idle; a pad proof does not establish MAX487 vehicle-side A/B polarity or ECU acceptance. No command should be initiated against a connected car without a safe, specifically authorized test procedure.

The documented **All live data** path uses one mode-41 map with 45 slots (39 requested channels plus repeated key readings), then mode-21 values, with known 360ms/block planned cadence and a firmware three-hour cap. Exact support and units on SME105 remain individually unverified. The independent EEC-IV references are [flxkrmr](https://github.com/flxkrmr/eec-iv-reader-arduino) and [doncreat0r](https://github.com/doncreat0r/eeciv), not authoritative ECU calibration maps. See [project reference index](../docs/REFERENCES.md).

## Durable experiment recordings

Every operation creates its capture record before dispatch, recording session/experiment ID, operation variant, timestamps, firmware and transport state, metadata, outcome/verdict, and raw bridge lines in order. The app stores metadata in IndexedDB `captures` and ordered raw/CSV Blob chunks in `chunks`, flushing at approximately one-second intervals. Dashboard RAM samples are bounded; exports load stored records and not only the visible recent values.

Startup recovery marks an operation without a legitimate END as **INCOMPLETE**; it does not synthesize successful completion. Link-loss preserves received raw bytes and revokes authenticated readiness. Storage/queue failures stop collection and report incomplete evidence rather than silently fabricating data. Export recordings before any planned handset migration or app data reset.

`exportExperimentArchive(id)` creates a checksum-verified ZIP:

| File | Preserved evidence |
| --- | --- |
| `metadata.json` | Capture metadata, operation and outcome |
| `raw.txt` | Original ordered bridge text |
| `events.jsonl` | Event, status, fault and diagnostic timeline |
| `ro.bin` | Reconstructed raw RO bytes |
| `ro-timestamps.csv` | Byte indices and microsecond timestamps |
| `tx-pad.jsonl` | Local TX-pad witness events |
| `SHA256SUMS` | SHA-256 checksums of the members |

The archive itself has a SHA-256 digest. Keep raw files unchanged, keep event order, and use separate derived files when updating decoders or sensor interpretations. Chrome browser PWA and Android WebView storage were historically separate; there is no automatic transfer between those stores. If any old Chrome PWA recordings exist, export them independently before deleting browser storage.

**Storage limitations:** quotas/eviction depend on WebView and available device space. A process or power loss can truncate the latest uncommitted chunk. Reference: [MDN Storage Quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria). A three-hour simulation does not equal a three-hour road test.

## Read before a vehicle session

[Main README](../README.md) · [Roadmap](../ROADMAP.md) · [Wiring safety](../docs/wiring-safety.md) · [Current implementation](../docs/implementation-status.md) · [DCL experiment plan](../docs/sme105-dcl-experiment-plan-2026-11-07.md) · [References](../docs/REFERENCES.md)
