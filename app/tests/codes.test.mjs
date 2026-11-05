import assert from "node:assert/strict";
import { test } from "node:test";
import { CODE_DB_META, CODES, lookupCode } from "../js/codes-db.js";

test("fault database covers the European list and this car's notes", () => {
  assert.equal(CODE_DB_META.count, Object.keys(CODES).length);
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
  assert.match(lookupCode("157").description, /mass air flow|MAF/i);
  assert.doesNotMatch(lookupCode("157").description, /MAP/i);
  assert.equal(lookupCode("214").category, "ignition");
  assert.equal(lookupCode("111").category, "pass");
  for (const code of ["010", "020", "030"]) {
    assert.equal(lookupCode(code).category, "legacy-unverified");
    assert.doesNotMatch(lookupCode(code).description, /depress|press.*pedal|follow/i);
  }
  assert.equal(lookupCode("538").category, "self-test result");
  const unknown = lookupCode("999");
  assert.equal(unknown.known, false);
  assert.equal(unknown.description, "Unknown code — not in database");
});
