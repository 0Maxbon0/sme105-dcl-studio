# SME105 DCL Studio — current implementation status

**As of 2026-11-09.** See the [main README](../README.md) for the active release and [references](REFERENCES.md) for all traced external sources. Old release reports document their own dates, not the current installed baseline.

| Area | Status | Verification boundary |
| --- | --- | --- |
| Native Android application | **v1.8.17 / build 19, installed** | New APK built with JDK21, deployed using `adb install -r`; WebView data retained |
| ESP32 Wi-Fi firmware | **v29 `esp32dev`, installed** | Flash verified by esptool digest, USB `fw=29`, safe idle and OTA valid |
| Direct ESP32 Hotspot | **Owner-reported bench PASS** | Phone paired to ESP32 without router; on isolated output demonstration, local LEDs lit; user accepted result |
| One user-visible password | **Implemented** | WPA2 association plus internally PBKDF2-derived TCP `AUTH`; token UI removed |
| Android/ESP32 long-term Wi-Fi stability | **Not separately certified** | No-internet Android Wi-Fi policy and session persistence need dedicated extended run evidence |
| ECU diagnostic reads/actuator semantics | **Experimental, not verified by bench network test** | Hardware/polarity qualification and timestamped ECU response still needed |
| Historical RAW captures | **Preserved** | Do not delete or rewrite; Android IndexedDB persistent |
| Standalone Python localhost web GUI | **Retired from main** | Old, separate web server and launchers removed; native Android `app/` assets remain essential |
| Python command-line tooling | **Maintained** | Capture/inspect/frame/decode/DTC commands and regression suites remain |

## Verification snapshot

- JavaScript offline/mobile/transport tests: **273 pass, 3 skipped** in the current November 9 checkout; no failures. Repeat after changes.
- Python suite before retiring the old GUI: **312 pass, 10 skipped**. After GUI removal and fixture separation: **297 pass, 10 skipped** locally in current-tree verification; clean checkout runs **293 pass, 14 skipped**, all with zero failures.
- Android Gradle JVM unit tests and `assembleDebug`: **PASS**; 105 APK web assets byte-identical to the source at acceptance.
- PlatformIO Wi-Fi build: **PASS**; physical USB v29 flash/verify **PASS**.
- No vehicle ECU operation was authorized or needed for the Wi-Fi bench acceptance.

## Remaining validation

1. Capture sustained direct-AP stability and disconnect/reconnect safety in a documented bench run; Android may classify this as a no-Internet network.
2. Verify exact MAX487 electrical levels, protection, polarity, ground and vehicle connector before any car DCL session.
3. Validate each experimental request/response profile on this precise SME105 ECU, keeping raw events and operator actions; never infer support from another Ford EEC-IV revision.
4. Promote sensor units/formulas, DTC interpretations and memory offsets only after repeatable evidence.
