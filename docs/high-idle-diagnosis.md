# High-idle diagnosis

## Limits

Telemetry can prioritise checks; it cannot by itself prove the cause of a high
idle. No SME-105 parameter mapping is currently verified. A field that looks
like ECT, TPS, load, IAC, O2, or fuel correction remains a candidate until it
passes the validation protocol.

Do not diagnose from the public DCL map or Java formulas alone. Confirm faults
with vehicle service information and independent mechanical/electrical tests.
Do not fabricate a result when a tool is unavailable.

Stop the engine for uncontrolled RPM, overheating, abnormal noise, smoke,
fuel smell, warning indications, or unsafe working conditions.

## Establish the symptom

Record before changing anything:

- cold start RPM and time since start;
- warm idle RPM after a normal drive or controlled warm-up;
- park/neutral versus in-gear behaviour, if safely applicable;
- air-conditioning, steering, electrical load, and cooling-fan state;
- throttle cable and plate return;
- recent repairs, battery disconnect, hose work, or cleaning;
- stored self-test codes without clearing them;
- exact raw capture and event markers.

Separate a brief commanded cold fast idle from a persistent warm high idle.
Repeat the same conditions before comparing changes.

## ECT branch

If the candidate ECT value remains implausibly cold as the engine warms:

- Compare its cold reading with ambient using an independent thermometer.
- Compare warm behaviour with an independent coolant-temperature measurement
  or service-data resistance/voltage test.
- Inspect the ECT connector, reference/ground, harness, and sensor according
  to the wiring diagram.
- A cold-biased input can support a commanded fast-idle hypothesis.

If the candidate ECT tracks cold-to-warm plausibly:

- Reduce the priority of ECT bias, but do not eliminate intermittent wiring,
  calibration error, or a mapping mistake.
- Continue to TPS, load, IAC, and unmetered-air branches.

If the field is static, discontinuous, or parity-invalid:

- Treat the mapping or capture as invalid before blaming the sensor.

## TPS branch

If the candidate TPS does not return consistently to the closed-throttle
baseline:

- With engine off, inspect pedal, cable, cruise linkage, throttle stop,
  deposits, and plate return.
- Perform repeated KOEO sweeps and holds.
- Use service-information voltage tests before condemning TPS.
- A high closed-throttle indication can support an ECU off-idle strategy, but
  correlated telemetry alone is not proof.

If TPS returns cleanly and repeatably to closed:

- Reduce the priority of a stuck throttle or TPS offset.
- Continue to calculated-load and IAC/air-leak branches.

If TPS is noisy or jumps:

- Separate raw-data/parity faults from actual sensor or wiring faults using
  independent measurement.

Never alter the factory throttle stop merely to lower idle.

## Calculated-load branch

If candidate load is high while the throttle is closed:

- Confirm all commanded loads: air conditioning, power steering, alternator,
  cooling fan, transmission state, and electrical accessories.
- Compare load-on and load-off event markers one load at a time.
- Check whether RPM itself is inflating a derived load value.
- Inspect relevant load inputs and charging system according to service
  information.

If candidate load changes at marked accessory edges and idle follows:

- This supports a load-compensation path.
- Determine whether the load request is genuine, stuck, or misreported.

If candidate load remains low while idle is high:

- Prioritise excess airflow, IAC behaviour, throttle closure, and vacuum leaks.
- Do not exclude load until the mapping is independently validated.

## IAC branch

If candidate IAC command is high:

- The ECU may be requesting extra air because of cold bias, load request,
  startup strategy, low-voltage compensation, or another input.
- Resolve ECT, TPS, load, battery/charging, and strategy conditions before
  condemning the valve.

If candidate IAC command is low but idle remains high:

- Prioritise airflow bypassing ECU control: sticking IAC, open throttle plate,
  PCV fault, brake-booster leak, purge path, hose split, throttle-body gasket,
  or intake leak.

If command changes but engine speed does not:

- Check IAC valve movement, passage restriction, wiring, and the possibility
  that the decoded field is not IAC.

If the IAC field is unavailable or unverified:

- Continue with reversible mechanical isolation only under the safe procedure
  below.

## Reversible IAC airflow blanking

This test distinguishes commanded/bypass air from air entering elsewhere. Use
the vehicle service procedure where available.

1. Engine off, key removed, and hot/moving parts safe.
2. Document the original IAC connector, valve, gasket, hoses, and air passage.
3. Install a reversible, non-shedding blank that blocks only the identified
   IAC airflow path. Do not force material into the intake and do not modify
   the throttle stop.
4. Reassemble sufficiently to prevent loose parts or unfiltered air.
5. Clear all tools, then start only for a short, supervised observation.
6. Stop immediately for uncontrolled speed, poor oil pressure, abnormal
   operation, or any loose component.
7. Key off and restore the original IAC path before normal use.

Interpretation:

- If idle drops substantially, airflow through the IAC path is implicated.
  Separate a commanded-open valve from a mechanically leaking/stuck valve
  with independent command, voltage, and valve checks.
- If idle remains high, another air path or mechanically open throttle becomes
  more likely.
- If the engine stalls, the IAC path was a major idle-air source under that
  condition; this does not prove the IAC was faulty.
- If the result is ambiguous, restore the vehicle and repeat only after the
  test arrangement is reviewed.

Do not use an electrical IAC disconnect as equivalent to physical airflow
blanking; a valve can remain mechanically open, and disconnecting it can
invoke a fail-safe strategy.

## Smoke-test air-leak branch

After a restored IAC blanking test, perform an engine-off smoke test with
equipment intended for intake systems and pressure limited to the vehicle
service specification. Do not use compressed shop air, oxygen, fuel vapour,
brake cleaner, propane, or an improvised smoke source.

Inspect in this order:

1. PCV valve, grommet, separator, and all PCV hoses.
2. Throttle-body gasket, shaft area, and bypass passages.
3. Intake-manifold gasket and plenum joints.
4. Brake-booster hose/check valve.
5. Evaporative-purge and vacuum accessory branches.
6. Injector seals and any model-specific vacuum ports.

Mark each smoke location and repair one fault at a time. Restore, repeat the
same idle conditions, and capture a new immutable session after each repair.

## O2 and fuel-correction support

Use O2 and fuel correction as supporting evidence only after closed-loop
operation is independently plausible.

If candidate O2 indicates lean and candidate fuel correction adds fuel:

- This can support unmetered air, low fuel delivery, exhaust leakage ahead of
  the sensor, or a biased sensor.
- Combined with low IAC command and persistent high idle, an intake-air leak
  becomes more plausible.
- Confirm with smoke testing, fuel-pressure/service checks, and exhaust
  inspection.

If candidate O2 indicates rich and correction removes fuel:

- Investigate fuel pressure, injector leakage, purge, sensor bias, and
  cold-enrichment inputs.
- Rich correction does not explain high airflow by itself.

If O2 switches and correction remains near its normal range:

- A large vacuum leak becomes less supported, not excluded.
- Check throttle and IAC mechanical airflow paths.

If open loop, cold, parity-invalid, fixed, or mapping-unverified:

- Do not use O2/fuel correction to select a branch.

## Reproducible decision record

Copy `examples/high_idle_evidence.example.json` to a derived analysis file.
Populate it only from validated, synchronized captures and the physical
airflow-isolation result:

```bash
cp examples/high_idle_evidence.example.json analysis/warm-idle-evidence.json
ford-dcl diagnose analysis/warm-idle-evidence.json --json \
  > analysis/warm-idle-diagnosis.json
```

`airflow_isolation` accepts `not_performed`, `rpm_dropped_or_stalled`, or
`rpm_remained_high`. `mixture` accepts `unknown`, `lean`, `normal`, or `rich`.
The default decision thresholds are 1000 RPM, 80 degC, and 10 percent IAC.
They are explicit software thresholds, not verified SME-105 calibration data.

The result can only set `definitive` after the physical IAC-path test, three
repeatable fully-warm sessions, and source capture IDs. It identifies an
airflow branch; it does not identify the exact failed hose, gasket, valve, or
sensor.

## Evidence conclusion

A defensible conclusion states:

- what was independently measured;
- which immutable captures and markers support it;
- which mappings are validated versus candidate;
- which reversible test changed the symptom;
- what was restored;
- what remains unknown.

“Telemetry resembles X” is not a definitive diagnosis. Require a confirming
mechanical or electrical test before replacing parts.

