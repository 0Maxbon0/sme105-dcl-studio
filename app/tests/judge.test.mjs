import assert from "node:assert/strict";
import test from "node:test";
import { judgeReading } from "../js/pids.js";

const steady = (value) => ({ last: value, min: value, max: value, n: 40 });

test("open intake-air sensor is called out", () => {
  const reading = judgeReading("IACT", steady(948), {});
  assert.equal(reading.level, "bad");
  assert.match(reading.text, /unplugged/);
});

test("low charging voltage is warned only while the engine is running", () => {
  assert.equal(judgeReading("VBAT", steady(12.6), { rpm: 0 }).level, "ok");
  assert.equal(judgeReading("VBAT", steady(12.6), { rpm: 900 }).level, "warn");
});

test("a jumping throttle is warned with the engine running", () => {
  const samples = [];
  for (let i = 0; i < 12; i += 1) samples.push({ value: i % 2 ? 20 : 140 });
  const reading = judgeReading("ITP", { last: 140, min: 20, max: 140, n: 12 }, { rpm: 1000, samples });
  assert.equal(reading.level, "warn");
});
