# RX timestamp race repair and USB firmware v23

## Confirmed defect

The v22 field event reported `elapsed_ms=5895`,
`last_rx_age_us=4294967294`, `last_rx_us=66221618`, and `ro_bytes=1953`.
All four ECU transmission pad witnesses had passed. The age is exactly
`uint32_t(-2)`: UART1's ISR published a timestamp two microseconds newer
than the watchdog's clock sample. This event is a firmware timestamp race,
not evidence that the ECU stopped transmitting.

The v22 subtraction read an asynchronously updated `lastRxAtUs` in the
same expression as `esp_timer_get_time()`. Reading the clock first allowed
an ISR to replace the timestamp before the subtraction. The unsigned result
then crossed the unchanged five-second threshold.

## Repair

In `pollActive()`, read `lastRxAtUs` into a local `uint32_t lastRxUs` in
one statement, then sample `esp_timer_get_time()` in the next statement.
Calculate the age from that local timestamp, and print that same snapshot
in silence evidence. An ISR between or after these statements cannot change
the subtraction's RX operand. An ISR before the first statement completes
publishes a timestamp preceding the later clock sample. Consequently a
slightly newer ISR timestamp cannot wrap the age to nearly `UINT32_MAX`.

Unsigned subtraction remains intentional: crossing `0xffffffff` to zero
still produces the actual elapsed interval. No signed clamp is used; this
also retains detection of silence beyond the signed 32-bit half-range.
The five-second watchdog runs throughout active capture, well before a
full microsecond-counter cycle could alias an unobserved silent interval.

The watchdog still requires a LIVE variant, `CART_READ`, five seconds since
capture start, and at least 5,000,000 microseconds since received data.
Genuine inactivity calls the original `stopEverything(RX_SILENCE)`, disables
TX/DE/timers, closes UARTs, emits reason 19 and its detailed evidence, and
does not grant retry authority.

Only the installed USB build number changes from 22 to **23**.
`kOtaCurrentVersion=1`, publisher key, signed manifest and ledger checks,
rollback policy, diagnostic words, PID maps, 22.5 ms CART cadence, UART error
and overflow handling, DE/RMT gates, and capture limits are unchanged.
Reversing only the timestamp patch and build-number change reconstructs
the v22 sketch byte for byte.

## Regression evidence

`tests/test_sme105_live_rx_silence.py` compiles the actual `pollActive()`,
`stopEverything()`, enums, variant selection, capture limits and retry
predicate from the sketch with C++17 warnings-as-errors and UBSan. Mocked
clock, serial output and hardware hooks verify:

- The field interleaving: clock samples 66,221,616 us, then the ISR publishes
  66,221,618 us before returning to the caller; all four LIVE variants keep
  running. Also test the next poll and an ISR preceding the clock sample.
- Reception every 22,500 us, with polls between frames, across a 32-bit wrap.
- Silence just below, exactly at, and above five seconds, including wrap,
  startup grace, and genuine silence beyond `INT32_MAX` microseconds.
- Reason 19, DE low, disabled timers, cancelled slots, closed UARTs, preserved
  evidence and no retry; a previously latched RX overflow stays latched.
- Other modes and inactive/passive stages do not acquire the LIVE silence
  fault; the independent capture timeout still stops LIVE at its limit.

Mutation proof: restoring the actual v22 sketch makes the new C++ test fail
on the reproduced ISR interleaving. Compiling the historical watchdog
guards from Git gives: v20 (`b472198`) has no LIVE silence watchdog;
v21 (`5138c67`) falsely stops with reason 7; v22 (`84d07ad`) falsely stops
with reason 19. The repaired v23 test passes while real silence still stops.

The existing parser harness needed its missing ALL-map include and
`extraColumn` state restored to compile existing firmware, and the USB
maintenance assertion needed its obsolete v21 expectation updated to v23.
These are test-only changes. Existing private capture fixtures were copied
from the owner's original checkout into ignored local capture paths;
none are committed. Python dependencies and the upstream CSV fixture were
provided in temporary test environments.

- Python suite: **266 tests, OK, 9 skipped**. The original v22 baseline,
  using the same fixtures and dependencies, reproduces the stale version
  assertion and all eight parser-harness compile errors.
- JavaScript suite: **44 pass, 1 fail, 3 skipped**. The remaining failure
  is reproduced unchanged on v22: `controller.test.mjs` expects `KOEO`,
  while the UI returns `engine off`. No browser behavior was changed.
- Focused watchdog suite, including the final long-silence case: **3 pass**.

## BLE build

Built with the requested command:

```sh
uvx --from platformio platformio run \
  --project-dir firmware/sme105_usb_bridge --environment esp32dev_ble
```

PlatformIO 6.2.0, Espressif32 6.12.0, Arduino ESP32 2.0.17, NimBLE 1.4.3:
compilation and linking **SUCCESS**. Image checksum and embedded SHA
validation also pass esptool `image_info`.

- Binary: **1,085,312 bytes**, within the actual **0x140000 / 1,310,720-byte**
  application partition, leaving 225,408 bytes.
- Linked flash use: 1,078,729 bytes; RAM use: 92,652 bytes.
- Firmware image SHA-256:
  `beb126098bd2de98ff80553a0e3abaf001814589a79c61a615c0a8e9eba2439c`.

## USB maintenance

The owner authorized the physical USB update. CP2102 by-id resolved to
`/dev/ttyUSB0`, with no other process holding the port. Esptool confirmed
ESP32-D0WD-V3 rev3.1, MAC `00:4b:12:3b:2b:f8`, 4 MB flash. Read-only
`HELLO/PINS/STATUS/OTA_STATUS` confirmed v22, `stage=0 DE=LOW auto_tx=0
gate4=1 fault=0 armed=NONE`, no read/observe consumed, and
`running=app0 boot=app0 accepted_version=22 boot_health=VALID
confirm_required=0 rollback=1`. The final preflight passed after draining
the single expected startup announcement. Earlier premature
opens reproduced the previously documented serial flood/startup artifact;
no write was attempted until the complete settled preflight passed.

The actual partition table passed its MD5 check: NVS `0x9000/0x5000`,
otadata `0xe000/0x2000`, app0 `0x10000/0x140000`, app1 `0x150000/0x140000`.
Before writing, private backups were saved outside Git under
`~/.config/sme105/usb-pre-v23-20261105/` (directory 0700, files 0600):

- Boot/settings `0x0..0xffff`: 65,536 bytes, SHA-256
  `ee0dc9d1b964d11ba198a28974026eb614a1ec03da9acac3e248fae30eeccff0`.
- Full v22 app0: 1,310,720 bytes, SHA-256
  `55c557ee935625e2c58689deb503fe4580bb70e27aaa1c4a2b432eaba0f8a8cc`.

Backups used digest-verified 64 KB reads. One corrupt read was rejected and
repeated read-only with pinned esptool 4.9.0; no flash write occurred during
backup. Full backups were then verified against device flash digests. The
app0 prefix matches the archived v22 firmware SHA-256
`1201444e541f17d8313116a19d713c004559f3c8fa08f0b2c08802e76d5c9276`.
Protected-region digests were recorded for independent post-write comparison.

Esptool 4.9.0 wrote **only** the frozen application at `0x10000`, using
`--flash_mode keep --flash_freq keep --flash_size keep`. Its erase span
was `0x10000..0x118fff`, entirely inside app0. It wrote 1,085,312 bytes
and reported **Hash of data verified**. An independent device flash digest
matched the frozen image again before and after boot.

Before first v23 boot, a fresh readback of the entire 64 KB boot/settings
region was byte-identical to its backup, including NVS. After boot,
bootloader, partition table and otadata remained byte-identical. The
combined app1/storage digest also remained unchanged. NVS changed only
after firmware boot, consistent with the existing USB installed-version
adoption policy; its original private backup is retained. No bootloader,
partition, NVS, OTA metadata or app1 image was flashed.

Post-installation `HELLO/PINS/STATUS/OTA_STATUS` confirmed **fw23**,
`stage=0 DE=LOW auto_tx=0 gate4=1 fault=0`, `running=app0 boot=app0
accepted_version=23 boot_health=VALID confirm_required=0 rollback=1`.
The existing `TX2_BENCH` passed all four physical GPIO17 pad words with
`de_low=1 match=1` and the independent RMT decode witness. Its final result
was `PASS_LOCAL_PAD completed=4 DE=LOW ecu_tx=0 no_auto_retry=1`.
No ECU diagnostic command was sent. A subsequent 30-second observation on
the same USB connection, with repeated status and final identity/health
queries, passed with no reboot announcement, initialization fault, serial
failure, overflow or transport loss; `tx2_bench_pass=1` stayed set.

Installation and local verification: **PASS**. The unrelated, pre-existing
JavaScript KOEO label assertion described above is the remaining test failure.

## Vehicle validation still required

The host tests prove the timestamp regression and software shutdown contract.
USB boot and DE-low local-pad checks prove installation and local operation
only. Long-duration LIVE/LIVE2/LIVE3/ALL reception on the actual vehicle
still requires an owner-authorized vehicle session. No ECU diagnostic
commands are part of this maintenance workflow.
