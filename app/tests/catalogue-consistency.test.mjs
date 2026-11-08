import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { COMMAND_CATALOGUE, DCL_PROBE_VARIANTS, EVIDENCE_LEVELS, EVIDENCE_LEVEL_NAMES, EXPERIMENT_CATALOGUE, evidenceLevelName } from "../js/protocol.js";
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
  assert.equal(candidate.evidenceNumericLevel, 3);
  assert.equal(candidate.evidenceLevel, "3: Structural Response Observed");
  assert.equal(candidate.parityStatus, "UNRESOLVED_MISMATCH");
  assert.match(candidate.description, /parity byte D3, while generic VPARITY expects 93/);
  assert.equal(candidate.blockedReason, null);
  assert.equal(DCL_PROBE_VARIANTS.MEM.variantKey, "MEM");
  assert.equal(DCL_PROBE_VARIANTS.MEM.armCommand, "ARM_MEM");
  assert.equal(DCL_PROBE_VARIANTS.MEM.readCommand, "READ_MEM");
  assert.match(STR.confirmMemBody, /address map and 22D3 parity remain unverified/);
  assert.equal(STR.readIdentity, "Experimental memory read");

  const catalogue = Object.values(EXPERIMENT_CATALOGUE);
  const expectedIds = [
    "ECU_STATUS", "STORED_0E", "STORED_A4", "CLEAR_DTC", "KOEO_253E", "KOER_253E", "KOEO_ALT", "PIDMAP_TX",
    "PIDMAP", "PIDMAP_ALT", "PID_VALUES", "CLEAR_A1", "CLEAR_F4", "DMRMAP_TX", "DMRMAP", "DMR_VALUES",
    "PID_DMR_BOTH", "CHANGE_BAUD", "STOP_PID_FLOW", "MEMORY_READ", "MEM_OFF0", "MEM_SINGLE", "MEM_PARITY",
    "GO_OFFLINE", "OUTPUT_SWITCH_TEST", "CYLINDER_BALANCE_TEST",
  ];
  assert.equal(catalogue.length, 26);
  assert.deepEqual(catalogue.map(candidate => candidate.id).sort(), expectedIds.sort());
  const clearDtc = catalogue.find(candidate => candidate.id === "CLEAR_DTC");
  assert.equal(clearDtc.evidenceNumericLevel, EVIDENCE_LEVELS.LEVEL_1_NOT_TESTED);
  assert.equal(clearDtc.evidenceLevel, evidenceLevelName(1));
  assert.match(clearDtc.description, /HSK_ACK.*words_started=0.*physical bus transmission remains unverified on the vehicle/i);
  assert.equal(catalogue.find(candidate => candidate.id === "MEM_OFF0").requiredFirmwareVersion, 28);
  const fields = ["id", "name", "commandWord", "envelope", "description", "source", "sourceUrl", "parityStatus", "evidenceNumericLevel", "evidenceLevel", "classification", "risk", "requiredEcuState", "repeats", "armCommand", "readCommand", "variantKey", "sendable", "blockedReason"];
  for (const candidate of catalogue) {
    for (const field of fields) assert.ok(field in candidate, `${candidate.id} must define ${field}`);
    assert.equal(candidate.evidenceLevel, evidenceLevelName(candidate.evidenceNumericLevel), candidate.id);
  }
  assert.equal(Object.keys(EVIDENCE_LEVELS).length, 5);
  for (let level = 1; level <= 5; level += 1) assert.equal(evidenceLevelName(level), EVIDENCE_LEVEL_NAMES[level]);
  for (const variant of Object.values(DCL_PROBE_VARIANTS)) assert.equal(variant.evidenceLevel, evidenceLevelName(variant.evidenceNumericLevel), variant.word);

  const [html, app, ui] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/ui.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /id="(?:mem-btn|identity-out|dcl-probe-(?:select|description|run|summary|export|raw))"/);
  assert.match(html, /id="dcl-run-action"/);
  assert.match(html, /id="dcl-toggle-multiselect"/);
  assert.doesNotMatch(app, /getElementById\("(?:mem-btn|dcl-probe-(?:select|run|export))"\)/);
  assert.doesNotMatch(ui, /mem-btn/);
  assert.match(ui, /dcl-run-action/);
});
