# Hardware and electrical interfaces

**Scope:** explain the research prototype actually used so far, distinguish
it from proposed KiCad hardware, and document which electrical facts remain
unverified. This is **not** a vehicle-wiring instruction or plug-and-play
OBD-II adapter guide.

## 1. Existing hand-wired experiment prototype

| Component | Role | Confidence / note |
| --- | --- | --- |
| Classic ESP32 DevKit-class board (USB/UART, CP2102 reported) | Embedded timing, serial RX/TX, Wi-Fi SoftAP and separately built BLE | Working development-platform family; confirm exact board/module marking on current unit |
| MAX487-based 5 V transceiver board | Candidate differential DCL receive/transmit interface | Manual `DE`/`/RE` pins; 5 V logic must not reach ESP32 GPIO untreated |
| Four-channel logic-level converter / equivalent 5 V → 3.3 V RO conversion | Match MAX487 receiver output to ESP32 RX | Check direction, bandwidth, actual module and idle level |
| External ~10 kΩ `DE` pull-down | Hold bus driver disabled across reset/boot | Required physical fail-safe, not just a firmware command |
| USB data cable + separate regulated bench power | Power/program/debug without drawing from the car's OBD pin 16 | Suitable for isolated development only; check power-path and ground |
| Diagnostic connector / test leads | Access candidate vehicle DCL conductors | Exact vehicle wiring, polarity, loading and isolation are **not established** by this document |
| Phone with Android app | Operator UI, local link and capture storage | The tested Android device is not a validated automotive display |

The 5 V MAX487 device is **not** a 3.3 V-native ESP32 transceiver:
the transceiver's `RO` output can exceed the ESP32's input rating.
The `DI`/`DE` input-high behavior, RX translator and specific breakout
board must all be checked against their actual datasheets.

### Firmware-side signal map

| ESP32 | Direction | Current firmware use | Interface |
| --- | --- | --- | --- |
| GPIO16 | Input | DCL receive (`RO`) | MAX487 `RO` through verified 5 V → 3.3 V translation |
| GPIO17 | Output + witness input | DCL transmit (`DI`), monitored at the physical pad | MAX487 `DI` |
| GPIO18 | Output + pad witness | Differential driver enable (`DE`) | MAX487 `DE` + external 10 kΩ pull-down |
| — | — | Receive-enable | MAX487 `/RE` tied LOW in the documented current bridge |
| USB UART | Host service | Programming, STATUS and trusted maintenance | CP2102 / USB; distinct from the DCL bus |

The definitive implementation is
[`sme105_usb_bridge.ino`](../firmware/sme105_usb_bridge/sme105_usb_bridge.ino);
other experimental sketches in `firmware/` may use different GPIOs,
framing or policies. Do **not** substitute their wiring for the active
bridge.

### Vehicle connector status

The research target is a Ford EEC-IV SME-105 (`97AB-12A650-KA`), not a
generic compliant OBD-II CAN reader. The observed connector positions
discussed during research include **3 and 11 as candidate DCL pair**,
**4/5 as grounds**, **7 as a distinct K-line candidate**, and **16 as
nominal battery voltage**. Their precise application on the subject
vehicle, the DCL A/B polarity, K-line availability and ground strategy
must be independently verified from the vehicle-specific pinout and
measurements. Do not wire from this table alone.

In the current prototype, **do not use pin 16 as an unfused supply**;
USB/separately protected bench power is the established boundary.
`GPIO17` must not drive any vehicle line until a suitable electrical
interface and procedure are specifically approved. `DE` is LOW by
default and an isolated bench proof is a prerequisite to named
operator-armed transactions; it is **not** authorization to connect
an unqualified board to the car.

See [wiring safety](wiring-safety.md) and
[MAX487 bench quick start](max487-quickstart.md) for the preserved
project-specific safety requirements.

## 2. Hardware evolution

| Iteration | What exists | Safe interpretation |
| --- | --- | --- |
| Early receive-only adapters (`XY-K485`, passive sketches) | Historical lab experiments | Autodirection is not an adequate deterministic active-master driver |
| ESP32 DevKit + 5 V MAX487 | Hand-wired development bridge, local direct-link bench work | Network operation and isolated GPIO tests **do not** certify ECU electrical layer |
| [PCB R0](../hardware/pcb-r0/README.md) | Editable KiCad research layout, 115 × 75 mm | Provisional first PCB design; no production or vehicle approval |
| [PCB R1](../hardware/pcb-r1/README.md) | Editable four-layer review layout, 95 × 60 mm | Compact **proposal**; locally reviewed ERC/DRC, no assembled prototype |

### R1 conceptual power and signal flow

    Nominal OBD pin 16 (vehicle battery) -- F1 candidate fuse
       -> reverse polarity + transient protection (unqualified)
       -> LM5164-Q1 candidate 5 V regulator
           -> MAX487 (5 V)
           -> TPS62160 candidate 3.3 V regulator
                -> ESP32-WROOM-32UE-N4 + Wi-Fi/BLE radio

    Candidate DCL A/B -> DNP links -> MAX487 A/B
    MAX487 RO -> 12 kΩ / 20 kΩ candidate divider -> GPIO16
    GPIO17 -> DI; GPIO18 -> DE (+ pull-down); /RE -> LOW

The R1 design explicitly keeps the candidate vehicle-side links
`R13/R14/R15` **DNP (do not populate)**. Its six-pin J1 is a **placeholder
header**, not a production-ready OBD male plug. R1 review BOM parts
have provisional/unselected MPNs, including a proposed **1 A** input
fuse: this is **not** a calculated, verified fuse recommendation for
the live car. The 12 V input architecture is a **future proposal**,
not permission to replace the present bench supply.

KiCad ERC/DRC passing verifies rule consistency, **not** surge
survivability, RF performance, fabricated track tolerances, component
selection, ECU safety, or even a successful power-up. Read
[R1 review status](../hardware/pcb-r1/REVIEW_STATUS.md),
[fabrication assumptions](../hardware/pcb-r1/FAB_PROFILE.md)
and [review BOM](../hardware/pcb-r1/BOM_REVIEW_ONLY.csv) before
describing R1 publicly.

## 3. Mechanical and field-readiness gaps

- Confirm the specific ESP32 board, transceiver breakout, level translator,
  cable and connector by photos and actual markings.
- Establish vehicle-specific DCL pins, bias, termination, ground and A/B
  polarity by independent electrical verification.
- Design and test vehicle power/ESD/load-dump/cranking/reverse polarity
  protection before allowing OBD-powered operation.
- Select real orderable manufacturer part numbers, enclosure, antenna,
  pigtail, mechanical clearances and production test points.
- Test R1 first on current-limited isolated power with **no vehicle**.
  Only then consider any separately authorized and supervised vehicle test.

**Please do not treat this guide as a schematic or assembly authorization.**
