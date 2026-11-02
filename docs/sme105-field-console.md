# SME-105 field console v1

## Actual capabilities and limitations

The new firmware targets the existing ESP32 + MAX487 + BSS138 wiring:
GPIO16/RX2, GPIO17/TX2 and GPIO18/DE. The older XY-K485 was a desk
receiver, **not a required automotive interface**. Its A/B link must be
disconnected from MAX487 before any later field work.

**No active DTC read is verified or enabled.** Previous CART captures showed
header/ID quartets, not validated diagnostic codes. Public scanner references
conflict on B read-codes: 26 0E versus 26 A4. Sending either without correctly
synchronized CART slots is not a valid read-codes implementation.

The following do NOT exist in this firmware: clear codes, actuator/KOEO test,
PID map writes, EEPROM writes, arbitrary raw TX, unbounded active polling.

The measured A/B resistance (~188 ohms) and SM712 on the board do not certify
the automotive load and transient environment. Passing the two-board desk
test does not approve direct connection to an unprotected car ECU.

## Commands (USB baud 115200)

| USB command | Behaviour |
| --- | --- |
| STATUS | Exact identity SME105_FIELD_V1; DE LOW; RX and watchdog |
| OPTIONS | All reference choices and conflicts, no TX |
| HELP | Lists commands |
| MON2400 / MON2400N1 | RX-only 2400/8N2 or 2400/8N1 for 5 seconds |
| MON4800 / MON4800N2 | RX-only 4800/8N1 or 4800/8N2 for 5 seconds |
| MON9600 / MON9600N2 | RX-only 9600/8N1 or 9600/8N2 for 5 seconds |
| MON19200 / MON19200N2 | RX-only 19200/8N1 or 19200/8N2 for 5 seconds |
| CART_REF | Explicit ONE attempt: reference Echo-ID, strict candidate ACK then Go-CART, then 10 seconds RX; NOT DTC read |
| STOP | Ends active receive capture, keeps DE LOW |

CART_REF emits exactly two fixed 11-byte reference frames maximum, at 2400
baud 8N2, only on explicit action. It is locked after an attempt regardless
of outcome. The software cutoff is 100ms; physical DE pull-down 10k remains
necessary. The extra 01 candidate ACK does not authenticate ECU origin.
This option is not a substitute for a validated protected vehicle interface.

## Commands on Ubuntu

From the project root:

    ./.venv/bin/python scripts/sme105_field_session.py --action status
    ./.venv/bin/python scripts/sme105_field_session.py --action options
    ./.venv/bin/python scripts/sme105_field_session.py --action monitor9600
    ./.venv/bin/python scripts/sme105_field_session.py --action monitor2400

Once the vehicle interface and selected reference-only scope are validated,
the optional historical CART reference experiment uses a final explicit
human confirmation and two quiet STATUS preflights:

    ./.venv/bin/python scripts/sme105_field_session.py --action cart-ref

It will NOT read DTCs: it only attempts the observed historical handshake.
USB reset may reset the firmware per-boot latch, which is not permission
to repeat an experiment.

Every sent capture transcript is saved without overwriting in
captures/FIELD_CONSOLE/ and an SHA256 is printed. The host fails on partial
serial output, UART errors, capture overflow and missing terminal markers.
Startup CP2102 garbage is drained once, with two subsequent exact STATUS
checks mandatory before any action.

Analyze an actual log without inventing DTC values:

    ./.venv/bin/python scripts/analyze_field_capture.py captures/FIELD_CONSOLE/FILE.txt --json

## Test and upload

    ./.venv/bin/python -m platformio run --project-dir firmware/sme105_field_console
    PYTHONPATH=src ./.venv/bin/python -m unittest discover -s tests -q
    ./.venv/bin/python -m ruff check scripts/sme105_field_session.py scripts/analyze_field_capture.py tests/test_sme105_field_session.py tests/test_analyze_field_capture.py

Upload only on isolated desk with the external A/B terminals not connected
to any car or live bus. Confirm identity over USB before using the console.
