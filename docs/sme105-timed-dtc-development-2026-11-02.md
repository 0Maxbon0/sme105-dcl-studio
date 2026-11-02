# SME-105 CART timing and stored-code development — 2026-11-02

## What is actually flashed

The latest ESP32 DevKit V1 firmware is
`firmware/sme105_dtc_one_shot/sme105_dtc_one_shot.ino`, with identity
`SME105_DTC_ONE_SHOT_V1`. It was built using PlatformIO ESP32 Arduino core
2.0.17, uploaded to `/dev/ttyUSB0` with esptool SHA verification, and read back
with `scripts/sme105_timed_session.py --action status`.

This firmware **does not send read-codes B** and **cannot yet extract real
stored trouble codes**. `READ_B_ONCE` is denied at compile time as well as
the command interface. Only historical one-shot Echo-ID / Go-CART is available.
The new work is hardware-side UART interrupt timestamping and a timing-only
four-word B scheduler witness; successful compilation is not evidence that
timer-driven differential transmission has been qualified.

## What changed

* `firmware/sme105_dtc_one_shot/`: 2400/8N2 guarded reference handshake;
  9600/8N1 UART2 FIFO interrupt capture; timestamps per received byte;
  strict UART health/coalescing/overflow/cap accounting; independent timer
  interrupt **dry run only** for the four CART command slots ID0–ID3.
* `src/ford_dcl/cart_timed.py`: physical frame and sparse-slot reconstruction
  from device-side byte-completion events; strict parity, cycle progression,
  timing and phase checks. No inference from USB batch arrival time.
* `src/ford_dcl/cart_dtc_candidates.py`: offline read-only candidate path
  requiring a witnessed complete four-word command, post-command DCL mode 26,
  observed status and data slots, and self-test completion. Candidate codes
  preserve both plausible nibble interpretations, physical slot ownership,
  and raw evidence. Flags for confirmed ECU provenance and confirmed DTC read
  remain false.
* `scripts/sme105_timed_session.py`: explicit one-shot host session with
  double firmware identity check, user authorization, immutable raw transcript
  and SHA-256. No retry.
* `scripts/analyze_timed_dtc.py`: offline fail-closed analysis for native
  ISR capture as well as simulated full-command captures.
* `src/ford_dcl/cart_reference.py`: allow a longer frame-edge gap when
  payload slots are actually observed, rather than incorrectly applying
  the ID-only 25 ms bound to possible 14-slot B responses.

## Source-verified protocol information

Reference `doncreat0r/eeciv` transmits a four-frame command block:

| Frame ID | Slot | Word |
|---|---|---|
| 0 | 1 | `01 B0` |
| 1 | 1 | `FF 5F` |
| 2 | 1 | `26 0E` in doncreat0r, **or** `26 A4` in flxkrmr |
| 3 | 1 | `00 A0` |

The conflicting second words are **both valid parity** and imply different
slot allocations (14 vs 4). The actual SME-105 variant is not established by
the saved ID-only vehicle capture. Sending either stand-alone by USB would
ignore physical CART slot timing.

Reference `flxkrmr/eec-iv-reader-arduino` displays three hex digits from a
pair `[b0,b1]` as `((b1 & 0x0F) << 8) | b0`. Existing project decoding
also preserves the alternative `(b0 << 4) | (b1 & 0x0F)` until vehicle-specific
encoding is evidenced. A synthetic word `16 C1` therefore gives
reference candidate `116` and alternate `161`; **neither is a fault
observed from the Escort**.

Research sources:
`https://github.com/doncreat0r/eeciv`,
`https://github.com/flxkrmr/eec-iv-reader-arduino`,
`https://github.com/babroval/ford-eec-iv-diagnostic`.

## Verification and commands

```bash
# No ECU activity: read firmware identity and TX lock status.
./.venv/bin/python scripts/sme105_timed_session.py \
  --port /dev/ttyUSB0 --action status

# Build only:
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_one_shot

# Model tests: C++ compile and synthetic failure handling.
./.venv/bin/python firmware/sme105_dtc_one_shot/verify_b_plan.py

# All Python unit tests.
PYTHONPATH=src ./.venv/bin/python -m unittest discover -s tests -q

# ONLY when explicitly conducting an approved reference vehicle session:
# --action plan-b-once includes 2400 Echo-ID/Go-CART then dry-run
# four-slot scheduler with zero diagnostic B TX.
./.venv/bin/python scripts/sme105_timed_session.py \
  --action plan-b-once

# Afterwards inspect the immutable capture:
PYTHONPATH=src ./.venv/bin/python scripts/analyze_timed_dtc.py \
  captures/TIMED_CART/<UTC-filename>-cart-isr.txt --json
```

The vehicle session command above is **not** the final DTC-reading
procedure, and should not be offered as a guaranteed productive trip.
Do not ask the user to repeat previously successful isolated MAX487/XY-K485
bench byte tests.

## Precise remaining gate to the user's one-visit DTC goal

Complete a bounded full four-word hardware UART TX path that gates DE within
real CART slots, confirm differential start/stop and post-TX turn-around
against physical timing (not USB timestamps), and settle the B 4-vs-14-slot
variant with appropriately grounded evidence. Then obtain a real response
containing post-B DATA slots with no errors, correlate it to the request,
preserve both raw and interpreted code words, and only then call the tool a
real DTC reader. No clear-codes, KOEO run, actuator tests or arbitrary RAW
transmit were implemented.

The original 3,984-byte ECU CART capture is ID-only, not a stored-code
response. It remains immutable.
