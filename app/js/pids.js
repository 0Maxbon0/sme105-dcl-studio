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
  N: ["Engine speed", "rpm", "How fast the crankshaft is turning. This stays at zero with the engine off."],
  ACT: ["Intake air temperature", "°C", "The air temperature the ECU is using. If the sensor is unplugged, this copies the coolant temperature."],
  ECT: ["Coolant temperature", "°C", "Engine coolant temperature. About 85–95 °C is normal when fully warm."],
  IACT: ["Intake-air sensor, raw", "counts", "The raw sensor number. Near 1000 means the sensor is unplugged or its wire is open."],
  IECT: ["Coolant sensor, raw", "counts", "The raw coolant-sensor number, before it is converted to degrees."],
  ITP: ["Throttle position", "counts", "Pedal position. It should sit still at idle and rise smoothly as you press the pedal."],
  VBAT: ["Battery voltage", "volts", "About 12 V with the engine off, and about 13.8–14.5 V while it is running and charging."],
  BP: ["Barometric pressure", "inHg", "Outside air pressure. Near sea level this is about 29–30."],
  SAFTOT: ["Spark advance", "degrees", "How many degrees before top dead centre the spark plug fires."],
  FUELPW1: ["Injector open time", "ticks", "How long the injector stays open. Zero with the engine off."],
  LAMBSE1: ["Target mixture", "lambda", "1.00 is the normal mixture. Below 1 is richer, which is normal when the engine is cold."],
  IEGO1: ["Oxygen sensor, raw", "counts", "The exhaust oxygen sensor. Once the engine is warm it should keep moving between low and high."],
  VS: ["Vehicle speed", "mph", "Speed from the vehicle speed sensor. Zero when the car is stopped."],
  LOAD: ["Engine load", "%", "How hard the engine is working. It rises when you press the pedal."],
  KAMRF1: ["Learned fuel correction", "ratio", "The ECU's long-term fuel adjustment. 1.00 means no correction."],
  FMEM_FLAGS: ["Failure memory, byte 1", "", "A packed set of failure flags. Each line below is one flag. The exact meaning of each bit is not published for this ECU."],
  FMEM_FLAG2: ["Failure memory, byte 2", "", "A second packed set of failure flags. Same limitation as byte 1."],
  RATCH: ["Learned closed throttle", "counts", "The throttle reading the ECU has learned as 'pedal released'."],
  DSDRPM: ["Target idle speed", "rpm", "The idle speed the ECU is trying to hold."],
  ISCDTY: ["Idle air valve", "%", "How far the idle-air valve is open. The ECU uses it to hold the idle speed."],
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
  EGRDC: ["EGR valve command", "%", "How far the ECU is commanding the EGR valve open."],
  VSBAR: ["Speed, filtered", "mph", "A filtered vehicle-speed value. Zero when stopped."],
  MAF: ["Airflow sensor, raw", "counts", "Only meaningful if this ECU has a mass-airflow sensor. Code 157 says it might."],
  BCSDC: ["Torque-converter clutch", "%", "Command to the transmission lock-up clutch, if this car has one."],
  GR_CM: ["Commanded gear", "", "The gear the ECU is commanding. Meaningless on a manual gearbox."],
  ETVOCM: ["Electronic pressure control", "volts", "Transmission line-pressure control, if fitted."],
  TV_PRES: ["Transmission pressure", "psi", "Commanded transmission pressure, if fitted."],
  ITOT: ["Transmission temperature, raw", "counts", "Raw transmission-oil temperature, if fitted."],
  PDL: ["Gear position", "", "Park, reverse, neutral, drive or low, if the ECU has that switch."],
};

export function pidSetForVariant(variant) {
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

function lastOf(samples) {
  return samples?.length ? samples[samples.length - 1].value : null;
}

function jumpiness(samples) {
  if (!samples || samples.length < 6) return 0;
  const tail = samples.slice(-12);
  let sum = 0;
  for (let i = 1; i < tail.length; i += 1) sum += Math.abs(tail[i].value - tail[i - 1].value);
  return sum / (tail.length - 1);
}

/** Plain judgement for one live value. level is ok, warn, bad, or quiet. */
export function judgeReading(name, summary, context = {}) {
  if (!summary) return null;
  const v = summary.last;
  const rpm = context.rpm ?? 0;
  const ect = context.ect;
  const running = rpm > 400;
  const warm = ect != null && ect >= 70;
  if (name === "N") {
    if (v === 0) return { level: "quiet", text: "Engine is off. This is normal." };
    if (v > 5000) return { level: "bad", text: "Engine speed is very high." };
    if (v > 3500) return { level: "warn", text: "Engine speed is high." };
    return { level: "ok", text: running && v < 1400 ? "Idle speed looks normal." : "Engine speed looks normal." };
  }
  if (name === "VBAT") {
    if (v < 11.6) return { level: "bad", text: "Battery voltage is too low." };
    if (v > 15.2) return { level: "bad", text: "Voltage is too high. Check the alternator." };
    if (running && v < 13.0) return { level: "warn", text: "The engine is running but the battery is not charging well." };
    if (!running && v < 12.2) return { level: "warn", text: "Battery is low. It may need charging." };
    return { level: "ok", text: running ? "Charging voltage looks normal." : "Battery voltage looks normal." };
  }
  if (name === "IACT") {
    if (v >= 900) return { level: "bad", text: "Intake-air sensor looks unplugged or its wire is open." };
    if (v < 30) return { level: "bad", text: "Intake-air sensor looks shorted to ground." };
    return { level: "ok", text: "Intake-air sensor is in a normal range." };
  }
  if (name === "ACT") {
    if (context.iact >= 900) return { level: "warn", text: "The ECU is guessing this, because the intake-air sensor is not connected." };
    if (v > 70) return { level: "warn", text: "Intake air is very hot." };
    return { level: "ok", text: "Intake-air temperature looks normal." };
  }
  if (name === "ECT") {
    if (v >= 115) return { level: "bad", text: "Coolant is too hot. Stop and let the engine cool." };
    if (v >= 105) return { level: "warn", text: "Coolant is hotter than normal." };
    if (running && v < 60) return { level: "quiet", text: "Engine is still cold. Some readings are not meaningful yet." };
    return { level: "ok", text: "Coolant temperature looks normal." };
  }
  if (name === "ITP") {
    const jump = jumpiness(context.samples);
    if (v < 8) return { level: "bad", text: "No throttle signal. Check the sensor plug and the 5 V supply." };
    if (running && jump > 40) return { level: "warn", text: "Throttle signal is jumping. Check the connector, the sensor ground and the engine ground." };
    return { level: "ok", text: "Throttle signal looks steady." };
  }
  if (name === "LAMBSE1") {
    if (warm && (v < 0.85 || v > 1.15)) return { level: "warn", text: "The target mixture is far from normal for a warm engine." };
    if (!warm && v < 1) return { level: "quiet", text: "Richer than normal. Expected while the engine is cold." };
    return { level: "ok", text: "Target mixture looks normal." };
  }
  if (name === "IEGO1") {
    if (!warm) return { level: "quiet", text: "Oxygen sensor is not ready until the engine is warm." };
    const span = summary.max - summary.min;
    if (summary.n > 30 && span < 40) return { level: "warn", text: "Oxygen sensor is not moving. It may still be cold, or the sensor is not working." };
    return { level: "ok", text: "Oxygen sensor is moving, which is what a warm engine should do." };
  }
  if (name === "BP") {
    if (v < 27 || v > 31.5) return { level: "warn", text: "Barometric pressure is outside the usual range." };
    return { level: "ok", text: "Barometric pressure looks normal." };
  }
  if (name === "RATCH" && context.itp != null && Math.abs(v - context.itp) > 80 && rpm < 400) {
    return { level: "warn", text: "Closed-throttle memory does not match the pedal position right now." };
  }
  return null;
}

export function formatValue(value) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 1e6) / 1e6;
  return String(rounded);
}

export function rowsToCsv(rows) {
  const lines = ["t_s,pid,raw,value"];
  for (const row of rows) lines.push(`${row.t},${row.name},${row.raw},${row.value}`);
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
