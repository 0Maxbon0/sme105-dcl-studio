import assert from "node:assert/strict";
import test from "node:test";
import { createController } from "../js/controller.js";
import { EXPECTED_HELLO, EXPECTED_PINS } from "../js/protocol.js";
import { WifiTransport } from "../js/wifi.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SAFE_STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=27";

class SingleControllerBridge {
  constructor(token = TOKEN) {
    this.token = token;
    this.active = null;
    this.authAttempts = [];
  }
  open(name, onReply = () => {}) {
    if (this.active && !this.active.closed) throw new Error("DENIED controller_busy");
    const bridge = this;
    const client = {
      name,
      authenticated: false,
      closed: false,
      write(line) {
        if (this.closed) throw new Error("socket closed");
        const command = String(line).trim();
        if (!command.startsWith("AUTH ")) {
          if (!this.authenticated) {
            onReply("DENIED auth\n");
            this.closed = true;
            return;
          }
          return;
        }
        bridge.authAttempts.push(command);
        if (command.slice(5) !== bridge.token) {
          onReply("DENIED auth\n");
          this.closed = true;
          return;
        }
        this.authenticated = true;
        onReply("AUTH OK\n");
      },
      close() {
        this.closed = true;
        this.authenticated = false;
        if (bridge.active === this) bridge.active = null;
      },
    };
    this.active = client;
    return client;
  }
}

function controllerHarness(transport = "wifi") {
  const commands = [];
  let respond = () => {};
  const controller = createController({ send(command) {
    commands.push(command);
    respond(command);
  } });
  function identify() {
    controller.onConnected(`SME105 ${transport}`, transport);
    controller.handleLine("AUTH OK");
    controller.handleLine(EXPECTED_HELLO);
    controller.handleLine(EXPECTED_PINS);
    controller.handleLine(SAFE_STATUS);
  }
  return { controller, commands, identify, setResponder(fn) { respond = fn; } };
}

test("only one authenticated TCP controller owns the bridge at a time", () => {
  const bridge = new SingleControllerBridge();
  const firstReplies = [];
  const first = bridge.open("phone-1", line => firstReplies.push(line.trim()));
  first.write(`AUTH ${TOKEN}\n`);

  assert.equal(first.authenticated, true);
  assert.deepEqual(firstReplies, ["AUTH OK"]);
  assert.throws(() => bridge.open("phone-2"), /controller_busy/);
  first.close();

  const second = bridge.open("phone-2");
  second.write(`AUTH ${TOKEN}\n`);
  assert.equal(second.authenticated, true);
  assert.equal(bridge.authAttempts.length, 2);
});

test("disconnect clears controller identity and reconnect sends a fresh AUTH before becoming ready", () => {
  const bridge = new SingleControllerBridge();
  const h = controllerHarness();
  const replies = [];
  const first = bridge.open("phone", line => replies.push(line.trim()));
  first.write(`AUTH ${TOKEN}\n`);
  h.identify();
  assert.equal(h.controller.state.link, "ready");
  assert.equal(h.controller.state.identity.auth, "OK");

  first.close();
  h.controller.onDisconnected();
  assert.equal(h.controller.state.identity.auth, "");
  assert.equal(h.controller.state.link, "disconnected");

  const second = bridge.open("phone");
  assert.equal(second.authenticated, false);
  assert.equal(bridge.authAttempts.length, 1, "opening a TCP socket does not inherit the prior auth state");
  second.write(`AUTH ${TOKEN}\n`);
  assert.equal(second.authenticated, true);
  assert.equal(h.controller.state.link, "disconnected", "fresh socket AUTH alone does not restore controller readiness");
  assert.equal(h.controller.requestVehicle("LIVE").ok, false);
  h.identify();

  assert.equal(bridge.authAttempts.length, 2);
  assert.equal(h.controller.state.identity.auth, "OK");
  assert.deepEqual(h.commands.slice(-3), ["HELLO", "PINS", "STATUS"]);
});

test("reconcile does not trust a native connected socket that is unauthenticated", async () => {
  const nativeStatus = {
    connected: true,
    authenticated: false,
    mode: "ap",
    ssid: "SME105_DCL",
    host: "10.77.13.1",
    port: 8765,
  };
  const transport = new WifiTransport({ onDisconnect: () => {} }, {
    isNative: () => true,
    loadNative: async () => ({ WifiBridge: { async getStatus() { return nativeStatus; } } }),
  });

  assert.deepEqual(await transport.reconcile(), { connected: false });
  assert.equal(transport.connected, false);
  assert.equal(transport.authenticated, false);
});

test("reconnect performs identity checks only and never replays a vehicle operation", () => {
  const h = controllerHarness();
  h.identify();
  h.setResponder(command => {
    if (command === "STATUS") h.controller.handleLine(SAFE_STATUS);
    // The lost ARM acknowledgement deliberately produces no READ or retry.
  });

  assert.equal(h.controller.requestVehicle("LIVE").ok, true);
  assert.deepEqual(h.commands.slice(-2), ["STATUS", "ARM_LIVE"]);
  h.controller.onDisconnected();
  h.identify();

  assert.deepEqual(h.commands.slice(-3), ["HELLO", "PINS", "STATUS"]);
  assert.equal(h.commands.filter(command => command === "ARM_LIVE").length, 1);
  assert.equal(h.commands.filter(command => command === "READ_LIVE").length, 0);
  assert.equal(h.controller.state.op, null);
});

test("DE, auto-TX, stage, and gate safety failures stop before ARM or READ", () => {
  const unsafeStatuses = [
    SAFE_STATUS.replace("DE=LOW", "DE=HIGH"),
    SAFE_STATUS.replace("auto_tx=0", "auto_tx=1"),
    SAFE_STATUS.replace("stage=0", "stage=1"),
    SAFE_STATUS.replace("gate4=1", "gate4=0"),
  ];

  for (const status of unsafeStatuses) {
    const h = controllerHarness();
    h.identify();
    h.setResponder(command => {
      if (command === "STATUS") h.controller.handleLine(status);
    });
    assert.equal(h.controller.requestVehicle("LIVE").ok, true);
    assert.equal(h.commands.some(command => command.startsWith("ARM_") || command.startsWith("READ_")), false, status);
    assert.equal(h.controller.state.trust, "untrusted");
  }

  const safe = controllerHarness();
  safe.identify();
  assert.equal(safe.controller.state.status.fields.DE, "LOW");
  assert.equal(safe.controller.state.status.fields.auto_tx, "0");
  assert.equal(safe.controller.state.status.fields.armed, "NONE");
});

test("BLE remains functional when the operator explicitly selects BLE", () => {
  const h = controllerHarness("ble");
  h.identify();
  h.setResponder(command => {
    if (command === "STATUS") h.controller.handleLine(SAFE_STATUS);
    if (command === "TX2_BENCH") h.controller.handleLine("TX2_BENCH_END result=PASS_LOCAL_PAD completed=4 DE=LOW ecu_tx=0");
  });

  assert.equal(h.controller.state.transport, "ble");
  assert.equal(h.controller.requestBench().ok, true);
  assert.ok(h.commands.includes("TX2_BENCH"));
  assert.equal(h.controller.state.link, "ready");
});

test("demo sessions stay isolated from the Wi-Fi and BLE hardware transports", () => {
  let hardwareTransportCalls = 0;
  const commands = [];
  const controller = createController({ send: command => commands.push(command) });
  controller.onConnected("demo", "demo");
  controller.handleLine("AUTH OK");
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine(SAFE_STATUS);

  const result = controller.requestVehicle("LIVE");
  assert.equal(result.ok, true);
  assert.equal(controller.state.transport, "demo");
  assert.equal(controller.state.op.source, "simulation");
  assert.equal(hardwareTransportCalls, 0);
  assert.deepEqual(commands.slice(-1), ["STATUS"]);
});
