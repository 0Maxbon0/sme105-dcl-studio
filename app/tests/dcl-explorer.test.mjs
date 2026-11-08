import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { EXPERIMENT_CATALOGUE, DCL_PROBE_VARIANTS, VARIANTS } from "../js/protocol.js";
import { discoveryPassCandidates } from "../js/controller.js";
import { filterDclCatalogue, renderDclCommandExplorer, wireDclCommandExplorer } from "../js/ui.js";

const expected = {
  ECU_STATUS: ["0381", "READ_ONLY"],
  STORED_0E: ["260E", "READ_ONLY"],
  STORED_A4: ["26A4", "READ_ONLY"],
  CLEAR_DTC: ["0291", "STATE_CHANGING"],
  KOEO_253E: ["253E", "SELF_TEST"],
  KOER_253E: ["253E", "SELF_TEST"],
  KOEO_ALT: ["2594", "SELF_TEST"],
  PIDMAP_TX: ["4196", "STATE_CHANGING"],
  PIDMAP: ["005E", "READ_ONLY"],
  PIDMAP_ALT: ["004E", "READ_ONLY"],
  PID_VALUES: ["21F6", "READ_ONLY"],
  CLEAR_A1: ["01A1", "STATE_CHANGING"],
  CLEAR_F4: ["01F4", "STATE_CHANGING"],
  DMRMAP_TX: ["42A6", "CONFIG_CHANGE"],
  DMRMAP: ["242E", "READ_ONLY"],
  DMR_VALUES: ["22C6", "READ_ONLY"],
  PID_DMR_BOTH: ["271E", "READ_ONLY"],
  CHANGE_BAUD: ["8174", "CONFIG_CHANGE"],
  STOP_PID_FLOW: ["411E", "SEQUENCE_DEPENDENT"],
  MEMORY_READ: ["42F3 / 22D3", "READ_ONLY"],
  MEM_OFF0: ["42F3 / 22D3", "READ_ONLY"],
  MEM_SINGLE: ["42F3", "READ_ONLY"],
  MEM_PARITY: ["42F3 / 2293", "READ_ONLY"],
  GO_OFFLINE: ["80CE / 7F20", "SEQUENCE_DEPENDENT"],
  OUTPUT_SWITCH_TEST: ["procedure", "FACTORY_PROCEDURE"],
  CYLINDER_BALANCE_TEST: ["procedure", "FACTORY_PROCEDURE"],
};

test("the command catalogue is complete and each operation variant matches its fixed firmware words", () => {
  const catalogue = Object.values(EXPERIMENT_CATALOGUE);
  assert.equal(catalogue.length, Object.keys(expected).length);
  const byId = new Map(catalogue.map(item => [item.id, item]));
  const fields = ["id", "name", "commandWord", "envelope", "description", "source", "sourceUrl", "parityStatus", "classification", "risk", "requiredEcuState", "repeats", "armCommand", "readCommand", "variantKey", "sendable", "blockedReason"];
  for (const [id, [word, classification]] of Object.entries(expected)) {
    const item = byId.get(id);
    assert.ok(item, `missing catalogue candidate ${id}`);
    assert.equal(item.commandWord, word, id);
    assert.equal(item.classification, classification, id);
    for (const field of fields) assert.ok(field in item, `${id} is missing ${field}`);
  }
  for (const [key, [word, arm, read]] of Object.entries({
    PIDMAP_ALT: ["004E", "ARM_PIDMAP_ALT", "READ_PIDMAP_ALT"],
    KOEO_ALT: ["2594", "ARM_KOEO_ALT", "READ_KOEO_ALT"],
    CLEAR_A1: ["01A1", "ARM_CLEAR_A1", "READ_CLEAR_A1"],
    CLEAR_F4: ["01F4", "ARM_CLEAR_F4", "READ_CLEAR_F4"],
    CHANGE_BAUD: ["8174", "ARM_CHANGE_BAUD", "READ_CHANGE_BAUD"],
    DMRMAP_TX: ["42A6", "ARM_DMRMAP_TX", "READ_DMRMAP_TX"],
    STOP_PID_FLOW: ["411E", "ARM_STOP_PID_FLOW", "READ_STOP_PID_FLOW"],
    MEM: ["42F3 / 22D3", "ARM_MEM", "READ_MEM"],
  })) {
    const variant = DCL_PROBE_VARIANTS[key];
    assert.equal(variant.word, word, key);
    assert.equal(variant.armCommand, arm, key);
    assert.equal(variant.readCommand, read, key);
    assert.equal(VARIANTS[key].command, key, key);
  }
  assert.deepEqual(discoveryPassCandidates().map(item => item.id), [
    "STORED_0E", "STORED_A4", "ECU_STATUS", "PIDMAP", "PIDMAP_ALT", "DMRMAP", "DMR_VALUES", "PID_DMR_BOTH",
  ]);
  assert.ok(discoveryPassCandidates().every(item => item.classification === "READ_ONLY" && item.sendable));
});

test("catalogue search and category/firmware filters match names and hexadecimal words", () => {
  assert.deepEqual(filterDclCatalogue({ query: "004E" }).map(item => item.id), ["PIDMAP_ALT"]);
  assert.deepEqual(filterDclCatalogue({ query: "242e" }).map(item => item.id), ["DMRMAP"]);
  assert.ok(filterDclCatalogue({ query: "cylinder balance" }).some(item => item.id === "CYLINDER_BALANCE_TEST"));
  assert.ok(filterDclCatalogue({ category: "SELF_TEST" }).every(item => item.classification === "SELF_TEST"));
  assert.ok(filterDclCatalogue({ category: "FACTORY_PROCEDURE" }).every(item => item.classification === "FACTORY_PROCEDURE"));
  assert.ok(filterDclCatalogue({ firmwareStatus: "SUPPORTED", firmwareVersion: "27" }).every(item => item.sendable));
  assert.deepEqual(filterDclCatalogue({ firmwareStatus: "DEFERRED", firmwareVersion: "27" }), []);
  assert.ok(filterDclCatalogue({ firmwareStatus: "DEFERRED", firmwareVersion: "24" }).every(item => item.requiredFirmwareVersion > 24));
  assert.equal(filterDclCatalogue({ category: "CONFIG_CHANGE" }).some(item => item.id === "CHANGE_BAUD"), true);
});

test("Explorer cards show exact transmission details and respond to search and filters", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-explorer.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const state = { link: "ready", phase: "idle", transport: "ble", discoveryPass: null, status: { fields: { fw: "27" } } };
    wireDclCommandExplorer();
    renderDclCommandExplorer(state);
    assert.equal(document.querySelectorAll("#dcl-command-list .dcl-command-card").length, catalogueSize());
    const search = document.getElementById("dcl-command-search");
    search.value = "004E";
    search.dispatchEvent(new window.Event("input"));
    assert.equal(document.querySelectorAll("#dcl-command-list .dcl-command-card").length, 1);
    assert.match(document.getElementById("dcl-command-detail-body").textContent, /00 4E/);
    assert.match(document.getElementById("dcl-command-detail-body").textContent, /VPARITY:/);
    assert.match(document.getElementById("dcl-command-detail-body").textContent, /00 4E \(match\)/);
    search.value = "005E";
    search.dispatchEvent(new window.Event("input"));
    assert.match(document.getElementById("dcl-command-detail-body").textContent, /00 5E → 00 4E \(listed literal differs\)/);
    search.value = "";
    search.dispatchEvent(new window.Event("input"));
    document.getElementById("dcl-command-category").value = "FACTORY_PROCEDURE";
    document.getElementById("dcl-command-category").dispatchEvent(new window.Event("change"));
    assert.equal(document.querySelectorAll("#dcl-command-list .dcl-command-card").length, 2);
    document.getElementById("dcl-command-firmware").value = "SUPPORTED";
    document.getElementById("dcl-command-firmware").dispatchEvent(new window.Event("change"));
    assert.equal(document.querySelectorAll("#dcl-command-list .dcl-command-card").length, 2);
    document.getElementById("dcl-command-firmware").value = "ALL";
    document.getElementById("dcl-command-firmware").dispatchEvent(new window.Event("change"));
    document.getElementById("dcl-command-category").value = "ALL";
    document.getElementById("dcl-command-category").dispatchEvent(new window.Event("change"));
    search.value = "22D3";
    search.dispatchEvent(new window.Event("input"));
    assert.match(document.getElementById("dcl-command-detail-body").textContent, /fixed continuation: 22 D3/);
    assert.match(document.getElementById("dcl-command-detail-body").textContent, /22 D3 → 22 93/);
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

function catalogueSize() { return Object.keys(EXPERIMENT_CATALOGUE).length; }
