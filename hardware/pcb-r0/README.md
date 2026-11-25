# SME105 DCL Bridge — PCB R0 engineering prototype

**State:** editable KiCad schematic and four-layer PCB now routed with ground planes. Prototype-review **only**: NOT vehicle-qualified, NOT manufacturing approved. See `REVIEW_STATUS.md`.
**Source reviewed:** firmware/sme105_usb_bridge/README.md and platformio.ini; docs/wiring-safety.md, docs/max487-quickstart.md and docs/wifi_ble_stability_and_rf_report.md.
**Scope:** single-board replacement for current ESP32 DevKit + MAX487 + RO 5V-to-3.3V translation; retain the existing GPIO map and firmware. Add protected OBD power and optional external 2.4 GHz antenna. No new Bluetooth chipset needed.

## Electrical architecture — proposed

```text
OBD verified pigtail (J1 header placeholder)  Automotive protection/power
  pin 16 VBAT --- fuse --- reverse-polarity stage --- surge clamp
                                                  |
                                   automotive buck 5V (candidate LM5164-Q1)
                                     |                       |
                                 MAX487 VCC              3V3 regulator
                                     |                       |
OBD pin 3?  -------- DNP link -- A/B?                     ESP32-WROOM-32UE-N4
OBD pin 11? -------- DNP link -- B/A?                       | BLE + Wi-Fi integrated
                                     |                        +-- IPEX 2.4 GHz antenna
                            MAX487 RO -- resistor divider --> GPIO16
                            MAX487 DI <------------------------ GPIO17
                            MAX487 DE <------------------------ GPIO18
                                   + 10k pull-down to GND
                            MAX487 /RE --> GND (receiver enabled)
OBD pin 4 --> GND; pin 5 --> reference-isolation DNP link; verify on car
UART programming/service header: 3V3/GND/TXD0/RXD0/EN/GPIO0 (and optional USB/UART debug adapter)
OBD pin 7 IS NOT DCL; leave unconnected in R0.
```

## Reused firmware signals (confirmed from source)

| Logic | ESP32 GPIO | WROOM-32UE pad | Direction | Other end |
|---|---:|---:|---|---|
| DCL RX | 16 | 27 | IN | MAX487 RO through 5V->3V3 conversion |
| DCL TX | 17 | 28 | OUT and pad witness | MAX487 DI |
| Driver enable | 18 | 30 | OUT | MAX487 DE and 10k resistor to GND |
| Enable receiver | — | — | — | MAX487 /RE tied to GND |
| UART flashing | TXD0/RXD0 | 35/34 | IO | service header; no DevKit USB-UART required |

## Core choices

1. **ESP32-WROOM-32UE-N4** rather than the complete DevKit. The classic ESP32 core retains the GPIO/UART architecture used by the repository; N4 has 4 MB flash. The UE version includes an RF connector for a *suitable* approved 2.4 GHz antenna.
2. **No second Bluetooth module:** current firmware already contains optional NimBLE UART transport (build flag `SME105_BLE`); deployed Wi-Fi image is a different configuration. Improve radio by antenna placement/measurements, not a second radio by assumption.
3. **Keep the existing MAX487 functional interface for R0.** A 3.3V-native replacement could eliminate the 5V RX translator, but changes the bus electrical interface and requires validation against the actual DCL wiring.
4. **Input power is a fresh engineering subsystem, not the old bench wiring.** 12V OBD pin 16 must never connect directly to ESP32/5V/3V3 rails. Proposed protection chain and a 6–100 V-rated automotive buck are preliminary; final reverse polarity, surge/load-dump, fuse, thermal and sleep-current design must be calculated and tested before vehicle power-on.
5. **No assumption that pins 3/11 A/B or 120-ohm termination are correct** until measured on this specific SME-105 ECU and connector.
6. Boot hardware must hold DE OFF regardless of ESP boot state. Reserve access for programming/debugging even after removing the DevKit.

## Suggested PCB zones (mechanical dimensions NOT final)

- **Vehicle-facing edge:** OBD connector, fuse/reverse-polarity/surge input, DCL protection.
- **Center:** 5V/3V3 switching supply, MAX487, RO divider.
- **Antenna edge:** WROOM-32UE with connector and RF clearance; antenna routed away from car metal and switching inductor.
- **Service:** test pads + UART firmware recovery header + optional physical disconnect/disable for bus driver.
- Board shape depends on the exact OBD male connector and case. Do **not** commit to dimensions or component footprints without the mechanical part numbers.

## Release gates (before CAD manufacturing exports)

- Confirm current physical module identity, 5V logic shifter board and MAX487 part/variant; record photographs of both sides.
- Verify exact OBD connector pins and GND, especially DCL 3/11 polarity and actual bus load, on this car.
- Choose direct-plug or short-cable OBD male connector and enclosure dimensions.
- Complete KiCad GUI ERC, resolve 0.20 mm thermal drill feasibility and review PCB copper and antenna layout with real module and manufacturer constraints.
- Validate automotive power path (reverse polarity, cranking, load dump/transients, peak Wi-Fi/BLE current, ignition-off parasitic drain).
- Compare USB-only bench functional signals and active-driver safety with existing bridge; field ECU operation is a separate approval.
- Compile and verify matching Wi-Fi and BLE profiles on the replacement module without altering saved app/device settings unexpectedly.

## Primary component references

- Espressif ESP32-WROOM-32E/32UE datasheet: https://documentation.espressif.com/esp32-wroom-32e_esp32-wroom-32ue_datasheet_en.html
- Espressif ESP32 hardware schematic checklist: https://docs.espressif.com/projects/esp-hardware-design-guidelines/en/latest/esp32/schematic-checklist.html
- TI LM5164-Q1 candidate regulator: https://www.ti.com/product/LM5164-Q1
- KiCad: https://www.kicad.org/
