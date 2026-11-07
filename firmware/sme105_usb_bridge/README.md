# SME-105 Ford DCL: one-image interactive USB + Wi-Fi bridge (engineering candidate)

**Status: USB/Wi-Fi bench verified, TX2 local pad proof verified; NOT validated on this ECU or approved for live diagnostic use.**
This is a separate, permanent-format ESP32 firmware image. Once it has been
installed and independently checked, host software can operate it over one
115200-baud USB serial connection **or authenticated Wi-Fi TCP**, without
generating/flashing a new sketch for every protocol observation. **Neither
compiling nor a USB acknowledgement
proves a correct A/B bus signal or an ECU diagnostic response.**

The candidate diagnostic words are compared against the upstream sources
[flxkrmr/eec-iv-reader-arduino](https://github.com/flxkrmr/eec-iv-reader-arduino)
and [doncreat0r/eeciv](https://github.com/doncreat0r/eeciv). Neither repo
certifies this **97AB-12A650-KA** ECU or confirms our A4/0E variants.
This work is CART-only; not the DESK branch.

This image exists because actual car V5 data from GPIO17 decoded **6D CC,
29 E9, 6C 3C, 98 47** where the earlier software intended **01 B0,
FF 5F, 26 A4, 00 A0**. Four UART2 `TX_DONE` events alone did not prove a
correct GPIO17 TX pad. The new bridge independently routes the physical
GPIO17 pad to UART2 RX (the ESP32 input matrix) and reads its two-byte FIFO
at each TX completion. If the actual bytes differ from the source-pinned pair,
it latches `PAD_MISMATCH` and **never schedules another word** in that session.
This is a local pad witness, **not** independent A/B or ECU-ownership proof.

## Fixed interface and pins

- USB CDC/serial: **115200 8N1**, ASCII commands terminated by newline; raw
  decoded RO byte stream is ASCII hex records with monotonic MCU microseconds.
- ESP32 **GPIO16** ← MAX487 RO (through existing BSS138 translator) → UART1 RX.
- ESP32 **GPIO17** → MAX487 DI, via UART2 TX; same GPIO17 fed to UART2 RX
  input matrix for an independent decoded *local-pad* loopback.
- ESP32 **GPIO18** → MAX487 DE, with the installed external 10k pulldown;
  MAX487 `/RE` remains grounded. **No extra wires** or protocol pins.
- No automatic ECU transmission at boot, no arbitrary hexadecimal writes,
  and no generic output/actuator-control API. The allowlist includes explicitly
  armed DTC, self-test, live-data, memory and offline profiles; `CLR` is a
  state-changing DTC-clear request. The new DCL discovery probes are fixed,
  single-word read candidates and are not verified on the SME-105.

## Persistent Wi-Fi: normal station or optional direct WPA2 AP

In normal **STA mode** the ESP32 uses an existing 2.4 GHz router or hotspot.
In explicitly **USB-provisioned direct AP-only mode** (v8), it broadcasts
one private WPA2 network to the laptop's separate USB Wi-Fi adapter, with no
home-router dependency. It never creates an *open* hotspot. The STA SSID and WPA2
passphrase are saved to ESP32 Preferences/NVS (`sme105wifi` namespace), and
the bridge automatically attempts to reconnect after ordinary power cycles or
coverage loss. The v7 recovery logic keeps modem sleep disabled, retries STA
association at bounded 10-second intervals when offline, and reinitializes
the station from the existing NVS credentials after 60 seconds of continuous
outage (at most once every 60 seconds). It never erases NVS to reconnect.
After an IP renewal, it discards the old TCP authentication, restarts the
listener, and retries any failed TCP bind/listen at 3-second intervals. mDNS
registration retries independently every 10 seconds while connected. All of
these operations are suppressed during an active vehicle session. In STA
mode the router/hotspot must be running and the laptop or phone must be on
that LAN. In direct AP mode the laptop's separate USB Wi-Fi adapter connects
to the ESP32 instead. **No ECU command is sent at boot,
reconnect, authentication or power-on.** There is no need to flash different
images for USB versus Wi-Fi operations.

Do the following **only over the physical USB serial port at 115200 baud**:

```text
WIFI_STATUS
WIFI_TOKEN
WIFI_CONFIG <BASE64_SSID> <BASE64_WPA2_PASSWORD>
WIFI_STATUS
```

Use **standard padded Base64** on each field (encode the original SSID and
password separately in your host application; never type the plaintext as
the USB command). SSID: **1–32 bytes** (no control/NUL bytes). WPA2 password:
**8–63 printable ASCII bytes**, including spaces, but no control/NUL bytes.
Invalid input is rejected without changing the active session; credentials
are never echoed in any response. Base64 is *encoding, not encryption*; the
physical USB port is the provisioning security boundary.

Expected one-line responses:

```text
WIFI_CONFIG OK saved=1 reconnecting=1
WIFI_STATUS state=CONNECTING ip=0.0.0.0 port=8765 clients=0 host=sme105-bridge.local
WIFI_STATUS state=CONNECTED ip=192.168.1.42 port=8765 clients=0 host=sme105-bridge.local
WIFI_TOKEN <32-lowercase-hex-characters>
```

`WIFI_TOKEN` reveals the **128-bit random** authentication token **to USB
only**, never through TCP or the mirrored RAW output stream. The token is
generated with ESP32 hardware entropy and persists in NVS across power
cycles. Keep it secret and do not put it in log files. `WIFI_FORGET` (USB
only, idle) removes *both STA and AP* Wi-Fi credentials, stops Wi-Fi and rotates the
authentication token; it **does not reset** the once-per-boot diagnostic or
OBSERVE attempt counters. Use `WIFI_STATUS` to see the current IPv4 address;
`sme105-bridge.local` is an mDNS convenience name and may not resolve on all
phones/hotspots, so prefer the IP address when necessary.

`WIFI_DIAG` is a read-only USB or authenticated-TCP command that reports
`disconnects`, the numeric ESP-IDF `last_reason`, `got_ip`, `reconnects`,
`reinitializations`, `listener_failures`, `listener_restarts`, `listener`,
`mdns`, `offline_ms`, and `rssi` (dBm while connected, 0 when offline). These
counters reset at power-up and do **not** reveal credentials or tokens. A
disconnect reason helps distinguish router/auth/beacon failures, but cannot
alone establish weak RF, a brownout, or wiring defects. A connected client
can request it after returning to coverage. A 5–10m distance and one wall do
not guarantee a reliable 2.4GHz link: power stability, antenna placement,
router isolation, channel interference and the actual RSSI still matter.
On v9 it additionally reports `mode=STA/AP`, `ap_clients` and `ap_stops`.
In AP mode `rssi=0` indicates no STA RSSI measurement, **not 0 dBm**.

### Dedicated direct link: ESP32 AP to RT5370 USB adapter

The owner has one internal laptop Wi-Fi interface `wlp9s0` for `Venom`
internet and an independent USB RT5370 (`wlx1cbfce64dd94`) for the
ESP32. **The ESP32 acts as AP; the laptop USB adapter as client.** AP-only
is chosen because distant-home STA reconnection must not interrupt a live
in-car field capture.

- ESP32 WPA2 SSID: `SME105-DIRECT-2BF8`. Private 32-character random
  passphrase is generated and saved under
  `~/.config/sme105/direct-ap-pass` (owner-only mode 0600), **not in Git**.
- Fixed ESP32 IP: **10.77.13.1/24**, authenticated TCP **8765**, one
  associated client. Laptop USB static IP: **10.77.13.2/24**.
- No default gateway, DNS or internet on the USB Wi-Fi profile. Internet stays
  on the internal `wlp9s0` / `Venom` interface. This avoids the many
  host Docker bridges in `192.168.x` ranges.
- AP mode and WPA2 secret are saved in NVS and restart after power loss;
  no phone/router is needed. The previous STA SSID/password stay saved for
  reversal by USB command `WIFI_STA_MODE`.
- On unexpected AP stop the firmware revokes TCP authority and retries AP
  startup after 10s when no vehicle session is in progress. AP status is
  available over physical USB or authenticated TCP:
  `WIFI_AP_STATUS mode=AP state=ACTIVE ip=10.77.13.1 stations=1 channel=6 port=8765 wpa2=1`.

After supervised **application-only v9 flashing** on an isolated desk and
positive USB STATUS/OTA_STATUS validation, the provisioning helper does the
USB-only PSK setup and laptop's NetworkManager profile automatically:

```bash
./.venv/bin/python scripts/sme105_direct_ap_setup.py
```

It verifies exact device identity, safe IDLE/DE status and GPIO topology,
generates a random PSK, sends `WIFI_AP_CONFIG <SSID_BASE64> <PSK_BASE64>`
only on USB, waits for AP ACTIVE, creates a USB-interface-specific
NetworkManager connection and supplies the PSK through the restricted system
Python D-Bus helper `scripts/sme105_nm_usb_secret.py`, without putting it in
process arguments. The helper requires `python3-dbus` and an existing valid
private TCP authorization token `~/.config/sme105/bridge-token`. It verifies
that `ip route get 10.77.13.1` selects the USB adapter
and `ip route get 1.1.1.1` still selects the internal `wlp9s0` internet.

When using the bridge remotely:

```bash
PYTHONPATH=src ./.venv/bin/python scripts/sme105_usb_bridge.py --host 10.77.13.1 --command STATUS
```

**Never use the host CLI's `--command HELLO` to check connectivity**: that
host alias maps to *active OBSERVE* (vehicle Echo-ID/Go-CART transmit).
Authentication still uses the same previously provisioned TCP token. AP
enabling, Wi-Fi reconnection, authentication and host network setup do not
send any ECU commands. This desk result does not prove vehicle power/RF range.

### Authenticated TCP console (PC or smartphone)

Use a TCP terminal/client on the *same trusted WLAN*, connect to port
**8765** at the IP from `WIFI_STATUS` (or `sme105-bridge.local` if mDNS works),
and send the exact first line:

```text
AUTH <32-hex-token>
```

Within 5 seconds, before any command or RAW output, the firmware requires a
matching token and replies **exactly `AUTH OK\n` (LF)**. Invalid/expired
authentication and oversized lines disconnect without revealing device
state. Only **one** TCP client may be connected at a time. The authorized
client then uses the same command names `HELLO`, `STATUS`, `PINS`, `STOP`,
`LISTEN_9600`, `OBSERVE`, `ARM_A4`/`READ_A4`, `ARM_0E`/`READ_0E`, and
`RESET_IDLE`; they do not require another firmware flash. USB remains active,
and each `RX t_us=<decimal> byte=<HH>` record, `TX_PAD`, `FAULT`, and `END`
is queued for USB and authenticated TCP. While TCP is authenticated, it is
the **mandatory evidence receiver**; USB is an optional best-effort mirror.
An unplugged or unmonitored USB Serial port must not terminate a Wi-Fi-only
CART capture. If that optional mirror falls more than the queue capacity
behind, stale USB bytes are discarded with a monotonically counted
`usb_skipped` field in `STATUS` (also shown in `OTA_DIAG`). USB-only sessions
still require USB delivery and fail closed on bounded output backpressure.

`WIFI_CONFIG`, `WIFI_AP_CONFIG`, `WIFI_STA_MODE`, `WIFI_AP_MODE`,
`WIFI_TOKEN` and `WIFI_FORGET` **cannot** be invoked from
Wi-Fi, even after authentication. A pending `ARM_A4` or `ARM_0E` can only be
used for `READ_*` by **the same originating transport** (USB-to-USB or
authenticated-TCP-to-that-TCP). Wi-Fi disconnection revokes pending Wi-Fi
arms. `STOP` is always allowed from either authenticated channel and clears
pending arms. The active diagnostic and OBSERVE limits still apply globally
across both transport types. A disconnected TCP controller during a live
session causes immediate safe STOP and prevents any new controller from
taking over until that session finishes.

**Transport safety:** The TCP socket uses nonblocking sends; it cannot wait
for a slow peer in an ESP32 CART timing loop. The output subscribers have
independent cursors and a finite 16 KiB fan-out queue. On an active session
with **primary transport** backpressure, overflow, client disconnect, or TCP
send failure, the bridge stops the ECU transmission path. USB stays primary
when there is no authenticated TCP connection. A disconnected TCP client may
not receive `END`; that absence makes its evidence incomplete, not successful.
Check the full RX count against `END ro_bytes` and require `ro_lost=0`,
`uart_errors=0`; `STATUS` also exposes `transport_lost`, `out_overflow` and
`usb_skipped`. No UART/TCP output is performed by the protected CART ISRs.

**Security boundary:** TCP is deliberately *not* TLS-encrypted; use only a
trusted WPA2/WPA3 local Wi-Fi network. Do not expose/forward port 8765 to the
Internet or share the token. WPA encryption protects the wireless hop, not
other untrusted devices already on the LAN. NVS credentials are not
hardware-encrypted unless ESP32 flash encryption/NVS encryption is
separately enabled. The token prevents unauthenticated commands but does not
prove physical ECU safety, authorization for unsafe B requests, or a DTC.

## Signed OTA firmware updates without returning to USB

The bridge supports an **authenticated and publisher-signed OTA update** via
the existing Wi-Fi TCP port **8765**. The active firmware partition is never
overwritten. ESP32's existing 4 MB `default.csv` partition table already has
two application slots (`app0`/`app1`), each **1,310,720 bytes**, plus separate
NVS at offset `0x9000` and OTA metadata at `0xe000`. No new partition table
is needed; changing the table could erase credentials or prevent rollback.
Only upload the **PlatformIO application `firmware.bin`**, not a merged flash,
bootloader, or partition image. The first USB firmware upload is owned by the
Prime operator; all subsequent signed *application* updates can use Wi-Fi.

**Supervised USB maintenance from a previously OTA-updated device:** the
operator must first verify the real running partition, its `VALID` OTA state,
chip identity and hardware disconnection from the ECU, and back up NVS and
otadata privately. With boot running `app0` at `0x10000`, write *only* the
application image at that address; do not run the normal PlatformIO combined
USB uploader, which may rewrite OTA metadata, partition table and bootloader.
For this v7 build, a boot already marked `VALID`, with no pending signed OTA
ledger, durably adopts baseline version 7 in NVS after a physical USB flash.
Signed OTA `PENDING_VERIFY` still uses the old accepted version and the
original signed ledger, so it cannot bypass `OTA_CONFIRM` or rollback checks.
This is **not** Secure Boot: physical flash access remains privileged and can
replace code. A direct USB flash does not receive normal signed OTA automatic
first-boot rollback and must be verified independently before use in a car.

### Publisher key and signature contract

The ESP32 contains only the **P-256 ECDSA public key** pinned in the sketch.
Its DER SubjectPublicKeyInfo SHA-256 fingerprint is:

```text
4f3bb05f5a94fe931bce67f91057ab17e3d5ea4734dc066a722f47c27e682e79
```

The owner controls the separate signing **private key outside the Git repo**.
Do not copy the private key into firmware, Git, chats, CI logs, network
messages or captures. The device verifies each signed manifest **before
calling `esp_ota_begin`**, then independently hashes every binary byte and
rejects an image whose SHA-256 or ESP32 image validation fails. The public
key alone cannot produce a valid update. A publisher-key rotation requires
a new version signed by the previously trusted key.

After the normal authenticated TCP exchange (`AUTH <32hex>` → exact
`AUTH OK\n`), the **flow-controlled OTA_BEGIN2** updater sends this
**single ASCII line**, terminated by LF:

```text
OTA_BEGIN2 <size_decimal> <64_lowercase_sha256hex> <version_decimal> <ECDSA_P256_DER_signature_base64>
```

The signature is ECDSA P-256 with SHA-256 over the *exact* UTF-8 bytes:

```text
SME105-OTA-V1
esp32dev
<size_decimal>
<64_lowercase_sha256hex>
<version_decimal>
```

Each displayed line ends in **one LF byte** (including the final version
line). There are **no blank lines or spaces** around substituted values.
Decimal size/version have no leading zeroes. Versions are
strictly increasing (the first signed upgrade from the USB-installed base
version `1` must be `2` or greater). The firmware image size must be from
65,536 up to **1,310,720 bytes**, inclusive. The signature is an ASN.1 DER
ECDSA signature, encoded as standard padded Base64 without wrapping.

For example, an owner's **offline** signing process can produce the DER
signature using OpenSSL (the content of `manifest.txt` must follow the exact
five-line format above):

```sh
openssl dgst -sha256 \
  -sign "$HOME/.config/sme105/ota-signing-key.pem" \
  -out signature.der manifest.txt
base64 -w0 signature.der
```

The host uploader should calculate size/hash itself, construct that canonical
manifest, sign it using the private key only on the trusted signing machine,
and never print the key. This is a signing example, **not** a recommendation
to transmit the firmware manually through a text terminal.

### Binary transfer and result checks

1. Authenticate as normal on TCP port 8765 and request `OTA_STATUS`.
2. Send the validated signed `OTA_BEGIN2` line. The ESP32 replies
   `OTA_READY size=<decimal> chunk=8192\r\n` **only after signature and inactive-slot
   admission have succeeded**. Invalid signatures/bounds get
   `OTA_FAIL reason=<generic>\r\n` without changing the running image.
3. **Only after receiving `OTA_READY`**, send up to **8,192 raw bytes** of
   `firmware.bin`. The device writes bounded 512-byte portions and replies
   `OTA_PROGRESS received=<cumulative_count>\r\n` after each **non-final**
   window has passed `esp_ota_write` and incremental SHA-256. The host checks
   that exact monotonic offset before sending the next window. The final
   window receives only `OTA_OK`. No Base64, delimiters, separators or final
   newline are added to the binary. A 15-second device idle timeout or
   five-minute total limit, TCP disconnect, Wi-Fi loss, invalid digest or
   malformed image aborts without switching the boot partition. The obsolete
   `OTA_BEGIN` sender is rejected before flash; never silently downgrade the
   OTA transfer protocol or replay uncertain bytes.
4. On fully verified image, receive
   `OTA_OK version=<decimal> sha256=<64lowerhex> rebooting=1\r\n`.
   The device stages the inactive partition as the next boot and reboots;
   missing `OTA_OK` is **not** proof of success. The device gives the final
   TCP response a short bounded drain/grace period before restarting. If the
   complete signed image was sent but its final receipt disappeared, the host
   **never resends the image**: it may recover only by independently
   authenticating a new-boot `PENDING_VERIFY` state on a different app slot,
   then issuing the previously approved `OTA_CONFIRM` exactly once. Any
   inconsistent or unconfirmed state is a failure, not implicit success.
5. After reboot, reconnect and authenticate on TCP port 8765 (using the
   **existing NVS token**) and ask `OTA_STATUS`. The new app is deliberately
   `boot_health=PENDING_VERIFY`, `confirm_required=1` until remote access is
   demonstrated. Send the **same signed manifest version and binary SHA**:

   ```text
   OTA_CONFIRM <version_decimal> <64_lowercase_sha256hex>
   ```

   It must reply `OTA_CONFIRM OK version=<n>\r\n`. This proves that the new
   app's authenticated remote interface works and that the client knows the
   exact image admitted by the previous firmware. `OTA_CONFIRM` is accepted
   **only on authenticated TCP**, never over USB. The host must not re-upload
   the image automatically just because the device rebooted.
6. Wait for the eight-second first-boot health interval and poll `OTA_STATUS`
   again. A healthy upgrade should show `running=app0` or `running=app1`,
   `boot_health=VALID`, `confirm_required=0`, `rollback=1`, and
   `accepted_version` equal to the signed version. It also emits
   `OTA_BOOT state=VALID version=<n>`. If the authenticating client cannot
   reconnect and confirm **within 45 seconds**, the new image rolls back.

An `OTA_STATUS` example (read-only over authenticated TCP **or USB**):

```text
OTA_STATUS state=IDLE received=0 size=0 running=app1 boot=app1 accepted_version=2 boot_health=VALID confirm_required=0 rollback=1
```

After an unsuccessful transfer, authenticated TCP may request read-only
`OTA_DIAG`: it reports accepted flash byte offset, write count/longest write,
last failure, reset reason and bounded RTC progress without exposing
SSID/password, bearer token, signing key or firmware content. The USB-only
`OTA_DEBUG` uses physical serial and never injects diagnostic lines into the
OTA TCP protocol. Neither command initiates an ECU request or firmware update.

Recommended laptop workflow after building the exact application image:

```bash
PYTHONPATH=src ./.venv/bin/python scripts/sme105_wifi_ota.py \
  --firmware firmware/sme105_usb_bridge/.pio/build/esp32dev/firmware.bin \
  --manifest "$HOME/.config/sme105/next-firmware.json" \
  --sign-manifest --version 6

PYTHONPATH=src ./.venv/bin/python scripts/sme105_wifi_ota.py \
  --firmware firmware/sme105_usb_bridge/.pio/build/esp32dev/firmware.bin \
  --manifest "$HOME/.config/sme105/next-firmware.json" \
  --host 192.168.1.10 --upload

PYTHONPATH=src ./.venv/bin/python scripts/sme105_wifi_ota.py \
  --firmware firmware/sme105_usb_bridge/.pio/build/esp32dev/firmware.bin \
  --manifest "$HOME/.config/sme105/next-firmware.json" \
  --host 192.168.1.10 --check-installed
```

The version/path are examples (the latest live hardware validation accepted
version **5**): use a **strictly higher version** than the device's accepted
version and a fresh manifest path, since signing refuses overwrite. DHCP
may change the example IP. Keep the P-256 private signing
key offline with a secure backup; it is never embedded in the ESP32.

**OTA admission is fail-closed:** the bridge rejects OTA on USB, without
`AUTH`, during any ECU session, with an ARM pending, during a previous OTA,
or while a new image awaits boot-health verification. During OTA, no
`OBSERVE`, `READ`, `LISTEN`, or other vehicle-affecting command can start.
`STOP` may abort an *in-progress* OTA receive, preserving the old partition.
The existing `GPIO18 DE` fail-safe and original CART timing/interrupt code
are not changed by this OTA transport.

**Automatic first-boot rollback:** Arduino ESP32's default behavior would
otherwise mark an OTA image valid *before* `setup()`. This sketch overrides
`verifyRollbackLater()` to defer the ESP-IDF bootloader's validation until
after a real app health check. The first boot requires working low-DE
hardware initialization, valid Wi-Fi credentials/token, a reachable WLAN,
a successfully started TCP listener, and the **authenticated `OTA_CONFIRM`
proof delivered through that listener**. It waits at least eight seconds.
If health cannot be established within 45 seconds, the app requests
`esp_ota_mark_app_invalid_rollback_and_reboot()`. A crash/reset before
confirmation causes the rollback-enabled bootloader to reject the unverified
image on the following boot. The accepted anti-rollback version in NVS is
advanced only after successful new-app health checks, not merely when the
image download completes. NVS Wi-Fi credentials are left intact.

**Limits of rollback:** it requires the *previous* application slot and OTA
metadata to remain valid. It cannot recover from a broken bootloader,
destructive partition rewrite, damaged flash or physical compromise. The
OTA protocol protects **publisher authenticity and image integrity**, not
network confidentiality (TCP is not TLS). A device on an untrusted LAN
could intercept the session token; use a trusted local WPA2/WPA3 network,
never expose TCP port 8765 directly to the Internet, and keep the signing
private key offline.

### Explicit host commands

| Command | Effect |
| --- | --- |
| `HELLO` | Read-only identity and protocol version. |
| `STATUS` | Read-only state, DE status, consumed read and OBSERVE latches, optional arm, fault. |
| `PINS` | Read-only GPIO assignment. |
| `HELP` | Print exact command allowlist. |
| `TX2_BENCH` | **Required once after every reboot before any `READ_*`**. Runs two 2400 reference frames and four 9600 UART2 words, checking all GPIO17 UART2 RX bytes and independent input-only RMT first word. GPIO18 DE stays LOW; no ECU request. `PASS_LOCAL_PAD` does **not** prove MAX487 A/B or ECU acceptance. Explicitly available over authenticated TCP or USB. |
| `LISTEN_9600` | **No bus TX**: 10s UART1 RO capture at 9600 8N1, no 2400 handshake. Needs an already present CART stream. |
| `OBSERVE` | **Active 2400 handshake** (fixed Echo ID + Go CART only), then 10s raw 9600 RO capture. **At most once per ESP32 boot**; not a passive bus operation. |
| `ARM_A4` | Prepare one *candidate* stored-code sequence, no bus TX; expires after 15s. |
| `READ_A4` | Only following a valid A4 arm: fixed four-word candidate `01B0 FF5F 26A4 00A0` in ID0..3 synchronized slots, at most once/boot. |
| `ARM_0E` | Prepare alternate *candidate* with `26 0E` as the third word, no bus TX; expires in 15s. |
| `READ_0E` | Only following 0E arm: candidate `01B0 FF5F 260E 00A0`. |
| `ARM_ECU_STATUS` / `READ_ECU_STATUS` | Fixed single-shot candidate `01B0 FF5F 0381 00A0`; captures raw RO bytes for 10s. |
| `ARM_PIDMAP` / `READ_PIDMAP` | Fixed single-shot candidate `01B0 FF5F 005E 00A0`; captures raw RO bytes for 10s. Published literal has parity discrepancy (formula gives `004E`). |
| `ARM_DMRMAP` / `READ_DMRMAP` | Fixed single-shot candidate `01B0 FF5F 242E 00A0`; captures raw RO bytes for 10s. |
| `ARM_DMR` / `READ_DMR` | Fixed single-shot candidate `01B0 FF5F 22C6 00A0`; captures raw RO bytes for 10s. |
| `ARM_BOTH` / `READ_BOTH` | Fixed single-shot candidate `01B0 FF5F 271E 00A0`; captures raw RO bytes for 10s. |
| `READ_KOEO` / `READ_KOER` | Existing explicitly confirmed `25 3E` self-test profiles; they are not passive reads. |
| `READ_CLR` | Existing explicitly confirmed `02 91` DTC-clear profile; sends the command word once, then captures. This changes ECU diagnostic state. |
| `READ_LIVE*` / `READ_ALL` | Existing live profiles; use `41 96` to load the PID map and `21 F6` for PID values. |
| `READ_MEM` | Existing experimental memory-read profile (`42 F3` / `22 D3`); target map remains unverified. |
| `READ_OFF` | Existing go-offline profile (`80 CE` with `7F 20` qualifier). |
| `STOP` | Asserts local DE LOW and cancels current TX/timers; always recognized. |
| `RESET_IDLE` | Clears a finished idle session's fault/arm status; **never** re-arms a consumed diagnostic or OBSERVE attempt. |

Active-master electrical qualification gate (`kActiveMasterQualified = true`, v25 field build):
Vehicle transmissions are enabled only after the exact 4/4 local `TX2_BENCH` passes in
the current boot. Each `READ_*` still requires a matching `ARM_*` within 15 seconds.
`OBSERVE` requires the same successful local bench and remains limited to one attempt
per boot. `PASS_LOCAL_PAD` proves the local pad path only; it does not prove MAX487 A/B
or ECU acceptance.

Each `READ_*` is explicitly armed and sends only its named fixed profile; there
is no arbitrary-byte path, opcode sweep, automatic retry or A4/0E fallback.
The new discovery profiles send one command word and then listen; they do not
load a map or start a repeating PID stream. A clean/allowed `END` can release
the read latch for a later separately armed request. Pad, phase, DE, overflow
and RX-silence faults remain latched until reboot. `RESET_IDLE` never clears a
consumed request. `OBSERVE` has a separate latch and is rejected after its
single active 2400 handshake attempt until reboot. `LISTEN_9600` is repeatable
because it never transmits. In-car handshake and each diagnostic operation
must be separately authorized by the operator.

The DCL discovery command bytes come from an experimental third-party EEC-IV
command map, not a Ford service specification and not an SME-105 compatibility
claim. `READ_ECU_STATUS`, `READ_PIDMAP`, `READ_DMRMAP`, `READ_DMR` (`22C6`), and
`READ_BOTH` (`271E`) are fixed, single-shot **candidates** for raw capture. The
DMR and combined responses are not semantically decoded. A clean bridge
capture proves only local capture/pad integrity; raw RO bytes may include local
self-echo and are not automatically attributed to the ECU. See
`docs/SME105-DCL-command-discovery-2026-11-07.md` for provenance and deferred
state-changing commands. The alternative `01 A1`, `01 F4`, `81 74`, `42 A6`, `41 1E`, `25 94`,
and parity-derived `00 4E` candidates are listed in HELP as deferred and return
`DENIED command_deferred_not_sendable`; they are not transmitted. The external
PID-map source literal `00 5E` differs from the generic local parity result
`00 4E`; firmware preserves `00 5E` as the source candidate, and pad evidence
proves emission only, not ECU acceptance.

To qualify **only the local TX2 pad** from the office without a USB serial
connection, use the explicit authenticated command from the laptop:

```bash
PYTHONPATH=src ./.venv/bin/python scripts/sme105_usb_bridge.py \
  --host 192.168.1.10 --command TX2_BENCH
```

The host demands two complete reference frames, four ordered UART2 pad
readbacks (`01B0 FF5F 26A4 00A0`), independent GPIO17 RMT input waveform
decoding `01B0`, `DE=LOW` throughout, exact `TX2_BENCH_END PASS_LOCAL_PAD`
and a fresh `STATUS` confirming `tx2_bench_used=1 tx2_bench_pass=1`.
Malformed, missing, duplicated or contradictory evidence is rejected; the
host never automatically retries or sends `OBSERVE`, `ARM_*` or `READ_*`.
This is not a MAX487 A/B differential measurement or ECU/DTC validation.

### Wire text protocol (the host must save this stream)

Example responses (numeric values below are *examples*):

```text
BOOT SME105_USB_BRIDGE_V1 no_auto_tx=1 DE=LOW source_commands_unverified=1
HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1
STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 pad_rx=0 read_used=0 observe_used=0 armed=NONE fault=0
PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1
EVENT read_armed variant=A4 valid_ms=15000 no_tx_yet=1
EVENT session=READ_CANDIDATE
EVENT h2400_tx=ECHO_ID bytes=11 candidate=1
H2400 t_ms=5000 byte=00
EVENT ack=candidate_11_echo_plus_01 source=UNVERIFIED
EVENT h2400_tx=GO_CART bytes=11 candidate=1
EVENT cart=9600_8N1 raw_ro=1 ecu_verified=0 dtc_verified=0
RX t_us=5100000 byte=00
RX t_us=5101042 byte=00
TX_PAD slot=0 expected=01B0 observed=6DCC tx_us=... done_us=... match=0
FAULT reason=11
END reason=11 ro_bytes=... ro_lost=0 uart_errors=0 pad_verified=0 words_started=1 ecu_verified=0 dtc_verified=0 DE=LOW
```

`STATUS` stage integers: 0 idle, 1 quiet preflight, 2 Echo ID TX, 3 ACK wait,
4 Go CART TX, 5 CART passive, 6 CART candidate, 7 draining/finishing,
8 fail latched. `DE=ACTIVE_GUARDED` may appear while actually transmitting;
there must never be a false `DE=LOW` during an active handshake or slot.
`pad_rx=0` **while idle** just means the native 9600 GPIO17 readback path
is not currently open; it is not an assertion that the GPIO is missing.

`RX` contains every byte decoded by UART1 RO, including potential *local
self-echo*. It is deliberately not attributed to ECU or DTC. The host should
persist the entire byte-oriented transcript, extract the `byte=HH` fields in
order into a binary `.bin` file, and compare the number of RX records with
`END ro_bytes`. It must reject a complete-evidence claim if `ro_lost` or
`uart_errors` is nonzero, if `END` is absent, or if the USB transcript is
truncated. Timestamps are ISR observation timestamps, not independent
physical edge timestamps. Hex is uppercase and zero-padded.

The `TX_PAD` record reports source-pinned expected bytes and actual native
UART2 RX bytes decoded from GPIO17, before granting the next timed source
word. Its `match=1` means the PAD **only** matches the commanded bytes. It is
not an ECU acknowledgement, DTC, A/B differential test, or authorization to
continue beyond the fixed four words. A mismatch stops further transmission.

## Hardware time bounds and fail-closed behavior

1. Handshake `ECHO_ID` / `GO_CART` are exact 11-byte frames at **2400 8N2**,
   with no arbitrary host payload. Each 11-byte UART burst lasts ~50.4ms.
   RMT **channel 6** drives an **autonomous 52ms maximum DE-high gate**,
   independently of USB task/CPU progress. A separate TIMERG0 watchdog
   enforces a 75ms maximum recovery deadline if the UART stalls.
2. After exact **11 local echo bytes + `01` candidate** are received within
   400ms, the bridge switches to native 9600 8N1. This handshake evidence
   does not independently establish whether the ECU accepted the request.
3. For diagnostic mode, UART1 validates **16 consecutive ID0..15** headers,
   including status/parity byte, intra-header serial timing, phase and
   10ms cadence, before scheduling any command. Slots use the source-pinned
   sync+2917µs target, the **4+24 serial-bit** reference timing.
4. RMT channels **2–5** independently bound each two-byte diagnostic word's
   DE assertion to **2180µs HIGH + 80µs LOW**. TIMERG0 additionally cuts
   off at **2250µs**. UART2 must have correct TX_DONE time and **exact two
   correct UART2 RX pad bytes** before the next word may be scheduled.
5. Any invalid frame, missing expected echo, RX loss, UART error, wrong
   GPIO17 bytes, timeout, serial cancellation, or unexpectedly late slot
   prevents subsequent TX. The full retained raw RO byte sequence is still
   drained to the host as feasible and marks incomplete evidence.
6. `STOP` deasserts DE and masks future TX interrupts. `RESET_IDLE` cannot
   erase the diagnostic-consumed latch. No mode sends automatically at boot.

**Limitations:** The A/B differential line is not measured here; the local
GPIO17 loopback does not independently prove MAX487 driver integrity,
termination, bus contention or ECU response. An RMT output gate limits DE
pulse width but cannot establish exactly when the ECU considers a timed slot
valid. The source scanners disagree over the third word, and their DTC
interpretation has not been verified for 97AB-12A650-KA. There is no
production-safe DTC decoder, no "DTC read success" claim, and no production
authority to clear codes or actuate outputs.

## v21 continuous live data

`ARM_ALL` / `READ_ALL` load one 45-word PID map (IW2..IW4, frames 1..15),
containing 39 unique requested channels. Mode 41 loads the map, mode 21
repeats it. Frame length remains 6, designed at 22.5 ms/frame and 360 ms/block.
Each additional map word retains its own RMT DE gate, pad readback and watchdog;
the complete 45/45 map must be verified before leaving the loading block.
Actual support and refresh timing have not been measured on the owner's ECU.

ALL uses lossless packed output to fit the 115200-baud USB budget:

```text
RXB t_us=100000 data=00F8A5 dt=0,1042,2500
```

`data` is 1..16 raw bytes; `dt` contains their original MCU timestamp offsets
from `t_us`. Sum modulo 2^32 to reconstruct each original timestamp. Legacy
single-set captures keep their ordinary RX format. STATUS advertises
`live_all=1 rx_batch=1 fw=21`. The browser and Python recorder/decoder support
both formats. Evidence is never discarded to improve throughput.

All live modes stop after three hours, five seconds of ECU silence, transport
loss, or existing pad/timing/overflow faults. Queues stay fixed-size; no trip is
stored in ESP32 RAM/flash. Wire timestamps wrap every ~71.6 minutes; host
decoders unwrap consecutive timestamps. A longer duration is not a hardware
or vehicle safety certification. BLE is retained; no Wi-Fi migration is made.

## Compile only — no flash or hardware operation

From the repository root:

```sh
./.venv/bin/python -m platformio run -d firmware/sme105_usb_bridge
```

This **only** builds a `.bin` firmware image. The bridge is an engineering
candidate: build success is not car safety validation. Do not upload to
hardware or transmit to the vehicle without the owner's separate explicit
authorization and an electrical validation plan. The old one-shot firmware
and all existing captures remain unmodified by this directory.
