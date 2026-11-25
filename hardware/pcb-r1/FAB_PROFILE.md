# Proposed manufacturing profile — design-rule assumption ONLY

- Board: 95 x 60 mm; rigid FR-4, four copper layers.
- Copper: nominal 1 oz external (verify internal copper and impedance).
- Proposed stackup: manufacturer-recommended 4-layer stackup, not ordered.
- Minimum through-hole drill: **0.20 mm** configured in KiCad project.
- Routing: approximately 0.20 mm signal tracks; 0.60/0.30 mm normal vias,
  plus plated 0.20 mm thermal holes embedded in module/regulator pad patterns.
- Solder finish, soldermask, minimum annular rings, via-in-pad finishing and
  thermal pad fill/capping MUST be agreed with the chosen assembler.

The 0.20mm drill capability is listed by JLCPCB and PCBWay, but it is not
necessarily free or suitable with all board thicknesses, thermal-via
structures, and assembly processes. PCB manufacturer approval and DFM
required before ordering any boards.

Public specifications:
- https://jlcpcb.com/blog/pcb-design-verification-guide
- https://www.pcbway.com/capabilities.html

**Not a factory-approved Gerber order.**
