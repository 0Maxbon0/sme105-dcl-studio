# SME-105 isolated GPIO TX/DE bench (NO vehicle TX)

This firmware **cannot send ECHO-ID, GO-CART, B or any ECU command**. The four pairs are unrelated sample bytes (`55AA,33CC,0FF0,6996`). No automatic transmit on boot, and one test per reset. It is deliberately **not** vehicle-safe firmware.

## Wiring (desk only)

Disconnect **MAX487, vehicle A/B, all car wires**, power via laptop USB only.

- ESP32 **TX2 / D17 / GPIO17** → through ~1kΩ resistor → **RX2 / D16 / GPIO16** (UART echo and RMT pad capture).
- ESP32 **D18 / GPIO18** → through ~1kΩ resistor → **D19 / GPIO19** (DE output edge capture).
- No GPIO19 jumper to TX17, and never connect another output to GPIO16 or GPIO19.

Commands from repo root:

```bash
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_tx_isolated
# ONLY if disconnected from car/MAX487:
./.venv/bin/python -m platformio run -d firmware/sme105_dtc_tx_isolated -t upload --upload-port /dev/ttyUSB0
./.venv/bin/python scripts/sme105_tx_isolated_session.py --action status
./.venv/bin/python scripts/sme105_tx_isolated_session.py --action pins
./.venv/bin/python scripts/sme105_tx_isolated_session.py --action auto-de --isolated-confirmed
# Flash/reset for a fresh one-shot, then verify TIMERG0 ISR starts RMT:
./.venv/bin/python scripts/sme105_tx_isolated_session.py --action timed-de --isolated-confirmed
# Reset board after the autonomous-DE one-shot, then use the GPIO jumpers:
./.venv/bin/python scripts/sme105_tx_isolated_session.py --action bench --isolated-confirmed
```

The host first verifies firmware ID, one-shot unused and **GPIO19/DE idle LOW**. Do **not** use the idle level on GPIO16 as a proof of its jumper: TX GPIO17 is INPUT before the bench, so GPIO16 may naturally read 0 despite a correctly installed jumper. Before any UART bytes, the firmware makes a **short GPIO-only preflight** and requires GPIO16 to follow GPIO17 HIGH/LOW and GPIO19 to follow GPIO18 LOW/HIGH/LOW; failed wiring aborts with zero UART bytes. This preflight itself briefly drives GPIO18 HIGH, so MAX487 and all vehicle wiring must be physically disconnected. It records the original raw USB witness under `captures/ISOLATED_GPIO/` and SHA256 and validates four distinct words at 10ms intervals. UART2 transmits two fixed bytes per word, while a separate UART1 ISR verifies exact received bytes/times; UART2 TX_DONE verifies shift-register completion. Four separately preloaded RMT TX channels (2–5) each provide **one** ~2180µs autonomous DE window, with GPIO19 observing the external pad and GPIO16 capturing the UART waveform. The host checks the measured DE pulse, exact code-dependent TX edge counts, 4/4 TX_DONE and local echo. Faults stop all later words and forbid automatic retries. `auto-de` is an independent no-UART-byte GPIO experiment; neither bench tests the MAX487/ECU electrical bus.

**Limits:** RMT measures 3.3V GPIO logic via separate pads and a jumper, not voltage at the MAX487 differential A/B pair. The RMT DE window ends autonomously at 2180us, but early STOP and the secondary TIMERG0 cutoff still require CPU execution; neither proves qualified electrical protection under an ECU fault or bus contention. A passed bench **does not** guarantee an automotive collision-free interface. B candidate `26A4` versus `260E` and the ECU response format remain unresolved. Do not use this firmware on the vehicle.

## Actual desk results (2026-11-02)

- `20261102T202942430789Z-autonomous-de-gpio-bench.txt`, SHA256 `993205a8e8bd36ac1b58b8c85ae808b5dc9d76edaed2bf0bcc1576eeb406fb22`: RMT generated a GPIO18 pulse measuring 2180us (RMT RX) and 2171us (GPIO polling). Task-triggered, **no UART bytes**.
- `20261102T203246257414Z-timed-rmt-de-gpio-bench.txt`, SHA256 `9af2f7db00efd09faf2459a5f53e9e22f12ab687478e5fdda2a2b63debfc6d45`: TIMERG0 slot ISR launched RMT TX, and autonomous RMT ended a 2180us pulse; GPIO poll measured 2179us. **No UART bytes, no physical MAX487 bus check.**
- `20261102T203609162626Z-tx-de-jumper-bench.txt`, SHA256 `e90c3ce9079d4e87bb2618c2d50cde2216d3848aaa08699e5d3a45865af8f9e8`: earlier failed external jumper preflight (`tx_low=0 de_high=0`); zero UART bytes. Later physical jumpers were validated; this record remains untouched.
- `20261102T212224133023Z-tx-de-jumper-bench.txt`, SHA256 `8053a41aaf4ba9a5843e53cb6073789c6a0cfa4f49aa4abdc7654291f33c7580`: **PASS_GPIO_JUMPERS_ONLY**, 4/4 synthetic words and 8/8 exact received bytes, 4 TX_DONE, 0 UART errors, 0 cutoff. TIMERG0 fired at nominal offsets +10/+4/+4/+4µs and external GPIO19 RMT measured 2085/2085/2085/2084µs DE HIGH; GPIO16 RMT captured expected level segments 17/9/5/13. This is the first real 4-slot complete isolated bench witness, not a Ford/ECU B request.

The verified isolated bench prepares four independent RMT one-shot DE windows in advance, triggered successively by the slot timer ISR which queues two bytes to UART2. UART2 TX_DONE/STOP remaps GPIO18 to software LOW early. **A USB connection or board reset resets the one-shot latch**, so it is not persistent authorization; never reuse this bench with an ECU. The real Ford CART receiver remains separate, and the B diagnostic command is still compile-locked.
