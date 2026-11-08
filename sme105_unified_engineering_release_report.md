# SME105 DCL Studio — Final Release Corrections & Real-Capture Verification Report

**Date:** 2026-11-08  
**Vehicle:** 1998 Ford Escort 1.6 Zetec-E (L1H)  
**ECU:** Ford EEC-IV SME-105 (`97AB-12A650-KA`)  
**Hardware Interface:** ESP32 + MAX487 DCL Bridge (v27 baseline / v28 candidate)  
**Mobile Application:** SME105 DCL Studio v1.8.13 (Android Debug APK)  
**Repository:** `/home/maxim/maximizotech/sme105-fw-review-FORupdGL` (`main` @ `67acaa3` + release candidate working tree)  
**Supervisor / Reviewer:** Antigravity (AGY)  
**Implementation Specialists:** Codex GPT-6 Luna (`xhigh`)  

---

## Executive Summary & Verdict

- **Final Release Candidate Verdict:** **PASS — ALL DEFECTS RESOLVED & INDEPENDENTLY VERIFIED — READY FOR OWNER AUTHORIZATION**  
- **Test Results:**
  - **JavaScript Test Suite (Concurrent):** 231 tests total — **228 passed, 0 failed, 3 skipped** (`duration: ~7.5s`)
  - **JavaScript Test Suite (Serial `--test-concurrency=1`):** 231 tests total — **228 passed, 0 failed, 3 skipped** (`duration: ~29.0s`, zero lifecycle flakiness)
  - **Python Bridges, Diagnostics & Profile Suite:** 313 tests total — **303 passed, 0 failed, 10 skipped** (hardware skips, `duration: ~24.6s`)
  - **Git Diff Hygiene:** Zero trailing whitespace or syntax errors (`git diff --check` clean, 0 violations)
- **Deliverables Built & Verified:**
  - **Android Debug APK:** `android/app/build/outputs/apk/debug/app-debug.apk` (4,964,922 bytes)  
    `SHA-256: 5fb6385390381840ddf1d74d6282da11af510ffd76a81d5ca46328c1c8164562`
  - **ESP32 USB Bridge Firmware:** `firmware/sme105_usb_bridge/.pio/build/esp32dev/firmware.bin` (852,928 bytes)  
    `SHA-256: 093bf9e0d804f73455778e856e0cfa13ce70e1071fec81b2d0760d0c3d83ee0a`
  - **ESP32 BLE Bridge Firmware:** `firmware/sme105_usb_bridge/.pio/build/esp32dev_ble/firmware.bin` (1,079,296 bytes)  
    `SHA-256: 0d69c6e121b36fedd521cf31924f3456554eb734543bca8c15723f732376cd3e`
- **Strict Deployment Gate Compliance:**
  - **NO** `git commit` performed.
  - **NO** `git push` performed.
  - **NO** `adb install` performed on device `RZCRB06S0JH`.
  - **NO** `esptool.py` (ESP32 flash) performed.
  - **ZERO** unconfirmed diagnostic transmissions issued to the vehicle.

---

## 1. Verified Defect Resolutions

| Issue ID | Priority | Module | Description & Resolution | Verification Status |
|---|---|---|---|---|
| **Defect 1** | P0 | `app/js/capture-comparison.js` | **Dynamic MEM_PARITY Response-Cycle Count (Elimination of `~38` Fallback)**: Replaced hardcoded fallback with `cycleClassificationFor(rawParsed, source)`. Computes sustained and entry response cycles dynamically from parsed RX frames via `analyzeMemCycles(rawParsed.frames)` and `classifyCycles(cycles)`. Reports `~38 response cycles` for full real recording, `~18 response cycles` for partial 2,500-line slice, `1 entry response cycles` for single-cycle entry, and `unknown response cycles` when frame cycle evidence is unavailable. Never defaults to 38, 39, or 41. | **PASSED** (11/11 capture comparison tests pass, including full, partial, entry, and no-frames cases) |
| **Defect 2** | P0 | `app/js/capture-comparison.js` | **Initial Response Attribution & Repeated Envelope Words**: Distinguishes 4-word Ford EEC-IV DCL request envelope (`01B0 FF5F [CMD] 00A0`), TX witnesses, TX echo reflections, unattributed envelope repetitions (`repeatedEnvelopeWords`, tagged `UNATTRIBUTED_ENVELOPE_REPETITION`), and genuine independent ECU response candidates. Excludes repeated envelope words from candidate response blocks while preserving valid candidate responses (e.g. KOER F00: `16C1`, F01: `72E1`, F02: `3845`, F03: `21C5` from slot 2; KOEO F00: `11B1` from slot 2). Preserves legitimate `00A0` words in `F04_F15` at F08 and F09 (e.g. in 260E). | **PASSED** (Real capture regression confirms KOER/KOEO response blocks cleanly isolated) |
| **Defect 3** | P1 | `app/js/frame-inspector.js` & `app/js/analysis-ui.js` | **Modular Cycle Classification Architecture**: Relocated `classifyCycles()` to `app/js/frame-inspector.js` and re-exported it from `app/js/analysis-ui.js`. Allows both UI and capture-comparison engines to classify generic CART cycles (10ms baseline), response entry cycles (mixed cadence), and sustained response cycles (15ms cadence) with zero circular dependencies. | **PASSED** (10/10 analysis-ui tests pass, frame inspector tests pass) |
| **Defect 4** | P1 | `app/js/frame-inspector.js` | **Bounded Pagination & Event Jumping**: Implemented responsive bounded pagination (100 frames/page default, Prev/Next navigation, Page X of Y, visible frame range) enabling smooth inspection of all 5,681 KOER frames without DOM bloat. Added event jump controls for KOEO `11B1` (~9.22s), `ACC0 → EC80` (t=9.48s), KOER candidate codes `16C1..21C5` (t=58.83s–58.92s), `ACC0 → EC80` (t=59.10s), and MEM_PARITY changing cycles. Page automatically resets to 1 upon filtering. | **PASSED** (14/14 unit tests pass) |
| **Defect 5** | P1 | `app/js/analysis-ui.js` | **Asynchronous UI Lifecycle Safety**: Guarded all DOM manipulation with null-safe helpers (`el`, `setHidden`, `setText`, `replaceContent`, `setDisabled`, `listen`). Added generation tokens (`generations` Map) and `ui.dispose()` to cleanly discard stale async responses upon selection change or teardown. Exported awaitable `ui.settled()` promise, eliminating `UI did not settle` test timeouts. | **PASSED** (All lifecycle tests pass cleanly across concurrent and serial test runs) |

---

## 2. Real-Capture Verification Matrix (November 8 Field Evidence)

Verified against genuine phone captures in `/home/maxim/maximizotech/sme105-field-evidence/phone-2026-11-08-readonly-audit/reconstructed-captures/`:

| Pair / Capture | Vehicle Commands | Observed Ground Truth & Derived Evidence | Verdict / Behavior |
|---|---|---|---|
| **MEM_PARITY (32) Full vs Partial** | `42F3/2293` | **Full Capture (`raw.txt`, 4904 lines)**: Dynamically calculated 38 sustained response cycles (Cycles 3–40, 15ms) + 1 entry cycle. Continuation reports: `sustained continuation activity observed (profile candidate 2293, ~38 response cycles, witness count 164)`.<br>**Partial Slice (2,500 lines)**: Dynamically calculated 18 sustained response cycles + 1 entry cycle. Continuation reports: `sustained continuation activity observed (profile candidate 2293, ~18 response cycles, witness count 164)`. Never falls back to `~38`.<br>**No Frame Evidence**: Reports `unknown response cycles`. | `PASSED` (Cycle counts derived dynamically per recording) |
| **KOER (34) & KOEO (33)** | `253E` vs `253E` | **Envelope Repetition & Response Candidates**: In both tests, the 4-word envelope (`01B0 FF5F 253E 00A0`) repeats across F00..F03 in slot 1. These repeated words are classified as `repeatedEnvelopeWords` (`UNATTRIBUTED_ENVELOPE_REPETITION`) and excluded from `initialResponseBlock`. KOER cleanly extracts slot 2 candidate codes `16C1`, `72E1`, `3845`, `21C5`. KOEO cleanly extracts slot 2 code `11B1`. | `DIFFERENT` (Correct response extraction without envelope contamination) |
| **MEM (29) vs MEM_SINGLE (31)** | `42F3/22D3` vs `42F3` | **Continuation**: `MEM` includes continuation activity (`22D3` with witness count 244); `MEM_SINGLE` transmitted initial request only (`witness_count: 4`, no continuation). | `DIFFERENT` (Clean continuation separation; MEM_SINGLE reports initial request only) |
| **260E (21) vs 26A4 (22)** | `260E` vs `26A4` | **Cadence distinction**: `260E` exhibited 16 frames at 42.5ms; `26A4` exhibited 16 frames at 17.5ms.<br>**Payload match**: Both share initial response block F00..F11 (including legitimate `00A0` words at F08 and F09). | `DIFFERENT` (Shared payload block with distinct 42.5ms vs 17.5ms cadence) |
| **005E (24) vs 004E (25)** | `005E` vs `004E` | **Acceptance distinction**: `005E` (PIDMAP invalid parity) had 10.0ms baseline throughout with 0 response frames. `004E` (PIDMAP_ALT valid parity) showed 1 cycle of 42.5ms response cadence.<br>**ECU Attribution**: Neither returns a decoded PID map. | `DIFFERENT` (Differentiates structural acceptance without inventing decoded PID mappings) |

---

## 3. Firmware v28 Compatibility & Upgrade Matrix

| Bridge Firmware | Status Response | `MEM_OFF0` Capability | Baseline / Discovery / Expanded Commands | Upgrade Logic |
|---|---|---|---|---|
| **v27 (Current Vehicle)** | `fw=27 ...` | Reported as `UNSUPPORTED (Requires v28)` | Fully supported (25/26 commands) | Maintained for all existing operations |
| **v28 (Candidate)** | `fw=28 ... mem_off0=1` | Fully supported with frame 0 arming fix | Fully supported (26/26 commands) | Monotonic NVS upgrade adopts v28 on physical USB boot |

---

## 4. Test & Verification Summary

### JavaScript Test Suite (Node.js Concurrent Runner)
```text
> sme105-dcl-studio-android@1.0.0 test
> node --experimental-global-webcrypto --test app/tests/*.test.mjs

ℹ tests 231
ℹ suites 0
ℹ pass 228
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 7524.748853
```

### Serial Node.js Test Suite (`--test-concurrency=1`)
```text
node --experimental-global-webcrypto --test --test-concurrency=1 app/tests/*.test.mjs

ℹ tests 231
ℹ suites 0
ℹ pass 228
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 0
ℹ duration_ms 29049.646351
```

### Python Test Suite (Unittest Discovery)
```text
Ran 313 tests in 24.579s

OK (skipped=10)
```

### Git Diff Syntax & Whitespace Check
```text
git diff --check
(Zero violations returned)
```

---

## 5. Build Artifact Hashes and Sizes

| Artifact | Path | Size | SHA-256 Checksum |
|---|---|---|---|
| **Android Debug APK** | `android/app/build/outputs/apk/debug/app-debug.apk` | 4,964,922 bytes (~4.9 MB) | `5fb6385390381840ddf1d74d6282da11af510ffd76a81d5ca46328c1c8164562` |
| **ESP32 USB Firmware** | `firmware/sme105_usb_bridge/.pio/build/esp32dev/firmware.bin` | 852,928 bytes (~833 KB) | `093bf9e0d804f73455778e856e0cfa13ce70e1071fec81b2d0760d0c3d83ee0a` |
| **ESP32 BLE Firmware** | `firmware/sme105_usb_bridge/.pio/build/esp32dev_ble/firmware.bin` | 1,079,296 bytes (~1.1 MB) | `0d69c6e121b36fedd521cf31924f3456554eb734543bca8c15723f732376cd3e` |

*Note: App web assets in the APK match `app/` byte-for-byte.*

---

## 6. Remaining Protocol Uncertainties & Owner Authorization Checklist

1. **Unproven Diagnostic Meanings**: Unconfirmed DTC interpretations and PID decodings remain strictly designated with `[HYPOTHESIS - UNPROVEN FOR SME-105]`.
2. **`CLEAR_DTC` Level 1**: Remains classified as Level 1 until physical bus acceptance past `HSK_ACK` is demonstrated on the vehicle.
3. **Owner Authorization Gate**: No code has been pushed or committed, no firmware flashed, and no APK installed. Once the owner authorizes:
   - Commit and push release candidate to GitHub `0Maxbon0/sme105-dcl-studio`.
   - Install `app-debug.apk` on Android device `RZCRB06S0JH`.
   - Flash firmware v28 via USB onto ESP32 bridge when on the test bench.
