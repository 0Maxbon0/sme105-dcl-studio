# SME105 Wi-Fi recovery / USB maintenance — 2026-11-03

## Outcome

- Source commit: `a3820df` (`fix(escort): recover WiFi station, listener and mDNS after loss`).
- The v6 signed fan-out image remains unchanged and was **not** installed.
- Built and offline-verified **signed v7** application: size `833712`, SHA-256
  `48d85990460f4d416508f0bfc85b06f212385e11d121be7c2056656ed980a384`.
- Physically verified USB adapter CP2102, ESP32-D0WD-V3 and MAC
  `00:4b:12:3b:2b:f8`. The prior running and boot app was `app0`, OTA
  `accepted_version=5`, boot health `VALID`.
- Backups created outside Git with `0600`: NVS at `0x9000`/`0x5000`,
  otadata at `0xe000`/`0x2000`, and original `app0` at
  `0x10000`/`0x140000`. Backup directory:
  `~/.config/sme105/usb-pre-v7-20261103/`. Never publish its contents.
- Wrote **only** signed v7 application binary to active `app0` at
  `0x10000` via USB `esptool write_flash`, with no erase of NVS, otadata,
  bootloader or partition table. Esptool reported writing 833712 bytes and
  `Hash of data verified.`
- The device actually rebooted and reported `running=app0 boot=app0
  accepted_version=7 boot_health=VALID confirm_required=0 rollback=1`;
  `STATUS stage=0 DE=LOW auto_tx=0 fault=0`; `WIFI_STATUS CONNECTED ip=192.168.1.10`.
- After a further supervised USB hardware reset, authenticated TCP/8765
  successfully answered **read-only** `STATUS`, `OTA_STATUS`, `WIFI_STATUS`,
  `WIFI_DIAG` with the same v7 state. Listener and mDNS both reported active,
  RSSI approximately `-58 dBm` next to the laptop.

## Code repairs

- Separate Wi-Fi reconnect retry after 10 seconds and STA config reinitialization
  after 60 seconds continuous loss (no NVS erasure, no vehicle TX).
- Disable modem sleep for an always-on remote bridge; ensure adequate power.
- Correct Arduino-ESP32 `WiFiServer::begin()` void-return pitfall: verify the
  socket really listens, reclaim any leaked failed socket, and retry boundedly.
- Revoke TCP authentication and restart listener/mDNS on new IP assignment;
  retry failed mDNS registration independently.
- Read-only `WIFI_DIAG`: disconnect events/reason, IP generations, reconnect
  attempts, listener errors, mDNS and RSSI. No private Wi-Fi/token exposure.
- Separate USB-installed build version adoption from normal signed OTA
  PENDING_VERIFY / authenticated OTA_CONFIRM and anti-rollback ledger.

## Validation and limits

- Full offline unittest suite: **230 PASS**. Ruff: PASS. PlatformIO esp32dev
  build: SUCCESS. Fresh recovery host regression: PASS.
- Esptool's **write-time flash hash verification** completed. An additional
  independent read-back attempt over USB stalled near 31%; the read was
  interrupted with **no writes**, so full second-pass byte-for-byte comparison
  is **not claimed**. Successful subsequent ESP reboot and authenticated TCP
  read-only commands verified the installed v7 app.
- This demonstrates boot and service availability but **does not prove**
  recovery from real in-car Wi-Fi coverage loss. The cause in the car cannot be
  assigned without contemporaneous `WIFI_DIAG`, power integrity and RSSI data.
- No car ECU command, diagnostic read, `OBSERVE`, or actuation was sent during
  this repair/deployment. Device was off vehicle wiring for USB maintenance.
- Do not interpret CART RX bytes as verified ECU/DTC. Reconnect counters reset
  on ESP32 reboot and do not preserve the earlier loss reason.
- Power-off of laptop was separately requested by owner after successful USB
  flash and validation; actual shutdown success is not represented in this file.
