# Bench-only dual receiver with the old XY-K485

This plan reuses the ESP32 DevKit, the existing MAX487 manual-direction
module, the older XY-K485 automatic-direction board, and the already
available signal resistors. **No vehicle, no OBD plug, no vehicle power**.

## Identification boundary

Historical project notes identify the older module as an XY-K485
automatic-direction RS485 unit with labels `VCC/GND/TXD/RXD/A+/B-`,
using 3.3 V in the previous bench test. The precise chip and exact
revision of the owner's photographed board have **not** been independently
verified. A manufacturer manual for a matching module design explicitly
defines **RXD as UART DATA OUTPUT** and **TXD as UART DATA INPUT**:
https://joy-it.net/files/files/Produkte/COM-TTL-RS485/COM-TTL-RS485_Manual_2024-04-19.pdf
The owner's prior 3.23 V meter measurement was on **TXD**, not RXD;
it did NOT verify the voltage of the actual receive output. Measure RXD
against GND with the old module powered at 3.3 V before joining to GPIO19.

## Purpose

In one opt-in bench-only test, the MAX487 module drives a *short, isolated*
RS485 pair, and both the MAX487 receiver and old XY-K485 receive the
same test waveform using **independent ESP32 UARTs**:

- ESP32 UART2 RX pin GPIO16: MAX487 RO via 5 V→3.3 V level shifter.
- ESP32 UART1 RX pin GPIO19 (`D19`, next to `D18` on the ESP32 board):
  old XY-K485 **RXD (receiver OUTPUT)**, **only after verifying its output
  voltage remains within the ESP32 3.3 V input limit**.
- UART2 TX pin GPIO17: MAX487 DI (not connected to old XY).
- GPIO18: MAX487 DE via external 10k pull-down to GND.
- GPIO19 is **only an input** for the old module in this desk-only firmware;
  do not also connect it to MAX487 `/RE` or any other signal. Keep MAX487
  `/RE` physically tied to GND. Disconnect the old XY-K485 RXD wire before
  flashing any different firmware that may use GPIO19 as an output.
- Old XY-K485 TXD/DI: hold idle-high via existing 10k resistor to 3.3 V
  *only if confirmed for this XY clone*, so its auto direction stays
  receive; do **not** drive an unknown pin.

Electrical safety rules:

1. Completely disconnect old and new boards' A/B from the car/ECU.
2. Leave ESP32 powered **only by laptop USB**. Keep grounds common.
3. MAX487 VCC stays on its verified **5 V** rail, and its RO still passes
   through existing BSS138 shifter before GPIO16.
4. Old XY VCC is **3.3 V only if its pinout/supply is confirmed**.
5. After separately confirming supply, pin identity, RXD <=3.3V and that the
   old module remains in receive mode with its TXD held idle HIGH, use a short
   **direct** bench pair: MAX A -> XY A+ and MAX B -> XY B−. No vehicle or
   other equipment may touch that pair. 10k series resistors are **not**
   suitable for this terminated RS485 link: they can attenuate the differential
   signal enough to make the experiment invalid. Direct links are conditional
   on both modules being electrically compatible and the old auto-direction
   transmitter being inactive; they do not provide current limiting against
   two active drivers. If that cannot be verified, STOP rather than connect.
   If the old board has a switchable 120Ω termination, leave it OPEN. Do not
   remove the MAX487 soldered `121` resistor.
6. Do not connect ESP32 GPIO4 or GPIO21 to A/B for this test, unlike
   `firmware/bench_test`, and **never tie B− to GND**.
7. If pin labels, supply or UART output level cannot be confirmed, stop
   before applying power; a close-up photo can resolve the physical model.

## Firmware already prepared (NOT FLASHED)

`firmware/rs485_two_receiver_bench/` is a **separate bench-only build**:

- USB 115200 ASCII: `STATUS` reports identity and no automatic TX.
- Only the explicit `START_DESK_TEST` command can start a transmission,
  **one attempt per boot**; any other command fails closed.
- Stage 1: MAX sends the proven 11-byte Echo-ID vector at 2400/8N2;
  UART2 (MAX RO) and UART1 (old XY RO) must each read the identical
  bytes with zero reported UART errors.
- Only if stage 1 succeeds: stage 2 sends 64 reference sync/ID bytes
  at 9600/8N1, validates both receiver streams, and compares byte-for-byte.
- MAX DE remains LOW before/after the test and has a software 100ms cutoff.
  The software deadline is not an independent hardware safety device.
- A UART echo (even from two modules) tests the differential receive path
  **not real ECU command semantics or precise microsecond CART slots**.

The ESP32 currently carries `dcl_readiness_bench` (DE permanently LOW).
Keep it there until the old board's pinout and bench wiring are ready.
When ready, the assistant can flash `rs485_two_receiver_bench`, run one
USB-approved test, save the exact console log, **then restore and verify**
`dcl_readiness_bench` immediately.

2026-11-02 desk-only preparation checks completed:

- `rs485_two_receiver_bench` **build PASS**.
- Temporarily uploaded the bench-only image *without* an old board
  connected. A USB-only `STATUS` query returned the exact expected
  `STATUS TWO_RECEIVER_DESK_ONLY DE=LOW TX=WAITING_FOR_START_DESK_TEST`.
  **No** `START_DESK_TEST` was sent and no dual-receiver differential
  comparison was claimed.
- Restored `dcl_readiness_bench` (SHA verified by esptool), then
  read back `STATUS BENCH_ONLY DE=LOW NO_DCL_TX_TO_AB` and re-ran the
  internal UART self-test successfully.
- The CP2102 on this laptop sometimes emits corrupt serial bytes
  immediately after flashing or reopening. Its startup data must not
  be mistaken for verified firmware identity. Even if a quiet readback
  requires reopening the port, **no vehicle-side START is allowed**.
- Python offline suite remained **74/74 PASS**.

2026-11-02 first live dual-receiver desk test (incomplete physical wiring):

- Firmware flashed and USB STATUS verified with CP2102 RTS/DTR deasserted.
- Exactly one START_DESK_TEST was sent. The first 2400/8N2 stage reported
  `FAIL ECHO_ID_2400_8N2 max=11/11:MATCH xy=0/11:BAD`
  with no UART errors and DE cutoff OK. The second 9600 stage was skipped.
- **Owner clarified afterward that the A/B terminal blocks of both modules
  were completely UNCONNECTED during this attempt.** This is a sufficient
  explanation for the old receiver obtaining 0 bytes. The successful MAX487
  stream was only local self-echo, NOT a two-module differential validation.
- Independently, the earlier plan had also inverted the `TXD`/`RXD` labels
  of the old board, assuming TXD was output and RXD input. A matching-module
  manual says RXD is output, TXD input, but exact clone behavior still needs
  verification. Do not attribute the 0-byte result to pin direction alone.
- Exact output saved as `captures/rs485-two-receiver-desk-20261102-182127.log`.
- Restored `dcl_readiness_bench` via PlatformIO (flash SHA verified) and
  observed `STATUS BENCH_ONLY DE=LOW NO_DCL_TX_TO_AB` on USB.
- Do not repeat until old XY `RXD` idle-output voltage has been measured,
  the TTL connection corrected, and two isolated A/B links are installed
  and checked with USB power off. Do not substitute 10kΩ series resistors
  on A/B. Only use a direct short isolated pair once old module receiver mode
  and compatibility are confirmed; otherwise stop and identify the hardware.

**Pending physical work:** owner to measure old-module RXD output voltage,
then move GPIO19 to RXD and move the 10k 3.3 V pull-up to TXD (power off).
Verify series-resistor A/B wiring before any new test. Nothing grants approval
to connect the old XY module to the car.

## 2026-11-02 second physical bench attempt — PASS

Owner confirmed that old XY-K485 RXD and TXD both measured approximately
3.23 V while powered, moved old RXD to ESP32 D19, tied TXD through 10k to
3V3, and connected MAX487 A->XY A+ and MAX487 B->XY B- directly on a desk-only
isolated pair. No vehicle connection was part of this test.

- `rs485_two_receiver_bench` rebuilt and flashed through `/dev/ttyUSB0`:
  PlatformIO upload PASS, image hashes verified by esptool.
- USB firmware identity confirmed via `STATUS TWO_RECEIVER_DESK_ONLY DE=LOW
  TX=WAITING_FOR_START_DESK_TEST` with RTS/DTR deasserted.
- Sent exactly **one** `START_DESK_TEST`.
- `PASS ECHO_ID_2400_8N2 max=11/11:MATCH xy=11/11:MATCH de_cutoff=OK
  uart_errors_max=0 uart_errors_xy=0`.
- `PASS CART_9600_8N1 max=64/64:MATCH xy=64/64:MATCH de_cutoff=OK
  uart_errors_max=0 uart_errors_xy=0`.
- Terminal outcome `SELFTEST PASS`. Captured at
  `captures/rs485-two-receiver-desk-20261102-183733.log`.
- Immediately restored `dcl_readiness_bench` via PlatformIO, verified flashed
  SHA, and confirmed `STATUS BENCH_ONLY DE=LOW NO_DCL_TX_TO_AB` over USB.

**Boundary:** This validates the desk-only two-module UART/RS485 receive
path for the tested waveforms, not ECU wiring, electrical transient protection,
Ford-specific initialization, DCL timing, or vehicle-safe active transmission.
The previous pending physical-wiring checklist is now historical and complete.

Never flash the historical `bench_test` / `max487_bench` auto-send sketches
in preparation for a vehicle visit.
