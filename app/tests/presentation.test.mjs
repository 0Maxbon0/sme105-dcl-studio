import assert from "node:assert/strict";
import test from "node:test";
import { displayReading, judgeReading, readingLabel, rowsToCsv, scaleWord } from "../js/pids.js";

test("both Ford speed encodings display kilometres per hour", () => {
  // Independent anchors: 100 mph = 160.9344 km/h; VS resolution 1/32 mph,
  // VSBAR resolution 1/2 mph (LHBH1 13-30).
  for (const [pid, raw] of [[0x18, 3200], [0x17, 200]]) {
    const decoded = scaleWord(pid, raw);
    assert.equal(decoded.value, 100);
    assert.equal(decoded.unit, "mph");
    assert.deepEqual(displayReading(decoded.name, decoded.value), { value: 160.9344, unit: "km/h" });
    assert.deepEqual(displayReading(decoded.name, 0), { value: 0, unit: "km/h" });
  }
});

test("fuel correction is a change from unity, not an air/fuel ratio", () => {
  assert.equal(displayReading("KAMRF1", 1).value, 0);
  assert.equal(displayReading("KAMRF1", 1.0625).value, 6.25);
  assert.equal(displayReading("KAMRF1", 0.9375).value, -6.25);
});

test("manual gearbox never interprets constant 2 as actual second gear", () => {
  const summary = { last: 2, min: 2, max: 2, n: 514, rawLast: 2 };
  assert.match(readingLabel("GR_CM", summary), /Not applicable.*manual/);
  assert.doesNotMatch(readingLabel("GR_CM", summary, { manual: false }), /manual/);
  assert.equal(readingLabel("GR_CM", null), "No reading yet");
});

test("unverified signals and tick duration do not acquire invented physical units", () => {
  const summary = { last: 1408, min: 1408, max: 1408, n: 40 };
  assert.equal(readingLabel("FUELPW1", summary), "Injector pulse commanded");
  assert.match(readingLabel("MAF", summary), /unverified/);
  assert.equal(displayReading("ITP", 159).unit, "counts");
  assert.equal(displayReading("IEGO1", 1023).unit, "counts");
  assert.equal(displayReading("FUELPW1", 1408).unit, "ticks");
});

test("CSV retains original evidence and labels native and display units", () => {
  const csv = rowsToCsv([{ t: 1, name: "VS", raw: 3200, value: 100 }]);
  assert.equal(csv, "t_s,pid,raw,value,unit,display_value,display_unit\n1,VS,3200,100,mph,160.9344,km/h\n");
});

test("saturated oxygen input cannot get a healthy verdict just because coolant is warm", () => {
  const summary = { last: 1023, min: 1011, max: 1023, n: 337 };
  assert.equal(judgeReading("IEGO1", summary, { rpm: 832, ect: 74.4 }).level, "quiet");
  assert.equal(judgeReading("IEGO1", summary, { rpm: 0, ect: 74.4 }).level, "quiet");
  assert.match(judgeReading("ACT", summary, { iact: 948 }).text, /verified limit/);
});
