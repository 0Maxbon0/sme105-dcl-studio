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
  controller.handleLine(`STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=${stage} DE=${de} auto_tx=${auto} gate4=${gate} tx2_bench_pass=${pass} tx2_bench_used=${pass} fault=0`);
}

test("BLE authorization is cleared on reconnect and required for vehicle operations", () => {
  const { controller, sent } = harness();
  identify(controller);
  controller.onDisconnected();
  controller.onConnected("SME105-DCL");
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  assert.equal(controller.requestVehicle("LIVE").ok, false);
  assert.equal(sent.some(command => command.startsWith("ARM_")), false);
  controller.handleLine("AUTH OK transport=BLE");
  assert.equal(controller.requestVehicle("LIVE").ok, true);
});

test("an idle bridge with its read latch set is not rearmed", () => {
  const { controller, sent } = harness();
  identify(controller, { pass: "1" });
  assert.equal(controller.requestVehicle("LIVE").ok, true);
  controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=1 fault=19 out_overflow=0 transport_lost=0 usb_skipped=0");
  assert.equal(controller.state.lastSession.verdict.status, "BRIDGE_READ_ALREADY_USED");
  assert.equal(sent.some(command => command.startsWith("ARM_") || command.startsWith("READ_")), false);
});

test("used latch with transport loss is not called a clean read lock or armed", () => {
  const { controller, sent } = harness();
  identify(controller, { pass: "1" });
  controller.requestVehicle("LIVE");
  controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=1 fault=19 out_overflow=1 transport_lost=0 usb_skipped=0");
  assert.equal(controller.state.lastSession.verdict.status, "INCOMPLETE");
  assert.equal(sent.some(command => command.startsWith("ARM_")), false);
});

test("repeated fault while stopping sends STOP only once", () => {
  const { controller, sent } = harness();
  identify(controller, { pass: "1" });
  controller.requestVehicle("LIVE");
  controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 fault=0");
  controller.handleLine("EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1");
  controller.handleLine("EVENT session=READ_CANDIDATE epoch=2 boot_id=77");
  controller.handleLine("FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW");
  controller.requestStop();
  controller.handleLine("FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW");
  assert.equal(sent.filter(command => command === "STOP").length, 1);
  assert.notEqual(controller.state.op.operatorStop, true);
});

test("ble module imports without a browser", () => {
  assert.equal(typeof ble.BleTransport, "function");
  assert.equal(ble.bluetoothAvailable(), false);
});

test("demo transcript answers HELLO, PINS and a stored-code read", () => {
  const replay = createReplay(demo("read-0e.txt"));
  assert.equal(replay.respond("HELLO")[0], EXPECTED_HELLO);
  assert.equal(replay.respond("PINS")[0], EXPECTED_PINS);
  const { controller, sent } = harness();
  controller.onConnected("demo"); controller.handleLine("AUTH OK transport=BLE");
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
  controller.onConnected("demo"); controller.handleLine("AUTH OK transport=BLE");
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
  assert.equal(result.requestedMode, 0x25);
  assert.equal(result.codes[0].mode, 0x25);
  assert.equal(result.codes[0].rawBytes.length, 2);
  assert.ok(Number.isFinite(result.codes[0].rxTimeUs));
  assert.equal(result.bridgeBlocks, 89);
  assert.equal(result.frame7First, 0xac);
  assert.equal(result.frame7Last, 0xec);
  assert.equal(result.selfTestComplete, true);
});

test("unsafe status, denial, timeout and disconnect do not produce a trusted read", () => {
  const unsafe = harness();
  identify(unsafe.controller, { de: "HIGH" });
  assert.equal(unsafe.controller.requestVehicle("0E").ok, true);
  unsafe.controller.handleLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=HIGH auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  assert.equal(unsafe.sent.includes("ARM_0E"), false);
  assert.equal(unsafe.controller.state.trust, "untrusted");

  const denied = harness();
  identify(denied.controller, { pass: "1" });
  denied.controller.requestVehicle("0E");
  denied.controller.handleLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  assert.equal(denied.sent.at(-1), "ARM_0E");
  denied.controller.handleLine("DENIED arm_required_or_consumed");
  assert.equal(denied.sent.includes("READ_0E"), false);
  assert.equal(denied.controller.state.lastSession.verdict.valid, false);

  const timed = harness();
  identify(timed.controller, { pass: "1" });
  timed.controller.requestVehicle("KOEO");
  timed.controller.handleLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
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
  dropped.controller.handleLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  dropped.controller.handleLine("EVENT read_armed variant=OFF valid_ms=15000 no_tx_yet=1");
  dropped.controller.onDisconnected();
  assert.equal(dropped.controller.state.link, "disconnected");
  assert.equal(dropped.controller.state.lastSession.verdict.status, "FAILED");
});

test("an already-passed bench is not repeated before ARM", () => {
  const { controller, sent } = harness();
  identify(controller, { pass: "1" });
  controller.requestVehicle("A4");
  controller.handleLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=0");
  assert.equal(sent.includes("TX2_BENCH"), false);
  assert.equal(sent.at(-1), "ARM_A4");
  controller.handleLine("EVENT read_armed variant=A4 valid_ms=15000 no_tx_yet=1");
  assert.equal(sent.at(-1), "READ_A4");
  assert.deepEqual(sent.filter((command) => command.startsWith("ARM_") || command.startsWith("READ_")), ["ARM_A4", "READ_A4"]);
});

test("start failures preserve mismatched counters and never retry", () => {
  for (const reason of [3, 4, 19]) {
    const { controller, sent } = harness();
    identify(controller, { pass: "1" });
    controller.requestVehicle("LIVE");
    controller.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 fault=0");
    controller.handleLine("EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1");
    controller.handleLine("EVENT session=READ_CANDIDATE epoch=2 boot_id=77");
    controller.handleLine("EVENT ack=candidate_11_echo_plus_01 source=UNVERIFIED");
    controller.handleLine(`FAULT reason=${reason} cause=RX_SILENCE DE=LOW`);
    controller.handleLine(`END reason=${reason} ro_bytes=93380 ro_lost=0 uart_errors=0 DE=LOW`);
    assert.equal(controller.state.lastSession.outcome, "NOT_STARTED_ECU_NO_RESPONSE");
    assert.match(controller.state.lastSession.verdict.reasons.join(" "), /RX lines 0 != ro_bytes 93380/);
    assert.equal(sent.filter(x => x === "READ_LIVE").length, 1);
    assert.equal(sent.filter(x => x === "ARM_LIVE").length, 1);
    assert.equal(sent.filter(x => x === "STOP").length, 1);
  }
});

test("busy or hardware-faulted bridges are not described as a clean read lock", () => {
  for (const [stage, fault] of [["2", "19"], ["0", "17"], ["0", "11"]]) {
    const { controller, sent } = harness(); identify(controller, { pass: "1" });
    controller.requestVehicle("LIVE");
    controller.handleLine(`STATUS SME105_USB_BRIDGE_V1 stage=${stage} DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=1 fault=${fault} out_overflow=0 transport_lost=0 usb_skipped=0`);
    assert.notEqual(controller.state.lastSession.verdict.status, "BRIDGE_READ_ALREADY_USED");
    assert.equal(sent.some(x => x.startsWith("ARM_")), false);
  }
});

test("operator reboot requires a fresh safe STATUS and never clears a latch automatically", () => {
  for (const condition of ['safe','busy','de','transport','missing']) {
    const {controller,sent}=harness();identify(controller,{pass:'1'});
    assert.equal(controller.requestReboot().ok,true);
    assert.equal(sent.at(-1),'STATUS');
    assert.equal(sent.includes('REBOOT'),false);
    if(condition==='missing')continue;
    let status='STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=1 fault=19 out_overflow=0 transport_lost=0 usb_skipped=0';
    if(condition==='busy')status=status.replace('stage=0','stage=2');
    if(condition==='de')status=status.replace('DE=LOW','DE=HIGH');
    if(condition==='transport')status=status.replace('transport_lost=0','transport_lost=1');
    controller.handleLine(status);controller.handleLine(status);
    assert.equal(sent.filter(c=>c==='REBOOT').length,condition==='safe'?1:0);
    assert.equal(sent.some(c=>/^(ARM_|READ_|RESET)/.test(c)),false);
  }
});

test("restart precheck cancellation and link loss cannot dispatch a late reboot", () => {
  for (const cancel of ['stop','disconnect']) {
    const {controller,sent}=harness();identify(controller,{pass:'1'});
    controller.requestReboot();
    if(cancel==='stop')controller.requestStop();else controller.onDisconnected();
    controller.handleLine('STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=1 fault=19 out_overflow=0 transport_lost=0 usb_skipped=0');
    assert.equal(controller.state.phase,'idle');
    assert.equal(sent.includes('REBOOT'),false);
    assert.equal(sent.includes('STOP'),false);
  }
});

test("controller carries current v24 evidence requirement into the final verdict", () => {
  const {controller}=harness();identify(controller,{pass:'1'});controller.requestVehicle('LIVE');
  controller.handleLine('STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 fault=0 out_overflow=0 transport_lost=0 usb_skipped=0 fw=24 pad_evidence=2');
  controller.handleLine('EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1');
  controller.handleLine('EVENT session=READ_CANDIDATE');
  for(const [slot,word] of ['01B0','FF5F','21F6','00A0'].entries())controller.handleLine(`TX_PAD slot=${slot} expected=${word} observed=${word} match=1`);
  controller.handleLine('END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 pad_verified=4 words_started=4 DE=LOW');
  assert.equal(controller.state.lastSession.verdict.valid,false);
  assert.match(controller.state.lastSession.verdict.reasons.join(' '),/provenance/);
});


test("DCL discovery variants arm and transmit only their named fixed probe", () => {
  const commands = {
    ECU_STATUS: "0381", PIDMAP: "005E", DMRMAP: "242E", DMR: "22C6", BOTH: "271E",
  };
  for (const [variant, word] of Object.entries(commands)) {
    const { controller, sent } = harness();
    identify(controller, { pass: "1" });
    assert.equal(controller.requestVehicle(variant).ok, true, variant);
    controller.handleLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fw=24 pad_evidence=2 out_overflow=0 transport_lost=0 usb_skipped=0 fault=0");
    assert.equal(sent.at(-1), `ARM_${variant}`, variant);
    controller.handleLine(`EVENT read_armed variant=${variant} valid_ms=15000 no_tx_yet=1`);
    assert.equal(sent.at(-1), `READ_${variant}`, variant);
    controller.handleLine("EVENT session=READ_CANDIDATE epoch=5 boot_id=77");
    const expected = ["01B0", "FF5F", word, "00A0"];
    for (let slot = 0; slot < expected.length; ++slot) {
      controller.handleLine(`TX_PAD slot=${slot} expected=${expected[slot]} observed=${expected[slot]} tx_us=${1000 + slot * 3000} done_us=${3000 + slot * 3000} match=1 evidence=2 epoch=5 boot_id=77 tx_seq=${slot + 1} block=0 complete=1`);
    }
    controller.handleLine("RX t_us=16000 byte=AA");
    controller.handleLine("END reason=16 ro_bytes=1 ro_lost=0 uart_errors=0 evidence=2 epoch=5 boot_id=77 witness_started=4 witness_verified=4 pad_verified=4 words_started=4 DE=LOW");
    assert.equal(controller.state.lastSession.verdict.valid, true, variant);
    assert.equal(controller.state.lastSession.dclProbe.word, word, variant);
    assert.equal(controller.state.lastSession.dclProbe.responseBytes, 1, variant);
    assert.equal(controller.state.lastSession.dclProbe.ecuOriginVerified, false, variant);
    assert.equal(controller.state.lastDclProbe.rawLines.some(line => line.startsWith("RX ")), true, variant);
    assert.deepEqual(sent.filter(command => command.startsWith("ARM_") || command.startsWith("READ_")), [`ARM_${variant}`, `READ_${variant}`]);
  }
});

test("vehicle preflight retains the matching operation recording archive", () => {
  const { controller } = harness();
  identify(controller, { pass: "1" });
  const archive = { id: "capture-1", variant: "DMR", closed: false };
  controller.setArchive(archive);
  assert.equal(controller.requestVehicle("DMR").ok, true);
  assert.equal(controller.state.archive, archive);
});
