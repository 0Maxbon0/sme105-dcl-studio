import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CODE_DB_META, lookupCode } from "../js/codes-db.js";

test("fault database covers the European list and this car's notes", () => {
  const csv = readFileSync("/tmp/babroval/eec-iv/resources/EECIVFaults.csv", "utf8");
  const rows = csv.split(/\r?\n/).filter((line) => line.trim());
  assert.equal(CODE_DB_META.count, rows.length);
  assert.equal(CODE_DB_META.license, "MIT");
  assert.match(CODE_DB_META.source, /babroval\/ford-eec-iv-diagnostic/);
  const code122 = lookupCode("122");
  assert.equal(code122.known, true);
  assert.match(code122.description, /Throttle position/);
  assert.equal(code122.category, "sensor");
  assert.match(code122.note, /confirmed|stored/);
  assert.match(code122.note, /TP/);
  for (const code of ["113", "157", "214", "452"]) {
    const hit = lookupCode(code);
    assert.equal(hit.known, true, code);
    assert.ok(hit.note, code);
  }
  assert.equal(lookupCode("214").category, "ignition");
  assert.equal(lookupCode("111").category, "pass");
  assert.equal(lookupCode("010").category, "prompt");
  const unknown = lookupCode("999");
  assert.equal(unknown.known, false);
  assert.equal(unknown.description, "Unknown code — not in database");
});
