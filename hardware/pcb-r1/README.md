# SME105 DCL Bridge R1 — compact KiCad PCB prototype

**Engineering review only — not approved for manufacturing, plugging into the car or driving the ECU.**

This is a 95 × 60 mm, 4-layer **single PCB** replacing the ESP32 DevKit,
MAX487 breakout, level-shifter breakout and bench-supply wiring in the
existing SME105 Ford Escort DCL bridge. It is smaller than the R0 115 × 75 mm
layout by approximately 34% in area. This is a compact layout trial; the
final dimensions depend on the OBD connector, case and external RF antenna.

## Open locally on Ubuntu

From this folder (when the local tools cache is present):

    ./open-local-kicad.sh
    ./open-local-schematic.sh
    ./verify-local.sh

Alternatively open `board.kicad_pro` in **KiCad 7+**. Project-local
`parts.pretty/` and `fp-lib-table` carry the footprints. The full installed
KiCad application is *not included* in the review ZIP.

## Electrical architecture

- J1: six-position **placeholder header** for an externally sourced OBD2
  pigtail. It is **not a ready-made male OBD2 plug footprint**.
- OBD pin 16 nominal 12 V -> input fuse -> reverse-series diode -> transient
  clamp (candidate, unqualified) -> LM5164-Q1 5 V buck -> TPS62160 3.3 V buck.
- ESP32-WROOM-32UE-N4 module (not full DevKit): Wi-Fi and Bluetooth LE in
  the existing chip, with external 2.4 GHz U.FL antenna support.
- MAX487 5 V DCL transceiver: RO through 12 kΩ / 20 kΩ input divider to
  ESP32 GPIO16; DI driven from GPIO17; DE GPIO18 with 10 kΩ pull-down;
  receiver /RE tied low.
- J2: UART0 3.3 V flashing/recovery header, BOOT and RESET buttons.
- **R13/R14/R15 MUST remain DNP:** DCL candidate pin links and signal-ground
  link must not be enabled before vehicle pinout and electrical qualification.

## Verified locally

- Schematic electrically cross-checked with real board pads (116 matches).
- Electrical rules: **ERC 0 errors and 0 warnings** (confirmed on same
  generated schematic source via KiCad GUI; the optional SPICE-model issue
  diagnostic is disabled in the KiCad project, and no simulation was run).
- Geometry: **DRC 0 errors/warnings, no unconnected pads** for this revision,
  using min through-hole 0.20 mm explicitly set in `board.kicad_pro`.
- All 26 routed copper nets on outer front/back layers; two inner ground
  planes. 398 routed segments; 41 vias; 41 physical footprints.
- Layout checked for intersecting front courtyards and out-of-outline parts.

**Passing ERC/DRC is not equivalent to electrical, automotive or RF safety
qualification.** See `REVIEW_STATUS.md`, `FAB_PROFILE.md`, `DESIGN.md`,
`BOM_REVIEW_ONLY.csv`, and `ACCESSORIES_REVIEW_ONLY.csv`.

## Reproducibility

`gen_cad.py` holds the original net and placement specification;
`build-local.sh --reset-unrouted` **replaces the routed PCB** and must NOT be
run accidentally. Keep the routed files as the review master. All custom
work is isolated under `hardware/pcb-r1/`; the firmware was not modified.
