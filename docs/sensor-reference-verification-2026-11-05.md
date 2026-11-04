# Sensor conversion and normal-range verification

Vehicle confirmed by owner on 2026-11-05: 1998 Escort 1.6 Zetec, manual,
1600 cc, SME-105 and the recorded 97AB-12A650-KA identity. Confirmation is
an owner declaration, not an independently photographed label or calibration
dump. No engine-code suffix, sensor part numbers or ECU oscillator measurement
has been independently obtained. The existing response software bytes alone
do not identify a Ford strategy/transfer curve.

## Research result

The public sources support a published regulated-idle reference and the
existing protocol encodings. They do **not** establish calibrated SME-105
throttle volts, oxygen millivolts, injector milliseconds or complete numeric
healthy ranges for every channel. Those conversions remain disabled rather
than being presented as verified. Internet research cannot replace a missing
calibration definition or a matched physical measurement.

### Applicable Ford material

1. [Ford Escort/Orion workshop section 329-04, Zetec/Zetec-E specifications (mirror)](https://workshop-manuals.com/ford/escort.orion_1991_08.1990-09.2001/mechanical_repairs/3_powertrain/329_engine_management/329-04_engine_management_zetec-zetec-e_engines/specificationsgeneral_specifications/):
   the 1.6 L1E, L1H and L1K columns give regulated idle as 875 ± 50 rpm.
   The table distinguishes EEC-IV and EEC-V applications. A model name and
   displacement alone must not select an electronic calibration. The app uses
   the shared 825–925 rpm **regulated idle** reference only after the operator
   selects a settled, fully warm, stationary, neutral, released-pedal and
   unloaded idle comparison. It does not classify revving or cold start against
   this band, nor automatically declare that the engine is fully warm from an
   invented coolant threshold. Published base-idle service settings are not
   everyday idle targets and have not been applied.
2. [Ford TSB 74/2000, dated 8 June 2000 (reproduced on Ford Owners Club)](https://www.fordownersclub.com/forums/topic/1004-engine-revs-up-and-down/):
   contains a Ford-authored diagnostic procedure for manual Escort 1.6/1.8
   Zetec variants and distinguishes EEC-IV/V. It documents the relevance of
   calibration and connector contamination to driveability, supporting checks
   before component replacement. It does not supply the missing raw-count
   voltage conversion. This is a reproduced bulletin, not a currently hosted
   Ford original; unrelated forum opinions were not used as specifications.
3. The accessible petrol cooling and charging specification pages contained
   service information but no usable calibrated live-PID healthy temperature
   or voltage bands. Their absence is not proof that such specifications do
   not exist. Values from US 2.0 Escort, 1980s CVH, 1.3 HCS or 1.8 engines
   were excluded from 1.6 sensor limits.

## Count-to-unit verification

- Throttle: [reference implementation](https://github.com/babroval/ford-eec-iv-diagnostic/blob/master/eec-iv/src/babroval/eec_iv/service/ParameterServiceImpl.java)
  applies an integer approximate millivolt transform. This is not a verified
  transfer for 97AB-12A650-KA. No nominal 5 V ADC formula, voltage endpoint
  range, or percentage opening has been enabled.
- Oxygen: the same implementation uses an inverted count-to-millivolt
  transform. That demonstrates why raw high cannot automatically mean rich;
  it does not authenticate this ECU's input conditioning. No converted oxygen
  voltage, lean/rich alarm or switch-rate threshold has been enabled.
- Injector: LHBH1 chapter 13 describes 32 clock ticks per raw unit. Its
  separate FREQ18 discussion is strategy/clock-specific. The implementation
  above computes microseconds with another correction. Neither establishes
  a verified clock-time mapping for the owner's installed hardware. The app
  retains clock ticks and explains that a larger command represents more
  on-time within the same encoding. No fixed normal pulse duration is assigned.
- Temperature raw inputs: thermistor transfer is nonlinear. The ECU's
  separate ECT and ACT channels already provide temperatures; an ACT value
  can be substituted. Raw IECT/IACT cannot be treated as an independent
  calibrated temperature or sensor-health pass/fail.
- PID 0x26: LHBH1 calls it unused while the [other PID map](https://github.com/doncreat0r/eeciv/blob/master/tables.h)
  mentions possible MAF. Activity cannot validate identity, volts or g/s.
- EGR, octane, neutral and calibration raw inputs: no exact applicable
  transfer or healthy band was established. Equipment/strategy differences
  matter. A zero or a changing count is not sufficient qualification.
- Speed: existing reference decoding remains native mph; the display applies
  the exact unit factor 1.609344 to show km/h. This unit conversion does not
  itself prove vehicle speed calibration while moving.

## Per-channel interpretation in the app

Every entry in `PIDS` has an explicit reference and behaviour description in
`app/js/reference.js`; tests enforce complete coverage. The UI displays these
with every live card and links the idle specification to its source.

- Engine RPM and idle target: published regulated-idle reference, with
  operating conditions and a distinction between actual RPM and ECU target.
- Coolant/intake temperature and supply voltage: operating-state explanations;
  no unsupported generic 85–95 °C, 105/115 °C or 13 V health thresholds.
- Pressure: altitude/weather/engine-load dependence; no fixed sea-level band
  is used as a sensor-failure test.
- Spark, injector command, load and duty commands: explain what increases
  mean and why higher/lower is not universally better. Duty-cycle endpoints
  describe command units, not physical valve opening or a healthy band.
- Mixture command and learned factor: unity references distinguish requested
  mixture and correction from measured exhaust composition or a verified
  healthy adaptation band.
- Raw signals and PID 0x26: explicitly unverified physical scaling/limits.
- Packed flags and switch states: no numeric high/low health score.
- Timer and throttle mode: operating values/states, not fault severity.
- Automatic transmission channels: retained and marked inapplicable for the
  manual profile. Switching the manual option off does not fabricate ranges
  for another transmission.

Previous generic alarms were replaced because they were not backed by
applicable manufacturer limits. The saved captures, decoder, sampling sets,
native values, technical details and CSV evidence remain intact. The earlier
capture review describes observed clues; it is not an approved factory
threshold catalogue and has been superseded by this document for limit policy.

## Evidence still required for additional conversions

Obtain a Ford calibration/strategy definition tied to the actual ECU label,
or have a qualified technician record synchronized raw PID and independently
measured signal voltage over several operating points. The oxygen check must
establish polarity and response across actual sensor operating states. Verify
injector pulse duration with an appropriate automotive measurement instrument
and compare it with the same capture's command. A single plausible sample
or idle-only recording cannot establish the whole conversion or healthy band.
These measurements were not performed in this session.

## Validation

18 focused tests pass: existing capture decoding, unit presentation and CSV
preservation, complete per-PID reference coverage, idle boundaries (824/825,
925/926), explicit test-condition gating and neutral treatment of unsupported
factory health thresholds. JavaScript syntax and diff whitespace checks pass.
The two previously established unrelated broader-suite failures remain:
missing temporary DTC fixture and the old KOEO-label expectation. No firmware
flash, physical car measurement, deployment, commit or push was performed.
