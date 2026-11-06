import assert from "node:assert/strict";
import { test } from "node:test";
import { noResponseFromStart } from "../js/session-outcome.js";

test("no response requires zero received evidence and excludes Stop, simulation and other faults", () => {
  const result = { source: "bridge", kind: "live", totalRows: 0, parityRejects: 0 };
  for (const reason of [3, 4, 19]) {
    const session = { rx: 0, problems: [`FAULT reason=${reason}`], end: { reason, ro_bytes: 0, ro_lost: 0, uart_errors: 0, de: "LOW" } };
    assert.equal(noResponseFromStart(session, result, false), true);
    assert.equal(noResponseFromStart(session, result, true), false);
    assert.equal(noResponseFromStart(session, { ...result, source: "simulation" }, false), false);
    assert.equal(noResponseFromStart({ ...session, rx: 1 }, result, false), false);
    assert.equal(noResponseFromStart({ ...session, problems: ["FAULT reason=11"] }, result, false), false);
    assert.equal(noResponseFromStart({ ...session, end: { ...session.end, ro_bytes: 93380 } }, result, false), true);
    assert.equal(noResponseFromStart(session, result, false, { reason: "storage failure" }), false);
  }
});

import { ignitionConfirmationNeeded } from "../js/session-outcome.js";
test("only established real live streams with matching silence need confirmation", () => {
  const session = { rx: 20, end: { reason: 19, ro_bytes: 20, ro_lost: 0, uart_errors: 0, de: "LOW" }, faults: ["FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW"], problems: ["FAULT reason=19"] };
  const result = { source: "bridge", kind: "live", totalRows: 2, verdict: { witnessStatus: "SESSION_BOUND" } };
  for (const variant of ["LIVE", "LIVE2", "LIVE3", "ALL"]) {
    assert.equal(ignitionConfirmationNeeded(session, { ...result, variant }, {}, { reason: session.faults[0] }), true);
    assert.equal(ignitionConfirmationNeeded(session, { ...result, variant }, { operatorStop: true }, null), false);
    assert.equal(ignitionConfirmationNeeded(session, { ...result, variant, source: "simulation" }, {}, null), false);
    assert.equal(ignitionConfirmationNeeded(session, { ...result, variant, totalRows: 0 }, {}, null), false);
    assert.equal(ignitionConfirmationNeeded(session, { ...result, variant }, {}, { reason: "Recording storage failed" }), false);
    assert.equal(ignitionConfirmationNeeded({ ...session, problems: ["FAULT reason=17"] }, { ...result, variant }, {}, null), false);
  }
});
