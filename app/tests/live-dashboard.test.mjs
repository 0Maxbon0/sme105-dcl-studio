import assert from "node:assert/strict";
import { test } from "node:test";
import { sensorsForGroup, sensorFreshness, sensorFreshnessTransitions } from "../js/live-dashboard.js";
import { AUTOMATIC_PIDS } from "../js/pids.js";

test("Advanced exposes exactly the 39 decoded channels; ordinary groups omit automatic-only channels", () => {
  const advanced = sensorsForGroup("advanced", { manual: true });
  assert.equal(advanced.length, 39);
  assert.equal(new Set(advanced.map((sensor) => sensor.name)).size, 39);
  assert.ok([...AUTOMATIC_PIDS].every((name) => advanced.some((sensor) => sensor.name === name)));
  for (const group of ["overview", "engine", "fuel", "temp", "switches"]) {
    assert.ok(sensorsForGroup(group).every((sensor) => !AUTOMATIC_PIDS.has(sensor.name)), group);
  }
  assert.ok(sensorsForGroup("advanced").filter((sensor) => sensor.notApplicable).length === AUTOMATIC_PIDS.size);
});

test("freshness is learned from each signal cadence and separates absent, historical and stale data", () => {
  assert.equal(sensorFreshness([]).state, "none");
  const samples = [0, 1000, 2000].map((receivedAt) => ({ receivedAt }));
  assert.equal(sensorFreshness(samples, { active: true, now: 2500 }).state, "fresh");
  assert.equal(sensorFreshness(samples, { active: true, now: 7000 }).state, "stale");
  assert.equal(sensorFreshness(samples, { active: false, now: 2500 }).state, "historical");
  assert.equal(sensorFreshness(samples.slice(-1), { active: true, now: 2050 }).state, "learning");
});

test("freshness journal emits only state transitions with the supporting latest sample", () => {
  const previous = new Map();
  const series = { name: "N", pid: 1, summary: { n: 3 }, samples: [
    { receivedAt: 0, raw: 242, value: 968, unit: "rpm" },
    { receivedAt: 100, raw: 243, value: 972, unit: "rpm" },
    { receivedAt: 200, raw: 244, value: 976, unit: "rpm" },
  ] };
  const first = sensorFreshnessTransitions({ N: series }, previous, { active: true, now: 200 });
  assert.equal(first.length, 1);
  assert.equal(first[0].state, "fresh");
  assert.equal(first[0].priorState, "unobserved");
  assert.deepEqual(first[0].last, { raw: 244, value: 976, unit: "rpm", receivedAt: 200 });
  assert.deepEqual(sensorFreshnessTransitions({ N: series }, previous, { active: true, now: 250 }), []);
  const stale = sensorFreshnessTransitions({ N: series }, previous, { active: true, now: 600 });
  assert.equal(stale[0].state, "stale");
  assert.equal(stale[0].priorState, "fresh");
});
