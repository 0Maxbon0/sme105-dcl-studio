# SME105 four-slot *isolated dual-RS485 desk* firmware (NOT vehicle firmware)

**Safety boundary:** Send exactly four non-Ford synthetic 9600/8N1 words,
`55AA, 33CC, 0FF0, 6996`, each 10ms apart, and require exact echoes from
both transceiver receivers. This does **not** send Echo-ID, Go-CART, B, any
diagnostic command, clear/KOEO/actuator command or packet to any ECU. Compile
lock: `SME105_VEHICLE_TX=0`. No output on boot; only the explicit USB
`BENCH_RS485_ONCE` triggers one attempt per reset. The lock does not persist
across USB reset and does not authorize any vehicle use.

## Rewire with power removed, ESP32 USB ONLY

Before all wiring **disconnect car/OBD/ECU entirely and unplug laptop USB**.
Remove prior GPIO17→GPIO16 and GPIO18→GPIO19 resistive jumpers.

| From | To | Function |
| --- | --- | --- |
| ESP32 D17/GPIO17 | MAX487 DI | UART2 TX at 9600 8N1 |
| ESP32 D18/GPIO18 | MAX487 DE | output enable, with external **10k pulldown to GND** |
| MAX487 /RE | GND | receiver always enabled |
| MAX487 RO | **BSS138 level shifter (HV side 5V)** then ESP32 D16/GPIO16 (LV 3.3V) | MAX RX, via appropriate 5V→3.3V adaptation |
| XY-K485 **RXD** | ESP32 D19/GPIO19 | second RX output, previously verified ≈3.23V |
| XY-K485 **TXD** | 10k pullup to ESP32 3V3 | old automatic module stays receiver-only as tested |
| ESP32 D21/GPIO21 | 1k resistor → D18/DE line | independent 3.3V DE sense, **never A/B** |
| MAX487 A | XY-K485 A+ | short isolated differential pair |
| MAX487 B | XY-K485 B− | short isolated differential pair |
| MAX487 VCC | verified USB 5V | existing MAX487 5V module |
| XY-K485 VCC | verified ESP32 3V3 | only the **previously tested** board |
| ESP32, MAX487, XY | GND common | share ground |

Use the verified BSS138 connection **HV=5V, LV=3.3V, shared GND**, with the
MAX RO high-voltage line on HV and GPIO16 on LV. **Do not connect RO 5V to
ESP32**, or XY RXD if its measured HIGH exceeds 3.3V. Keep prior MAX's
onboard `121` resistor untouched; leave any optional XY 120Ω terminator
OPEN. Do not put 10k *series* resistors in A/B and do not tie B− to ground.
Do not enable two RS485 drivers against each other: XY TXD held idle HIGH
is conditional on the previously tested exact board and its observed
receive-only mode. Stop if the board or wiring differs.

## Read-only checks / build (without changing firmware on device)

```bash
cd "/media/maxim/MAX/Docs/Maxim Docs/Maximizo/escort scanning"
./.venv/bin/python -m platformio run -d firmware/sme105_rs485_four_slot_isolated
```

Do not upload until the wiring has been physically moved and checked. **The
currently flashed GPIO-only firmware must NEVER be powered with MAX487.**
Once physically verified off-vehicle, the designated build can be flashed:

```bash
./.venv/bin/python -m platformio run -d firmware/sme105_rs485_four_slot_isolated -t upload --upload-port /dev/ttyUSB0
./.venv/bin/python scripts/sme105_rs485_four_slot_session.py --port /dev/ttyUSB0 --action status
./.venv/bin/python scripts/sme105_rs485_four_slot_session.py --port /dev/ttyUSB0 --action pins
```

Only if both read-only checks show exact ID, `used=0`, `PINS max16=1
xy19=1 de21=0`, and all power/level/wiring checks physically pass:

```bash
./.venv/bin/python scripts/sme105_rs485_four_slot_session.py \
  --port /dev/ttyUSB0 --action bench --isolated-confirmed
```

The firmware then performs a **35µs isolated DE-only active preflight** (DI
held idle HIGH) to prove the independent GPIO21 sense follows GPIO18
LOW/HIGH/LOW, and checks both UART receivers idle HIGH. This briefly asserts
the MAX487 driver and is permissible **only** on a genuinely isolated desk
pair. Preflight failure emits **zero UART bytes**. One-shot UART test then
sends four bounded words and verifies two independent receive paths:
UART1 MAX487 RO GPIO16 exact two-byte echo with real UART arrival timestamps,
and RMT6 XY-K485 RXD GPIO19 strictly decoded 9600/8N1 digital pulse runs.
RMT6 has no absolute XY byte arrival timestamps; none are invented.
RMT0 separately captures MAX RO GPIO16 level transitions, and RMT1 measures
physical DE GPIO21 duration. Four distinct RMT2..RMT5 channels each
produce a single <=2180µs autonomous DE HIGH pulse; separate UART2 TX_DONE
may release DE early. TIMERG0 backup 2250µs cutoff is CPU-interrupt-dependent
and not an independent electrical protector. No retries or vehicle logic.

## Real isolated A/B desk results (2026-11-02)

The initial revisions correctly failed closed when UART2 RX decoded
D1 instead of 55 despite clean GPIO16 RMT pulses. MAX487 now uses UART1 RX
(the hardware configuration validated in the prior GPIO four-word bench).
XY-K485 uses RMT6 sampling of GPIO19 rather than another simultaneous UART
RX. The RMT decoder handles the final HIGH data bits merging into stop HIGH,
only for the bounded literal-sample tail and only if GPIO19 stays HIGH
through the RMT idle threshold. The host also rejects noisy partial STATUS
and PINS replies instead of trusting embedded tokens.

- Immutable source capture:
  captures/ISOLATED_RS485/20261102T215643084944Z-four-slot.txt
- SHA256:
  2fc12bd1f846579e75de7813669a9497698849de40013af17276bf1122127217
- Result: PASS_DUAL_RS485_DESK_ONLY; four words completed, all 8 MAX
  hardware UART bytes exact; all 8 XY GPIO19 RMT-decoded bytes exact.
- 0 UART errors, 0 coalesced reads, 0 watchdog cutoffs.
- TIMERG0 slot offsets +3,+4,+4,+4 microseconds, 10ms slot spacing;
  externally sensed DE HIGH 2084 microseconds for each word.
- Both MAX RMT0 and XY RMT6 detected 17,9,5,13 expected level segments
  by word. No B request and no ECU transmission.

**Readiness boundary:** A live isolated A/B test now passes. It validates
only this particular desk path; it cannot certify automotive voltage/current, faults,
bus collision arbitration, ECU pinout, or the disputed DTC B command
(`26A4` vs `260E`). Never connect this bench firmware to the vehicle.
