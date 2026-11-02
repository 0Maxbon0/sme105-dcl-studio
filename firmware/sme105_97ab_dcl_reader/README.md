# Ford 97AB-12A650-KA SME-105, one-shot DCL readout prototype

The user goal is deliberately small: **stored codes first, sensor values
second**. This new ESP32 Arduino 2.0.17 image reuses the **existing**
ESP32 + MAX487 + BSS138 wiring, with **no other GPIO jumper or XY-K485**.

## Exactly the unchanged existing pins

- GPIO17 -> MAX487 DI; GPIO18 -> MAX487 DE with existing external 10k
  pulldown; MAX487 /RE -> GND.
- MAX487 RO -> BSS138 5V-to-3.3V translator -> ESP32 GPIO16.
- GPIO19 and GPIO21 **unused**; MAX487 5V and ESP32 USB as already tested.
- CAR/ECU bus A/B **disconnected during desk testing**.

No code is sent on startup, STATUS, PINS, RX_TEST or PREVIEW commands.
The explicitly named READ_DTC_A4_ONCE or READ_DTC_0E_ONCE consumes its
one-shot before attempting any reference handshake; no automatic retry,
memory-clear, ECU self-test or actuator command exists. The lock resets
if USB/ESP32 resets; one-shot means one attempt per boot, NOT persistent.

## Evidence-based construction

Existing live vehicle captures proved the candidate 2400/8N2 Echo-ID
and Go-CART can produce 9600/8N1 reference-compatible ID cycles.
An actual UART1 receive-only CART dry run recorded 4 timer slot targets
at +3/+4/+3/+4us. The isolated two-module RS485 test confirmed exact
4/4 synthetic words, but never tested an ECU B command.

This new source combines UART2 TX GPIO17 and native **UART1 RX GPIO16**
(the exact receiver proven on desk), separate UART2 TX_DONE ISR and
four RMT2..RMT5 **autonomous 2180us finite DE gates** on GPIO18.
The timer ISR schedules four *fixed* commands in consecutive CART frame
IDs0..3 slot1 after one validated 16-ID baseline; no Python/USB
per-byte timing. TX_DONE, two local echo bytes, parity, timing, stop,
overflow and cutoff failures abort further words.

The manual choices are source-backed but **experimental**:

- A4: 01 B0 | FF 5F | 26 A4 | 00 A0; next block **4 slots**
  (flxkrmr/eec-iv-reader-arduino).
- 0E: 01 B0 | FF 5F | 26 0E | 00 A0; next block **14 slots**
  (doncreat0r/eeciv).

The 2400 Echo-ID step is borrowed from doncreat0r and matches old
vehicle observations, **not** from flxkrmr (whose source sends
Go-CART directly). The flxkrmr full workflow also uses an earlier
DCL error/flag clear command 01 F4 which this experimental minimal
reader intentionally does **not** send (it changes ECU DCL state).
Consequently lack of response to A4 would not prove 0E is correct.

Original native RX ISR timestamps and raw word bytes are captured for
up to 10 seconds after the handshake, then dumped over USB. The
host saves the entire native evidence and SHA256. Source-aligned
stored-code candidates are **unverified** until confirmed on the exact
ECU, even when B gets a local echo and a plausible status response.
Do not treat A/B line loading, transient behavior, car-side polarity,
or bus collision handling as proven by the desk test alone.

## One actual successful same-wire desk test

2026-11-02 22:43:59Z host capture:

`captures/SME105_97AB/20261102T224359048789Z-desk.txt`

SHA256:
`bd2adff2add392c8fb46afdcf8b19c5fe08da8047e749f2ca0a63ad52525b132`

- 4/4 synthetic words: 55AA, 33CC, 0FF0, 6996, all **exact** via
  MAX487 RO -> UART1, with UART2 TX_DONE observed once per word.
- TX_DONE offsets: **2115/2092/2088/2088us** after enabling word.
- UART errors 0, coalesced 0, cutoff 0, DE LOW at end.
- This is local MAX RO self-echo only (no XY now). It is NOT proof of
  97AB-KA ECU DTC or sensor read, no DE differential collision test.

## Host commands

From project root, with current USB connected:

~~~sh
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py --action status
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py --action pins
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py --action rx-test
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py --action preview-a4
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py --action preview-0e
~~~

ONLY on the isolated desk with car A/B physically disconnected:

~~~sh
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py \
    --action desk --isolated-confirmed
~~~

When a suitable **protected** DCL adapter is independently verified and
the vehicle is in KOEO (engine off), only one manually authorized
diagnostic attempt per session, with no automatic alternate:

~~~sh
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py \
    --action observe-cart --vehicle-confirmed
# only if the reference CART capture is valid, at a NEW session:
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py \
    --action dtc-a4 --vehicle-confirmed
~~~

The host requires typing the full MCU command for the vehicle attempt
and keeps the raw capture in `captures/SME105_97AB/`. Use `dtc-0e`
**only** as a separately considered alternative after inspecting the
first session evidence. Preserve files even on protocol rejection.

**Live sensors (G=21 F6) are not implemented or claimed in V1**. The
reference scanner first negotiates an ECU PID map (E=41 96 and
multiple map-upload frames); a bare G command is not sufficient. Add
that separately **after** the first successful actual B response, with
raw RPM/ECT/TPS values verified before converting to engineering units.

Build/flash (when device has *no vehicle connection*):

~~~sh
./.venv/bin/python -m platformio run -d firmware/sme105_97ab_dcl_reader
./.venv/bin/python -m platformio run -d firmware/sme105_97ab_dcl_reader \
    -t upload --upload-port /dev/ttyUSB0
~~~
