# SME105 DCL Studio — installation and hardware setup

**Current mode (2026-11-09):** native Android app v1.8.17 + ESP32 v29 direct WPA2 SoftAP; optional host Python CLI for evidence analysis. The obsolete Python localhost web GUI and associated launchers were retired from the maintained tree. Do not use `ford-dcl-gui` or the historical `Launch Studio.bat` instructions from old archived reports.

## 1. Host tools: Ubuntu or Windows

Use Python 3.12+, Node 22, JDK 21 and an Android SDK for app development. The Python CLI does not require Node/Android; Node is for building the phone application.

### Ubuntu

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip
# From the repository root:
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
ford-dcl --help
python -m serial.tools.list_ports -v
```

To access `/dev/ttyUSB*` without root (log out and back in after adding the group):

```bash
sudo usermod -aG dialout "$USER"
id -nG
ls -l /dev/serial/by-id/
```

A Silicon Labs CP2102 adapter commonly appears as `/dev/ttyUSB0` or a stable `/dev/serial/by-id/...` symlink. Never assume that a numeric port still identifies the same device after reconnecting it; confirm hardware identity before physical USB rekey or firmware flash.

### Windows

Install a supported Python interpreter and Git; check CP2102 COM access in **Device Manager → Ports**. The included `Install CP2102 Driver.bat` can install the vendor driver if missing. Then, in PowerShell from the repository root:

```powershell
py -3 -m venv .venv
.venv\Scripts\python.exe -m pip install -e .
.venv\Scripts\ford-dcl.exe --help
.venv\Scripts\python.exe -m serial.tools.list_ports -v
```

The obsolete GUI EXE/bundle is not part of the maintained CLI/Android release; do not invoke old `scripts/build_windows.bat`, `scripts/launch_windows.bat` or `Launch Studio.bat` from historical notes.

## 2. Build and install Android

From the repository root:

```bash
npm ci
npm test
npm run android:sync
cd android
./gradlew :app:testDebugUnitTest :app:assembleDebug --offline
```

On Windows, use `gradlew.bat` instead. Install the resulting APK **over** the existing application:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

The APK keeps its existing Android private data and IndexedDB evidence. **Never uninstall, `pm clear` or reset app storage for an ordinary upgrade**. Old Chrome/PWA storage is distinct from installed Android WebView storage; export any historic Chrome recordings before removing obsolete browser installations.

## 3. Build and configure the direct Wi-Fi bridge

The standard **Wi-Fi** image is `esp32dev` (firmware v29), not `esp32dev_ble`:

```bash
python -m pip install -e '.[firmware]'
python -m platformio run -d firmware/sme105_usb_bridge -e esp32dev
```

Flash only the correct firmware application slot, with a verified image and private backups of existing `app0`/partition table/NVS/OTA. Detailed supervised flash and backup guidance lives in [the direct Wi-Fi engineering guide](wifi_bridge_architecture_and_setup.md).

The ESP32 creates the 2.4 GHz WPA2 network and listens at `10.77.13.1:8765`. **No router, cloud service or home Wi-Fi is needed**. Its existing SSID can be device-specific (`SME105-DIRECT-2BF8` on the current device).

If and only if the owner wants to replace a **previously configured** AP password, use the separate explicit physical-USB rekey command after verifying `STATUS` shows safe idle and `DE=LOW`:

```bash
python scripts/sme105_wifi_setup.py --ap --ap-rekey --port /dev/ttyUSB0
```

The utility prompts privately for **one WPA2 passphrase**, saves a complete AP profile atomically, keeps previous AP keys for rollback, and never requires manual TCP token transfer. Do not supply passwords in command-line flags, examples or logs. `WIFI_FORGET` wipes more settings and is **not** a password-change operation.

## 4. Connect the phone

In **SME105 DCL Studio → Settings → Wi-Fi Bridge**, verify the configured SSID, enter the one WPA2 password and tap **Save Passphrase**, then **Connect**. If Android asks to connect to a local network without Internet, accept and stay on the ESP32 Wi-Fi. A connected phone should pass `AUTH`, `HELLO`, `PINS` and `STATUS`; the bridge should show safe idle. A network scan or LED flash alone is not ECU authentication evidence.

The current owner confirmed direct phone pairing and a separate bench-output LED demonstration while the car/ECU was disconnected. Long-duration network stability and vehicle acceptance require separately recorded procedures.

## 5. Read-only CLI and capture integrity

`ford-dcl` remains available for **offline analysis** and *authorized* USB capture. `--baudrate` selects host↔ESP USB speed, **not** the firmware's vehicle DCL baud rate. Never infer ECU compatibility from reference framing alone.

```bash
ford-dcl --help
ford-dcl frame "FF 5F 00 A0" --json
ford-dcl dtc 0x116 0x121 0x551 --source continuous_memory --json
```

For raw capture, use the matching documented firmware format and explicit operator evidence labels; preserve the returned session directory, timestamp, exact bytes and SHA-256. A safe vehicle test must be separately authorized and follow [wiring safety](wiring-safety.md) and [experiment plan](sme105-dcl-experiment-plan-2026-11-07.md). Do not connect arbitrary A/B polarity, use OBD pin 16 as power, or execute `ARM_*`/`READ_*`/DTC clear as a Wi-Fi smoke test.
