# Vehicle test protocol

## Scope

This protocol collects reproducible evidence. It does not assume that any
decoded field is correct, and it does not authorise active DCL transmission.
Complete the wiring review before every session.

With no suitable test equipment available, perform only receive-only KOEO
sessions with bounded duration and fail-safe abort. Defer active-master, KOER,
termination, polarity-under-power, and signal-integrity work until the
electrical interface is measured and approved.

## Session identity

Use UTC and create a new named output parent for every wiring, DCL baud,
adapter, or ignition change:

```text
SME105_<STATE>_<TEMP>_<TEST>_DCL<BAUD>_<YYYYMMDDTHHMMSSZ>
```

Examples:

```text
SME105_KOEO_COLD_BASELINE_DCL9600_20260822T030000Z
SME105_KOEO_COLD_TPS_SWEEP_DCL9600_20260822T031000Z
SME105_KOER_WARM_LOADS_DCL9600_20260822T034500Z
```

Do not put multiple baud candidates or wiring polarities in one session.

Capture metadata must include:

- exact session name and UTC start;
- vehicle identifier without public personal data;
- ECU label/calibration text as photographed or transcribed;
- adapter make, revision, and USB identity;
- receive-only or active-master mode;
- connector pins and recorded A/B assignment;
- power source and ground point;
- port path, USB baud (115200 ASCII or 460800 binary), candidate DCL
  baud/8N2 setting, firmware identity, and CLI version;
- ambient condition and cold/warm assessment;
- operator and safety observer;
- raw-capture filename and post-session SHA-256.

## Event markers

Markers are operator declarations, not decoded conclusions. Do not edit a
capture's `events.jsonl`. In a second terminal, append to a separate marker
log at the physical action time:

```bash
SESSION_NAME="SME105_KOEO_COLD_BASELINE_DCL9600_20260822T030000Z"
EVENT_LOG="captures/${SESSION_NAME}.operator-events.jsonl"
ford-dcl marker SESSION_START --output "$EVENT_LOG"
ford-dcl marker TPS_SWEEP_START --output "$EVENT_LOG"
ford-dcl marker TPS_SWEEP_END --detail "pedal released" --output "$EVENT_LOG"
```

Each marker contains UTC and host monotonic time. Run capture and marker
commands on the same host boot so monotonic timestamps are comparable.

Use uppercase tokens and an optional short note:

```text
SESSION_START
KEY_OFF
KEY_ON
ENGINE_START
ENGINE_STOP
TPS_CLOSED
TPS_SWEEP_START
TPS_25_HOLD_START
TPS_25_HOLD_END
TPS_50_HOLD_START
TPS_50_HOLD_END
TPS_SWEEP_END
LOAD_HEADLAMPS_ON
LOAD_HEADLAMPS_OFF
LOAD_BLOWER_ON
LOAD_BLOWER_OFF
LOAD_STEERING_START
LOAD_STEERING_END
O2_CLOSED_LOOP_WINDOW_START
O2_CLOSED_LOOP_WINDOW_END
SENSOR_UNPLUG_START name=<sensor>
SENSOR_UNPLUG_END name=<sensor>
ABORT reason=<plain-language reason>
SESSION_END
```

Never label a signal `ECT`, `TPS`, `LOAD`, `IAC`, or `O2` in raw evidence
unless that mapping is already independently validated. Event names describe
the operator action only.

Keep a spoken or written count before each action. Hold conditions long enough
to observe several candidate update cycles, but use the shortest safe duration.
After `SESSION_END`, hash and make the marker log read-only:

```bash
sha256sum "$EVENT_LOG" > "${EVENT_LOG}.sha256"
chmod a-w "$EVENT_LOG" "${EVENT_LOG}.sha256"
sha256sum --check "${EVENT_LOG}.sha256"
```

## Preflight

1. Review `docs/wiring-safety.md`.
2. Confirm park/neutral, parking brake, wheel chocks, ventilation, clear
   engine bay, and immediate key access.
3. Confirm no leaks, loose wiring, warning smoke, or unsafe engine condition.
4. Confirm original sensor and vacuum connections before modification.
5. Confirm receive-only hardware cannot drive the DCL pair.
6. Verify the serial device identity and that no other process owns it.
7. Start a new capture and emit `SESSION_START`.
8. Record `KEY_OFF` and at least 10 seconds of baseline.

## KOEO baseline and key-on

1. Keep engine off and all loads off.
2. Emit `KEY_ON`, then turn the key to run without cranking.
3. Capture for a bounded interval, normally 30 seconds.
4. Emit `KEY_OFF`, switch off, and continue for 10 seconds.
5. Emit `SESSION_END` and seal the capture.

Passive RX is likely silent because DCL is request/response. Record the silence
as observed; do not extend the session indefinitely or improvise a request.

## Cold-to-warm session

Prerequisite: an electrically approved interface and safe KOER operation. Do
not perform this phase under the no-test-equipment restriction.

1. Define cold as an engine that has soaked long enough for coolant and intake
   temperatures to approach ambient. Record soak time and ambient estimate;
   do not claim equality without measurement.
2. Capture KOEO baseline, then emit `ENGINE_START` immediately before cranking.
3. Do not touch the throttle during initial stabilisation.
4. Add elapsed-time markers at consistent intervals.
5. Continue only while ventilation, coolant temperature, oil pressure,
   battery/charging state, and engine behaviour remain safe.
6. Mark the warm/closed-loop assessment as an operator observation, not as a
   decoded fact.
7. Emit `ENGINE_STOP`, stop the engine, then `KEY_OFF`.

Compare monotonic trends, plateaus, dropouts, and repeated cold starts. A trend
that resembles temperature does not prove an ECT mapping.

## TPS sweep and throttle holds

KOEO is preferred for mapping pedal/plate position without engine-speed risk.

1. With key on and engine off, emit `TPS_CLOSED` without touching the pedal.
2. Emit `TPS_SWEEP_START`.
3. Move the throttle slowly and continuously from closed toward full travel,
   then return slowly to closed. Do not force the mechanism.
4. Emit `TPS_SWEEP_END`.
5. In a separate capture, perform approximate 25% and 50% holds, marking each
   start and end. The percentages describe pedal/operator position, not a
   calibrated TPS percentage.
6. Repeat the sweep twice.

Reject a candidate that is not repeatable, has implausible discontinuities, or
does not return to its baseline. A responding field may still represent a
derived load or another correlated quantity.

## Throttle holds with engine running

This is a gated KOER test. Use a safety observer, approved interface, adequate
ventilation, and an independent tachometer before assigning target RPM.

- Use only low, pre-agreed, bounded holds.
- Never hold against a vehicle in gear.
- Do not rely on unvalidated telemetry for overspeed protection.
- End the hold immediately for surge, knock, overheating, warning lamps,
  unexpected throttle response, or observer command.

## Electrical and mechanical loads

After a stable warm idle, apply one load at a time and mark both edges:

1. Headlamps on, hold briefly, headlamps off.
2. Cabin blower on, hold briefly, blower off.
3. Rear-window heater on/off only if fitted and known safe.
4. Air-conditioning request on/off only if fitted and system condition is
   known.
5. Power-steering load only with wheels clear of hazards; do not hold at full
   lock.

Allow recovery between loads. Look for repeated fields that change at the
event edge and recover afterward. Such response supports a load-related
hypothesis but does not establish field identity.

## O2 closed-loop window

Prerequisite: safe warm KOER operation and a known-good exhaust/ventilation
arrangement.

1. Reach a stable warm idle without declaring closed loop from telemetry.
2. Use service information or independent measurement to determine when
   closed-loop operation is plausible.
3. Emit `O2_CLOSED_LOOP_WINDOW_START`.
4. Record a bounded steady-idle window, then one small, safe engine-speed
   change and recovery.
5. Emit `O2_CLOSED_LOOP_WINDOW_END`.

Candidate O2 and fuel-correction fields should show repeatable, physically
plausible interaction. Oscillation alone is not proof: noise, parity errors,
aliasing, and unrelated control loops can oscillate.

## KOEO one-sensor unplug test

Use only a sensor approved by vehicle service information for an ignition-off
disconnect. Never unplug ECU, ignition, injector, airbag, transmission, or
unknown connectors.

1. Complete and seal an intact KOEO baseline.
2. Key off, remove the key, and wait for ECU power-down.
3. Photograph and label the original connection.
4. Disconnect exactly one approved sensor.
5. Start a new capture, emit `SENSOR_UNPLUG_START name=<sensor>`, then perform
   one bounded KOEO key-on window.
6. Key off and wait for power-down.
7. Reconnect and lock the sensor before any engine start.
8. In a new restoration capture, emit
   `SENSOR_UNPLUG_END name=<sensor>` and repeat KOEO.

An unplug test may set a stored fault. Record that possibility and follow
vehicle service information. Do not clear codes merely to improve the result.
The changed raw field is only a mapping candidate until repeated and checked
against known fail-safe behaviour.

## KOER safety gate

KOER is permitted only when all conditions are met:

- the vehicle is mechanically safe to run and exhaust is controlled;
- the interface has passed electrical validation with appropriate equipment;
- receive and active-driver states are proven;
- KOEO captures are stable and reproducible;
- an operator remains at the key and a second person observes;
- no loose leads can reach moving or hot parts;
- session duration and maximum engine speed are agreed in advance;
- an independent means of observing engine speed and temperature is present;
- the test can be aborted by key-off and immediate bus-driver disable.

Failure of any gate means KOEO only.

## Abort conditions

Emit `ABORT` if possible, then disable transmission, key off, and disconnect
according to the restoration sequence for any:

- smoke, smell, heat, spark, warm lead, or adapter reset;
- unstable, rising, or uncontrolled idle;
- unexpected actuator operation;
- warning light, loss of oil pressure, overheating, or abnormal noise;
- communication flood or driver stuck enabled;
- loss of serial logging, timestamping, or event-marker control;
- wiring movement, uncertain polarity, or ground fault;
- observer command or any condition not covered by the procedure.

Safety takes priority over preserving a clean capture.

## End and restoration

1. Emit `ENGINE_STOP` if applicable, stop the engine, then emit `KEY_OFF`.
2. Wait for ECU power-down.
3. Stop capture and emit `SESSION_END` if still possible.
4. Restore every load, hose, connector, sensor, and wiring lock.
5. Disconnect DCL signals, separate project power, then car ground last.
6. Inspect the vehicle in its original configuration.
7. Hash and make the raw capture read-only.
8. Record deviations, aborted steps, and restoration confirmation.

