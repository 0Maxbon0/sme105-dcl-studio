# Continuous live capture v21

Owner confirmed the ESP32 was disconnected from the car and connected only
to USB before maintenance. Existing BLE transport and pairing are retained;
the Wi-Fi question was answered as feasibility only.

## Changes

- One mode-41 PID map, then continuous mode-21 reads: 45 slots, 39 unique
  requested channels. No rotation between LIVE/LIVE2/LIVE3. Same length-6
  frames; designed 360 ms/channel cycle. Sensor support and timing on this
  ECU remain unverified.
- Every map word retains independent physical pad/DE verification and
  watchdogs; incomplete 45/45 loading fails closed. Critical functions/map
  were verified in IRAM/DRAM in the compiled ELF.
- Lossless RXB batches preserve original bytes and uint32 timestamps while
  fitting the calculated 115200-baud budget. Both host decoders understand
  batches and unwrap timestamps beyond 71.6 minutes.
- Three-hour live limit. Five seconds without ECU data stops capture as
  incomplete; existing link loss, timing, DE and overflow stops remain.
- Expandable descriptions under ALL, LIVE, LIVE2 and LIVE3. Full phone data
  is archived in IndexedDB; bounded recent history feeds the UI. Archive
  export/recovery retains all readings; nothing is automatically deleted.
  Free quota check: 1 GB. Queued storage backlog limit: 4 MB, then stop.

## Verification and limits

Focused browser-side suite: 40 passing tests, plus the added controller
retention test passing with its seven all-live companion tests. Python:
33 passing tests. Software simulation covers three hours, two wire-clock
wraps and over 1.3 million samples. IndexedDB tests cover multi-chunk export,
reopening, write failure and low quota using temporary fake-indexeddb.
Firmware builds for esp32dev_ble: static RAM 92,652 bytes; reported program
usage 1,078,081 / 1,310,720 bytes. Frozen application image: 1,084,656 bytes,
SHA-256 `d170f04d9110a7cf736ab76c6699e5f5c844c279f893c0504848820a8f5a076d`.

These are software/desk checks, not an endurance, RF, electrical safety or
road test. The combined map and three-hour duration have not been tested on
the car. Local interactive preview remains unverified because browser access
was declined earlier. No claim of zero latency or guaranteed three-hour
phone/radio retention is made. Browser termination can lose an uncommitted
chunk; export before clearing browser data. App v1.6.0 is served through the
existing ngrok tunnel; nine public app files were verified byte-for-byte
against the local files. The tunnel depends on this computer remaining online.

## USB maintenance evidence

Chip: ESP32-D0WD-V3 rev3.1, MAC 00:4b:12:3b:2b:f8, 4 MB flash.
Pre-maintenance: fw20, app0 running/boot, OTA VALID, accepted version20,
stage0, DE LOW, auto_tx0, fault0.

Private backups (0600, outside Git) under
`~/.config/sme105/usb-pre-v21-20261105/`:

- boot/settings region 0x0..0xffff, 65,536 bytes, SHA-256
  `a597b0154a99025e513990800893586ffe4f0543bf56053072fa924a2b5e3762`.
- app0 0x10000..0x14ffff, 1,310,720 bytes, SHA-256
  `f5747a08bf1042ffde02baa6d6635c04c9cf5ef226f72c8ee439d0f9ecd6ece8`.

Large read_flash attempts failed/stalled without writing flash. Backup
succeeded in independently digest-verified 64 KB chunks at 115200 baud.
Partition table confirms NVS 0x9000/0x5000, otadata 0xe000/0x2000,
app0 0x10000/0x140000 and app1 0x150000/0x140000. Only app0 is authorized
for this USB installation; bootloader, table, NVS and otadata are preserved.

Installed the frozen application at **0x10000 only** with esptool 4.9.0,
115200 baud; 1,084,656 bytes written and the flash hash verified. Before
first boot, a fresh 65,536-byte read of 0x0..0xffff was byte-identical to
the private backup: bootloader, partition table, NVS and otadata preserved.

After reset and a nine-second startup interval:

```text
STATUS: stage=0 DE=LOW auto_tx=0 gate4=1 fault=0 live_all=1 rx_batch=1 fw=21
OTA_STATUS: running=app0 boot=app0 accepted_version=21 boot_health=VALID confirm_required=0
TX2_BENCH_END result=PASS_LOCAL_PAD completed=4 DE=LOW no_rmt_start=1 ecu_tx=0 no_auto_retry=1
```

All four local UART2 words matched their physical pad readback; every word
reported de_low=1. Final STATUS kept stage0, fault0, zero overflow, DE LOW,
no armed vehicle command, and tx2_bench_pass1. Final OTA_STATUS remained VALID.
This local pad test does not prove MAX487 external bus signals, ECU map
acceptance, sustained BLE delivery or car safety. No READ/ARM or other ECU
command was sent during maintenance.
