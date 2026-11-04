# SME-105 DCL reference Echo Module ID — experimental one-shot

This is an unverified **reference** request from
[`doncreat0r/eeciv/Diag324.c`](https://github.com/doncreat0r/eeciv/blob/master/Diag324.c).
It is **not** evidence that SME-105 accepts, safely implements, or replies to
this frame. A local MAX487 receiver echo is **not** an ECU reply.

Previous observation: KOEO pin 3 to pin 5 = +4.77 V, pin 11 to pin 5 =
+0.23 V, pin 3 to pin 11 = +4.54 V; passive UART at 9600 8N2 remained silent.
The board's A-to-B resistance measured approximately 188 ohms, which may
load or contend with the vehicle network. Board SM712 TVS protection does
not mean automotive protection has been qualified.

## One-time physical setup, ignition OFF and USB disconnected

- **Do not remove the onboard 121/120-ohm resistor** on this evidence.
- Remove the temporary **direct** MAX487 `DE -> GND` jumper; never drive
  GPIO18 into a hard GND connection.
- Restore `ESP32 D18 -> MAX487 DE` and install/retain **10 kOhm from DE to
  GND** so boot/reset always disables the driver.
- Leave `MAX487 RE (/RE) -> GND`; `DI <- TX2`; `RO -> shifter HV1`,
  `shifter LV1 -> RX2`; MAX487 and ESP32 powered as on the successful bench.
- Before any physical vehicle test, qualify the automotive electrical
  protection and bus-loading conditions. Two matched series current-limit
  resistors (e.g. 330 ohms each) on A and B provide one experimental
  *mitigation* but do **not** independently certify interface safety.
- With car key OFF, once verified: MAX487 `A` through resistor to OBD pin 3,
  MAX487 `B` through resistor to OBD pin 11, common GND to OBD pin 5.
  Automotive 12V pin 16 is NOT used. Make secure shrouded connections;
  never touch adjacent pins. Unplug laptop mains charger. Engine stays OFF.

## Prepare software with A/B physically disconnected from ECU

    ./.venv/bin/python -m platformio run --project-dir firmware/dcl_echo_id_once --target upload --upload-port /dev/ttyUSB0

This firmware never transmits on boot. Once a qualified vehicle interface
is available, use **one** explicit host action while ignition is ON,
engine OFF:

    ./.venv/bin/python scripts/echo_id_once.py --send

The host asks the operator to type `ECHOID`, checks firmware status, sends
the command only once, and saves a timestamped serial log to
`captures/ECHO_ID_ONCE/`. Firmware drives DE for a bounded 11-byte frame
at **2400 baud 8N2** (not the passive 9600 baud setting), with a 100ms
watchdog to force receiver mode; listens for 1.5 seconds, then refuses more
requests until reboot.

Frame (hex): `00 00 00 00 00 01 82 00 00 00 83`.
The reference scanner treats an `01` response as the beginning of its
handshake. This implementation does NOT send any subsequent CART command.

**Interpretation:** `TX complete bytes=11` confirms only the ESP UART wrote
11 bytes, not that ECU saw them. `RX` lines may be local echo from MAX487;
an additional byte after the local echo is only a *candidate* ECU reply until
timing, polarity and signal source are independently verified. Silence is
also inconclusive. Do not blindly repeat, change polarity, or send arbitrary
RAW/wake/EEPROM commands.
