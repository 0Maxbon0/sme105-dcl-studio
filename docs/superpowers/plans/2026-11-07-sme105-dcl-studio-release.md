# SME105 DCL Studio — One-Shot Firmware + Android Integration Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a coordinated, evidence-preserving SME105 firmware (v25) and Android app (v1.8.12 / versionCode 14) update with an authoritative experiment catalogue, firmware-level active-master qualification gate, per-experiment durable recording and export with SHA-256 verification, and authorized physical device installation.

**Architecture:** ESP32 firmware (`esp32dev_ble`) with fail-closed command lookup, active-master electrical qualification gate, and local GPIO17 pad witness; Android Capacitor/PWA client with durable IndexedDB session storage, SHA-256 multi-file session exports, and technical English DCL exploration interface; Python host CLI (`sme105_usb_bridge.py`) with read-only HELLO separated from active OBSERVE.

**Tech Stack:** C++ / Arduino / ESP-IDF (PlatformIO, NimBLE), JavaScript ES2022 / Node.js test runner / IndexedDB / Capacitor 8.6 / Gradle 8.14.3 / Java 21, Python 3.12 / unittest / pyserial.

**Spec:** USER_REQUEST and `docs/wiring-safety.md`, `docs/SME105-DCL-command-discovery-2026-11-07.md`, `docs/SME105-DCL-protocol-structure-analysis-2026-11-07.md`.

## Global Constraints

- Target vehicle: 1998 Ford Escort 1.6 Zetec-E, EEC-IV, SME-105 ECU (`97AB-12A650-KA`).
- Hardware pinout: ESP32 GPIO16 (RO/UART1), GPIO17 (DI/UART2 TX + local pad witness), GPIO18 (DE/RMT with external 10k pull-down). Hold `/RE` LOW. K-Line / OBD pin 7 disabled.
- Preserve existing WIP and untracked files (`docs/SME105-DCL-command-discovery-2026-11-07.md`, `docs/SME105-DCL-protocol-structure-analysis-2026-11-07.md`). Never reset, clean, checkout, stash, discard, or overwrite.
- Do not commit or push.
- Active vehicle transmission disabled by default until hardware qualification evidence has been reviewed. Implement restriction in firmware itself.
- Permitted desk-only operations: HELLO, HELP, STATUS, PINS, BLE_STATUS, TX2_BENCH (DE LOW), RMT_DUMP, STOP.
- Target versions: Firmware `kUsbInstalledBuildVersion`: 24 → 25; Android `versionName`: 1.8.11 → 1.8.12; `versionCode`: 13 → 14.
- Flash method: Application-only flash at `0x10000` using pinned esptool 4.9.0; private full backup before writing; never erase full flash, NVS, bootloader, partition table, otadata, or app1.
- In-place Android install: `adb install -r <apk-path>`; never wipe app data.

---

### Task 1: Authoritative Experiment Descriptor Catalogue & Parity Analysis

**Files:**
- Modify: `app/js/protocol.js`
- Test: `app/tests/protocol.test.mjs`
- Test: `tests/test_cart_reference.py`

**Interfaces:**
- Consumes: A–R source command definitions (`doncreat0r/eeciv`, `flxkrmr/eec-iv-reader-arduino`)
- Produces: `EXPERIMENT_CATALOGUE`, `DCL_PROBE_VARIANTS`, `DCL_BLOCKED_CANDIDATES`, `VARIANTS` in `app/js/protocol.js` with exact metadata, parity status, sendability, and blocking reasons.

- [ ] **Step 1: Write failing test in `app/tests/protocol.test.mjs` for the authoritative catalogue**

Verify that:
1. `EXPERIMENT_CATALOGUE` contains all A–R entries and known variants.
2. `005E` PIDMAP is clearly documented with its parity mismatch (generic parity is `004E`), marked as published literal, never auto-fallback.
3. `004E` is explicitly separate as parity hypothesis (blocked) and distinct from RX frame-ID E.
4. `DMR` (`22C6`) and `BOTH` (`271E`) are categorized as deferred pending protocol support.
5. `MEM` has expected sequence `42F3` then `22D3` and is deferred/blocked until target map is validated.
6. Sendability flags and exact blocking reasons are present for every entry.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test app/tests/protocol.test.mjs`
Expected: FAIL due to missing or unupdated catalogue exports.

- [ ] **Step 3: Update `app/js/protocol.js` with the authoritative catalogue**

Define the unified `EXPERIMENT_CATALOGUE` object containing:
- Stable identifier, display name, exact command words, envelope.
- Description, source, parity status (`GENERIC_MATCH`, `UNRESOLVED_MISMATCH`, `NOT_APPLICABLE`).
- Evidence level, classification (READ_ONLY, STATE_CHANGING, MODE_CHANGING).
- Sendable boolean and exact reason if deferred or blocked.
- Update `DCL_PROBE_VARIANTS` to contain only sendable single-shot candidates (`ECU_STATUS`, `PIDMAP`, `DMRMAP`).
- Move `DMR` (`22C6`) and `BOTH` (`271E`) to deferred candidates with clear protocol reasons.
- Ensure all entries match across `VARIANTS` and `DCL_BLOCKED_CANDIDATES`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test app/tests/protocol.test.mjs`
Expected: PASS

---

### Task 2: Firmware Core Safety, Active-Master Gate, and BLE Build Corrections

**Files:**
- Modify: `firmware/sme105_usb_bridge/sme105_usb_bridge.ino`
- Modify: `firmware/sme105_usb_bridge/README.md`

**Interfaces:**
- Consumes: Experiment catalogue definitions, active-master gate requirements.
- Produces: Firmware v25 image (`esp32dev_ble`) enforcing electrical safety gate, latch protection, fail-closed variant lookup, BLE help output, and USB maintenance boot-health adoption.

- [ ] **Step 1: Write static/unit test assertions or review existing firmware tests**

In `tests/test_sme105_usb_bridge.py` and `app/tests/session.test.mjs`, verify expectations for:
1. `kUsbInstalledBuildVersion = 25`.
2. Active-master qualification gate `kActiveMasterQualified = false;` returning `DENIED active_master_not_qualified` for all active vehicle transmission (`OBSERVE`, `READ_*`, `ARM_*`).
3. `OBSERVE` requiring `tx2BenchPassed` without consuming `observeConsumed` before passing.
4. Correct HELP output in BLE builds (no false Wi-Fi commands, include `BLE_STATUS`).
5. Wi-Fi commands in BLE build returning `DENIED unsupported_build_wifi_disabled`.
6. USB maintenance boot-health: when running on app0 with `imageState == ESP_OTA_IMG_UNDEFINED`, adopt `kUsbInstalledBuildVersion = 25` and cancel rollback so status reports `boot_health=VALID accepted_version=25`.

- [ ] **Step 2: Update `firmware/sme105_usb_bridge/sme105_usb_bridge.ino`**

1. Set `constexpr uint32_t kUsbInstalledBuildVersion = 25;`.
2. Add `constexpr bool kActiveMasterQualified = false;` with explicit electrical safety justification comments.
3. In `beginSession`:
   - If `!kActiveMasterQualified && (target == CART_READ || (target == CART_PASSIVE && kind == 3))` (vehicle TX): return `DENIED active_master_not_qualified`.
   - If `(target == CART_READ || (target == CART_PASSIVE && kind == 3)) && !tx2BenchPassed`: return `DENIED tx2_pad_bench_required` (BEFORE latching `observeConsumed`!).
   - In `ARM_*`: if `!kActiveMasterQualified`: return `DENIED active_master_not_qualified`.
   - Fail-closed variant validation: check variant against allowlist; reject invalid variant.
4. In `initializeOtaBootHealth()`:
   - When running on app0 with `!pendingKeysExist` and `imageState == ESP_OTA_IMG_UNDEFINED`: call `esp_ota_mark_app_valid_cancel_rollback()` and update `otaAcceptedVersion = kUsbInstalledBuildVersion;` in NVS.
5. In command dispatch for Wi-Fi commands:
   - Under `#if defined(SME105_BLE)`, Wi-Fi configuration/mode commands return `DENIED unsupported_build_wifi_disabled`.
   - HELP string lists `BLE_STATUS` and BLE features; excludes Wi-Fi commands.

- [ ] **Step 3: Build firmware and test**

Run: `.venv/bin/pio run -d firmware/sme105_usb_bridge -e esp32dev_ble`
Expected: SUCCESS. Verify memory size within `0x140000` (1,310,720 bytes).

---

### Task 3: Desktop Host CLI Corrections (`scripts/sme105_usb_bridge.py`)

**Files:**
- Modify: `scripts/sme105_usb_bridge.py`
- Modify: `tests/test_sme105_usb_bridge.py`

**Interfaces:**
- Consumes: Firmware v25 protocol, updated experiment catalogue.
- Produces: Updated CLI tool where `HELLO` is strictly read-only, `OBSERVE` is explicitly separated and authorized, and all new probes and operations are supported.

- [ ] **Step 1: Write failing tests in `tests/test_sme105_usb_bridge.py`**

1. Test that `HELLO` sends `"HELLO\n"`, does not require `SEND HELLO` confirmation, and never sends `OBSERVE`.
2. Test that `OBSERVE` sends `"OBSERVE\n"`, requires explicit `SEND OBSERVE` confirmation, and is distinct.
3. Test that all new discovery commands (`REQUEST_ECU_STATUS`, `REQUEST_PIDMAP`, `REQUEST_DMRMAP`, `REQUEST_DMR`, `REQUEST_BOTH`, `REQUEST_KOER`, `REQUEST_CLR`, `REQUEST_MEM`, `REQUEST_LIVE3`) are present in `COMMANDS`, `WIRE_COMMANDS`, `REQUEST_WORDS`, `CAR_TRANSMIT`, and `ARM_EVENT` regex.
4. Test that `DENIED active_master_not_qualified` is parsed and handled cleanly without infinite wait.

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m unittest tests/test_sme105_usb_bridge.py`
Expected: FAIL on `HELLO` / `OBSERVE` separation and missing command variants.

- [ ] **Step 3: Implement corrections in `scripts/sme105_usb_bridge.py`**

1. Separate `HELLO` (read-only identity) from `OBSERVE` (active handshake).
2. Update `COMMANDS`, `CAR_TRANSMIT`, `WIRE_COMMANDS`, `REQUEST_WORDS`.
3. Update `ARM_EVENT` regex to include all variants.
4. Update `execute()`, `menu()`, and `confirm_vehicle()` text.
5. Handle `DENIED active_master_not_qualified` cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `.venv/bin/python -m unittest tests/test_sme105_usb_bridge.py`
Expected: PASS

---

### Task 4: Per-Experiment Durable Recording, Storage & Export System

**Files:**
- Modify: `app/js/recording.js`
- Modify: `app/js/session.js`
- Modify: `app/js/controller.js`
- Modify: `app/js/app.js`
- Modify: `app/js/test-history.js`
- Modify: `app/js/exports.js`
- Test: `app/tests/session.test.mjs`
- Test: `app/tests/controller.test.mjs`
- Test: `app/tests/test-history.test.mjs`

**Interfaces:**
- Consumes: Stream of protocol lines, user consent, experiment metadata.
- Produces: Persistent IndexedDB recording per experiment (with unique `sessionId`), crash-resilient chunking, SHA-256 verified per-session exports (`metadata.json`, `raw.txt`, `events.jsonl`, `ro.bin`, `ro-timestamps.csv`, `tx-pad.jsonl`, `SHA256SUMS`).

- [ ] **Step 1: Write failing tests for per-experiment durable recording and export**

1. Test that each experiment creates a persistent recording before ARM/dispatch.
2. Test that operator consent is recorded in IndexedDB with `sessionId` and awaited before dispatch.
3. Test that `SESSION_RESULT.rx` correctly stores `end.ro_bytes`.
4. Test that partial lines on disconnect are retained rather than dropped.
5. Test that unfinished captures are recovered on startup and marked `INCOMPLETE` without fabricating `END`.
6. Test that per-experiment export generates `SHA256SUMS` and validates all file hashes before reporting success.
7. Test that `MEM` expected sequence in `session.js` uses `42F3` then `22D3`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test app/tests/controller.test.mjs app/tests/session.test.mjs app/tests/test-history.test.mjs`
Expected: FAIL

- [ ] **Step 3: Implement per-experiment recording in `app/js/recording.js` & `app/js/controller.js` & `app/js/app.js`**

1. In `app/js/recording.js`:
   - Add operation-specific storage check (e.g., 20 MB for probes, 1 GB for live).
   - Add boot-time crash recovery: scan for unclosed captures and mark them `INCOMPLETE`.
   - Add multi-file export generator: `exportExperimentArchive(id)` producing ZIP with `metadata.json`, `raw.txt`, `events.jsonl`, `ro.bin`, `ro-timestamps.csv`, `tx-pad.jsonl`, `SHA256SUMS`.
2. In `app/js/app.js`:
   - Fix `SESSION_RESULT.rx`: `rx: session.verdict?.end?.ro_bytes ?? null`.
   - Connect durable recording to DCL discovery probes, DTC reads, KOEO, KOER, CLR, MEM, OFF.
   - Update `ask()` to record and await durable consent in IndexedDB before executing action.
   - Ensure `sessionId` is passed across all journal events, raw lines, and metadata.
3. In `app/js/session.js`:
   - Fix `MEM` expected words to `42F3` / `22D3`.
4. In `app/js/test-history.js`:
   - Update history view to support loading and exporting persisted experiment recordings.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test app/tests/controller.test.mjs app/tests/session.test.mjs app/tests/test-history.test.mjs`
Expected: PASS

---

### Task 5: Android Build, Packaging & Version Update

**Files:**
- Modify: `android/app/build.gradle`
- Modify: `app/index.html`
- Modify: `app/sw.js`

**Interfaces:**
- Consumes: Web assets, Capacitor native bridge, Android Gradle configuration.
- Produces: Signed debug APK `android/app/build/outputs/apk/debug/app-debug.apk` (versionName `1.8.12`, versionCode `14`).

- [ ] **Step 1: Update versions**

1. In `android/app/build.gradle`: `versionCode 14`, `versionName "1.8.12"`.
2. In `app/js/protocol.js`: verify `APP_VERSION = "1.8.12"`.
3. In `app/index.html` and `app/sw.js`: increment cache bust / service worker version as established.

- [ ] **Step 2: Build bundle and synchronize Android**

Run:
```bash
export JAVA_HOME=/home/maxim/.local/share/jdks/jdk-21
export ANDROID_HOME=/home/maxim/.local/share/android-sdk
export PATH=$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH
npm run native:bundle
npx cap sync android
```
Expected: SUCCESS

- [ ] **Step 3: Build Android debug APK**

Run:
```bash
cd android && ./gradlew assembleDebug
```
Expected: `BUILD SUCCESSFUL`.
Verify APK exists at `android/app/build/outputs/apk/debug/app-debug.apk`.

- [ ] **Step 4: Verify APK contents and calculate SHA-256**

Inspect package name `com.maximizotech.sme105dclstudio`, versionName, versionCode. Compute SHA-256.

---

### Task 6: Full Software Test Suite & Lint Validation

**Files:**
- Repository root

**Interfaces:**
- Consumes: All updated firmware, app, and script sources.
- Produces: Clean test and lint run with exact counts and 0 failures.

- [ ] **Step 1: Run `npm test`**

Run: `npm test`
Expected: All tests pass, 0 failures.

- [ ] **Step 2: Run Python test suite**

Run: `.venv/bin/python -m unittest discover -s tests`
Expected: All tests pass, 0 failures.

- [ ] **Step 3: Run `git diff --check`**

Run: `git diff --check`
Expected: 0 errors / clean.

---

### Task 7: Documentation, Experiment Plan, and Release Artifacts

**Files:**
- Create: `docs/sme105-dcl-experiment-plan-2026-11-07.md`
- Create: `artifacts/releases/2026-11-07-v25-release-report.md`
- Modify: `README.md`
- Modify: `PROJECT_HANDOFF.md`
- Modify: `STATUS_REPORT.md`
- Modify: `app/README.md`
- Modify: `firmware/sme105_usb_bridge/README.md`
- Modify: `docs/SME105-DCL-command-discovery-2026-11-07.md`
- Modify: `docs/SME105-DCL-protocol-structure-analysis-2026-11-07.md`

**Interfaces:**
- Consumes: Test results, firmware and APK hashes, experiment catalogue.
- Produces: Complete technical documentation and dated release artifacts.

- [ ] **Step 1: Write dated experiment plan `docs/sme105-dcl-experiment-plan-2026-11-07.md`**

Include:
- Full command matrix with evidence level, request envelope, safe ordering.
- Blocked commands and reasons.
- Per-session recording format.
- Required hardware qualification.
- Export and comparison procedures.

- [ ] **Step 2: Update existing docs to reflect v25 and release state**

Update `README.md`, `PROJECT_HANDOFF.md`, `STATUS_REPORT.md`, `app/README.md`, `firmware/sme105_usb_bridge/README.md`, `docs/SME105-DCL-command-discovery-2026-11-07.md`, `docs/SME105-DCL-protocol-structure-analysis-2026-11-07.md`.

- [ ] **Step 3: Generate release report `artifacts/releases/2026-11-07-v25-release-report.md`**

Record binary hashes, package metadata, test pass counts, build flags, and safety disposition.

---

### Task 8: Authorized Physical Hardware Update & Verification (Conditional)

**Files:**
- Hardware: ESP32 `/dev/ttyUSB0`, Android Phone (`adb`)

**Interfaces:**
- Consumes: Compiled firmware v25 binary, compiled Android v1.8.12 APK, connected devices.
- Produces: Application-only flashed ESP32 running v25, in-place updated Android app.

- [ ] **Step 1: Check hardware preflight**

Check `/dev/serial/by-id/`, `adb devices -l`.
If serial device is present and verified:
1. Verify chip identity, running partition `app0`, boot `app0`.
2. Take fresh private full-flash backup outside repo with permissions 0600.
3. Compute and record backup SHA-256.
4. Perform application-only flash of v25 binary to app0 at `0x10000` using pinned esptool 4.9.0.
5. Verify post-flash status: fw=25, app0, VALID, DE LOW, no fault.
6. Desk validation: HELLO, PINS, STATUS, TX2_BENCH (DE LOW). Verify 4/4 pad words and RMT evidence.
7. Confirm NO vehicle command (OBSERVE, READ, etc.) is sent.

If phone is present and verified over ADB:
1. In-place install: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
2. Verify package `com.maximizotech.sme105dclstudio`, versionName `1.8.12`, versionCode `14`.
3. Launch app and verify UI loads with existing data preserved.
4. If phone is disconnected/unavailable, report build success and keep artifacts ready.
