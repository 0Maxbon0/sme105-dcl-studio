/** DIAGMODE 21H PID scaling. Port of scripts/decode_live_pids.py. */

export const LIVE_PIDS = Object.freeze([
  0x00, 0x01, 0x0f, 0x10, 0x05, 0x06, 0x09, 0x11,
  0x03, 0x04, 0x0c, 0x0d, 0x08, 0x18, 0x27, 0x28,
]);

export const LIVE2_PIDS = Object.freeze([
  0x00, 0x01, 0x24, 0x25, 0x2b, 0x09, 0x2a, 0x15,
  0x1a, 0x1b, 0x2f, 0x2e, 0x0b, 0x0e, 0x2d, 0x11,
]);

export const LIVE3_PIDS = Object.freeze([
  0x00, 0x01, 0x02, 0x07, 0x12, 0x13, 0x17, 0x26,
  0x30, 0x32, 0x35, 0x36, 0x37, 0x38, 0x11, 0x04,
]);

export const ALL_LIVE_PIDS = Object.freeze([...new Set([...LIVE_PIDS, ...LIVE2_PIDS, ...LIVE3_PIDS])]);
// Rows are frame IDs, columns are IW2..IW4. Must match live_all_map.h.
export const ALL_LIVE_MAP = Object.freeze([
  [0, 0, 0], [0x01, 0x24, 0x02], [0x0f, 0x25, 0x07],
  [0x10, 0x2b, 0x12], [0x05, 0x2a, 0x13], [0x06, 0x15, 0x17],
  [0x09, 0x1a, 0x26], [0x11, 0x1b, 0x30], [0x03, 0x2f, 0x32],
  [0x04, 0x2e, 0x35], [0x0c, 0x0b, 0x36], [0x0d, 0x0e, 0x37],
  [0x08, 0x2d, 0x38], [0x18, 0x01, 0x11], [0x27, 0x09, 0x15],
  [0x28, 0x2a, 0x01],
].map((row) => Object.freeze(row)));

export const BITMAP_BITS = {
  BITMAP_0: {
    6: "not in neutral/park",
    7: "fuel pump on",
    10: "canister purge active",
    11: "A/C clutch disengaged",
  },
  BITMAP_1: {
    0: "closed loop fuel",
    1: "power steering switch closed",
    2: "A/C selected",
    4: "IDM input high",
    5: "AM1 on",
    6: "AM2 on",
    8: "overdrive cancel",
  },
};

export function s8(v) {
  const n = v & 0xff;
  return n & 0x80 ? n - 256 : n;
}

export function fToC(f) {
  return (f - 32) / 1.8;
}

/** Python 3 round(): half to even, including a decimal digit count. */
export function pyRound(value, digits = 0) {
  if (!Number.isFinite(value)) return value;
  const neg = value < 0;
  const p = 10 ** digits;
  const x = Math.abs(value) * p;
  const flo = Math.floor(x + 1e-10);
  const frac = x - flo;
  let q;
  if (frac > 0.5 + 1e-8) q = flo + 1;
  else if (frac < 0.5 - 1e-8) q = flo;
  else q = flo % 2 === 0 ? flo : flo + 1;
  const out = q / p;
  return neg ? -out : out;
}

/** Positive integer division rounded half-to-even, matching Python round(n/d). */
export function pyRoundDiv(n, d) {
  const q = Math.floor(n / d);
  const rem = n % d;
  const twice = rem * 2;
  if (twice > d) return q + 1;
  if (twice < d) return q;
  return q % 2 === 0 ? q : q + 1;
}

export const PIDS = {
  0x01: ["N", "rpm", (v) => v * 4],
  0x03: ["BP", "inHg", (v) => (v & 0xff) / 8],
  0x04: ["SAFTOT", "deg", (v) => s8(v) / 4],
  0x05: ["IACT", "A/D", (v) => v],
  0x06: ["IECT", "A/D", (v) => v],
  0x08: ["IEGO1", "A/D", (v) => v],
  0x09: ["ITP", "A/D", (v) => v],
  0x0c: ["FUELPW1", "ticks", (v) => v * 32],
  0x0d: ["LAMBSE1", "lambda", (v) => v / 2048],
  0x0f: ["ACT", "degC", (v) => pyRound(fToC(s8(v) * 2), 1)],
  0x10: ["ECT", "degC", (v) => pyRound(fToC(s8(v) * 2), 1)],
  0x11: ["VBAT", "V", (v) => (v & 0xff) / 16],
  0x18: ["VS", "mph", (v) => v / 32],
  0x27: ["LOAD", "%", (v) => pyRound(v * 0.0488, 2)],
  0x28: ["KAMRF1", "A/F", (v) => v / 16],
  0x24: ["FMEM_FLAGS", "bits", (v) => v & 0xff],
  0x25: ["FMEM_FLAG2", "bits", (v) => v & 0xff],
  0x2b: ["RATCH", "TPcnt", (v) => v / 4],
  0x2a: ["DSDRPM", "rpm", (v) => (v & 0xff) * 16],
  0x15: ["ISCDTY", "%", (v) => pyRound((v * 100) / 2048, 1)],
  0x1a: ["BITMAP_0", "bits", (v) => v],
  0x1b: ["BITMAP_1", "bits", (v) => v],
  0x2f: ["INDS", "A/D", (v) => v],
  0x2e: ["IOCC", "A/D", (v) => v],
  0x0b: ["IVCAL", "A/D", (v) => v],
  0x0e: ["APT", "", (v) => s8(v)],
  0x2d: ["ATMR1", "s", (v) => v],
  0x02: ["MAP", "inHg", (v) => (v & 0xff) / 8],
  0x07: ["IEGR", "counts", (v) => v],
  0x12: ["MAP_FREQ", "Hz", (v) => v * 0.0625],
  0x13: ["EGRDC", "%", (v) => pyRound((v * 100) / 2048, 1)],
  0x17: ["VSBAR", "mph", (v) => (v & 0xff) * 0.5],
  0x26: ["MAF", "counts", (v) => v],
  0x30: ["BCSDC", "%", (v) => pyRound((v * 100) / 2048, 1)],
  0x32: ["GR_CM", "", (v) => v & 0xff],
  0x35: ["ETVOCM", "V", (v) => v / 4],
  0x36: ["TV_PRES", "psi", (v) => (v & 0xff) * 0.5],
  0x37: ["ITOT", "counts", (v) => v],
  0x38: ["PDL", "", (v) => v & 0xff],
};

/** Plain names. The short key stays the ECU identifier used in captures. */
export const PID_TEXT = {
  N: ["Engine RPM", "rpm", "Crankshaft revolutions per minute. This stays at zero with the engine off."],
  ACT: ["Intake air temp", "°C", "ECU-reported intake-air temperature, related to the separate two-wire IAT in the intake plenum. The observed ACT/IACT delay is unexplained; ECU-specific fallback behavior is unverified."],
  ECT: ["Coolant temp", "°C", "Engine coolant temperature reported by the ECU. Warm-up, thermostat and fan operation determine expected temperature; a factory pass/fail band is not verified."],
  IACT: ["Air temperature input", "counts", "Raw intake-temperature-related channel, associated with the separate IAT, not a third physical sensor. A preserved capture shows ACT changing to 37.8°C 26.324 seconds before IACT changes; synchronization and fallback remain unverified. No temperature calibration is applied."],
  IECT: ["Coolant sensor input", "counts", "The raw coolant-sensor number, before it is converted to degrees."],
  ITP: ["Throttle signal", "counts", "Should rise smoothly as the throttle opens. Counts are not throttle percent; percentage needs calibrated closed/open positions."],
  VBAT: ["ECU voltage", "V", "ECU supply voltage. Starting, charging and electrical loads affect it. Compare with a battery measurement before diagnosing the charging system."],
  BP: ["Barometric pressure", "inHg", "Absolute outside pressure; expected pressure depends on altitude and weather."],
  SAFTOT: ["Spark advance", "degrees", "How many degrees before top dead centre the spark plug fires."],
  FUELPW1: ["Injector command", "ticks", "The protocol reports clock ticks. Milliseconds need a verified ECU clock conversion; no duration is guessed."],
  LAMBSE1: ["Mixture command", "lambda", "1.00 is the normal mixture. Below 1 is richer, which is normal when the engine is cold."],
  IEGO1: ["Oxygen sensor input", "counts", "Switching is expected during closed-loop operation. Raw count direction and sensor voltage need verified input-circuit scaling; high counts do not by themselves mean rich exhaust."],
  VS: ["Vehicle speed", "mph", "ECU vehicle-speed channel from VSS pulses. A hand-spun or noisy VSS can produce readings while the car is parked; this is not independently verified road speed."],
  LOAD: ["Engine load", "%", "How hard the engine is working. It rises when you press the pedal."],
  KAMRF1: ["Fuel adaptation", "ratio", "The ECU's long-term fuel adjustment. 1.00 means no correction."],
  FMEM_FLAGS: ["Failure memory, byte 1", "", "A packed set of failure flags. Each line below is one flag. The exact meaning of each bit is not published for this ECU."],
  FMEM_FLAG2: ["Failure memory, byte 2", "", "A second packed set of failure flags. Same limitation as byte 1."],
  RATCH: ["Throttle reference", "counts", "The throttle reading the ECU has learned as 'pedal released'."],
  DSDRPM: ["Idle target", "rpm", "The idle speed the ECU is trying to hold."],
  ISCDTY: ["Idle valve command", "%", "Commanded electrical duty cycle, not measured valve opening. The ECU uses it to control idle speed."],
  BITMAP_0: ["Switches, group 1", "", "On/off inputs: gear position, fuel pump, canister purge and the air-conditioning clutch."],
  BITMAP_1: ["Switches, group 2", "", "On/off inputs: closed-loop fuel, power steering, air conditioning, and a few outputs."],
  INDS: ["Neutral / drive switch", "counts", "Whether the gearbox is in park/neutral or in gear."],
  IOCC: ["Octane adjust", "counts", "The octane-adjust input. Unused on many cars, so it may sit at one value."],
  IVCAL: ["Calibration voltage", "counts", "A reference voltage the ECU uses to identify its calibration."],
  APT: ["Throttle mode", "", "A small number describing the throttle strategy. It is not the pedal position."],
  ATMR1: ["Time since start", "seconds", "How long the engine has been running in this key cycle."],
  MAP: ["Manifold pressure", "inHg", "Pressure in the intake manifold. Only present if this ECU uses a MAP sensor."],
  IEGR: ["EGR sensor, raw", "counts", "Raw exhaust-gas recirculation sensor. Stays still if the car has no EGR."],
  MAP_FREQ: ["MAP frequency", "Hz", "Frequency output of a MAP sensor, if fitted."],
  EGRDC: ["EGR valve command", "%", "Commanded electrical duty cycle if supported; this is not measured valve opening or exhaust flow."],
  VSBAR: ["Speed, filtered", "mph", "A separate ECU speed-related channel. It can lag or differ from VS during changing VSS pulses; exact filtering and scaling on this ECU are not independently verified. Compare only with a stable, verified speed reference."],
  MAF: ["MAF sensor signal", "counts", "PID 0x26. The owner identified the unplugged/reconnected component as the MAF sensor. PID 0x26 is retained as raw ECU counts; physical scaling to g/s or volts remains unverified."],
  BCSDC: ["Torque-converter clutch", "%", "Command to the transmission lock-up clutch, if this car has one."],
  GR_CM: ["Commanded gear", "", "The gear the ECU is commanding. Meaningless on a manual gearbox."],
  ETVOCM: ["Transmission overcurrent monitor", "volts", "Reference ETVOCM electrical monitor, if fitted; not a measurement of hydraulic pressure."],
  TV_PRES: ["Transmission pressure", "psi", "Commanded transmission pressure, if fitted."],
  ITOT: ["Transmission temperature, raw", "counts", "Raw transmission-oil temperature, if fitted."],
  PDL: ["Gear position", "", "Park, reverse, neutral, drive or low, if the ECU has that switch."],
};

// LHBH1 ch.13 pp.13-30/31: VS = raw/32 mph, VSBAR = byte/2 mph.
// Keep decoder values and historical CSV columns stable; convert for display.
const MPH_TO_KMH = 1.609344;
export const AUTOMATIC_PIDS = new Set(["BCSDC", "GR_CM", "ETVOCM", "TV_PRES", "ITOT", "PDL"]);
const RAW_SIGNALS = new Set(["IACT", "IECT", "ITP", "IEGO1", "RATCH", "INDS", "IOCC", "IVCAL", "IEGR", "MAF", "ITOT"]);

export function displayReading(name, value, { unitSystem = "metric" } = {}) {
  if ((name === "ECT" || name === "ACT") && unitSystem === "imperial") return { value: value * 9 / 5 + 32, unit: "°F" };
  if (name === "VS" || name === "VSBAR") return unitSystem === "imperial"
    ? { value, unit: "mph" }
    : { value: value * MPH_TO_KMH, unit: "km/h" };
  if (name === "KAMRF1") return { value: (value - 1) * 100, unit: "% correction" };
  const spec = Object.values(PIDS).find(([key]) => key === name);
  return { value, unit: PID_TEXT[name]?.[1] ?? spec?.[1] ?? "" };
}

/** Human descriptions do not imply a calibrated voltage, temperature or percent. */
export function readingLabel(name, summary, { manual = true } = {}) {
  if (!summary) return "No reading yet";
  if (manual && AUTOMATIC_PIDS.has(name)) return "Not applicable — manual gearbox";
  if (name === "MAF") return "MAF sensor signal — raw counts";
  if (name === "IECT") return "See coolant temperature in °C";
  if (name === "RATCH") return "Learned closed-throttle reference";
  if (RAW_SIGNALS.has(name)) return "Raw signal — see details";
  if (name === "FUELPW1") return summary.last === 0 ? "No injector pulse commanded" : "Injector pulse commanded";
  if (name === "APT") return ({ "-1": "Closed throttle", 0: "Part throttle", 1: "Wide open throttle" })[summary.last] ?? "Unknown throttle mode";
  if (["BITMAP_0", "BITMAP_1", "FMEM_FLAGS", "FMEM_FLAG2"].includes(name)) return "See individual flags below";
  const view = displayReading(name, summary.last);
  return `${formatValue(pyRound(view.value, 2))} ${view.unit}`.trim();
}

export function pidSetForVariant(variant) {
  if (variant === "ALL") return ALL_LIVE_MAP;
  if (variant === "LIVE3") return LIVE3_PIDS;
  if (variant === "LIVE2") return LIVE2_PIDS;
  if (variant === "LIVE") return LIVE_PIDS;
  return null;
}

export function scaleWord(pid, raw) {
  const spec = PIDS[pid];
  if (!spec) return null;
  const [name, unit, fn] = spec;
  return { name, unit, value: fn(raw) };
}

export function bitRows(name, raw) {
  const map = BITMAP_BITS[name];
  if (map) {
    return Object.keys(map)
      .map((key) => Number(key))
      .sort((a, b) => a - b)
      .map((bit) => ({ bit, label: map[bit], on: ((raw >> bit) & 1) === 1 }));
  }
  if (name === "FMEM_FLAGS" || name === "FMEM_FLAG2") {
    const rows = [];
    for (let bit = 0; bit < 8; bit += 1) {
      rows.push({ bit, label: `Flag ${bit + 1} — meaning not documented for this ECU`, on: ((raw >> bit) & 1) === 1 });
    }
    return rows;
  }
  return [];
}

/** Assess only an explicit test against a sourced vehicle specification.
 * Other channels explain operating context without inventing health limits.
 */
export function judgeReading(name, summary, context = {}) {
  if (!summary || !Number.isFinite(summary.last)) return null;
  if (name === "N" && context.idleCheck === true) {
    if (summary.last === 0) return { level: "quiet", text: "Engine is stopped. The regulated idle comparison does not apply." };
    if (summary.last < 825) return { level: "warn", text: "Below the 825–925 rpm regulated idle reference. Recheck after the idle settles under the stated test conditions." };
    if (summary.last > 925) return { level: "warn", text: "Above the 825–925 rpm regulated idle reference. Recheck after the idle settles under the stated test conditions." };
    return { level: "ok", text: "Within the published regulated idle reference under the stated test conditions. This does not prove overall engine health." };
  }
  return { level: "quiet", text: "A health verdict needs the stated operating conditions and a verified limit. See the reference below." };
}

export function formatValue(value) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(rounded);
}

export function rowsToCsv(rows, { unitSystem = "metric" } = {}) {
  const combined = rows.some((row) => row.segment != null);
  const lines = ["t_s,pid,raw,value,unit,display_value,display_unit" +
    (combined ? ",segment,group,segment_t_s,sample_status,time_basis" : "")];
  for (const row of rows) {
    const spec = Object.values(PIDS).find(([name]) => name === row.name);
    const view = displayReading(row.name, row.value, { unitSystem });
    lines.push(`${row.t},${row.name},${row.raw},${row.value},${spec?.[1] ?? ""},${formatValue(view.value)},${view.unit}` +
      (combined ? `,${row.segment},${row.variant},${row.source_t},${row.validity},host-arrival-aligned` : ""));
  }
  return lines.join("\n") + "\n";
}

export function summarizeSeries(samples) {
  if (!samples.length) return null;
  let min = samples[0].value;
  let max = samples[0].value;
  for (const sample of samples) {
    if (sample.value < min) min = sample.value;
    if (sample.value > max) max = sample.value;
  }
  return {
    n: samples.length,
    first: samples[0].value,
    min,
    max,
    last: samples[samples.length - 1].value,
    rawLast: samples[samples.length - 1].raw,
  };
}
