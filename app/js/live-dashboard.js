import { ALL_LIVE_PIDS, AUTOMATIC_PIDS, PID_TEXT, PIDS } from "./pids.js";

export const LIVE_GROUPS = Object.freeze({
  overview: Object.freeze([]),
  engine: Object.freeze(["N", "DSDRPM", "ISCDTY", "ITP", "RATCH", "APT", "ATMR1", "VS"]),
  fuel: Object.freeze(["SAFTOT", "FUELPW1", "LAMBSE1", "IEGO1", "KAMRF1", "LOAD"]),
  temp: Object.freeze(["ACT", "ECT", "IACT", "IECT", "BP"]),
  switches: Object.freeze(["VBAT", "BITMAP_0", "BITMAP_1", "INDS", "IOCC", "IVCAL"]),
  advanced: Object.freeze(ALL_LIVE_PIDS.filter((pid) => PIDS[pid]).map((pid) => PIDS[pid][0])),
});

export const LIVE_GROUP_TITLES = Object.freeze({
  overview: "All available",
  engine: "Engine / Idle",
  fuel: "Fuel / Combustion",
  temp: "Temp / Air",
  switches: "Switches / Electrical",
  advanced: "Technical inputs",
});

export const LIVE_GROUP_HELP = Object.freeze({
  overview: "Current readings and your pinned sensors.",
  engine: "Engine speed, idle command, throttle movement and driving speed.",
  fuel: "Fuel command and feedback. Requests and raw counts are not measured exhaust results.",
  temp: "ECU temperature readings and raw sensor inputs. Raw counts are not degrees.",
  switches: "Power, switch inputs and failure-memory bytes. Undocumented bits remain unverified.",
  advanced: "All 39 decoded channels, including hidden automatic-only and equipment-dependent signals. Raw export still retains every channel.",
});

const PID_BY_NAME = new Map(ALL_LIVE_PIDS.filter((pid) => PIDS[pid]).map((pid) => [PIDS[pid][0], pid]));

export function sensorsForGroup(group, { manual = true } = {}) {
  const names = LIVE_GROUPS[group] || LIVE_GROUPS.overview;
  return names
    .filter((name) => group === "advanced" || !AUTOMATIC_PIDS.has(name))
    .map((name) => {
      const pid = PID_BY_NAME.get(name);
      const [, unit] = PIDS[pid];
      const [title] = PID_TEXT[name] || [name];
      return { pid, name, unit, title, notApplicable: manual && AUTOMATIC_PIDS.has(name) };
    });
}

/** Freshness is learned from this signal's own receive intervals, not a fixed global timeout. */
export function sensorFreshness(samples, { active = false, now = Date.now() } = {}) {
  if (!samples?.length) return { state: "none", label: "NO SAMPLE", ageMs: null, intervalMs: null };
  const timed = samples.slice(-8).filter((sample) => Number.isFinite(sample.receivedAt));
  const latest = timed.at(-1);
  if (!latest) return { state: "unknown", label: "TIME NOT RECORDED", ageMs: null, intervalMs: null };
  const ageMs = Math.max(0, now - latest.receivedAt);
  if (!active) return { state: "historical", label: "Saved reading", ageMs, intervalMs: null };

  const intervals = [];
  for (let index = 1; index < timed.length; index += 1) {
    const delta = timed[index].receivedAt - timed[index - 1].receivedAt;
    if (delta > 0 && delta <= 60_000) intervals.push(delta);
  }
  if (intervals.length < 2) {
    return { state: "learning", label: "", ageMs, intervalMs: null };
  }
  intervals.sort((a, b) => a - b);
  const intervalMs = intervals[Math.floor(intervals.length / 2)];
  const limitMs = Math.max(intervalMs * 3, intervalMs + 250);
  return ageMs <= limitMs
    ? { state: "fresh", label: "", ageMs, intervalMs, limitMs }
    : { state: "stale", label: "Waiting for signal", ageMs, intervalMs, limitMs };
}

/** Return only observed freshness state changes so the run journal stays useful and bounded. */
export function sensorFreshnessTransitions(pids, previous = new Map(), options = {}) {
  const changes = [];
  for (const series of Object.values(pids || {})) {
    if (!series?.samples?.length) continue;
    const name = series.name || "";
    if (!name) continue;
    const freshness = sensorFreshness(series.samples, options);
    const priorState = previous.get(name);
    if (priorState !== freshness.state) {
      previous.set(name, freshness.state);
      const last = series.samples.at(-1);
      changes.push({ name, pid: series.pid, state: freshness.state, priorState: priorState || "unobserved",
        sampleCount: series.summary?.n ?? series.samples.length, ageMs: freshness.ageMs,
        intervalMs: freshness.intervalMs, last: { raw: last.raw, value: last.value, unit: last.unit,
          receivedAt: last.receivedAt ?? null } });
    }
  }
  return changes;
}

