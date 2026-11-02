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

The script first verifies firmware ID, one-shot unused and idle input pads, then sends one bounded bench command. Before any UART bytes, the firmware makes a **short GPIO-only preflight** and requires GPIO16 to follow GPIO17 HIGH/LOW and GPIO19 to follow GPIO18 LOW/HIGH/LOW; failed wiring aborts with zero UART bytes. This preflight itself briefly drives GPIO18 HIGH, so MAX487 and all vehicle wiring must be physically disconnected. It records the original raw USB witness under `captures/ISOLATED_GPIO/` and SHA256 and validates four distinct words, synthetic 10ms starts, UART1 exact two-byte echo, TX_DONE per word, RMT GPIO16 TX transitions, RMT GPIO19 DE pulse durations. Faults stop all later words and forbid auto retry. `auto-de` is an **independent no-UART-byte** desk experiment: RMT TX autonomously generates one ~2180us pulse on GPIO18 and RMT RX captures the same pad. It remains a pad-level test, not evidence of MAX487/ECU safety.

**Limits:** RMT measures 3.3V GPIO logic via separate pads and a jumper, not voltage at the MAX487 differential A/B pair. The RMT DE window ends autonomously at 2180us, but early STOP and the secondary TIMERG0 cutoff still require CPU execution; neither proves qualified electrical protection under an ECU fault or bus contention. A passed bench **does not** guarantee an automotive collision-free interface. B candidate `26A4` versus `260E` and the ECU response format remain unresolved. Do not use this firmware on the vehicle.

## Actual desk results (2026-11-02)

- `20261102T202942430789Z-autonomous-de-gpio-bench.txt`, SHA256 `993205a8e8bd36ac1b58b8c85ae808b5dc9d76edaed2bf0bcc1576eeb406fb22`: RMT generated a GPIO18 pulse measuring 2180us (RMT RX) and 2171us (GPIO polling). Task-triggered, **no UART bytes**.
- `20261102T203246257414Z-timed-rmt-de-gpio-bench.txt`, SHA256 `9af2f7db00efd09faf2459a5f53e9e22f12ab687478e5fdda2a2b63debfc6d45`: TIMERG0 slot ISR launched RMT TX, and autonomous RMT ended a 2180us pulse; GPIO poll measured 2179us. **No UART bytes, no physical MAX487 bus check.**
- `20261102T203609162626Z-tx-de-jumper-bench.txt`, SHA256 `e90c3ce9079d4e87bb2618c2d50cde2216d3848aaa08699e5d3a45865af8f9e8`: failed independent external jumper preflight (`tx_low=0 de_high=0`); **no UART bytes transmitted**. The preflight briefly drove DE on the desk as described above. The four-word GPIO test remains **UNTESTED**, not PASS.

The latest isolated bench source prepares RMT channel 2 as an autonomous DE HIGH window, triggered by the same slot timer ISR that queues two UART bytes; UART TX_DONE/STOP remaps GPIO18 to software LOW early. It compiled and passed source tests but the four-word path needs both physical jumpers before any physical PASS claim. A USB connection or board reset resets the one-shot latch; it is *not* a persistent authorization mechanism for vehicle use.
