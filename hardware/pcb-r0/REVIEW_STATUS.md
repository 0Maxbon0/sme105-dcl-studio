# SME105 DCL Bridge R0 — review handoff (2026-11-22)

**Purpose:** Editable four-layer KiCad engineering sample. This is **not** a
car-ready, fabrication-approved ECU interface, and its online PCBKit cloud
project currently contains only initial blank files because its remote
sandbox fails to launch.

## Files

Open `board.kicad_sch` and `board.kicad_pcb` in KiCad 7 or newer.
The project-local `fp-lib-table` and `parts.pretty/` provide the footprints
without extra libraries. Preview SVGs are in `previews/`.
`BOM_REVIEW_ONLY.csv` is not a purchase order.

## Completed checks

- KiCad CLI loaded the schematic and exported its real netlist.
- Every populated schematic pin's net was compared to its corresponding
  physical PCB pad (116 matching pin-and-net identities; 0 mismatches).
- 41 physical footprints; 26 routed signal/supply networks; 391 outer-layer
  segments and 42 vias. Freerouting logged zero missing connections.
- Both inner planes filled with common GND.
- PCB geometry DRC: no reported shorts/spacing/unconnected errors.
  **18 drill-size findings still present**, from 0.20 mm exposed-pad thermal
  via holes against the default 0.30 mm fab rule; not silently waived.
- Three DNP 0-ohm links R13/R14/R15 deliberately isolate the vehicle DCL
  candidate pair and separate signal-ground connection.

## Must resolve before manufacturing or connecting to a car

1. Actual mechanical OBD2 male plug or qualified pigtail, pin orientation,
   enclosure, board dimensions (current 115 × 75 mm is a layout trial).
2. Confirm SME105 vehicle's DCL pins 3/11, line polarity, common mode,
   electrical protection, differential termination/biasing and grounding.
3. Finish automotive load-dump, reverse polarity, cold-crank, EMC and
   ignition-off battery drain qualification of the LM5164-Q1 5V front-end.
   A generic TVS + fuse and buck datasheet rating alone is not a substitute.
4. Select real MPNs and package tolerances for all passives, inductor,
   fuse, TVS, input diode, connectors, antenna and enclosure. Review 5V and
   3V3 regulator feedback, thermal, switching current loops on PCB, peak
   ESP32 WiFi/BLE current, ESP32 reset and boot strapping.
5. Professional board-layout review of EMI, switching loop length,
   antenna RF ground/cable route, 4-layer stackup and 0.20 mm drill capability.
6. KiCad7 CLI here does **not** expose ERC via its supported command line
   (only netlist export was completed); run full electrical rules in KiCad GUI
   before making a revision. Run safe bench tests, then separately authorize
   any in-vehicle or active-transmission testing.

All vehicle-facing conductors are **unverified**, and the links isolating them
must remain DNP. The firmware in its repository was not altered.
