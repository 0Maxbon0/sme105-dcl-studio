# SME105 delivery — Android 1.8.0 / firmware 24

Implemented on `fix/live-rx-silence-evidence-20261105`, preserving baseline `c12e12923327c2f87c3ddfa4e0a72ac754ab9aba` and all original captures. See `sol-acceptance-20261105.md` for the complete requirement mapping and `pin7-kline-engineering-20261105.md` for the reviewed hardware purchasing/design basis.

## Actual verification

- Node 22: **86 passed, 0 failed, 0 skipped**. Includes all previous tests, full real KOER/KOEO replay, historical DTC/111 isolation, IAT lag, native C++ producer tests, K-Line RX negatives and compile gates, simulation start/stop/recovery/export UI harness, ZIP payload and SHA manifest validation, focused history storage and offline module-cache coverage.
- Python host/source suite: **257 passed, 9 skipped, 0 failures**, 266 discovered, using the existing environment containing FastAPI. Initial system-Python run lacked FastAPI and exposed two outdated harness assumptions; the source shutdown harness now includes the actual pad evidence module and the USB-version assertion expects24. The full suite then passed.
- Firmware: **USB and BLE builds succeeded**, pinned Espressif32 6.12.0 / Arduino framework. Hardware/TX K-Line enable attempts fail compilation. ISR functions remain in IRAM. No K-Line electrical backend or GPIO activation exists.
- Android debug build: **succeeded**. APK manifest: package `com.maximizotech.sme105dclstudio`, versionCode2, versionName1.8.0. Packaged runtime source files compared byte-for-byte to working sources; checksums in `artifacts/sol-build-proof.json`.
- Original forensic ZIP SHA256 verified unchanged. Exact derived main session reproduces32862 bytes,5695 frames,353 complete Mode25 cycles,86 ACC0/267 EC80 phase words and172/538/521 repeated267 times each. Capture remains INCOMPLETE; no authenticated action cue or verified KOER success. Both frame-sync UTC and actual code-word receipt/MCU clocks are preserved separately.
- Galaxy SM-A528B: APK updated with `adb install -r`, preserving app data. Existing dashboard and dated DTC history remained accessible. Separate K-Line simulation recorded/stopped24 records. Native export produced4406-byte CSV in `Internal storage/Download/SME105 DCL Studio`; share sheet observed. Pulled CSV verified: all24 records are KLINE/simulation/hardwareVerified=false. No recipient was selected by the agent. Screenshot and CSV proof are included; share-sheet screenshots containing personal suggestions remain private, outside Git.
- Firmware v24 BLE image uploaded after the owner explicitly authorized flashing. Pinned esptool4.9 succeeded; passive boot observation after EN reset showed `no_auto_tx=1 DE=LOW` and no unexpected session/TX output. No serial command bytes were sent by the passive boot check. Application reconnect identity/status messages are local bridge operations, not ECU requests.
- A full4MiB pre-update ESP32 backup is private at `/home/maxim/.cache/sme105-private-backups/pre-v24-pinned-tool-20261105.bin`, SHA256 `a57ad11936c1e9235a9c8dfe02347efc894686e8db1ae2cf43209c805ada02fe`. The other installed esptool4.11 failed twice during readback; no writes were attempted with it. The pinned tool completed backup and upload successfully. Backup contains private device state and is deliberately excluded from Git.

## Artifacts and limits

`artifacts/android/sme105-dcl-studio-1.8.0-debug.apk` is the installable debug APK committed with this delivery. `artifacts/sol-build-proof.json` contains exact APK and both firmware paths, sizes and SHA256 values. `artifacts/sol-device-proof.json` and `artifacts/firmware-v24-boot-proof.json` record actual device checks. `artifacts/screenshots/sol-20261105/kline-simulation-recording.png` shows the new independent simulation UI.

Full native ZIP export was not repeated in this pass; its generation, complete channel contents, persistence and SHA manifest were tested offline. Active-session Home/BLE continuity remains covered by automated tests and earlier branch proof; no new running-vehicle session was authorized. The phone switched to another app during scripted testing; touch input stopped, and subsequent input checked SME105 foreground first. At the owner's request to finish promptly, remaining phone checks stopped. Bluetooth was restored and the final APK installed; the app was left stopped/disconnected.

No ECU command, code clear, sensor experiment, engine-running test, PATS operation or wiring change was performed. Upload/boot success does not verify physical DCL pad timing in a vehicle. Real-time operator cues remain unavailable. K-Line remains hardware-disabled, with no verified protocol/services/modules and no claim of real vehicle reception. Purchase a documented 3.3V-capable L9637 interface plus qualified automotive protection/harness/reference components as detailed in the engineering note; qualify the actual assembly and RX resource allocation before installation. No independent reviewer approval is claimed.

## Changed files

- `android/app/build.gradle`
- `app/data/codes.js`
- `app/index.html`
- `app/js/app.js`
- `app/js/cart.js`
- `app/js/controller.js`
- `app/js/diagnostics.js`
- `app/js/dtc-history.js`
- `app/js/exports.js`
- `app/js/kline-ui.js`
- `app/js/kline.js`
- `app/js/koer-guide.js`
- `app/js/pids.js`
- `app/js/protocol.js`
- `app/js/reference.js`
- `app/js/session.js`
- `app/js/strings.js`
- `app/js/ui.js`
- `app/styles.css`
- `app/sw.js`
- `app/tests/all-live.test.mjs`
- `app/tests/codes.test.mjs`
- `app/tests/diagnostics.test.mjs`
- `app/tests/export-channels.test.mjs`
- `app/tests/firmware-integrity.test.mjs`
- `app/tests/kline-ui.test.mjs`
- `app/tests/koer-kline.test.mjs`
- `app/tests/offline-package.test.mjs`
- `app/tests/session.test.mjs`
- `artifacts/android/sme105-dcl-studio-1.8.0-debug.apk`
- `artifacts/firmware-v24-boot-proof.json`
- `artifacts/kline-device-export.csv`
- `artifacts/koer-forensic-verification.json`
- `artifacts/screenshots/sol-20261105/kline-simulation-recording.png`
- `artifacts/sol-build-proof.json`
- `artifacts/sol-device-proof.json`
- `captures/derived-20261105/README.md`
- `captures/derived-20261105/iat.csv`
- `captures/derived-20261105/koeo.txt.gz`
- `captures/derived-20261105/main-koer.txt.gz`
- `docs/pin7-kline-engineering-20261105.md`
- `docs/sol-acceptance-20261105.md`
- `docs/sol-delivery-20261105.md`
- `firmware/sme105_usb_bridge/kline_rx.h`
- `firmware/sme105_usb_bridge/pad_evidence.h`
- `firmware/sme105_usb_bridge/sme105_usb_bridge.ino`
- `scripts/verify-preserved-koer.mjs`
- `tests/firmware/passive_integrity.cpp`
- `tests/test_sme105_live_rx_silence.py`
- `tests/test_sme105_wifi_recovery.py`
