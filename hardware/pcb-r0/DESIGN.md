# SME105 DCL Bridge — Custom PCB R0

## Goal

Single-board automotive diagnostic adapter replacing the existing ESP32 DevKit, 5 V MAX487 breakout and 4-channel level shifting board with a smaller PCB. Preserve the firmware's core GPIO16 (RX), GPIO17 (TX), GPIO18 (driver enable) interface. Supply the board from the car's diagnostic connector through independently engineered protection. Use existing ESP32 Wi-Fi and BLE with an external antenna; a second Bluetooth module is not justified by available RF measurements.

## Physical architecture

1. Vehicle-facing OBD-II male connector with positive 12 V feed, approved grounding and validated DCL pins; candidate DCL conductors on 3/11 are **not certified** by the bench tests.
2. Fuse, reverse-polarity stage, correctly calculated automotive input transient/load-dump protection, buck regulation for 5 V and 3.3 V regulation. Disconnect/reduce standby current because DLC power can be permanent.
3. ESP32-WROOM-32UE-N4 (classic ESP32 module, integral Wi-Fi + Bluetooth/BLE and external 2.4 GHz antenna connector); service UART0/BOOT/EN test pads and local reset.
4. MAX487 5 V differential transceiver, RO safely shifted down to 3.3 V, DI driven by GPIO17, DE driven by GPIO18 with 10 kΩ fail-safe pulldown and /RE held low, subject to vehicle-level electrical verification.
5. Case and board outline to match the actual connector mechanics and antenna clearance, not assigned from a generic product photo.

## Confirmed signal map from current firmware

| Signal | GPIO | ESP32 WROOM pad | Interface |
| --- | --- | --- | --- |
| DCL UART RX | 16 | 27 | MAX487 RO through 5 V to 3.3 V interface |
| DCL UART TX / pad witness | 17 | 28 | MAX487 DI |
| DCL driver enable | 18 | 30 | MAX487 DE and 10 kΩ to GND |
| Recovery serial RX | 3 | 34 | Service header RXD0 |
| Recovery serial TX | 1 | 35 | Service header TXD0 |

## Candidate components (not finalized)

| Function | Candidate | Qualification |
| --- | --- | --- |
| MCU/RF | ESP32-WROOM-32UE-N4 | Actual module footprint/pad numbers, boot straps, 3.3 V peak RF supply, external antenna selection |
| DCL PHY | MAX487ESA+T | Need vehicle voltage and loading qualification, plus robust bus protection |
| 5 V regulator | TI LM5164-Q1 or TPSM365R6V5 family | Select from validated application circuit and exact orderable pinout; simulate thermal/EMI/load-dump |
| 3.3 V rail | TPS62160DGKR switching buck converter (5 V to 3.3 V) | Account for ESP32 500 mA recommendation and radio bursts; do not confuse with typical draw |
| Power protection | Fuse + reverse-polarity + surge suppression | Device-level automotive transient design required; one generic TVS is not sufficient evidence |

## Unverified engineering inputs

- The vehicle connector pinout, candidate DCL 3/11 polarity, bias, signal levels, existing load and 120 Ω termination suitability.
- The exact MAX487 clone/module characteristics and additional protection needed when integrated.
- The actual vehicle voltage transient, inrush and ignition-off sleep budget.
- Connector footprint, enclosure dimensions, RF antenna orientation and radio link margin.
- Firmware compile and hardware behavior after swapping DevKit for WROOM module.

## Build sequence and acceptance gates

1. Datasheets and pin tables for every multi-pin component; frozen per-part electrical netlist and reference circuits.
2. Protected power + MCU/RF + UART + DCL schematic; KiCad ERC clean; exact signal-to-pad review.
3. Placement, thermal and RF keep-outs; PCB DRC, layout-to-schematic comparison, routing and manufacturability checks.
4. First power-up from a current-limited isolated bench supply; check rails and fail-safe receive-only state, then firmware/RF.
5. Separate certified/supervised vehicle-side electrical qualification **before** OBD 12 V power or active ECU commands.

## Engineering R0 build (22 November 2026)

The editable KiCad schematic and four-layer board are now generated and the
complete netlist is routed on **outer F.Cu / B.Cu only**; both internal copper
layers are solid ground fills. The proof-of-concept board uses a 115 x 75 mm
rectangular outline for layout validation. This is not the final mechanical
outline for a direct OBD2 plug.

Hardware-specific values, wiring polarity, power input protection, DCL voltage
ratings, signal-ground reference, BOM manufacturability and RF/EMI are still
engineering assumptions. The DCL bus physical connection and vehicle ground
bridge use **unpopulated 0-ohm links (R13, R14, R15)** to avoid enabling unsafe
connections by default. Do not connect this revision to a car.

The prototype PCB includes thermal vias with 0.20 mm drill diameter. An
unqualified 0.30 mm fabrication-rule assumption flags 18 via violations; a
fabricator must approve the smaller drill or the footprints must be changed.

**Status: routed, electrically cross-checked prototype layout; not a
manufacturing-approved design.**
