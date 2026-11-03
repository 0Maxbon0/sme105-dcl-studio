# SME-105 Ford DCL: one-image interactive USB + Wi-Fi bridge (engineering candidate)

**Status: compiled source, NOT validated on this ECU or approved for live diagnostic use.**
This is a separate, permanent-format ESP32 firmware image. Once it has been
installed and independently checked, host software can operate it over one
115200-baud USB serial connection **or authenticated Wi-Fi TCP**, without
generating/flashing a new sketch for every protocol observation. **Neither
compiling nor a USB acknowledgement
proves a correct A/B bus signal or an ECU diagnostic response.**

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
  no error clearing, self-test, actuator control or unsupported opcodes.

## Persistent Wi-Fi STA: provision over USB once, use Wi-Fi after every reboot

The ESP32 uses **2.4 GHz Wi-Fi STA only** (your existing home/router or phone
hotspot); it never creates an unsecured access point. The SSID and WPA2
passphrase are saved to ESP32 Preferences/NVS (`sme105wifi` namespace), and
the bridge automatically attempts to reconnect after ordinary power cycles or
coverage loss. The router/hotspot must be running and the laptop or phone
must be on the same local Wi-Fi network. **No ECU command is sent at boot,
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
only, idle) removes Wi-Fi credentials, disconnects STA, and rotates the
authentication token; it **does not reset** the once-per-boot diagnostic or
OBSERVE attempt counters. Use `WIFI_STATUS` to see the current IPv4 address;
`sme105-bridge.local` is an mDNS convenience name and may not resolve on all
phones/hotspots, so prefer the IP address when necessary.

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
is mirrored to USB and authenticated TCP using a bounded fan-out queue.

`WIFI_CONFIG`, `WIFI_TOKEN` and `WIFI_FORGET` **cannot** be invoked from
Wi-Fi, even after authentication. A pending `ARM_A4` or `ARM_0E` can only be
used for `READ_*` by **the same originating transport** (USB-to-USB or
authenticated-TCP-to-that-TCP). Wi-Fi disconnection revokes pending Wi-Fi
arms. `STOP` is always allowed from either authenticated channel and clears
pending arms. The active diagnostic and OBSERVE limits still apply globally
across both transport types. A disconnected TCP controller during a live
session causes immediate safe STOP and prevents any new controller from
taking over until that session finishes.

**Transport safety:** The TCP socket uses nonblocking sends; it cannot wait
for a slow peer in an ESP32 CART timing loop. The two output subscribers
have independent read cursors and a finite 16 KiB fan-out queue. On an active
session with network backpressure, overflow, client disconnect, or TCP send
failure, the bridge stops the ECU transmission path. A disconnected TCP
client may not receive `END`; that absence makes its evidence incomplete,
not successful. Check the full RX count against `END ro_bytes` and require
`ro_lost=0`, `uart_errors=0`; `STATUS` also exposes `transport_lost` and
`out_overflow`. No UART/TCP output is performed by the protected CART ISRs.

**Security boundary:** TCP is deliberately *not* TLS-encrypted; use only a
trusted WPA2/WPA3 local Wi-Fi network. Do not expose/forward port 8765 to the
Internet or share the token. WPA encryption protects the wireless hop, not
other untrusted devices already on the LAN. NVS credentials are not
hardware-encrypted unless ESP32 flash encryption/NVS encryption is
separately enabled. The token prevents unauthenticated commands but does not
prove physical ECU safety, authorization for unsafe B requests, or a DTC.

### Explicit host commands

| Command | Effect |
| --- | --- |
| `HELLO` | Read-only identity and protocol version. |
| `STATUS` | Read-only state, DE status, consumed read and OBSERVE latches, optional arm, fault. |
| `PINS` | Read-only GPIO assignment. |
| `HELP` | Print exact command allowlist. |
| `LISTEN_9600` | **No bus TX**: 10s UART1 RO capture at 9600 8N1, no 2400 handshake. Needs an already present CART stream. |
| `OBSERVE` | **Active 2400 handshake** (fixed Echo ID + Go CART only), then 10s raw 9600 RO capture. **At most once per ESP32 boot**; not a passive bus operation. |
| `ARM_A4` | Prepare one *candidate* stored-code sequence, no bus TX; expires after 15s. |
| `READ_A4` | Only following a valid A4 arm: fixed four-word candidate `01B0 FF5F 26A4 00A0` in ID0..3 synchronized slots, at most once/boot. |
| `ARM_0E` | Prepare alternate *candidate* with `26 0E` as the third word, no bus TX; expires in 15s. |
| `READ_0E` | Only following 0E arm: candidate `01B0 FF5F 260E 00A0`, at most once/boot. |
| `STOP` | Asserts local DE LOW and cancels current TX/timers; always recognized. |
| `RESET_IDLE` | Clears a finished idle session's fault/arm status; **never** re-arms a consumed diagnostic or OBSERVE attempt. |

The read attempt is consumed **before** the 2400 handshake. A failure does
not auto-retry or auto-switch A4/0E, even if a host repeats the command.
Likewise, an `OBSERVE` attempt is consumed **before** beginning its active
2400 handshake; a second `OBSERVE` is rejected as
`DENIED observe_already_used`, including after failure, STOP, or `RESET_IDLE`.
The read and OBSERVE latches are separate and both persist until reboot;
no USB command clears them. `LISTEN_9600`, which never transmits, remains
repeatable from idle without reflashing. In-car 2400 handshake must also be
separately authorized by the operator. Both B-command variants are conflicting scanner
sources and remain unverified for the SME-105; do **not** issue them against
a vehicle until the known GPIO17 waveform mismatch has been understood and
authorized electrical controls reviewed.

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
