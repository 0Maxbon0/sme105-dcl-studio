import assert from "node:assert/strict";
import test from "node:test";
import { judgeReading } from "../js/pids.js";

const steady = (value) => ({ last: value, min: value, max: value, n: 40 });

test("raw intake counts do not receive an invented factory fault threshold", () => {
  const reading = judgeReading("IACT", steady(948), {});
  assert.equal(reading.level, "quiet");
  assert.match(reading.text, /verified limit/);
});

test("battery readings require a verified test procedure before a health verdict", () => {
  assert.equal(judgeReading("VBAT", steady(12.6), { rpm: 0 }).level, "quiet");
  assert.equal(judgeReading("VBAT", steady(12.6), { rpm: 900 }).level, "quiet");
});

test("throttle activity alone cannot establish a sensor failure", () => {
  const samples = [];
  for (let i = 0; i < 12; i += 1) samples.push({ value: i % 2 ? 20 : 140 });
  const reading = judgeReading("ITP", { last: 140, min: 20, max: 140, n: 12 }, { rpm: 1000, samples });
  assert.equal(reading.level, "quiet");
});
