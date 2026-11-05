# v21 live capture: received bytes end before watchdog termination

Evidence: owner-provided `eec-iv-session.txt` (346 lines, not committed here).
This report does **not** claim a vehicle-side repair or an independent electrical
measurement. Analysis is against GitHub `main` at `5138c67a` and compares the
preceding v20 source commit `b472198c`.

## Reconstructed sequence

- `fw=21`, `live_all=1`, status idle with `DE=LOW`, and 4/4 local pad bench PASS.
- `ARM_ALL`, fresh handshake, `EVENT baseline=16`, mode 41/21 and the combined
  map. Firmware reports `EVENT live_pid_map set=ALL sent=45 verified=45`.
- `RXB` expands to **2,462** UART1 bytes, all preserved with per-byte times.
  Earliest: `60059882` us. Latest: `65088168` us. Continuous received interval:
  **5.028286 s**; largest inter-byte gap approximately **16.51 ms**.
- `EVENT dps_blocks_complete=14 frame_period_us=22500`.
- Ends with `END reason=7 ro_bytes=2462 ro_lost=0 uart_errors=0
  pad_verified=1 words_started=2 DE=LOW`, **without `FAULT reason=7`**.

`CART_HEADER` was overloaded: ISR header faults use `faultISR(CART_HEADER)`
and emit `FAULT` in `loop()`. The v21 **task-level no-RX watchdog** instead
used `stopEverything(CART_HEADER)` directly, producing `END reason=7` without
`FAULT`. Thus this particular stop is strongly attributable to the task
watchdog. Its condition is **five seconds since the last received UART1 byte**,
not five seconds after the recording began. If the final sampled timestamp is
accurate, the watchdog could not have fired until approximately `70,088,168`
us on the ESP32 microsecond clock; the `END` line has no own timestamp.

The user's green RX LED remaining illuminated is real observed evidence, but
an LED cannot show valid 9600-baud bytes, framing or whose transmitter is
driving the bus. The raw UART stopped at the end of this capture; whether the
ECU stopped, the MAX487/level-shifter path changed, or UART1 stopped receiving
cannot be resolved with this transcript alone. The last two command words
were started but only one was pad-verified at final reporting; do not treat
that as a complete last block or proof of ECU fault.

## Bounded changes in this review branch

- Retain the five-second **fail-closed transmitter shutdown** and no-retry
  policy. Do not turn absent bytes into a false successful three-hour run.
- Report silence distinctly as `RX_SILENCE` (19), with the actual UART1 last
  byte age, RX count, command-block counters, pending slot state, UART2 busy
  indication and GPIO16 level. Emit `FAULT reason=19` after closing TX so all
  existing clients mark the capture as incomplete.
- App v1.6.1: reject all abnormal `END` reasons (including legacy reason 7)
  and missing/non-LOW DE status. Bump the PWA cache to load the corrected logic.
- Source-bound host simulation and browser regression tests assert no
  premature stop while UART1 receives bytes and no false successful result.

## Unresolved engineering gate

**This does not restore a missing UART1 byte stream.** Replacing the five-second
watchdog with a longer interval would merely defer a stop if no bytes arrive,
not recover ECU data. Do not flash the review image or repeat active commands
as a blind test. First compare a legacy LIVE capture to this ALL capture;
capture **receive-only** UART1 activity and an independent RX/RO electrical
waveform during a stop, with the ECU safely stationary, to distinguish a
vehicle protocol interruption from a receive-path problem. Any subsequent
vehicle-side activity requires its own controlled authorization and evidence.

## Authorized USB-only v22 installation (2026-11-05)

The owner explicitly authorized flashing the connected USB ESP32 and reported
that it was safe to flash. Installed-build number advanced from 21 to **22**;
`kOtaCurrentVersion` was not raised. The work used the isolated review branch,
not `main`.

- Preflight direct CP2102 USB `HELLO/PINS/STATUS/OTA_STATUS`: fw21,
  `stage=0 DE=LOW auto_tx=0 fault=0`, `running=app0 boot=app0`, and
  `accepted_version=21 boot_health=VALID confirm_required=0`.
- Built `esp32dev_ble` with PlatformIO Core 6.2.0, `espressif32@6.12.0` and
  NimBLE 1.4.3: **SUCCESS**. Application size **1,085,312 bytes** within
  the app0 partition (1,310,720 bytes); firmware image SHA256
  `1201444e541f17d8313116a19d713c004559f3c8fa08f0b2c08802e76d5c9276`.
  ESP32 image checksum and SHA validation passed.
- Prior to writing, read private backups outside Git with mode 0600:
  `0x00000..0x0ffff` (65,536 bytes) SHA256
  `d7e63b9418ed85357dfa8c45008e7f73ff550e73e91d2e540af54e2bb8a22927`;
  full `app0` `0x10000..0x14ffff` (1,310,720 bytes) SHA256
  `56c0e62dc253f6b7aa5bf593d7140e7685e8b3fe6a32d8fdab58172ab8c05f76`.
  Its prefix exactly matched the archived verified v21 image.
- Live partition table independently confirmed NVS `0x9000`, otadata
  `0xe000`, app0 `0x10000` size `0x140000`, app1 `0x150000` size `0x140000`.
- Wrote **only** `app0` at `0x10000` with esptool at 115200 baud; 1,085,312
  bytes written, **Hash of data verified**, hard reset. No bootloader,
  partition table, NVS, otadata, or app1 image was directly flashed.
- Read the 64-KB boot/settings region again: bootloader + partition table
  (`0x0..0x8fff`) and otadata (`0xe000..0xffff`) byte-identical. NVS changed
  naturally after fw22 accepted-version adoption; preflash private backup
  retained.
- Postflash `HELLO/PINS/STATUS/OTA_STATUS`: **fw22**, `stage=0 DE=LOW
  auto_tx=0 gate4=1 fault=0`, `running=app0 boot=app0`,
  `accepted_version=22 boot_health=VALID confirm_required=0`.
- A DE-LOW, **no-ECU-TX** local `TX2_BENCH` passed all four GPIO17 pad
  words and independent RMT witness: `result=PASS_LOCAL_PAD completed=4
  DE=LOW ... ecu_tx=0`. Final status stayed idle, `DE=LOW`, `fault=0`,
  `tx2_bench_pass=1`, no active read or OBSERVE request.

No vehicle diagnostic command was sent as part of the flash/bench procedure.
The v22 flash confirms installation and local health only; it **does not
demonstrate that a live-data RX blackout has been repaired**.
