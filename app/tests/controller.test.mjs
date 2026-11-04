import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createController } from "../js/controller.js";
import { createReplay } from "../js/mock-transport.js";
import { EXPECTED_HELLO, EXPECTED_PINS, TIMEOUTS } from "../js/protocol.js";
import * as ble from "../js/ble.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const demo = (name) => readFileSync(path.join(repo, "app/demo", name), "utf8");

function harness() {
  const sent = [];
  let now = 1_000;
  const controller = createController({
    now: () => now,
    send: (command) => sent.push(command),
  });
  return {
    controller,
    sent,
    advance(ms) { now += ms; },
  };
}

function identify(controller, { pass = "0", de = "LOW", stage = "0", auto = "0", gate = "1" } = {}) {
  controller.onConnected("SME105-DCL");
  controller.handleLine("AUTH OK transport=BLE");
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine(`STATUS SME105_USB_BRIDGE_V1 stage=${stage} DE=${de} auto_tx=${auto} gate4=${gate} tx2_bench_pass=${pass} tx2_bench_used=${pass} fault=0`);
}

test("ble module imports without a browser", () => {
  assert.equal(typeof ble.BleTransport, "function");
  assert.equal(ble.bluetoothAvailable(), false);
});

test("demo transcript answers HELLO, PINS and a stored-code read", () => {
  const replay = createReplay(demo("read-0e.txt"));
  assert.equal(replay.respond("HELLO")[0], EXPECTED_HELLO);
  assert.equal(replay.respond("PINS")[0], EXPECTED_PINS);
  const { controller, sent } = harness();
  controller.onConnected("demo");
  for (const line of replay.respond("HELLO")) controller.handleLine(line);
  for (const line of replay.respond("PINS")) controller.handleLine(line);
  for (const line of replay.respond("STATUS")) controller.handleLine(line);
  assert.equal(controller.state.identity.helloOk, true);
  assert.equal(controller.state.identity.pinsOk, true);
  assert.equal(controller.requestVehicle("0E").ok, true);
  for (const line of replay.respond("STATUS")) controller.handleLine(line);
  for (const line of replay.respond("TX2_BENCH")) controller.handleLine(line);
  for (const line of replay.respond("STATUS")) controller.handleLine(line);
  for (const line of replay.respond("ARM_0E")) controller.handleLine(line);
  for (const line of replay.respond("READ_0E")) controller.handleLine(line);
  assert.ok(sent.includes("TX2_BENCH"));
  assert.ok(sent.includes("ARM_0E"));
  assert.ok(sent.includes("READ_0E"));
  assert.equal(controller.state.trust, "valid");
  assert.deepEqual(controller.state.lastSession.codes.map((entry) => entry.code), ["122", "113", "214", "157", "452"]);
  assert.equal(controller.state.rom.low, 0xad);
  assert.equal(controller.state.rom.high, 0x38);
});

test("KOEO demo replay keeps code 113 and the firmware block count", () => {
  const replay = createReplay(demo("koeo.txt"));
  const { controller } = harness();
  controller.onConnected("demo");
  for (const line of replay.respond("HELLO")) controller.handleLine(line);
  for (const line of replay.respond("PINS")) controller.handleLine(line);
  for (const line of replay.respond("STATUS")) controller.handleLine(line);
  assert.equal(controller.requestVehicle("KOEO").ok, true);
  for (const line of replay.respond("STATUS")) controller.handleLine(line);
  for (const line of replay.respond("TX2_BENCH")) controller.handleLine(line);
  for (const line of replay.respond("STATUS")) controller.handleLine(line);
  for (const line of replay.respond("ARM_KOEO")) controller.handleLine(line);
  for (const line of replay.respond("READ_KOEO")) controller.handleLine(line);
  const result = controller.state.lastSession;
  assert.equal(result.verdict.valid, true);
  assert.deepEqual(result.codes.map((entry) => entry.code), ["113"]);
  assert.equal(result.codes[0].source, "KOEO");
  assert.equal(result.bridgeBlocks, 89);
  assert.equal(result.frame7First, 0xac);
  assert.equal(result.frame7Last, 0xec);
  assert.equal(result.selfTestComplete, true);
});

test("unsafe status, denial, timeout and disconnect do not produce a trusted read", () => {
  const unsafe = harness();
  identify(unsafe.controller, { de: "HIGH" });
  assert.equal(unsafe.controller.requestVehicle("0E").ok, true);
  unsafe.controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=HIGH auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  assert.equal(unsafe.sent.includes("ARM_0E"), false);
  assert.equal(unsafe.controller.state.trust, "untrusted");

  const denied = harness();
  identify(denied.controller, { pass: "1" });
  denied.controller.requestVehicle("0E");
  denied.controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  assert.equal(denied.sent.at(-1), "ARM_0E");
  denied.controller.handleLine("DENIED arm_required_or_consumed");
  assert.equal(denied.sent.includes("READ_0E"), false);
  assert.equal(denied.controller.state.lastSession.verdict.valid, false);

  const timed = harness();
  identify(timed.controller, { pass: "1" });
  timed.controller.requestVehicle("KOEO");
  timed.controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  timed.controller.handleLine("EVENT read_armed variant=KOEO valid_ms=15000 no_tx_yet=1");
  assert.equal(timed.sent.at(-1), "READ_KOEO");
  timed.advance(TIMEOUTS.KOEO + 1);
  timed.controller.tick();
  assert.equal(timed.sent.at(-1), "STOP");
  timed.controller.handleLine("EVENT stop=accepted DE=LOW");
  assert.equal(timed.controller.state.lastSession.verdict.status, "INCOMPLETE");
  assert.equal(timed.controller.state.trust, "untrusted");

  const dropped = harness();
  identify(dropped.controller, { pass: "1" });
  dropped.controller.requestVehicle("OFF");
  dropped.controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  dropped.controller.handleLine("EVENT read_armed variant=OFF valid_ms=15000 no_tx_yet=1");
  dropped.controller.onDisconnected();
  assert.equal(dropped.controller.state.link, "disconnected");
  assert.equal(dropped.controller.state.lastSession.verdict.status, "FAILED");
});

test("an already-passed bench is not repeated before ARM", () => {
  const { controller, sent } = harness();
  identify(controller, { pass: "1" });
  controller.requestVehicle("A4");
  controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  assert.equal(sent.includes("TX2_BENCH"), false);
  assert.equal(sent.at(-1), "ARM_A4");
});
