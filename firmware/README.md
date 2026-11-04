# ESP32 Ford EEC-IV DCL firmware

These sketches treat 9600 baud, 8 data bits, no parity, and 2 stop bits as the
default DCL candidate configuration. That configuration and the electrical
layer must be validated against the exact ECU before active transmission.
The newly purchased 5 V MAX487 and four-channel level converter need
[this dedicated quick start](../docs/max487-quickstart.md). Do not use
the old 3.3 V or XY-K485 wiring for the MAX487.
USB serial is 115200 baud for `passive_ascii` and `dcl_master`. The timestamped
`passive_binary` sketch uses 460800 baud to carry its per-byte record overhead.

## Wiring

Never connect an ESP32 UART directly to vehicle diagnostic wiring. Use a
protected 3.3 V differential transceiver and establish a sound common reference
or use an appropriately isolated interface.

Common UART wiring:

- ESP32 GPIO16 (RX) <- transceiver RO.
- ESP32 GPIO17 (TX) -> transceiver DI.
- ESP32 3.3 V and GND -> compatible transceiver logic supply/reference.
- Transceiver A/B -> the validated DCL differential pair.

`dcl_master` additionally uses:

- ESP32 GPIO18 -> transceiver DE, active high.
- ESP32 GPIO19 -> transceiver /RE, active low.

GPIO18 is low and GPIO19 is low at idle, so the master defaults to receive.
Fit an external pull-down on DE so reset, boot, or unpowered-MCU states cannot
enable the driver; do not rely on firmware alone for the safe boot state.
The new MAX487 runs from 5 V. Its RO output needs 5 V-to-3.3 V translation
before GPIO16; its DI and DE inputs accept a 3.3 V logic HIGH. With the new
bench wiring, hold /RE at GND and fit a 10 kOhm external DE pull-down.

XY-K485 modules use automatic direction control and do not expose deterministic
DE and /RE control. Their turnaround behavior cannot enforce this master's
receive-default and hard-release guarantees. Treat an XY-K485 as receive-only
for this project. Also verify its UART-side output voltage before connecting it
to an ESP32; ESP32 GPIO is not 5 V tolerant. Replace it for master operation
with a protected 3.3 V transceiver board exposing DE and /RE.

A/B labels are not consistent across transceiver vendors. Validate polarity
against the vehicle wiring information and with passive oscilloscope or logic
capture before transmitting. If expected passive traffic is absent or inverted,
power down before swapping A and B and repeat validation.

Do not add a 120-ohm terminator blindly. First identify the bus topology and
measure the existing effective termination with the vehicle powered down.
Only add termination at a confirmed unterminated physical endpoint. Do not add
bias resistors without checking the existing network either.

## `passive_ascii`

The sketch listens on UART2 at GPIO16 and emits bounded batches containing only
whitespace-separated uppercase hexadecimal byte tokens:

```text
12 34 AB
```

A batch ends after 2.5 ms of UART inactivity or at 64 bytes. This preserves the
simple transparent text stream expected by the host text-token parser.

These text lines are UART batching artifacts only. They are not DCL frames,
packets, messages, checksummed units, requests, or responses. A real DCL
transaction can span lines, and one line can contain parts of multiple
transactions.

Passive firmware now leaves UART TX unattached, drives GPIO18 DE LOW, and
still requires the external DE pull-down for safe reset/boot.

## `passive_binary`

The binary sketch emits one timestamped MCU record for every received UART byte.
It uses SLIP so every possible byte value is preserved and record boundaries
remain recoverable by a streaming decoder.

SLIP framing:

- `C0` terminates a record; the encoder also writes `C0` before each record.
- Data byte `C0` is escaped as `DB DC`.
- Data byte `DB` is escaped as `DB DD`.
- Empty records between adjacent `C0` delimiters are ignored.

After SLIP decoding, every record is exactly 15 bytes. All multibyte fields are
little-endian:

- Offset 0: version, currently `01`.
- Offset 1: type; data is `01` and aggregate UART status is `02`.
- Offset 2: direction; unknown is `00`, MCU-to-bus is `01`, and bus-to-MCU is
  `02`.
- Offset 3: status flags.
- Offsets 4-11: unsigned 64-bit `timestamp_us` from `esp_timer_get_time()`.
- Offset 12: received byte value for type `01`; zero for type `02`.
- Offsets 13-14: CRC16-CCITT-FALSE.

CRC parameters are polynomial `0x1021`, initial value `0xFFFF`, no reflection,
and no final XOR. The CRC covers the first 13 decoded bytes, offsets 0 through
12.

Status bits report events delivered by the ESP32 Arduino
`HardwareSerial::onReceiveError` callback: `0x01` is FIFO overflow, `0x02` is
RX buffer full, `0x04` is frame error, `0x08` is parity error, and `0x10` is a
break condition. Firmware status `0x20` means bytes were suppressed while RX
remained in a break condition. Concurrent pending events can be combined in one status byte.
The status timestamp is when the first combined event was observed. The API
does not provide reliable per-byte error attribution, so the firmware does not
attach these aggregate conditions to a particular data byte.

Break reports are rate-limited to ten records per second. Bytes observed until
the RX input has remained break-free for 100 ms are discarded and reported
with `0x20`; a continuously low RX input must not create an unbounded stream of
false zero-valued DCL bytes. Any `0x10` or `0x20` status invalidates that
capture for packet decoding and requires electrical/polarity investigation.

The format is lossless for records delivered to USB: no byte value is reserved
after SLIP escaping, and CRC detects corruption. The 64-bit microsecond timer is
practically nonwrapping for this application. No finite MCU can recover UART
bytes already lost because the host stopped reading or buffers overflowed; an
overflow status record makes that loss explicit. The binary sketch emits no
startup text.

A Python stream decoder can split on `C0`, discard empty chunks, reverse SLIP
escapes, require 15 decoded bytes, validate the CRC over the first 13 bytes,
then unpack the fixed fields.

USB is configured at 460800 baud. On an 8N1 USB-UART bridge this carries at
most 46,080 transport bytes per second. Each record consumes 17 bytes without
escaping and at most 32 bytes if every decoded byte requires SLIP escaping.
A continuously saturated 9600 8N2 input can deliver about 873 bytes per second;
even the 32-byte worst case requires about 27,936 transport bytes per second.
This gives transport headroom, but capture software must still monitor UART
status records and must not claim losslessness after any overflow indication.

## `dcl_master`

This is a reference-only shell, not a validated vehicle diagnostic tool.
All candidate request descriptors are disabled; a compile-time guard prevents
RAW, SEND, wake pulses, and polling from enabling the bus driver. Studio
blocks uploading this sketch. Do not upload it manually to the car.
Only after a verified non-mutating ECU transaction and electrical validation
should a separate reviewed active implementation be developed.

Received master-side bytes are printed individually as:

```text
RX T=123456 BYTE=AB
```

These are timestamped UART bytes, not decoded DCL frames.

## `max487_bench`

The new **desk-only** MAX487 test deliberately drives A/B while they are
disconnected from all external equipment and checks its own receiver echo.
USB is 115200; local test UART is 9600 8N2. Use
[MAX487 quick start](../docs/max487-quickstart.md) to wire and flash.

## Desk bench test (separate sketch)

`firmware/bench_test/` is not sniffer firmware. It drives GPIO4 into K485 A+ on
the desk only. In the Diagnostic Studio open **Desk Bench Test** in the left
nav. Read `firmware/bench_test/README.md` before flashing. Re-upload
`passive_binary` before any vehicle connection.

