import assert from "node:assert/strict";
import test from "node:test";
import { judgeReading, PIDS } from "../js/pids.js";
import { IDLE_SOURCE, readingReference, READING_REFERENCES } from "../js/reference.js";

test("every supported channel has an explicit reference and interpretation", () => {
  for (const [name] of Object.values(PIDS)) {
    assert.ok(READING_REFERENCES[name], name);
    const ref = readingReference(name);
    assert.ok(ref.normal.length > 15, name);
    assert.ok(ref.meaning.length > 15, name);
  }
});

test("Ford 875 ± 50 reference applies only when the idle test is selected", () => {
  const reading = (rpm, context = {}) => judgeReading("N", { last: rpm }, context);
  assert.equal(reading(875).level, "quiet");
  assert.equal(reading(4000).level, "quiet");
  assert.equal(reading(0, { idleCheck: true }).level, "quiet");
  for (const rpm of [825, 875, 925]) assert.equal(reading(rpm, { idleCheck: true }).level, "ok");
  for (const rpm of [824, 926]) assert.equal(reading(rpm, { idleCheck: true }).level, "warn");
  assert.equal(readingReference("N").source, IDLE_SOURCE);
});

test("generic pressure, temperature and ADC limits cannot produce a healthy or faulty verdict", () => {
  for (const [name, value] of [["BP", 25.625], ["ECT", 74.4], ["IACT", 948], ["ITP", 43], ["IEGO1", 1023], ["LAMBSE1", 0.8]]) {
    assert.equal(judgeReading(name, { last: value }, { rpm: 875, ect: 90 }).level, "quiet", name);
  }
  assert.equal(judgeReading("N", { last: NaN }, { idleCheck: true }), null);
});

test("automatic references remain inapplicable to manual gearbox without assigning zero faults", () => {
  for (const name of ["BCSDC", "GR_CM", "ETVOCM", "TV_PRES", "ITOT", "PDL"]) {
    assert.match(readingReference(name).normal, /Not applicable/);
    assert.doesNotMatch(readingReference(name, { manual: false }).normal, /manual/);
  }
});
