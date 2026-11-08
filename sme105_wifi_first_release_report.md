# SME105 DCL Studio — Wi-Fi First Android Transport Release Report
**Release Candidate v1.8.16 (Build Code 18)**
**Supervisor & Lead Architect:** Antigravity (AGY)
**Implementation Engine:** Codex GPT-6 Luna (`model_reasoning_effort="xhigh"`)
**Target Vehicle:** 1998 Ford Escort 1.6 Zetec-E (L1H), EEC-IV SME-105 (`97AB-12A650-KA`)
**Diagnostic Hardware:** ESP32 + MAX487 DCL Transceiver
**Date:** November 8, 2026
**Independent Review Verdict:** **OFFLINE SOFTWARE / BUILD PASS**
*(Physical Android-ESP32 Wi-Fi Acceptance: PENDING Owner Authorization)*

---

## 1. Executive Summary

This engineering cycle resolves all P0 and P1 defects identified during the independent review of the SME105 DCL Studio Wi-Fi First Android release. Direct ESP32 WPA2 SoftAP (`10.77.13.1:8765`, SSID `SME105_DCL`) is established as the primary, default transport, while retaining legacy Bluetooth Low Energy (BLE) as a secondary manual option.

### Key Corrections Delivered:
1. **P0 — WPA2 PSK Association & Validation:**
   - SoftAP connection flow validates firmware-enforced 16–63 printable ASCII credentials before any network, socket, or ECU operation.
   - Credentials are encrypted using private Android Keystore AES-256-GCM (`savePassword`, `hasPassword`, `clearPassword`), eliminating plaintext localStorage storage and logging exposure.
   - Native plugin binds sockets directly to the selected Wi-Fi `Network` via `Network.getSocketFactory().createSocket()`, preventing cellular bypass, and supports graceful fallback binding to an already joined bridge network.
2. **P0/P1 — Android Target SDK 36 Permissions:**
   - Added `<uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES" android:usesPermissionFlags="neverForLocation" tools:targetApi="33" />`.
   - Updated `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` to `android:maxSdkVersion="32"`, ensuring correct compatibility across API 26 through API 36 without deriving location or altering global cleartext traffic.
3. **P1 — Native Contract Normalization:**
   - Both `hasToken()` and `hasPassword()` in `WifiBridgePlugin.java` return `{ hasToken/hasPassword: boolean, configured: boolean }`, resolving interface discrepancies.
   - Removed duplicate native calls and unsafe legacy fallback to browser `localStorage` in `app/js/app.js` (fails closed when native secure storage is unavailable).
4. **P1 — STA vs. AP Host Address Routing:**
   - Fixed `wifiConfig()` mode checks: SoftAP defaults to `10.77.13.1:8765`, while STA (existing router) mode requires an explicit assigned IP address and never silently connects to `10.77.13.1`.
5. **P1 — Link-Loss & Race Safety:**
   - `WifiTransport.reconcile()` requires both `connected: true` and `authenticated: true`.
   - Mid-capture socket drops preserve raw bytes without fabricated terminators, finalize active sessions cleanly, revoke readiness, and prevent automatic ECU command replay or automatic re-arming.
6. **P1 — USB Provisioning Safe Reuse:**
   - `scripts/sme105_wifi_setup.py` validates min 16-char SoftAP passwords and safely reuses existing SoftAP configuration via `WIFI_AP_MODE` when firmware returns `DENIED wifi_ap_config_exists`, avoiding destructive NVS rewrites.
7. **Version Bump:**
   - The first Wi-Fi build was `1.8.15` (code `17`). The subsequent write-safety correction round advanced the release to `1.8.16` (code `18`) consistently across Gradle, protocol, service-worker cache, offline tests, and UI.
8. **Write Reliability and Session Isolation (1.8.16):**
   - JavaScript `WifiTransport.write()` now rejects its own command on native-write failure instead of swallowing the error while keeping the queue usable for later valid commands.
   - The application controller consumes these expected rejected promises without duplicating its existing transport-error notification.
   - Native Android binds each queued write to its original authenticated connection generation, socket and output stream. FIFO admission checks reject stale A-session commands after disconnect/reconnect, and disconnect completion is fenced behind admitted writes. Already-started writes with uncertain delivery are reported as uncertain, never retried automatically.

---

## 2. Workstream Ownership & Modifications

Five Codex GPT-6 Luna agents executed concurrently with exclusive file ownership:

| Workstream | Agent | Owned Files | Modifications |
|---|---|---|---|
| **WS 1: Android Native & Security** | Luna 1 (`task-7432`) | `android/app/src/main/AndroidManifest.xml`<br>`android/app/src/main/java/com/maximizotech/sme105dclstudio/WifiBridgePlugin.java` | Target SDK 36 permissions (`NEARBY_WIFI_DEVICES`, `ACCESS_FINE_LOCATION` `maxSdkVersion=32`); Keystore AES-256-GCM PSK storage; `WifiNetworkSpecifier.setWpa2Passphrase`; manual-join network probe fallback; normalized contract methods. |
| **WS 2: JS Transport & Contract** | Luna 2 (`task-7434`) | `app/js/wifi.js`<br>`app/tests/wifi.test.mjs` | WPA2 password validation (16–63 ASCII for AP); fail-closed logic on missing credentials; explicit STA host check; secure `reconcile()` requiring both `connected` and `authenticated`. |
| **WS 3: App UI, Controller & Version** | Luna 3 (`task-7436`) | `app/js/app.js`<br>`app/index.html`<br>`app/js/ui.js`<br>`app/styles.css`<br>`app/js/protocol.js`<br>`app/sw.js`<br>`android/app/build.gradle`<br>`app/tests/mobile-settings-lab.test.mjs`<br>`app/tests/offline-package.test.mjs` | Version bump to `1.8.15` (code `17`); WPA2 passphrase settings UI and handlers; removed plaintext localStorage fallbacks; corrected AP/STA default IP routing; link-drop safe session handling. |
| **WS 4: Independent QA & Safety** | Luna 4 (`task-7438`) | `app/tests/wifi-integration.test.mjs`<br>`app/tests/wifi-transport-failure.test.mjs`<br>`app/tests/wifi-protocol-safety.test.mjs` | Negative tests: missing PSK rejection, short password rejection, STA host enforcement, mid-capture socket loss, zero command replay after reconnection. |
| **WS 5: ESP32 Provisioning & Docs** | Luna 5 (`task-7440`) | `scripts/sme105_wifi_setup.py`<br>`tests/test_sme105_wifi_setup.py`<br>`docs/wifi_bridge_architecture_and_setup.md` | Minimum 16-character WPA2 validation; safe SoftAP reuse via `WIFI_AP_MODE` on `DENIED wifi_ap_config_exists`; mock port context manager; updated documentation on firmware build boundaries. |

---

## 3. Verified Release Artifacts

All artifacts independently compiled and measured on the local host:

### 3.1 Android Debug APK
- **Application Version:** `1.8.16` (versionCode `18`)
- **File Path:** `android/app/build/outputs/apk/debug/app-debug.apk`
- **File Size:** `4,992,238` bytes
- **SHA-256 Hash:** `9a88e4a1c6bc1ebc56b182d4a2ff091d9fc4858df47e52a1f6a250223d6f4461`
- **Dex Content:** Verified `WifiBridgePlugin.class` present and compiled without errors.

### 3.2 ESP32 Wi-Fi Standard Firmware (`esp32dev`)
*Enables Wi-Fi SoftAP/STA and authenticated TCP server; disables BLE.*
- **PlatformIO Environment:** `[env:esp32dev]`
- **Binary Path:** `firmware/sme105_usb_bridge/.pio/build/esp32dev/firmware.bin`
- **Program Size in Flash (ELF):** `846,357` bytes (64.6% of 1,310,720 bytes)
- **Binary File Size on Disk:** `852,928` bytes
- **SHA-256 Hash:** `093bf9e0d804f73455778e856e0cfa13ce70e1071fec81b2d0760d0c3d83ee0a`

### 3.3 ESP32 Legacy BLE Feasibility Firmware (`esp32dev_ble`)
*Enables NimBLE UART; explicitly sets `WiFi.mode(WIFI_OFF)`.*
- **PlatformIO Environment:** `[env:esp32dev_ble]`
- **Binary Path:** `firmware/sme105_usb_bridge/.pio/build/esp32dev_ble/firmware.bin`
- **Program Size in Flash (ELF):** `1,072,725` bytes (81.8% of 1,310,720 bytes)
- **Binary File Size on Disk:** `1,079,296` bytes
- **SHA-256 Hash:** `0d69c6e121b36fedd521cf31924f3456554eb734543bca8c15723f732376cd3e`

---

## 4. Verification Evidence & Test Execution

| Suite | Command | Result | Duration | Exit Code |
|---|---|---|---|---|
| **Wi-Fi Focused JavaScript** | `node --experimental-global-webcrypto --test app/tests/wifi*.test.mjs` | **43 passed, 0 failed, 0 skipped** | 0.24s | `0` |
| **JavaScript Parallel Suite** | `npm test` | **274 total: 271 passed, 3 skipped, 0 failed** | 10.43s | `0` |
| **JavaScript Sequential Suite** | `node --experimental-global-webcrypto --test --test-concurrency=1 app/tests/*.test.mjs` | **274 total: 271 passed, 3 skipped, 0 failed** | 37.03s | `0` |
| **Python Unit & Provisioning** | `PYTHONPATH=src ./.venv/bin/python -m unittest discover -s tests -q` | **319 total: 309 passed, 10 skipped, 0 failed** | 24.11s | `0` |
| **Android JVM Concurrency Tests** | `./gradlew :app:testDebugUnitTest --offline` | **2 race tests passed, 0 failed** | 0.32s | `0` |
| **Android Java Compilation** | `./gradlew :app:compileDebugJavaWithJavac --offline` | **0 errors, SUCCESS (JDK 21)** | — | `0` |
| **Android Debug APK Assembly** | `./gradlew :app:testDebugUnitTest :app:assembleDebug --offline` | **SUCCESS (135 tasks: 7 executed, 128 up-to-date)** | 1s | `0` |
| **PlatformIO Wi-Fi Build** | `pio run -d firmware/sme105_usb_bridge -e esp32dev` | **SUCCESS** | 1.86s | `0` |
| **PlatformIO BLE Build** | `pio run -d firmware/sme105_usb_bridge -e esp32dev_ble` | **SUCCESS** | 1.99s | `0` |
| **Git Diff Syntax & Check** | `git diff --check` | **Clean (0 errors)** | 0.05s | `0` |

---

## 5. First-Time USB Setup & Offline Token Transfer

To prepare the ESP32 bridge for Wi-Fi operation before vehicle deployment:

1. Connect the ESP32 bridge via USB (`/dev/ttyUSB0`).
2. Run the secure provisioning tool in SoftAP mode:
   ```bash
   ./.venv/bin/python scripts/sme105_wifi_setup.py --ap \
     --ap-ssid SME105_DCL \
     --token-file ~/.sme105_wifi_token.txt
   ```
   - Enter a WPA2 passphrase of 16–63 printable ASCII characters when prompted (input is not echoed).
   - If the bridge is already configured, the tool safely invokes `WIFI_AP_MODE` and retrieves the token without rotating NVS.
3. Open the Android application (version 1.8.16):
   - Navigate to **Settings** -> **Wi-Fi Bridge**.
   - Enter the 32-character hexadecimal token retrieved from `~/.sme105_wifi_token.txt` and tap **Save Token**.
   - Enter the 16–63 character WPA2 passphrase and tap **Save Password**.
   - Credentials are stored strictly in private Android Keystore AES-256-GCM storage.

---

## 6. Physical Bench & Vehicle Acceptance Gates (Pending Authorization)

The following actions require explicit physical deployment authorization from the vehicle owner:

1. **Hardware Flash:**
   ```bash
   esptool.py --port /dev/ttyUSB0 --baud 460800 write_flash 0x10000 \
     firmware/sme105_usb_bridge/.pio/build/esp32dev/firmware.bin
   ```
2. **Android APK Installation:**
   ```bash
   /home/maxim/.local/share/android-sdk/platform-tools/adb -s RZCRB06S0JH install -r \
     android/app/build/outputs/apk/debug/app-debug.apk
   ```
3. **Physical Verification Stages:**
   - **Stage A (Radio & SSID):** Verify phone Wi-Fi scans and associates with `SME105_DCL` using WPA2.
   - **Stage B (TCP Handshake):** Connect phone to bridge at `10.77.13.1:8765`, verify `AUTH <token>\n` yields `AUTH OK\n`.
   - **Stage C (Preflight Readiness):** Verify `HELLO -> PINS -> STATUS` completes and diagnostic controls unlock only when `DE=LOW`, `auto_tx=0`, and `tx2_bench_pass=1`.
   - **Stage D (Vehicle Read):** Execute KOEO / Live Data read on 1998 Ford Escort 1.6 Zetec-E and verify continuous frame reception.

---

## 7. Follow-Up Write-Safety Correction and Independent Acceptance (v1.8.16)

After independent review identified two remaining transmission-safety defects, two additional Codex GPT-6 Luna `xhigh` workstreams corrected the JS and Android layers without changing any ESP32 ECU command definitions or the firmware. The JavaScript fix is in `app/js/wifi.js`; its unhandled-rejection-safe controller caller is in `app/js/app.js`. Three new JS tests cover error propagation, queued writes invalidated by disconnect, and safe consumption at the app controller boundary.

The native fix in `WifiBridgePlugin.java` creates a single FIFO writer, binds every write to its captured authenticated attempt/generation and socket/output identities at invocation time, revalidates before writing and before acknowledging completion, and rejects old-session commands instead of allowing them onto a later connection. Disconnect revokes the active session and closes the old socket before its cleanup barrier resolves. When a write had already started and its delivery cannot be determined, the error explicitly states *uncertain delivery*; there are no automatic ECU command retries.

The newly added **actual JVM plugin test**, `android/app/src/test/java/com/maximizotech/sme105dclstudio/WifiBridgePluginWriteRaceTest.java`, passed both deterministic scenarios:

1. Attempt A has an in-progress and a queued command, then disconnects and attempt B connects. The queued A command never writes to B.
2. An in-progress write races with disconnect; the socket is closed, the result is reported uncertain, and disconnect does not claim completion ahead of the write.

Independently verified release artifacts: Android **v1.8.16/code 18**, APK **4,992,238 bytes**, SHA-256 **`9a88e4a1c6bc1ebc56b182d4a2ff091d9fc4858df47e52a1f6a250223d6f4461`**. The USB Wi-Fi and BLE firmware binaries remain the unchanged v28 builds with hashes shown above. Android compilation and APK assembly succeeded with **JDK 21**, **Node 22** for Capacitor sync, and the existing local Android SDK. No source capture, Android app data, or ESP32 NVS was modified.

**Verdict:** OFFLINE SOFTWARE/BUILD ACCEPTANCE PASS. Physical Android–ESP32 SoftAP, TCP authentication, background handling, range, and vehicle tests remain **PENDING**. No commit, push, install, flash, USB provisioning command, or vehicle DCL operation was authorized or performed in this correction round.

---

## Follow-up release (2026-11-09) — superseding v1.8.16 details

This report describes the original v1.8.16 Wi-Fi-first development and is **historical**. The current installed release is **Android v1.8.17/build19 and ESP32 v29** with direct WPA2 SoftAP, one user-entered Wi-Fi password, internally derived TCP `AUTH`, and no manually entered token or router requirement. The owner has confirmed direct phone pairing and an isolated output-LED bench demonstration with the ECU disconnected; vehicle-side diagnostic and actuator semantics are **not** thereby verified. See [the current release/bench report](docs/releases/2026-11-09-direct-softap-bench.md), [main README](README.md), and [direct Wi-Fi setup](docs/wifi_bridge_architecture_and_setup.md) for the active baseline and recovery procedure. Earlier v1.8.16 validation results and hashes remain here only as dated history.
