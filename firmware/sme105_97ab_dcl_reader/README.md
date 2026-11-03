# Ford 97AB-12A650-KA SME-105, one-shot DCL reader

The user goal is deliberately small: **stored codes first, sensor values
second**. The ESP32 Arduino 2.0.17 image reuses the **existing**
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

The reader combines UART2 TX GPIO17 and native **UART1 RX GPIO16**
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

## First real vehicle attempt: 2026-11-03, V1

The one-shot A4 attempt on the owner's actual 97AB-12A650-KA was
captured unmodified at:

`captures/SME105_97AB/20261103T084338040254Z-dtc-a4.txt`

SHA256:
`9b35758ef5c900a8e0bed0c979c923edf4ca9dfb4c90f23276373b1b33e3df2a`

- ECHO_ID 11-byte local echo+01 ACK, GO_CART, UART1 native 9600 8N1,
  **16 consecutive correct ID0..ID15 frames**, 0 RX/coalesced/errors.
- First B request frame ID0 target at 18,727,952us; ISR timestamp
  18,727,956us (**+4us**). The command-slot start was **421us**
  after last header byte, consistent with the 4-bit CART gap.
- First received byte was **0x6D at +994us** from ISR start; expected
  **0x01 at ~+1042us**. This is fault **9 = InvalidEcho**.
- No byte 2, no confirmed B word, no DTCs. The recorded
  `end_us=0` does **not** mean TX_DONE hardware necessarily failed:
  the early echo mismatch at ~1 byte caused the ISR to mask TX_DONE
  before the two-byte UART transfer would finish.
- The local UART1 RO byte alone cannot identify bus ownership, actual
  GPIO17 bitstream, GPIO18 DE pulse, or differential contention.
  Do **not** blind-retry A4 or switch to 0E.

Run the immutable-source analysis **without the ESP32 connected**:

~~~sh
./.venv/bin/python scripts/inspect_sme105_first_dtc_attempt.py
~~~

### Experimental V2 diagnostics: built but **not yet flashed/tested on hardware**

To distinguish next causes instead of guessing, V2 adds:

- A first-byte failure snapshot with expected/received, UART2 status,
  GPIO18 DE output-mux route/input sample, and exact elapsed timing.
- Parallel read-only RMT0 GPIO16 level run capture, bounded to 48 words,
  with RMTMEM fallback explicitly labeled **unverified** if there was
  no completed RMT packet. No extra GPIOs or wires.
- The **same original desk wiring** test now checks the exact
  first B word `01 B0` as its fourth word (after 55AA, 33CC, 0FF0).
  The bench result additionally requires an actual completed RMT0
  RO waveform packet. It is *not* a simulated ECU success.
- V2 boot/STATUS `ro_scope=1` allows the host to recognize the new
  diagnostic and prevents inadvertently dispatching with the old V1
  before the V2 on-desk test is complete.

The V1 binary currently on the owner's ESP32 was **not overwritten**
by this source-only V2 change. V2 build and software tests have passed,
but until an off-vehicle flash and isolated same-wire desk test succeed,
**do not try V2 B transmission on the vehicle**. No claim is made that
RMT0 instrumented acquisition will work on the real bus yet.

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

For the **V2 diagnostic**, first unplug **vehicle A/B from the MAX487**,
keeping all ESP32/MAX487/BSS138 GPIO connections unchanged, flash the
V2 firmware, and run `status`, `pins`, `rx-test`, and the `desk`
test above. If the exact 01B0 bench word and RO scope both pass, inspect
the saved bench capture before reconnecting to the vehicle. Do not
assume the previously successful V1 4-word desk capture qualifies V2.

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
