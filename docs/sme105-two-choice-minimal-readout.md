# SME-105 minimal readout: two manual B variants, not a full scanner

Goal: retrieve stored trouble codes first, then a small group of live sensor
PIDs. A commercial GUI, clear codes, KOEO actuator routines, automatic
retries and arbitrary ECU commands are out of scope.

## Two different candidates, NEVER automatic attempts

Both references encode four two-byte CART request words in IDs 0,1,2,3,
slot 1 after the header, not one flat UART command. The final nibble of
the ID2 word is the claimed following frame's number of slots.

| Choice | Four fixed command words | B ID2 slot 1 | Next-block slot count |
| --- | --- | --- | --- |
| A4 | 01 B0; FF 5F; 26 A4; 00 A0 | 26 A4 | 4 |
| 0E | 01 B0; FF 5F; 26 0E; 00 A0 | 26 0E | 14 |

Evidence: flxkrmr/eec-iv-reader-arduino src/EecIv.cpp
REQUEST_CONT_SELF_TEST_CODES (8-byte exact request sequence), and
doncreat0r/eeciv tables.h cmdData 'B' read codes plus Diag324.c slot
sequencing. These are community ECU examples, not SME-105 qualification.

## Implemented locally

- firmware/sme105_dtc_active_candidate already models exactly these two
  selections, with BENCH_B_A4_ONCE and BENCH_B_0E_ONCE. Both are
  compile-locked; do not flash onto an ECU-connected ESP32.
- Inert PREVIEW_B_A4 and PREVIEW_B_0E commands now show which four
  words and response-slot count WOULD be used, without transmitting.
- src/ford_dcl/cart_dtc_candidates.py now rejects response frames
  exceeding the selected B variant's slot limit. It emits unverified
  candidate codes only when all timing and response status gates pass.
- scripts/analyze_timed_dtc.py can read and parse a raw, intact native
  CART response record; it NEVER claims a verified ECU DTC.
- scripts/check_sme105_b_variants.py confirms the old V5 received
  header/parity data approx 6041us too late to arm the live slot. Do not
  repurpose that V5 ISR for an active B request.

The proven MAX487+XY-K485 desk session passed 4/4 **synthetic** words,
not a live ECU CART B command or a contention test.

## Minimal experiment sequence

1. Leave firmware/dcl_readiness_bench flashed and MAX487 A/B away
   from vehicle until verified OBD pinout, polarity, electrical load,
   transient protection, and fail-low DE. A pad-level UART/RMT echo
   does not prove collision-free differential drive on the car.
2. Bench-qualify the source-pinned four-word CART **synchronized**
   injector with an independent differential emulator or logic
   capture, including a real 14-slot response, STOP, corrupt ACK,
   lost sync and hardware cutoff. Do not unlock B based only on
   the existing unsynchronized four-word desk PASS.
3. On a qualified vehicle interface use KOEO, one **manually chosen**
   read-only B variant and ONE bounded attempt. Always save the
   entire raw capture and SHA256. If anything fails, stop and
   analyze the original file before any other choice or retry.
4. On a complete, authentic native B capture, the offline command is:

   ~~~sh
   PYTHONPATH=src ./.venv/bin/python scripts/analyze_timed_dtc.py \
     captures/ACTUAL_CAPTURE.txt --json
   ~~~

5. Only after DTCs, use a separately qualified G=21 F6 PID request.
   One source reader also sends a PID map, changing ECU request RAM.
   Do not blindly send G as an OBD-II-style sensor query. Start by
   preserving raw PID words, then verify RPM/ECT/TPS scaling.

Current state: safe firmware restored and verified, no ECU B transmitted
and no real stored DTC or live PID value obtained. This plan does not
authorize vehicle TX.
