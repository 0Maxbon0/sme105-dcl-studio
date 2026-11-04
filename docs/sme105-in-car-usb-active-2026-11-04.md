# SME105 in-car USB-only controlled diagnostic attempt — 2026-11-04

## Owner directive and actual execution

The owner explicitly requested an immediate in-car USB test with ignition on,
reusing the existing knowledge, and an attempt to detect faults. This is a
vehicle-connected test, **not** a bench or Wi-Fi test. The ESP32 remained on
firmware v9; no flash, router work, clearing codes or actuators were used.

1. The preceding **passive-only** `LISTEN_9600` captured zero bytes. That
   result does not test ECU handshake, because this command transmits nothing.
2. A **local-only** `TX2_BENCH` passed all four source words:
   `01B0`, `FF5F`, `26A4`, `00A0`. Independent RMT decoding of
   `01B0` passed. External driver enable stayed `DE=LOW`;
   `ecu_tx=0`. Fresh STATUS confirmed `tx2_bench_pass=1`,
   `stage=0`, `fault=0`. This **does not** prove MAX487 A/B signalling
   or that the ECU sees a correct request.
3. **One** authorized, previously exercised active `OBSERVE` sequence:
   Echo ID (11 bytes at 2400), candidate 11-byte echo + `01` ACK
   (origin unverified), Go CART (11 bytes at 2400), then UART1 RO reception
   at 9600. No experimental `READ_A4` or `READ_0E` B command was sent.
4. Complete USB terminal record:
   `END reason=16 ro_bytes=3984 ro_lost=0 uart_errors=0 pad_verified=0
   words_started=0 ecu_verified=0 dtc_verified=0 DE=LOW`.
   The timeout reason is the firmware's normal 10-second bounded capture,
   not a UART error or an ECU diagnostic code. The host acknowledged STOP
   with `EVENT stop=idle DE=LOW` and exited successfully.

## Evidence integrity

Evidence lives under `captures/SME105_97AB/`; timestamps are UTC:

| Capture | Evidence | SHA-256 |
| --- | --- | --- |
| `20261104T135342868112Z-usb-bridge.txt` | DE-low local pad/RMT preflight | `127a295971d99861e643e58003e0ffe49917409cfbc78a9f104450497fc0191f` |
| `20261104T135427026967Z-usb-bridge.txt` | Complete active USB transcript and END | `06e9946d3eb90c1ca2303fa13f27540e179225922cea7c7880a58b72a32b2cf5` |
| `20261104T135427026967Z-usb-bridge.bin` | Exactly 3,984 UART1 RX bytes | `ed478fcf36923927d16ce2f68fcfe2b62c4d071445a481cfc8d26ce5bf634c12` |

Offline independent raw-byte audit:

- 996 exact quartets = 62 complete cycles of IDs 0–15 plus IDs 0–3.
- Every quartet is `00 00 00 <parity-coded ID>` from
  `scripts/analyze_cart_once.py:REFERENCE_CYCLE`.
- The 3,984-byte binary exactly equals the raw bytes reconstructed from
  `captures/CART_ONCE/20261102T150417765534Z.txt`, byte for byte.
- 3,984 timestamped UART samples; successive quartet start times have
  approximately 10 ms intervals (9.993–10.005 ms).
- **No additional word or payload** beyond CART sync/ID was present; no
  diagnostic trouble code (DTC), sensor value or ECU provenance was verified.

## Decision and next safe gate

The in-car USB path, 2400-baud bounded handshake and 9600-baud RX path
produced a reproducible continuous **ID-only** stream. That is useful progress
but **not a valid DTC read**. The candidate B diagnostic request still has
conflicting source definitions (`26 A4` vs `26 0E` and timing/slot counts),
and physical MAX487 A/B differential waveform, driver-enable safety, exact
ECU pinout/source and response interpretation remain unverified. Sending
either B variant merely to make a TX LED blink would be an uncontrolled
experiment; neither was sent. Do not clear ECU codes or issue KOEO/KOER
actuator tests. Next engineering gate is source/protocol reconciliation
and independent A/B scope/logic-analyzer proof with current limiting,
before one separately bounded B read. Historic `97AB` ECU identity and
UART-only payload have not been authenticated as ECU source.

## Later same-day owner-authorized live B attempt (2026-11-04)

Owner subsequently explicitly authorized trying both read-code candidates on
the connected stationary vehicle, with ignition ON and direct USB, and asked
for cross-checking the original community repositories. This section records
the attempts actually made; it does **not** claim any ECU diagnostic response.

### Public-source reconciliation

- `doncreat0r/eeciv`, `tables.h`, defines menu B as `26 0E` for
  `read codes` (14 data-slot count). Original source:
  https://github.com/doncreat0r/eeciv/blob/master/tables.h
- `flxkrmr/eec-iv-reader-arduino`, `src/EecIv.cpp`, defines
  `01 B0 / FF 5F / 26 A4 / 00 A0` for continuous self-test codes
  (4 data-slot count), **after** `01 F4` clears DCL error flags, and
  waits for `nextDiagnosticMode == 0x26` before interpreting returned
  data. The flxkrmr project's own README warns it is work in progress.
  Sources: https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/EecIv.cpp
  and https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/Cart.cpp
- Neither implementation proves which B variant is valid for this actual
  SME105 ECU, nor does either prove the current vehicle MAX487 bus electrical
  compatibility. The local firmware deliberately has no clear/error-flag
  command; no `01 F4` was sent.

### One USB B-A4 attempt, blocked before any ECU B TX

Using the existing `BridgeClient`, the USB identity, STATUS, PINS and
boot health prerequisites passed. The **same** continuous USB connection
then completed a 4/4 local `TX2_BENCH` with RMT and `DE LOW`. The
owner-authorized `REQUEST_A4` generated `ARM_A4`, a fresh
`STATUS armed=A4`, then `READ_A4` exactly once.

The firmware emitted `EVENT session=READ_CANDIDATE`, but stopped with
`END reason=1` (`BAD_IDLE`), `pad_verified=0`,
`words_started=0`, `DE=LOW`. There was **no Echo ID / Go CART /
diagnostic B TX**. Its quiet-phase guard refused to transmit while the
physical RO input was active (or stale bytes were available at 2400 baud).
19 `RX` bytes were emitted **before** `EVENT session=`, with the same
CART sync/ID pattern from the prior stream. The firmware's `ro_bytes=19`
count includes this pre-session residue; the host correctly refused to
attribute them to the just-started capture (`END RX count mismatch`),
marking that attempt **INCOMPLETE**, not a read-code result.

- USB transcript `captures/SME105_97AB/20261104T140314560274Z-usb-bridge.txt`,
  SHA-256 `6f15ce011f8e0dbecaacf39e92561628a31f22bccf29c1a3ec1a041b5348ef4c`.
- 19 pre-session bytes `captures/SME105_97AB/20261104T140314560274Z-usb-bridge.bin`,
  SHA-256 `e242a57bc6b201387135c39f77d58cadb33493903372943b2fdec2410b7f7422`.

Afterward a safe UART-only STATUS showed `stage=0`, `DE=LOW`,
`fault=0`, and v9 `boot_health=VALID` (the USB serial reopen may
reset the ESP32; that does not reset the vehicle ECU).

### Root cause corroboration: lingering CART traffic

One additional **short receiver-only** `LISTEN_9600` after the
failed A4 capture obtained `END reason=15 ro_bytes=444 ro_lost=0
uart_errors=0 ... DE=LOW` in about 1.1 seconds. Data starts
`00 00 00 D7 00 00 00 28 00 00 00 39 ...`, i.e., existing
parity-coded CART frame IDs. The ECU-side bus continued broadcasting
after the host's earlier 10-second OBSERVE stopped. This is a plausible
explanation for `BAD_IDLE`, but UART alone cannot authenticate the
electrical sender or rule out other wiring/receiver effects.

- Passive read `captures/SME105_97AB/20261104T140610760178Z-b-busy-line-usb.txt`,
  SHA-256 `fb83db7a25b08d22d24189d59440a5e357ff7574e604633b4de2b594dad04b2b`.
- Raw 444 bytes `captures/SME105_97AB/20261104T140610760178Z-b-busy-line-usb.bin`,
  SHA-256 `bef85b9308c806feb3beec3e63f4a66576dd4600b47330089b3b1ec7874ebb34`.

### Decision

`26 A4` was armed but **not transmitted**, `26 0E` was **not
attempted** because a second immediate B handshake would also encounter
the non-idle vehicle DCL link. It is incorrect to say the ECU rejected A4.
Do not bypass BAD_IDLE or blindly retry/reinitialize the ECU link.
To conduct another active request with the unchanged firmware, the operator
must restore physical bus quiet (usually ignition OFF followed by KOEO after
the vehicle has fully reset); confirm that the engine is not running and
no critical electronics depend on ignition continuity. That physical action
cannot be performed through this USB interface. Once quiet is established,
re-run the ordinary single-shot status/bench/armed request without modifying
or flashing firmware, monitor every fault and preserve END evidence.

## Post-ignition-cycle one-shot B-0E attempt (2026-11-04)

The owner switched ignition OFF and then back to KOEO; the green hardware
activity LED went dark. The ESP32 remained on direct USB, no Wi-Fi.
USB HELLO/PINS/STATUS/OTA preflight showed v9 VALID, `stage=0`,
`DE=LOW`, `auto_tx=0`, `fault=0`. A fresh host session ran
`TX2_BENCH` with 4/4 GPIO17 words and independent RMT proof (DE LOW),
then `ARM_0E` and **one** `READ_0E`.

The 2400-baud Echo ID handshake and candidate ACK completed; the 2400-baud
Go CART command followed. The device captured 16 consecutive sync/ID frames
on UART1 at 9600 baud, then entered one real CART TX slot. First command
word was supposed to be `01 B0`. The firmware stopped immediately:

```
FAULT reason=11
TX_PAD slot=0 expected=01B0 observed=0101 tx_us=3075851 done_us=3077940 match=0
END reason=11 ro_bytes=70 ro_lost=0 uart_errors=0 pad_verified=0 words_started=1 ecu_verified=0 dtc_verified=0 DE=LOW
EVENT stop=idle DE=LOW
```

`reason=11` means **PAD_MISMATCH**, not an ECU refusal or trouble code.
The subsequent diagnostic words `FF5F / 260E / 00A0` were never sent.
Critically, UART1 RO independently captured `t_us=3076846 byte=01` and
`t_us=3077888 byte=B0` in that same 2089-us slot: the expected TX word
was visible at the receiver, but the UART2 pad readback duplicated
`01 01`. These are compatible with a pad-readback bug rather than bad
UART2 transmission, but do **not** independently prove differential A/B
bus voltage or ECU signal ownership.

Evidence preserved with no retries:

| File under `captures/SME105_97AB/` | SHA-256 |
| --- | --- |
| `20261104T141106825311Z-usb-bridge.txt` | `3de32fe392910e1442e1a6525a81234cecdea874e126a52ec3c89febff177845` |
| `20261104T141106825311Z-usb-bridge.bin` | `e03980b386b3403b2a993ed4aed9b661b6db20cf866f0627bc6ce102f98ed336` |

### Source-only fix (not flashed)

The live `uart2ISR` previously read `UART2.fifo.rw_byte` twice, while
the isolated `TX2_BENCH` used the hardware-verified
`READ_PERI_REG(UART_FIFO_REG(2))` APB FIFO pop method. The source patch
now uses the latter for both active words, requires the FIFO count to
decrease **2 → 1 → 0**, and retains fail-closed PAD mismatch/framing
checks. Added regression coverage in
`tests/test_sme105_tx2_pad_source.py`. Focused tests: 4 PASS;
whole Python suite: **242 PASS**; PlatformIO release firmware: **BUILD PASS**.
New local (not installed) image SHA-256:
`ca02cedc6613d7fc0e381c1a94202a6f624387557261be74fee3dce1fa0c15ca`.

**Vehicle firmware remains v9**. Do not flash/retest an unqualified TX
firmware while attached to the active ECU bus; off-vehicle differential
A/B electrical verification, safe DE behavior, and byte-source checks
are still necessary. Neither 26A4 nor 260E has yielded a verified DTC.

## OWNER STOP / field observation — 2026-11-04 ~16:18 Africa/Cairo

**Owner explicitly ordered: log everything in the repository and STOP all
vehicle experiments.** No further ECU command, serial session, flash,
reset, Wi-Fi change, or ignition action is authorized as part of this turn.

Owner-observed physical state after the interrupted `READ_0E` attempt:
the **green MAX487 board's RX indicator became illuminated again**, and
the owner reports the connected unit/ECU keeps emitting traffic after
host capture ends; in their experience it only stops after ignition is
switched OFF and then back ON. This is an **eyewitness LED observation**;
there is *no further instrumented capture after the owner's report*.
The earlier independently preserved one-second passive USB capture
(444 bytes, 111 sequential CART ID frames, zero UART errors) supports
that CART traffic can continue after a host session ends, but an LED
alone does **not** prove which physical component drives the bus or
that the ECU is in a particular diagnostic mode.

### Final engineering state at the STOP boundary

- Installed on the USB-connected ESP32: **v9**, latest prior USB status
  `stage=0 DE=LOW auto_tx=0 fault=0`, OTA `boot_health=VALID`. The
  serial connection used to read that state was closed afterward.
  **No new device status was queried after the owner's latest LED report.**
- Last live candidate: `26 0E` requested once, but only the **first**
  synchronized command word `01 B0` started. Firmware halted immediately
  with `PAD_MISMATCH reason=11`, `pad_verified=0`, `words_started=1`;
  UART1 RO showed `01 B0`, while UART2's old pad readback said `01 01`.
  `FF 5F / 26 0E / 00 A0` were **not transmitted**.
- Prior `26 A4` was only armed; it stopped at `BAD_IDLE` with zero
  command slots transmitted. Hence **neither B variant was tested
  completely**. No valid diagnostic trouble codes were obtained.
- Source-only correction of the two-byte UART2 FIFO pop and 2→1→0
  occupancy validation is committed at `c081d18`. All **242 Python
  tests** and PlatformIO firmware build passed, but it is **NOT FLASHED**.
  Local built-image SHA-256:
  `ca02cedc6613d7fc0e381c1a94202a6f624387557261be74fee3dce1fa0c15ca`.
- The vehicle and ignition state are **not controlled by software here**.
  The operator owns the physical actions. Do not infer the RX light
  extinguished or the ECU stopped sending after this note.

### Resume boundary (only on a *future* explicit instruction)

Preserve all raw transcripts and hashes; do not send another live
`READ_A4`/`READ_0E` or use LED status as evidence for a valid DTC.
Before any further ECU-connected work, validate the source-only FIFO
fix with an isolated differential A/B circuit and an independent physical
waveform witness, verify RMT DE cutoff, and reconcile CART response
slots/diagnostic mode for `26 A4` vs `26 0E`. Revalidate under
explicit field authorization with bounded one-shot tests and do not
clear codes, alter actuator states or transmit arbitrary bus words.
The last instruction for this field session is **STOP**.

## v10 USB application flash (2026-11-04 ~16:35, ignition OFF)

Owner authorized flashing the `c081d18` UART2 pad-readback fix. Bench
evidence already showed the old `rw_byte` path producing `observed=0101`
while the APB `READ_PERI_REG(UART_FIFO_REG(2))` path produced exact words
with `rx_count=2 rx_count_mid=1 rx_count_after=0` on every slot.

- `kUsbInstalledBuildVersion` 9 → 10; 242 Python tests PASS; build PASS.
- Pre-flash: `running=app0 accepted_version=9 boot_health=VALID`.
- NVS (`0x9000`) and otadata (`0xe000`) backed up privately outside Git.
- Application-only `write_flash 0x10000`, hash verified. Image SHA-256
  `35a9e361c63dc9a3aee681e015745c27eaf40c335fe30d3a0308a437ab83b266`.
- Post-flash: `running=app0 accepted_version=10 boot_health=VALID`,
  `stage=0 DE=LOW auto_tx=0 fault=0`, all one-shot counters 0.
- First post-flash USB read contained repeated/garbled fragments; not
  reproduced on re-read. No command was executed by it (all counters 0).

## v10 KOEO one-shot `READ_0E` — first ECU diagnostic response (2026-11-04 ~16:38)

Owner switched ignition ON (KOEO, engine not running) with USB connected.
One host session: `TX2_BENCH` 4/4 PASS (RMT `01B0`, DE LOW), `ARM_0E`,
**one** `READ_0E`. Echo ID + `01` ACK, Go CART, 16-frame baseline, then
all four command words verified on the pad:
`TX_PAD 01B0 / FF5F / 260E / 00A0 match=1`,
`END reason=16 ro_bytes=3810 ro_lost=0 uart_errors=0 pad_verified=4 words_started=4`.

| File under `captures/SME105_97AB/` | SHA-256 |
| --- | --- |
| `20261104T143804949449Z-usb-bridge.txt` | `141c6a78563b524d5e405034d2445ce8edbe7b7f4de15a1b683eb1942363b2bb` |
| `20261104T143804949449Z-usb-bridge.bin` | `a170a0514ef6b6f44ed93f3a973a260bb5a650782efbcb1310161b19761b2c34` |

The ECU changed frame timing for one 16-frame block (≈42.5 ms per frame
instead of 10 ms) and placed non-sync words in it. Every word below passes
the CART vertical-parity rule `hi(b1) == lo(b0)^hi(b0)^lo(b1)^0xA`.
Status-slot mapping per flxkrmr `Cart.h`:

| Frame | Slot | Word | Meaning |
| --- | --- | --- | --- |
| 4 | current diagnostic mode | `26E0` | `0x26` — ECU entered code-read mode |
| 5 | next diagnostic mode | `FFA0` | `0xFF` idle |
| 6 | DCL error flags low | `1F40` | `0x1F` (likely stale; `01 F4` clear was never sent) |
| 7 | DCL error flags high | `FC90` | `0xFC`, includes `selfTestComplete` |
| 8–9 | DMR | `00A0 00A0` | 0 |
| 10–11 | ROM ID | `ADD0 3810` | `AD` / `38` |

Data words, code = `lo(b1)` followed by `b0` (flxkrmr `onFaultCodeRead`):

| Frame | Word | Code | Ford EEC-IV meaning |
| --- | --- | --- | --- |
| 0 | `22B1` | **122** | TP sensor below minimum voltage |
| 0 | `1391` | **113** | IAT/ACT sensor above maximum voltage (open) |
| 1 | `14D2` | **214** | Cylinder identification (CID) circuit failure |
| 1 | `5791` | **157** | MAF sensor below minimum voltage |
| 2 | `5294` | **452** | Insufficient input from vehicle speed sensor |

All five are valid Ford 3-digit EEC-IV codes. Codes were **not cleared**,
no KOEO/KOER self-test or actuator command was sent. Remaining caveats:
`26 0E` vs `26 A4` semantics (memory vs on-demand) are not authenticated;
no second independent read has been made yet.

## Independent `READ_A4` confirmation after ignition cycle (2026-11-04 ~16:43)

Owner cycled ignition OFF → ON (KOEO). Fresh ESP32 boot, `TX2_BENCH`
4/4 PASS, `ARM_A4`, one `READ_A4`. Pad-verified
`01B0 / FF5F / 26A4 / 00A0`, `END reason=16 ro_bytes=3970 ro_lost=0
uart_errors=0 pad_verified=4`.

| File under `captures/SME105_97AB/` | SHA-256 |
| --- | --- |
| `20261104T144256788073Z-usb-bridge.txt` | `abd8710acddedc75f0edb70442001b50d8aee6420441a3d29770d5d6cd01a308` |
| `20261104T144256788073Z-usb-bridge.bin` | `cdb04f5800779c74931697c505b70d6f38888e96351258fb36c44ddcfb8b0c7c` |

Response is identical to `READ_0E`: same parity-valid codes in the same
order and frames — **122, 113 (frame 0), 214, 157 (frame 1), 452
(frame 2)** — and the same status words `26E0 FFA0 1F40 FC90 … ADD0 3810`.
Only the response frame period differs (≈17.5 ms for A4 vs ≈42.5 ms for
0E), consistent with the 4- vs 14-data-slot counts in the two sources.
Two independent ignition cycles and both B variants therefore agree on the
stored code list. Codes were not cleared.

## v11 USB application flash (2026-11-04 ~17:15, ignition OFF)

Adds DIAGMODE 25H KOEO self test (request repeated every block, adaptive
frame-period header gate) and DIAGMODE 80H go-offline joined onto a running
CART stream (LHBH1 ch.13: Diagnostics state exits only via go-offline or
ignition reset). Parser replayed on real captures by
`tests/test_sme105_cart_join_parser.py`; 246 tests PASS.

- NVS/otadata backed up privately; application-only `write_flash 0x10000`,
  hash verified. Image SHA-256
  `213cd293549159362a3992b853c9e96d52191962971c923234aa151d4a0d67fa`.
- Post-flash: `accepted_version=11 boot_health=VALID`, `stage=0 DE=LOW`,
  `offline_used=0`, all one-shot counters 0.
- The first serial open after each esptool reset again returned ~550 bytes of
  the repeated boot-banner tail (`...source_commands_unverified=1`). The
  firmware output queue is cursor-based and cannot repeat bytes; subsequent
  opens are clean and every vehicle END byte count matched the host. Treated
  as a CP2102 post-reset artifact; host sessions always re-verify
  HELLO/STATUS/PINS before any TX.
