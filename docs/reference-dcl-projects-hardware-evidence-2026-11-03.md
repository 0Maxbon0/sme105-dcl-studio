# Ford DCL projects: hardware similarity, verified scope, and chosen reference

Research date: 2026-11-03. Scope is a **minimal**, single-owner Ford Escort
1998 1.6 Zetec **SME-105** DTC readout first, then a few raw sensor values.
Do not turn this into a scanner UI, ECU programmer, KOEO/KOER actuator tester,
or generic EEC-IV project. Keep the MAX487 vehicle TX disabled pending
electrical and synchronized-slot validation.

## Direct source comparison

| Source | MCU / host | DCL interface and timing | Public outcome evidence | Limits |
| --- | --- | --- | --- | --- |
| flxkrmr/eec-iv-reader-arduino | **Arduino Uno / ATmega328P**; C++ Arduino/PlatformIO, OLED, buttons, optional GUI | KiCad places **MAX485E U1**; SoftwareSerial and microsecond delays; no external PC required for embedded UI | **Best explicit car-level test table:** 1995 Mondeo 1.6 fault experiments (111, 159, 519, 118, 113), Mondeo 1.8 ECU, Escort MK7 1.6 listed working **96AB-12A650-KB**. Author reports one stored memory DTC displayed; KOEO/KOER system tests described | README says work-in-progress, not completely working. UI's live-data code and PID wiki are **not proof** of working live sensors. Tested Escort ECU part is commonly listed **SME-405**, not the target SME-105 |
| doncreat0r/eeciv | **ATmega324P** with two hardware UARTs; C / AVR peripheral register code | UART1 to **MAX485**, UART0 to MAX232 PC; 11.0592 MHz UART crystal; timer/interrupt-driven CART, manual RS-485 DE | Most directly reusable **device-side real-time architecture** and larger DCL protocol/command table with B=26 0E and G=21 F6 | Source code and comments, but empty upstream README and no comparable per-ECU published DTC/PID vehicle test table. Cannot call it validated on SME-105 or feature-complete |
| babroval/ford-eec-iv-diagnostic | **ATmega128**, AVR Assembly firmware/HEX, CP2101 USB, Java Swing | hardware UART0 PC, UART1 through **75ALS176** differential transceiver; timing-sensitive MCU mediates PC | **Broadest delivered implementation:** firmware HEX, PC GUI, faults and parameter CSV dictionaries, Java FAULTS / DATA / KOEO / KOER controls, screenshots, protocol map; README describes operational interface | A GUI feature or image is not an independent captured response; no provided direct evidence for the exact SME-105. Different transceiver and assembly architecture require careful port, not copying instructions to ESP32 |

### Material difference between same *car* and same *ECU*

flxkrmr's wiki lists the Escort MK7 1.6 as working with Ford number
`96AB-12A650-KB`. Independent ECU catalogues label that part **SME-405**.
The user's unit is **SME-105**, and no complete Ford part number from the
unit label has yet been bound to that wiki table. Related Escort body and
engine family increase relevance, but **do not prove ECU protocol
compatibility**. Parts sources also list *some* 1998 1.6 Zetec ECUs as
SME-105, so exact part number/catchword matters more than model year.

## Ranked decision (two distinct goals)

1. **Start from flxkrmr's tested memory-DTC protocol behavior**, including
   its whole DCL session and four-word A4 command block. It has the best
   public vehicle fault injection evidence plus a placed MAX485E similar
   to our MAX487. Do not copy its SoftwareSerial timing implementation
   or assume its 1-code display is a requirement: log *all* raw candidate
   slots and decode offline.
2. **Borrow doncreat0r's UART/timer architecture**: MCU, not PC COM timing,
   performs handshake and CART transitions; RX on hardware UART, deterministic
   DE cutoffs and slot timing. ESP32 UART1/UART2 + RMT/TIMERG0 replace the
   AVR registers; only forward captured bytes to Linux/Python afterward.
   Keep B=26 0E as a **separately identified alternative**, never an
   automatic retry following A4 uncertainty.
3. **Borrow babroval's complete host-side data/semantics**, e.g. its
   experimentally assembled command map, fault and PID dictionaries, and
   raw response to human-readable code mapping. Do not port ATmega128
   assembler or Java UI (not needed for minimal readout). Treat unverified
   conversions as hypotheses until a real ECU value is cross-checked.

Assembly is not a protocol requirement: the AVR author used low-level
interrupt/register control appropriate to a deterministic ATmega128
implementation. The ESP32 can reproduce the *timing contract* using
peripherals while the host remains display-only. Do not assume the
unsynchronized isolated four-word RS-485 test proves a live CART slot.

## Practical minimal transport and acceptance

Preserve the current physical arrangement **ESP32 GPIO17 -> MAX DI,
GPIO18 -> MAX DE with 10k pull-down, MAX /RE -> ground, MAX RO through
the BSS138 translator to GPIO16**, and hardware USB serial for logs.
The isolated MAX/XY 4-word differential test already passed 4/4, but
**car A/B stay disconnected**. The currently flashed
`dcl_readiness_bench` has been verified over USB:
`STATUS BENCH_ONLY DE=LOW NO_DCL_TX_TO_AB`.

Next implementation should be a small, *source-pinned port*, not a new
generic protocol:

1. Exact flxkrmr Echo-ID / Go-CART / B A4 state transitions as an offline
   state machine with a reference-frame test fixture. Note: flxkrmr first
   requests a DCL error/flag reset (01 F4), which **mutates ECU state**;
   do not silently include it in a supposedly read-only first attempt.
2. Hardware UART1 decoding for MAX RO16 (the desk result), UART2 TX17
   and bounded external driver timing on GPIO18. Prove
   synchronization from ID0..15 on *realistically emulated* CART timing,
   including bad parity and variable 4/14-slot response cadence.
3. Save the entire bounded raw UART/RMT evidence, including locally
   transmitted vs received byte origin, complete-ACK uncertainty,
   phase loss, FIFO errors, DE duration and STOP; never infer ECU origin
   from the local echo alone. One attempt, no automatic alternative.
4. Apply the existing DTC candidate parser to complete validated frames;
   preserve the hexadecimal raw words and candidates until a Ford-specific
   code interpretation is corroborated. Then tackle `G=21 F6` and
   source-defined PID maps in a separate non-clearing experiment.

**Blocking before any B sent on the car:** ECU exact part number/pinout,
physical automotive protection and bus loading, independent synchronized
differential DE/turnaround proof, and clarity on the candidate's status
reset. Do not treat GPIO pads or cloned transceivers as automotive certified.

## Primary source pointers (checked 2026-11-03)

- flxkrmr README/status: https://github.com/flxkrmr/eec-iv-reader-arduino
- flxkrmr tested cars, faults, ECU number:
  https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/Testing
- flxkrmr memory-code limitation / KOEO tests:
  https://github.com/flxkrmr/eec-iv-reader-arduino/wiki/Manual
- flxkrmr Uno board:
  https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/platformio.ini
- flxkrmr KiCad MAX485E U1:
  https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/pcb/EEC-IV-Reader.kicad_sch
- flxkrmr CART / fault code protocol source:
  https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/Cart.cpp
  https://github.com/flxkrmr/eec-iv-reader-arduino/blob/master/src/EecIv.cpp
- doncreat0r C UART1/MAX485 and timer:
  https://github.com/doncreat0r/eeciv/blob/master/Diag324.c
  https://github.com/doncreat0r/eeciv/blob/master/tables.h
- babroval implementation and PC GUI:
  https://github.com/babroval/ford-eec-iv-diagnostic
- Parts catalogue distinguishing tested Escort 96AB-KB as SME-405:
  https://carelectronicsuk.com/en-fr/pages/stock-2
- Parts catalogue proving 1998 Escort Zetec 1.6 can have SME-105:
  https://www.obdtester.com/ford-ecu-update/escort/1.6l_zetec/1998/98AB-12A650-BCC

**Licensing note:** flxkrmr is GPL-3.0; babroval is MIT; doncreat0r
has an MIT statement in its C source but no GitHub-recognized repository
LICENSE in the examined tree. Reimplementing interfaces from documented
behavior and adding our own tests is preferable to indiscriminately copying
licensable source code between these projects.
