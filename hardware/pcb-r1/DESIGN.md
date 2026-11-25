# SME105 DCL Bridge R1 — schematic and layout design notes

## Interfaces (from currently reviewed firmware)

| Function | WROOM pin / GPIO | Connected circuit |
|---|---|---|
| DCL UART RX | pad 27 / GPIO16 | MAX487 RO through 12k/20k 5V->3.3V divider |
| DCL UART TX | pad 28 / GPIO17 | MAX487 DI |
| DCL drive enable | pad 30 / GPIO18 | MAX487 DE, 10k pulled low at boot |
| UART programming RX | pad 34 / GPIO3 | J2 service header |
| UART programming TX | pad 35 / GPIO1 | J2 service header |
| Boot strap | pad 25 / GPIO0 | J2 and BOOT pushbutton |
| Chip enable | pad 3 / EN | 10k pullup and RESET pushbutton |

The MCU module candidate is **ESP32-WROOM-32UE-N4** with an external U.FL RF
connector. This uses integrated classic ESP32 BLE + Wi-Fi: adding a second
Bluetooth transceiver would not itself improve the chip's radio reception.
A matching certified external 2.4GHz antenna is still to be selected.

## Power

Nominal vehicle 12V input from OBD pin 16; protection topology and actual
load-dump capability **require analysis and bench testing**. A high input
rating on a DC/DC IC is insufficient on its own. Fuse, series diode,
transient clamp, EMC and off-state drain values are only candidates.

- U2 LM5164-Q1 5V: R4=158k high side and R5=49.9k low side, nominal ~5.00V
  from the 1.2V FB reference (component tolerances/PCB dynamics to test).
- U3 TPS62160 3.3V: R6=316k upper and R7=100k lower, nominal ~3.33V from
  0.8V FB reference (test peak Wi-Fi/BLE burst stability).
- MCU 3.3V, MAX487 5V. Never apply 12V to either device directly.
- The 5V buck and 3V3 buck thermal/EMI loops need professional layout
  and power/ripple assessment before any vehicle-side testing.

## OBD placeholder header J1

| Header pin | Candidate OBD conductor | Status |
|---|---|---|
| 1 | OBD16 +12 V | verify physical polarity, fuse and protection |
| 2 | OBD4 chassis ground | verify reference path |
| 3 | OBD5 signal ground | R15 DNP, requires grounding review |
| 4 | OBD3 DCL candidate | R13 DNP, polarity and voltage UNVERIFIED |
| 5 | OBD11 DCL candidate | R14 DNP, polarity and voltage UNVERIFIED |
| 6 | not connected | leave unconnected |

Do **not** install R13/R14/R15 or attach DCL lines to an ECU without verified
vehicle measurements, designed bus protection, line common-mode and biasing
and confirmed load limits. The custom bus interface cannot be assessed as an
ordinary OBD-II CAN/ISO9141 device based on connector shape.

## PCB topology

- R1 rectangular 95 x 60 mm engineering envelope, actual connector and
  case choice pending; do not claim it fits inside an OBD male shell.
- Four copper layers: front signal/power, inner solid GND, inner solid GND,
  rear signal. GND planes were filled after routing on the outer layers.
- Tool-assisted routing gives full connectivity, but **the switching loop,
  RF ground return, antenna placement, high transient paths, solder wicking
  around thermal vias and final track widths require manual engineering QA**.
- Existing 0.20mm drills in thermal-via footprints meet the explicitly
  configured R1 design-rule profile; the chosen manufacturer must approve
  the stackup, through-hole geometry, minimum annular ring and assembly
  process (thermal vias inside exposed pads may require filling/capping).

## Baseline verification

41 footprints, 116 mapped schematic-to-PCB physical pins, 26 nets, 398
track segments, 41 vias; zero unconnected pads, zero KiCad DRC findings.
ERC on the same generated schematic symbols/labels: zero errors/warnings.
The board is still **NOT** approved for manufacturing or vehicle power-on.
