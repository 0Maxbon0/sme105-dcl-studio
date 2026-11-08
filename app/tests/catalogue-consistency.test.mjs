import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMMAND_CATALOGUE, DCL_PROBE_VARIANTS, EXPERIMENT_CATALOGUE } from "../js/protocol.js";
import { STR } from "../js/strings.js";
import "./test-env.mjs";

test("MEM candidate catalogue and confirmation text reflect the bridge profile", async () => {
  const candidate = COMMAND_CATALOGUE.MEM_READ;
  assert.equal(candidate.id, "MEMORY_READ");
  assert.equal(candidate.sendable, true);
  assert.equal(candidate.commandWord, "42F3 / 22D3");
  assert.deepEqual(candidate.envelope, ["01B0", "FF5F", "42F3", "00A0"]);
  assert.equal(candidate.requiredEcuState, "KEY_ON_ENGINE_OFF");
  assert.equal(candidate.classification, "READ_ONLY");
  assert.equal(candidate.evidenceLevel, "EXPERIMENTAL");
  assert.equal(candidate.parityStatus, "UNRESOLVED_MISMATCH");
  assert.match(candidate.description, /unverified for SME-105/);
  assert.match(candidate.description, /parity byte 93 differs.*2293/);
  assert.equal(candidate.blockedReason, null);
  assert.equal(DCL_PROBE_VARIANTS.MEM.variantKey, "MEM");
  assert.equal(DCL_PROBE_VARIANTS.MEM.armCommand, "ARM_MEM");
  assert.equal(DCL_PROBE_VARIANTS.MEM.readCommand, "READ_MEM");
  assert.match(STR.confirmMemBody, /address map and 22D3 parity remain unverified/);
  assert.equal(STR.readIdentity, "Experimental memory read");

  const fields = ["id", "name", "commandWord", "envelope", "description", "source", "sourceUrl", "parityStatus", "classification", "risk", "requiredEcuState", "repeats", "armCommand", "readCommand", "variantKey", "sendable", "blockedReason"];
  for (const candidate of Object.values(EXPERIMENT_CATALOGUE)) {
    for (const field of fields) assert.ok(field in candidate, `${candidate.id} must define ${field}`);
  }

  const [html, app, ui] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/ui.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="mem-btn"[^>]*data-str="readIdentity"/);
  assert.doesNotMatch(html.match(/<button id="mem-btn"[^>]*>/)?.[0] || "", /disabled/);
  const handler = app.slice(app.indexOf('getElementById("mem-btn").addEventListener'), app.indexOf('getElementById("reboot-btn")'));
  assert.match(handler, /COMMAND_CATALOGUE\.MEM_READ\.sendable === false/);
  assert.ok(handler.indexOf("return;") < handler.indexOf("ask("), "deferred memory profile returns before dispatch");
  assert.match(ui, /COMMAND_CATALOGUE\.MEM_READ\.sendable === false/);
});
