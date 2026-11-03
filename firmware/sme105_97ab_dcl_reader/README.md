# Ford 97AB-12A650-KA SME-105, one-shot DCL reader

## V4: vehicle RAW capture, adapted from existing CART references

The owner's priority is **save the actual UART receive stream**, not
interpret or translate DTCs. No further isolated desk trial is required for
this V4 workflow. The PC saves a full timestamped `.txt` capture and an
unchanged-order UART1 RO `.bin` file, both with SHA256.

The V3 one-word car probe (`20261103T091354379996Z-probe-first.txt`,
SHA256 `f336195b30228ba7c1c526118f0effe7b3f874cd22a08083455ef88cf22fb52d`)
reproduced `6D` where `01` was expected. Its first four unverified DI
RMT items also resemble a 9600/8N1 `6D` byte. This points to a specific
TX path to investigate, **not** to proven ECU response or a decoded DTC.
The V3 ISR wrote UART2 FIFO through an APB bitfield; the installed ESP32
vendor HAL instead writes TX bytes to `UART_FIFO_AHB_REG(2)`. V4 adopts the
vendor's AHB write convention for its RAW command.

V4 sends the reference `01 B0 | FF 5F | 26 A4 | 00 A0` sequence in
ID0..ID3 diagnostic slots, following
`flxkrmr/eec-iv-reader-arduino` `Cart.cpp` / `EecIv.cpp` behavior and
`doncreat0r/eeciv` CART timing. It checks 16 ID headers first and only
schedules subsequent fixed words if the next actual ID header has the
expected parity/cadence. **A mismatching local echo no longer discards
the raw stream or suppresses the next correctly scheduled word**.
Four TX slots maximum, 10-second fixed capture, no auto repeat/clear/test,
and no attempt to classify the bytes. The MAX487 `/RE` is grounded, so
RO includes possible local self-echo; there is no verified separation of
ECU-origin and self-echo bytes without additional physical measurement.
The flxkrmr B=26A4 variant is an experiment, not proven for this SME-105.

Manual one-shot on the car with key ON, engine OFF:

~~~sh
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py \
    --action raw-a4 --vehicle-confirmed
~~~

Type `RAW_A4_ONCE` once. The CLI saves `captures/SME105_97AB/*-raw-a4.txt`
and `*-raw-a4.bin`, prints both hashes, and does not interpret DTC codes.
An incomplete word sequence is still saved as evidence. No USB command
triggers a vehicle attempt unless the operator types the exact token.

## V4 actual vehicle capture — raw evidence, not ECU response

Actual file: `20261103T161832567760Z-raw-a4.txt` SHA256
`5476da95cc511bf1679ab722b57dd4f5f1e97b03edcfa2f7b605d87f4d08f387`.
Its `.bin` SHA256:
`b1d3aea06622a635872e8347630e5e0fa89eb1c71716962d6b0bf513f5d42d86`.
The 3993 binary bytes exactly equal all 3993 UART1 `CART_EVT` records.
There are exactly 996 correct cyclic four-byte ID headers
(`00 00 00 parity/ID`), eight additional bytes during the four TX slots
and a final truncated ID sync `00`. No data slots appear anywhere else.
The 996 ID frame intervals are 9999..10000µs.

| Our UART2 word | RO bytes in the same slot | TX_DONE delay |
| --- | --- | --- |
| `01 B0` | `6D CC` | 2088µs |
| `FF 5F` | `21 E9` | 2088µs |
| `26 A4` | `6C 3C` | 2088µs |
| `00 A0` | `98 47` | 2088µs |

All eight RO bytes are at the expected serial byte completion phase
(+994/+2035..2036µs after slot start) but **none equals the intended TX
byte**. The four received pairs also fail CART vertical parity. Four
UART2 TX_DONE events do not validate GPIO17 DI, MAX487 DE/A-B, ECU acceptance,
or a DTC. All remaining ~9.7 seconds are only cyclic ID headers. The
first `6D` also appeared in V1/V3, so the V4 AHB FIFO change did not fix it.

## V5 field-only source witness

The next firmware retains exactly the same RAW `A4` bytes and their
bounded four TX slots. It additionally starts *input-only* RMT1 on existing
GPIO17 before the first slot and captures a single completed waveform
packet covering the four words. A 15ms temporary RMT idle threshold spans
the 10ms between slots but ends after the last word; no unverified RAM
fallback is allowed. During the first RX stop bit of each word it also
records a GPIO18 DE pad sample and the GPIO17/18 output matrix routes.
GPIO18 input sensing is re-enabled **after** RMT output configuration.
These are local pad witnesses, not differential A/B evidence. The original
`.txt` and `.bin` raw UART1 saves remain unchanged. No new wiring, no
additional ECU commands, no DESK run.

Use the exact same `--action raw-a4 --vehicle-confirmed` command shown
above and manually confirm `RAW_A4_ONCE` only after checking the device
reports `SME105_97AB_READER_V5`; **do not reuse the old V4 capture as if it
contained these new DI/DE measurements**.

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

## V3: first-word-only car diagnostic, flashed and bench-verified

After a complete isolated V2 desk run passed twice (raw captures
`20261103T090337573272Z-desk.txt` and
`20261103T090411542115Z-desk.txt`), V3 was built and flashed on the
ESP32, with the unchanged GPIO connections. It is a separate
**one-word diagnostic**, not a fresh full fault-code read.

- `PROBE_B_FIRST_ONCE` performs the same exact reference handshake
  and validates 16 CART ID headers, then emits **at most one source-fixed
  2-byte word: `01 B0`** in ID0 slot1. After it gets both local echo bytes
  and TX_DONE, it deliberately stops *before* ID1 or any other B word.
  If the first byte is wrong it aborts immediately as in V2.
- Parallel GPIO17 **DI pad** RMT1 and GPIO16 **RO pad** RMT0 waveform
  probes run only during the first word. GPIO17 is an
  INPUT_OUTPUT (still driven by UART2 TX); both RMT inputs are restored
  by the normal GPIO matrix routine after port initialization. No wires,
  output GPIOs or line driver commands have been added.
- On mismatch the capture includes
  `CART_FIRST_ECHO_MISMATCH`, `CART_RO_RMT`, `CART_RO_EDGE`,
  `CART_DI_RMT`, `CART_DI_EDGE`, and
  `CART_PROBE_RESULT first_word_confirmed=0`.
  These are independent **ESP pad** observations, not differential
  A/B measurements or proof of ECU acceptance.
- V3 was flashed successfully, its flash write hashes verified and
  STATUS/PINS/RX_TEST passed. An actual isolated MAX487 bench run
  passed all 4 synthetic words, including 01B0, with UART1 echo and
  UART2 TX_DONE. Both RMT channels captured completed packets.

Exact isolated V3 desk evidence:

`captures/SME105_97AB/20261103T091141184623Z-desk.txt`

SHA256:
`1040616f06174002f5b0cfc2acec026b17cce5d4cfe042e48248b53eab2a1474`

**Next single in-car diagnostic**, only after the isolated desk test and
the adapter is returned to its verified vehicle DCL port, key ON
engine OFF:

~~~sh
PYTHONPATH=src ./.venv/bin/python scripts/sme105_97ab_session.py \
    --action probe-first --vehicle-confirmed
~~~

Type `PROBE_B_FIRST_ONCE` at the prompt. Preserve the new raw file
under `captures/SME105_97AB/` for next analysis.
Do NOT follow it immediately with `dtc-a4`, `dtc-0e` or another
probe. If the single 01B0 word is confirmed, that is **not a DTC**
result: the next software iteration will decide the full B sequence.
If it fails, compare DI17 and RO16 waveforms, reason code, UART status
and DE route against the two verified desk captures before changing
the bus timing or firmware.

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
