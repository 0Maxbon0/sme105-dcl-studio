import assert from "node:assert/strict";
import test from "node:test";
import { createController, discoveryPassCandidates } from "../js/controller.js";
import { EXPECTED_HELLO, EXPECTED_PINS } from "../js/protocol.js";

function makeHarness({ initialBenchPass = true, mode = "zero" } = {}) {
  const commands = [];
  let controller;
  let automatic = false;
  let benchPass = initialBenchPass;
  let firstStatusFault = false;
  const archives = [];
  const statusLine = () => `STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 pad_rx=1 tx2_bench_used=1 tx2_bench_pass=${benchPass ? 1 : 0} read_used=0 observe_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 offline_used=0 armed=NONE fault=${firstStatusFault ? 1 : 0} live_all=1 rx_batch=1 pad_evidence=2 kline_hw=0 kline_tx=0 kline_rx_backend=NONE fw=27`;
  controller = createController({ send(command) {
    commands.push(command);
    if (!automatic) return;
    if (command === "STATUS") {
      controller.handleLine(statusLine());
      firstStatusFault = false;
      return;
    }
    if (command === "TX2_BENCH") {
      benchPass = true;
      controller.handleLine("TX2_BENCH_END result=PASS checked=4");
      return;
    }
    if (command.startsWith("ARM_")) {
      controller.handleLine(`EVENT read_armed variant=${command.slice(4)} valid_ms=15000 no_tx_yet=1`);
      return;
    }
    if (command.startsWith("READ_")) {
      const variant = command.slice(5);
      controller.handleLine("EVENT session=READ_CANDIDATE");
      if (mode === "fault" && variant === "0E") {
        controller.handleLine("FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW");
        controller.handleLine("END reason=19 ro_bytes=0 ro_lost=0 uart_errors=0 DE=LOW");
      } else if (mode === "disconnect" && variant === "0E") {
        controller.onDisconnected();
      } else if (mode === "stop" && variant === "0E") {
        return;
      } else {
        controller.handleLine("END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 DE=LOW");
      }
      return;
    }
    if (command === "STOP") controller.handleLine("EVENT stop=accepted DE=LOW");
  }});
  controller.onConnected("SME105 test bridge");
  controller.handleLine("AUTH OK transport=BLE");
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine(statusLine());
  automatic = true;
  return {
    controller, commands, archives,
    setUnsafeStatus() { firstStatusFault = true; },
    async createArchive(variant, candidate, pass) {
      const archive = {
        id: `rec-${archives.length + 1}`, variant, closed: false,
        lines: [], line(value) { this.lines.push(String(value)); },
        async finish(verdict) { this.closed = true; this.verdict = verdict; return true; },
      };
      archives.push({ archive, candidate, pass });
      return archive;
    },
  };
}

function start(harness) {
  return harness.controller.startDiscoveryPass({ createArchive: harness.createArchive });
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("discovery runner did not reach the expected state");
}

test("read-only pass runs supported candidates sequentially and retains zero-byte results", async () => {
  const h = makeHarness({ mode: "zero" });
  const result = await start(h);
  assert.equal(result.pass.status, "complete");
  assert.deepEqual(result.pass.candidates, discoveryPassCandidates().map(item => item.id));
  assert.deepEqual(result.pass.results.map(item => item.variant), ["0E", "A4", "ECU_STATUS", "PIDMAP", "PIDMAP_ALT", "DMRMAP", "DMR", "BOTH"]);
  assert.equal(result.pass.completed.length, 8);
  assert.equal(result.pass.failed.length, 0);
  assert.ok(result.pass.completed.every(item => item.status === "ZERO_RESPONSE" && item.responseBytes === 0));
  const armed = h.commands.filter(command => command.startsWith("ARM_"));
  assert.deepEqual(armed, ["ARM_0E", "ARM_A4", "ARM_ECU_STATUS", "ARM_PIDMAP", "ARM_PIDMAP_ALT", "ARM_DMRMAP", "ARM_DMR", "ARM_BOTH"]);
  assert.equal(h.commands.some(command => /^(ARM|READ)_(?:CLR|KOEO|KOER|CHANGE_BAUD|CLEAR_A1|CLEAR_F4|DMRMAP_TX|STOP_PID_FLOW)$/.test(command)), false);
  assert.equal(h.archives.length, 8);
  assert.ok(h.archives.every(({ archive }) => archive.closed));
});

test("TX2_BENCH runs before ARM when bridge status says it is required", async () => {
  const h = makeHarness({ initialBenchPass: false, mode: "zero" });
  const result = await start(h);
  assert.equal(result.pass.status, "complete");
  assert.ok(h.commands.indexOf("TX2_BENCH") >= 0);
  assert.ok(h.commands.indexOf("TX2_BENCH") < h.commands.indexOf("ARM_0E"));
});

test("unsafe bridge status stops before creating a recording or sending an ARM", async () => {
  const h = makeHarness({ mode: "zero" });
  h.setUnsafeStatus();
  const result = await start(h);
  assert.equal(result.pass.status, "stopped");
  assert.equal(h.archives.length, 0);
  assert.equal(h.commands.some(command => command.startsWith("ARM_")), false);
  assert.equal(result.pass.remaining[0], "STORED_0E");
});

test("a bridge fault stops the pass without trying the next candidate", async () => {
  const h = makeHarness({ mode: "fault" });
  const result = await start(h);
  assert.equal(result.pass.status, "stopped");
  assert.equal(result.pass.failed.length, 1);
  assert.match(result.pass.error, /Bridge fault detected/);
  assert.deepEqual(h.commands.filter(command => command.startsWith("ARM_")), ["ARM_0E"]);
  assert.equal(result.pass.remaining[0], "STORED_A4");
});

test("connection loss stops the pass after the active capture", async () => {
  const h = makeHarness({ mode: "disconnect" });
  const result = await start(h);
  assert.equal(result.pass.status, "stopped");
  assert.match(result.pass.error, /disconnected/);
  assert.deepEqual(h.commands.filter(command => command.startsWith("ARM_")), ["ARM_0E"]);
});

test("operator Stop sends one bridge STOP and does not arm the next candidate", async () => {
  const h = makeHarness({ mode: "stop" });
  const running = start(h);
  await until(() => h.commands.includes("READ_0E"));
  h.controller.stopDiscoveryPass();
  h.controller.handleLine("END reason=15 ro_bytes=0 ro_lost=0 uart_errors=0 DE=LOW");
  const result = await running;
  assert.equal(result.pass.status, "stopped");
  assert.equal(result.pass.failed[0].status, "STOPPED");
  assert.equal(h.commands.filter(command => command === "STOP").length, 1);
  assert.deepEqual(h.commands.filter(command => command.startsWith("ARM_")), ["ARM_0E"]);
  assert.equal(result.pass.remaining[0], "STORED_A4");
});
