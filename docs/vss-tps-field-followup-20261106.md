# SME105 November 6 field follow-up — VSS comparison and calibrated TPS card

This note distinguishes actual observed phone data from hypotheses. No vehicle or ECU command was issued to gather these facts; the phone's existing `eeciv-recordings` IndexedDB was queried read-only. Do not commit original recordings, mobile backups or device secrets.

## Newest available VSS test (recorded about 11:27 UTC)

This was a 112-second `ALL` capture after the owner repaired and hand-turned their gearbox VSS. Speed readings reflect reported ECU channels, **not independently measured moving-vehicle speed**.

| PID | Number of samples | Zero | Nonzero | Maximum raw | Maximum displayed |
| --- | ---: | ---: | ---: | ---: | ---: |
| `VS` / 0x18 | 310 | 223 | 87 | 4095 (four samples) | 127.96875 mph, approximately 205.95 km/h |
| `VSBAR` / 0x17 | 310 | 205 | 105 | 219 | 109.5 mph, approximately 176.22 km/h |
| `N` engine RPM | 930 | 930 | 0 | 0 | 0 rpm |

Current software applies the published LHBH1 reference transforms `VS=raw/32 mph`, `VSBAR=(raw & 255)/2 mph` and display conversion `mph*1.609344`. The channels are separately requested/sampled at different times, and VSBAR is labelled filtered in published EEC-IV maps. Rapid manual VSS rotation, pulse irregularity, signal interference/wiring, ECU filtering, and a vehicle-specific scaling mismatch remain possible explanations for large differences. Neither this hand-spun capture nor the observed maxima prove the VSS is healthy or that either speed conversion is correct for SME105. Do not force the two channels equal or change the raw records.

**Next validation (operator-directed only):** inspect connector and VSS signal integrity, then compare both PIDs against an independent speed reference during a safe controlled road test. Do not command or simulate vehicle motion automatically.

## Separate gearbox-mounted switch

Its identity is not established without a photo/part number/connector count and physical location. An Escort manual gearbox can have a reverse-light switch, and a separate neutral/gear-position input may be present depending on vehicle/strategy. A reverse lamp switch need not have a PCM PID or fault code. Do not invent a `gear sensor` PID or claim a missing DTC proves the switch works.

## TPS display change

`Throttle calibrated` is a dedicated pinned-style dashboard card displaying relative mounted travel as a percent, with raw ITP and explicit confirmation/identity status. The original ITP card remains raw; the new card is a **derived display only**, not a 40th ECU PID. Tapping it opens the separately located TPS profile/reference editor. The card is hidden in LIVE3 because that mode does not request ITP. Existing calibration acceptance, historical-profile explicit selection, CSV/IDXDB raw preservation and firmware safety remain unchanged.

## Firmware audit

Firmware v24 was flashed on November 5 in the earlier authorized delivery (`docs/sol-delivery-20261105.md`). The later Android witness, calibration and session UX updates did not alter or reflash the ESP32; no v25 source release is present. Firmware v24's fail-closed `read_used` lock after RX_SILENCE is intentional, not evidence of line backpressure. New firmware is **not presently justified** by the speed comparison or this display-only change. End-to-end on-car VSS calibration and KOER confirmation, plus unimplemented K-Line RX hardware qualification, remain distinct open validation areas; no 100% vehicle readiness is claimed.
