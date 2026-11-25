# Developer setup and repeatable checks

This document is for **offline software evaluation** first. Building
the Android app or ESP32 image does not require attaching a vehicle or
transmitting anything to an ECU.

## Source of truth (local working tree, 25 November 2026)

| Item | Where to verify | Local value at documentation time |
| --- | --- | --- |
| Git source | `git rev-parse --short HEAD` | Run the command; the local rebranding branch may be ahead of GitHub |
| Android app version | `app/js/protocol.js` and `android/app/build.gradle` | `2.2.1` / build `31` |
| Firmware version | `kUsbInstalledBuildVersion` in `firmware/sme105_usb_bridge/sme105_usb_bridge.ino` | `30` |
| Firmware profiles | `firmware/sme105_usb_bridge/platformio.ini` | `esp32dev` (Wi-Fi), `esp32dev_ble` (alternative BLE) |
| Native package | `capacitor.config.json` | `com.maximizotech.sme105dclstudio` |

**Important:** historical Android `1.8.17` acceptance evidence,
the November 11 `1.8.18` debug APK, and today's `2.2.1` source
are **different revisions**. Do not label older artifacts
as fresh build outputs or assume the latest code was flashed/installed.

## Prerequisites

- Node.js **22** and npm. Dependencies are pinned by `package-lock.json`.
- Python **3.12+** and pip/venv (local offline analysis and tests).
- Optional firmware build: PlatformIO with its pinned `espressif32` platform
  and libraries.
- Optional Android build: **JDK 21**, Android SDK/Build Tools,
  installed Android platform, Gradle wrapper and Capacitor dependencies.
- KiCad (for editable PCB review): refer to the individual
  `hardware/pcb-r*/README.md` files. Do not fabricate or plug in the
  design based on a passing ERC/DRC check.

## Test the app source and Python analysis

From the project root:

    npm ci
    npm test

    python3 -m venv .venv
    . .venv/bin/activate
    python -m pip install -e .
    PYTHONPATH=src python -m unittest discover -s tests -q

In PowerShell, activate an appropriate Windows virtual environment
instead of `. .venv/bin/activate`. Some historical-capture tests
skip in a public checkout because private original RAW files are not
published. That is intentional: **never add private captures just to
change skipped tests into passes**.

## Compile-only firmware checks

Install the optional firmware dependencies in the virtual environment:

    python -m pip install -e '.[firmware]'
    python -m platformio run -d firmware/sme105_usb_bridge -e esp32dev
    python -m platformio run -d firmware/sme105_usb_bridge -e esp32dev_ble

These commands build binaries locally. They do **not** flash or rekey
the ESP32. The BLE environment is a separate firmware profile,
not an automatically negotiated mode inside the Wi-Fi image.

If testing an alternative hardware board or changing the active
`platformio.ini`, document the board, library version and affected safety
assumptions before sharing results.

## Build and test the Android app

    npm run android:sync
    cd android
    ./gradlew :app:testDebugUnitTest :app:assembleDebug

On Windows use `gradlew.bat`. Gradle produces a **debug** package under
`android/app/build/outputs/apk/debug/`. The release distribution/signing
workflow is separate; never commit passwords, signing keys, NVS images,
or raw device backups.

`npm run android:sync` rebuilds the bundled bridge and syncs the
Capacitor `app/` assets into Android. It is **not** an APK installation.
An installed app's IndexedDB history belongs to its Android package:
do not uninstall it or clear its data during routine upgrades.

## Change/verification checklist

1. Run `git status --short` and `git diff` before touching files.
   The current local repository may contain **untracked PCB sources and
   experimental build artifacts**; preserve them.
2. Edit the canonical source, not generated Android build outputs,
   generated vendor bundles or historical raw captures.
3. Add synthetic regression cases for transport, parser and
   recording changes, including stale-connection/timeout failure paths.
4. Run the relevant host checks. Native networking changes also
   require native JVM checks, firmware changes both PlatformIO builds.
5. Report actual pass/skip/fail counts **for that run** and separately
   state what was **not** tested on physical hardware.
6. Run `git diff --check` and the public release checklist.

For vehicle-facing experiments, read
[wiring safety](wiring-safety.md),
[fixed-command procedure](sme105-dcl-experiment-plan-2026-11-07.md),
and [engineering status](ENGINEERING_BRIEF.md) first.
