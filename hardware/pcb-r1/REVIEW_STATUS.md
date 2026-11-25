# Engineering handoff — SME105 R1, 22 November 2026

## Completed

- [x] Local KiCad GUI opened on Ubuntu without admin privileges.
- [x] Editable KiCad .kicad_sch, .kicad_pcb, .kicad_pro files present.
- [x] 95 x 60 mm compact engineering board layout; no overlapping front courtyards.
- [x] Schematic ERC: 0 errors, 0 warnings (KiCad GUI).
- [x] Confirmed the only ignored ERC category is `SPICE model issue`
      (circuit simulation not performed, and not implied by ERC PASS).
- [x] PCB DRC: 0 violations, 0 unrouted pads (0.2mm drill profile).
- [x] Reference-to-pad netlist consistency check: 116/116 passed.
- [x] Outer-only signal routing; both internal planes are GND.
- [x] DNP links R13/R14/R15 isolate unverified vehicle-facing conductors.
- [x] Project-local footprint library, schematic, board, BOM, preview SVGs.

## Still required before fabrication or ECU use

- [ ] Confirm actual male OBD2 connector or qualified pigtail mechanical part,
      wire orientation and enclosure size. J1 is only a 1x6 placeholder.
- [ ] Measure candidate Ford DCL lines 3/11 and polarity/termination/bias;
      confirm the real MAX487 interface and electrical protection.
- [ ] Review protection for load dump, reverse battery, short circuit, cold
      cranking, surge, EMI/ESD and current draw with ignition switched off.
- [ ] Verify regulator component values and footprints against real supplier
      MPNs and scope power rails under 2.4GHz radio bursts.
- [ ] Review 0.2mm plated thermal holes, copper ring, thermal-pad soldering,
      and full factory design-for-manufacturability with selected PCB vendor.
- [ ] Confirm ESP32 antenna model, placement, RF clearances and performance.
- [ ] Bench-power first (isolated, current-limited supply) with **no ECU**;
      confirm MCU flash/recovery and fail-safe DCL receiver state.
- [ ] Run further real-vehicle tests only after competent electrical sign-off.

Passing ERC/DRC proves software rule consistency, not that a board is safe to
manufacture, assemble, insert into an OBD port or operate an ECU.
