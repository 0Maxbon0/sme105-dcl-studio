# Owner capture review and display conversion evidence

Inputs: `/home/maxim/Downloads/eec-iv-live (1).csv` and
`/home/maxim/Downloads/eec-iv-live (2).csv`. Owner reports a stationary
1600 cc manual car, partly warmed, with some accelerator movement.
These CSVs contain decoded samples but no raw serial framing, parity/error
counters, session identity or final session validity. They cannot independently
prove transport integrity, sensor calibration or a failed component.

## Observations

- File (1): 7,703 readings over t=0.770–185.600 s, extra channels (LIVE3).
  File (2): 5,052 readings over t=0.840–122.043 s, engine channels (LIVE).
  Times restart in each file; the files cannot be synchronized from these CSVs.
- Intake raw IACT stays at 947–949 in file (2). This repeats the earlier capture
  and is consistent with an open/high input; earlier project captures also
  reported code 113. Check the sensor connection and wiring before replacing
  anything. ACT stays exactly 37.8 °C while ECT rises 72.2–76.7 °C. ACT may be a
  fallback; the previous UI claim that it always copies coolant was incorrect.
- Oxygen raw IEGO1 is 1011–1023, median 1023, in file (2). It is almost pinned
  at the raw upper limit. Partly warmed operation and absent closed-loop state
  prevent a firm diagnosis. A high raw count is not necessarily high sensor
  voltage or rich exhaust. Repeat fully warm with loop status and verified
  sensor-input scaling; do not condemn the sensor from this file alone.
- Running VBAT in file (2) is 12.75–13.0625 V, median 12.9375 V. Compare ECU
  voltage with a multimeter at the battery, at idle and slightly raised RPM,
  before diagnosing charging or ground problems. File (1)'s 9.5625 V minimum
  occurs at 53.19–53.55 s, as RPM goes from zero to cranking/running; this is
  consistent with engine start, rather than sustained running voltage collapse.
- ITP is 43–217 counts in file (2), median 157. Around 114–116 s the engine
  revs to 1884 rpm then settles as ITP and injector command change. Accelerator
  movement explains at least part of this activity. Capture a steady-pedal
  period before diagnosing noise, connector problems or a dead spot. Counts
  cannot be called throttle percent without calibrated endpoints.
- BP is 25.625–26.125 inHg, lower than the earlier project capture's 29.875.
  Check actual local absolute pressure/altitude and input interpretation before
  treating this as a barometric sensor fault; sea-level weather reports are
  pressure corrected and are not a direct comparison at altitude.
- Zero speed is expected because the owner was stationary. This does not
  validate speed calibration while driving. Coolant rises during warming;
  lambda command is 0.9921875–1 and learned fuel factor remains 1 (0% learned
  correction). These do not prove closed-loop control or absence of faults.

## Extra channels and manual gearbox

All samples remain available. No PID, capture, firmware command or scan set
was removed or changed by this display work.

- MAP, MAP_FREQ and EGRDC are always zero in file (1). Zero samples really
  arrived, but zero alone does not distinguish inactivity from unsupported
  equipment or a different ECU meaning. Do not diagnose absent/broken sensors
  from these zeros.
- BCSDC, ETVOCM, TV_PRES, ITOT and PDL are always zero; GR_CM is always 2.
  They describe automatic transmission functions in the reference table and
  should not be used as manual gearbox measurements. In particular, 2 does
  not establish that the car was in second gear. The app marks these as not
  applicable in manual mode, retaining values and graphs in technical details.
- The channel currently named MAF (PID 0x26) changes from 0–275 with engine
  activity. LHBH1 lists 0x26 as unused, while another implementation mentions
  MAF. Activity is evidence of a changing channel, not proof of airflow units.
  Its label now identifies the uncertainty; no g/s or voltage is guessed.
- IEGR changes 200–338. A changing raw input does not prove this car has EGR
  or establish valve position. Equipment and interpretation need confirmation.

Recommendation: keep the Engine scan for everyday use; use idle/flags and
extra channels for targeted investigation. Do not automatically remove or
stop sampling any constant or zero-valued channel. A received sample count
is distinct from a raw sensor count: 514 samples means 514 readings arrived.

## Conversion contract

The decoder and the original first four CSV fields retain their existing
values. New exports append `unit,display_value,display_unit` so historical
native values cannot be mistaken for the current display unit.

- LHBH1 chapter 13, printed pp.13-30/31, defines VS (0x18) as raw/32 mph
  and VSBAR (0x17) as low byte/2 mph. The UI multiplies mph by 1.609344 to
  show km/h, including graph ranges. Example: VS raw 3200 and VSBAR raw 200
  each mean 100 mph = 160.9344 km/h. Stationary recordings exercise only zero;
  confirm nonzero vehicle calibration against an independent speed reference.
- KAMRF1 is a multiplicative learned factor. Display correction is
  `(factor - 1) * 100`; factor 1 means 0%, 1.0625 means +6.25%.
- IECT is not linearly converted to temperature: the existing ECT channel
  already supplies the ECU's temperature in °C. The raw channel points to it.
- ITP, RATCH, IACT, IEGO1, IEGR, IOCC, INDS and IVCAL retain raw values in
  details. A generic ADC full-scale percentage is not throttle percent,
  and a generic 5 V ADC formula is not a verified sensor voltage conversion.
- FUELPW1 remains ticks in details. The reference specifies 32 clock ticks
  per raw unit but does not establish this ECU's time per tick. No ms is
  invented. Idle-air duty is labelled electrical command, not valve position.
- Warnings describe evidence and context. Fixed ACT is labelled possible
  fallback, oxygen raw saturation cannot receive a healthy verdict, and
  pedal movement is considered before describing throttle changes as a fault.

Sources checked: local `/tmp/LHBH1.TXT`, chapter 13 PID tables and chapter 22
ACT fallback logic; [reference PID map](https://github.com/doncreat0r/eeciv/blob/master/tables.h)
and [reference display conversions](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/eec-iv/src/babroval/eec_iv/service/ParameterServiceImpl.java).
The latter uses approximate sensor transforms on another implementation;
these were not copied as calibrated SME105 conversions.

## Checks

14 conversion, interpretation and existing decoder tests pass. The full app
suite has two failures also reproduced on the unchanged previous commit:
`codes.test.mjs` requires missing `/tmp/babroval/.../EECIVFaults.csv`, and
`controller.test.mjs` expects `KOEO` where the existing code emits `engine off`.
No new hardware verification or moving-vehicle speed calibration was performed.
