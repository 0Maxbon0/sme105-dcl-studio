# SME105 Direct Wi-Fi Bridge — One-Passphrase Setup (v1.8.17 / ESP32 v29)

**9 November 2026 bench update:** the owner confirmed that the phone joined
the ESP32's own hotspot directly and that isolated output indicator LEDs lit
when test signals were sent **with the vehicle ECU disconnected**. This is an
accepted owner-observed **bridge bench integration** result, not a validated
ECU response, real actuator command or independent long-duration Wi-Fi soak
test. The application and firmware versions were verified after deployment.
See the [dated acceptance notes](releases/2026-11-09-direct-softap-bench.md).

## Connection and security

For a 1998 Ford Escort SME105 EEC-IV with an ESP32+MAX487 bridge, use the
ESP32's own **WPA2 SoftAP**. **No router or Internet is required.** The current
hardware's existing SSID is `SME105-DIRECT-2BF8`; the bridge listens at
`10.77.13.1:8765` on Wi-Fi channel 6, with one Wi-Fi client permitted.
A different device may have a different SSID; its exact network name must
be entered in Android Settings rather than guessed.

The owner enters **one WPA2 password** in the Android app (8–63 printable ASCII
characters), saves it, and selects Connect. The password is encrypted in Android
Keystore-backed app-private storage, not saved in the web app's localStorage.
`WifiNetworkSpecifier` asks Android to connect to the selected local network.
Android may show a native permission/connection confirmation and a warning that
this local Wi-Fi network has no Internet access.

The TCP protocol **still requires `AUTH` before any bridge command**. Firmware
and the native Android plugin derive its 16-byte value separately from that one
WPA2 password and the exact SSID, using PBKDF2-HMAC-SHA256 with 10,000 rounds,
16-byte output, and UTF-8 salt `SME105-DCL-AUTH-V1:` followed by the SSID. The
16 bytes are represented as 32 lowercase hexadecimal characters in the existing
`AUTH` request; a peer must receive exact `AUTH OK`. **There is no second token
to type, transfer, or save for direct SoftAP.** This is one shared secret, not
two independent authentication factors: anyone who knows the Wi-Fi password
could potentially reach authenticated diagnostic controls. Keep it private and
change it if disclosed. ECU command arming and safety gates remain separate.

The legacy router/STA firmware commands, random NVS `token`, and BLE-only build
remain available for maintenance/compatibility. They are **not part of the
normal direct Android workflow**. Never flash `esp32dev_ble` to use Wi-Fi.

## First-time setup and password rotation: physical USB only

The operator must have safe access to the ESP32's own USB serial port and verify
`STATUS` shows `stage=0`, `DE=LOW`, `auto_tx=0`, `fault=0` before provisioning.
Use a bench setup disconnected from the vehicle bus for acceptance. Never
pass a password on the process command line or in a Git-tracked file.

Build Wi-Fi firmware **v29** with:

```bash
./.venv/bin/pio run -d firmware/sme105_usb_bridge -e esp32dev
```

When first configuring an ESP32 with no SoftAP saved:

```bash
python scripts/sme105_wifi_setup.py --ap --ap-ssid SME105_DCL
```

When updating an ESP32 that already has an AP (including the current vehicle):

```bash
python scripts/sme105_wifi_setup.py --ap --ap-rekey \
  --port /dev/serial/by-id/usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0
```

The utility prompts privately for the **same one Wi-Fi password** to use in
Android. `--ap-rekey` is explicit: a plain `--ap` run must **never silently
change** an existing AP password or claim to have changed it. `--ap-rekey`
preserves the *existing* SSID (the `--ap-ssid` argument is only for first-time
configuration). The USB-only `WIFI_AP_REKEY <base64_password>` command checks
for a safe, idle bridge; validates the input; writes one versioned NVS
`ap_bundle` containing the complete profile; verifies it; then restarts only
the SoftAP. The existing `ap_ssid`, `ap_pass`, `token`, and OTA data are **not
overwritten**; the previously flashed v28 image can still use the legacy AP
profile if a physical rollback becomes necessary. On an invalid modern bundle,
v29 fails closed rather than silently using the legacy AP.

Use neither `WIFI_FORGET` nor an NVS erase to change the direct-AP password:
`WIFI_FORGET` removes more data and rotates the legacy token. Preserve a private
NVS snapshot before password migration and retain the old firmware binary for
rollback. A successful NVS write is not yet proof of a working Android link.

## Android v1.8.17

1. Install the updated signed APK using `adb install -r` (do **not** uninstall,
   clear app data, or wipe IndexedDB and historical RAW captures).
2. Open **SME105 DCL Studio → Settings → Wi-Fi Bridge**. The default connection
   is direct ESP32 Wi-Fi; leave IP `10.77.13.1` and port `8765` unchanged.
3. Set the actual bridge SSID (`SME105-DIRECT-2BF8` on the current device).
   Enter the same single password supplied over USB; tap **Save Passphrase**.
4. Select **Connect** and approve the Android system's local-network request
   when shown. There is no token field, token transfer, or router step.
5. Wait for both the WPA2 association and authenticated TCP handshake.
   Only `HELLO`, `PINS`, and `STATUS` should be used in a connection smoke test.

**Acceptance evidence**: read-only USB `WIFI_AP_STATUS` must show
`mode=AP state=ACTIVE ip=10.77.13.1 stations=1 ... wpa2=1`, and the app must
show an authenticated, identity-checked connection. Check a deliberate failed
password/session does **not** authorize a command. Test link-loss/rejoin without
replaying writes. Android joining Wi-Fi without authenticated TCP is **not** a
full pass.

## Vehicle and rollback boundaries

Do **not** initiate KOEO, KOER, CART, DTC clear, idle/actuator commands, or other
vehicle output just to test the new Wi-Fi link. Hardware acceptance here only
proves network and bridge identity, **not** ECU command compatibility or
vehicle safety. Keep stage `0`, `DE=LOW`, and `auto_tx=0` during this phase.

For a supervised rollback, use the saved v28 `app0` firmware image and previous
signed Android APK, restoring via USB/app replace only. The legacy AP keys are
left intact deliberately. Do not blindly restore a whole NVS image, erase NVS,
rotate OTA state, or delete Android application data.
