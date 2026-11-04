/** DIAGMODE 21H PID scaling. Port of scripts/decode_live_pids.py. */

export const LIVE_PIDS = Object.freeze([
  0x00, 0x01, 0x0f, 0x10, 0x05, 0x06, 0x09, 0x11,
  0x03, 0x04, 0x0c, 0x0d, 0x08, 0x18, 0x27, 0x28,
]);

export const LIVE2_PIDS = Object.freeze([
  0x00, 0x01, 0x24, 0x25, 0x2b, 0x09, 0x2a, 0x15,
  0x1a, 0x1b, 0x2f, 0x2e, 0x0b, 0x0e, 0x2d, 0x11,
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
};

export function pidSetForVariant(variant) {
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
      rows.push({ bit, label: `bit ${bit}`, on: ((raw >> bit) & 1) === 1 });
    }
    return rows;
  }
  return [];
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
