# SME-105 next vehicle diagnostic session — evidence-led readiness

Date: 2026-11-02. Desk-only work; **car A/B disconnected** throughout.

## Confirmed existing vehicle evidence (not repeated)

- `captures/ECHO_ID_ONCE/20261102T144928924270Z.txt`: reference
  2400/8N2 11-byte Echo Module ID TX; 11 local-echo bytes followed by
  `0x01` candidate ACK. Source of `0x01` not electrically authenticated.
- `captures/CART_ONCE/20261102T150417765534Z.txt`: reported Go CART
  reference TX then 9600/8N1, **3,984** bytes received. Precisely **996**
  four-byte sync/ID groups, **62** complete 16-ID cycles plus four more
  IDs. No additional PID-data or DTC words in this capture. UART error
  count unknown due truncated terminal line. This original file is
  unchanged (SHA256 `857c83e98fa6197c089ba0599c449b90513f06dbc9ce5601b97d9d862a7b213c`).
- MAX487 RX LED extinguished when ignition was switched OFF, as observed
  by operator. This supports ignition-linked bus activity, but does
  not prove a particular byte's electrical source.

## Desk validation actually performed

1. Firmware `firmware/dcl_readiness_bench/` built and flashed to ESP32.
   It keeps MAX487 `DE=LOW` and tests UART2 INTERNAL loopback:
   `2400/8N2` Echo ID **11/11**, `9600/8N1` CART **64/64**,
   16 reference IDs/parity **PASS**.
2. Previously existing physical MAX487 self-echo verified **10/10**
   at 9600/8N2 with car disconnected. Immediately restored safe firmware.
3. Firmware `firmware/max487_dual_bench/` (explicit self-test only)
   built/flashed while car disconnected. Hardware MAX487 + BSS138 shifter
   self-echo: `2400/8N2 11/11` **PASS** and `9600/8N1 64/64`
   **PASS**, both DE cut-off watchdog `OK`. Immediately restored
   safe firmware. This is local receiver echo, NOT a car ECU response.
4. Final device identity and internal UART test: `STATUS BENCH_ONLY
   DE=LOW NO_DCL_TX_TO_AB`, all tests **PASS**. Firmware left on the
   ESP32 is the **never-drive internal bench** build, not a vehicle
   active diagnostic build.
5. Software test suite: **74/74 PASS**, Node syntax check PASS,
   `dcl_cart_once` compiled PASS, `sniffer` compiled PASS.
6. Web GUI `POST /api/capture/send` now **423 denied** unconditionally;
   both `CaptureManager.send_command` and `SerialCapture.write`
   independently deny direct Python writes.
   Unsafe active quick-command widgets removed. GUI cannot upload
   automatically-transmitting MAX487/XY-K485 bench sketches.
7. Patched sniffer's `uart_read_bytes` to process chunks sized at
   most 128 bytes, preventing `event.size` overflow of a stack buffer.
8. Added offline CART parser and command reference planner:
   `src/ford_dcl/cart_reference.py`. It accepts only uppercase
   A/B/G as *inert reference descriptions* and always returns
   `transmit_authorized=False`, `vehicle_compatible=False`.
   Neither code nor values are declared validated by synthetic tests.

## Discovered protocol ambiguity — critical

Two community implementations are not consistent:

| Candidate | doncreat0r/eeciv `tables.h` | flxkrmr/eec-iv-reader-arduino | Consequence |
| --- | --- | --- | --- |
| A status | `03 81` (1 slot) | not independently qualified for SME-105 | Do not claim official support |
| B read codes | `26 0E` (14 slots) | `26 A4` (4 slots) | **Conflicting wire definition; NOT release-ready** |
| G read PID values | `21 F6` (6 slots) | similar candidate | Original implementation can **repeat indefinitely** |
| C clear codes | `02 91` | state-mutating | **Forbidden** |
| D KOEO/KOER test | `25 3E` | can activate tests | **Forbidden** |
| E send PID map | `41 96` | changes ECU RAM profile | **Not part of read-only allowlist** |

Even commands labeled as readers must be placed in *synchronized CART
slots*, not sent as standalone UART byte pairs. Original scanner uses
4-bit sync alignment then nominal 24-bit slots (~0.417ms and 2.5ms at
9600), conditional direction changes, and a command word in frame ID2
slot1. A flat 10ms-per-frame host log cannot measure exact slot edges
or prove collision-free turnaround.

Public references:

- https://github.com/doncreat0r/eeciv/blob/master/Diag324.c
- https://github.com/doncreat0r/eeciv/blob/master/tables.h
- https://github.com/flxkrmr/eec-iv-reader-arduino

## Electrical and host-release blockers

- The MAX487 board measured ~188Ω across A/B earlier, with a physical
  120Ω (`121`) plus series paths. No independent SME-105 load/current
  limits, A/B differential waveform, transient behavior, or pinout
  document have been authenticated for this specific vehicle.
  Desk loopback cannot prove automotive bus safety.
- Confirm physically that MAX487 DE has a proper 10k pull-down and no
  direct short to GND when GPIO18 controls it; automotive protection
  and series-current-limiting need inspection. Do **not** remove the
  permanent SMD `121` resistor speculatively.
- ESP32 software `esp_timer` DE cutoff is not an independent hardware
  watchdog against CPU/brownout. Opening the USB serial interface may
  reset the ESP32; a per-boot one-shot lock is not a persistent car-session
  limiter. The CP2102 has produced short or prolonged corrupt startup
  output after firmware flashes; the desk verifier fails closed until
  exact quiet identity, with no car command on noisy connections.
- No safe bounded, timing-verified and ECU-validated B/G active command
  firmware has yet been released or flashed. No one should promise
  that simply plugging the current bench firmware into the car will
  produce diagnostic codes or sensor data. It **will not**.

## What remains before *one* next car trip for DTC/PIDs

1. Validate hardware protection/pinout/DE circuit off-car and reconcile
   conflicting B command and any protocol-specific request/response limits.
2. Implement and independently test a fail-closed, bounded CART
   synchronized-slot injector and a parser of **actual** returned slot
   words using an isolated two-node differential emulator/logic analyzer;
   cover bus contention, UART frame errors, loss of sync, reset and power loss.
3. Only then prepare a separately identifiable, explicitly-authorized,
   read-only vehicle firmware with an immutable, single attempt log, verified
   no-clear/no-actuation command allowlist, and host capture that returns
   failure on partial serial output.
4. At car, KOEO with protected adapter and user authorization; never
   issue clear codes / KOEO actuator test / arbitrary memory reads.

**Current release status: desk UART and local transceiver echo PASS;
vehicle DTC/PID acquisition NOT READY.** No new car activity was performed.

## Reproducibility

```bash
PYTHONPATH=src ./.venv/bin/python -m unittest discover -s tests -q
./.venv/bin/python scripts/verify_dcl_desk.py
./.venv/bin/python scripts/analyze_cart_once.py \
  captures/CART_ONCE/20261102T150417765534Z.txt
```
