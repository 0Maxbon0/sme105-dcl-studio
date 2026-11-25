# Hardware design workspace

The hardware folder contains **work-in-progress PCB design research**, not
releasable automotive hardware. The **actually tested bridge** remains
the separate hand-wired ESP32 DevKit + MAX487 bench assembly.

| Folder | Design | Status |
| --- | --- | --- |
| [`pcb-r0/`](pcb-r0/) | Original larger KiCad concept, approximately 115 × 75 mm | Historical 4-layer engineering prototype design, no fabrication/vehicle certification |
| [`pcb-r1/`](pcb-r1/) | Compact 95 × 60 mm, four-layer KiCad proposal | Locally reviewed ERC/DRC; **not manufactured, assembled or electrically qualified** |

Preferred files to keep under source control **after a dedicated privacy
and licensing review** are the editable `board.kicad_sch`,
`board.kicad_pcb`, `board.kicad_pro`, project-local
`parts.pretty/` + `fp-lib-table`, relevant generator/verification scripts,
the review-only BOM and curated non-sensitive previews.

Do **not** mistake routing session logs, interactive KiCad preference files,
machine lockfiles, staging ZIPs or downloaded datasheet PDFs for source.
Preserve every existing local file until its provenance and need are reviewed.
The parent project ignores obvious temporary/build items but does not
delete them.

Start with [hardware and wiring](../docs/HARDWARE_GUIDE.md),
[R1 status](pcb-r1/REVIEW_STATUS.md) and
[electrical safety](../docs/wiring-safety.md).
