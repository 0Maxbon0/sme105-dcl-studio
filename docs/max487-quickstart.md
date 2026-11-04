# MAX487 + ESP32 + 4-channel level converter: quick start

Vehicle: Ford Escort 1998, 1.6 Zetec. ECU label SME-105 is confirmed by the
owner. Ford EEC-IV DCL on OBD pins 3/11 remains a reference-based candidate:
there has not yet been a successful capture from this ECU.

**FIRST TEST IS DESK-ONLY. NEVER connect MAX487 A/B to the car during it.**
MAX487 is a 5 V part; the ESP32 GPIO inputs are **not 5 V tolerant**.

## Bench wiring (all connections with USB power OFF)

Check each pin label on your physical modules: do not guess from a photograph.
The receiver-enable input is active LOW, often written /RE or RE-bar.

**One USB cable powers the bench setup:** laptop USB-A to ESP32 Micro-USB
type B. That same cable also uploads firmware and carries serial logs.
The ESP32 runs from USB; the purchased MAX487 module and logic shifter can
share its USB-derived 5 V rail **only after measuring the board's 5V/VIN pin
and confirming it exposes approximately 5 V when powered by USB**. No second
power supply is normally needed for these low-power bench modules. Do not
connect an external 5 V source to that pin while USB is attached.

**VIN clarification:** on ESP32 DevKit V1 clones, the pin marked `VIN` next
to `GND` and `D13` is primarily an *input* to the board's regulator. Some
board revisions also expose USB-derived 5 V there, while others isolate it.
With **only USB connected**, measure VIN-to-GND first. Approximately 5 V
indicates a possible power source for these low-current modules, subject to
checking the board's actual power path and load; 0 V or 3.3 V means **do not
use VIN as the MAX487's 5 V supply**. A voltage reading alone does not prove
the pin can deliver arbitrary current. Never back-feed another supply into
VIN when USB is already connected.

| From | To | Purpose |
| --- | --- | --- |
| ESP32 GND | MAX487 GND and converter GND | Shared desk ground |
| ESP32 5V/VIN USB-output pin | MAX487 VCC and converter HV | Only if the USB-powered pin measures approximately 5 V |
| ESP32 3V3 | Converter LV | Never connect 5 V to LV |
| MAX487 RO | Converter HV1 | MAX487 receive output may reach 5 V |
| Converter LV1 | ESP32 GPIO16 | Safe 3.3 V UART receive (verify by meter) |
| ESP32 GPIO17 | MAX487 DI | UART transmit; MAX487 TTL HIGH threshold accepts 3.3 V |
| ESP32 GPIO18 | MAX487 DE | Driver enable: HIGH only during desk self-test |
| MAX487 DE | 10 kOhm resistor to GND | **Required** external pull-down during boot/reset |
| MAX487 /RE | GND | Receiver always active (LOW enables RX) |
| ESP32 GPIO19 | Nothing | Not used in new setup |
| MAX487 A and B | **Nothing external** | Remain disconnected from OBD and other devices |

If your ESP32 USB-derived 5 V pin cannot be confirmed, use a regulated
external 5 V bench supply with a common GND. Do not supply MAX487 from 3V3.
Four-channel BSS138 converters are not ideal for all push-pull UART signals;
the following 9600-baud desk test checks the actual bought hardware.

Check the voltage on GPIO16 is no more than about 3.3 V, not 5 V, before
starting the firmware. With USB power disconnected, check that DE is pulled
to GND through 10 kOhm and there are no 5V-to-GND or 5V-to-3V3 shorts.
If any measurement looks wrong, unplug USB and correct the wiring.

## Flash desk-only self-echo firmware

From the repository root (use the actual USB device name):

    ./.venv/bin/python -m platformio run --project-dir firmware/max487_bench
    ls /dev/serial/by-id/ /dev/ttyUSB* 2>/dev/null
    ./.venv/bin/python -m platformio run --project-dir firmware/max487_bench --target upload --upload-port /dev/ttyUSB0
    ./.venv/bin/python -m platformio device monitor --port /dev/ttyUSB0 --baud 115200

Or use Studio > Firmware > MAX487 desk self-test, acknowledge vehicle
disconnection, upload, then start the 115200-baud bench monitor.
Stop other serial-monitor or capture tools first.

Example successful output once per second:

    MAX487 DESK SELF-ECHO - NEVER CONNECT TO THE CAR
    PASS TX: A5 5A 00 FF 55 AA 00 00  RX: A5 5A 00 FF 55 AA 00 00  count=8

Ten successive PASS lines indicate the local MAX487/translator/UART path
works at 9600 8N2. This says nothing about the vehicle's DCL electrical
polarity, actual baud rate, termination, or ECU-specific request bytes.
FAIL means inspect GND, voltage, DE, /RE, RO and shifter wiring on the desk.

## Restore receive-only capture firmware

    ./.venv/bin/python -m platformio run --project-dir firmware/passive_binary
    ./.venv/bin/python -m platformio run --project-dir firmware/passive_binary --target upload --upload-port /dev/ttyUSB0

Passive binary firmware uses USB 460800 baud (not the bench 115200) and
GPIO16 RX at *candidate* 9600 8N2. It leaves UART TX disconnected in
software and keeps GPIO18 DE LOW. Keep the 10k pull-down and /RE-GND wiring.
Open Studio and select Passive binary capture for data acquisition.

## Before any ECU connection

There is still no verified OBD **male** breakout or full-wired cable. Do not
push clips or loose probes into the car diagnostic socket. The Fares board
may have a permanent 120-Ohm resistor across A/B; do not remove an unidentified
component. Its validity for the ECU bus must be checked. Board TVS devices do
not prove full automotive transient protection. Confirm the vehicle-specific
pinout, signal voltage, A/B polarity and bus loading, protective interface,
and a verified non-mutating DCL transaction before transmitting to the ECU.

**No active ECU requests are enabled in the project now.** See
[wiring-safety.md](wiring-safety.md).
