import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { pbkdf2Sync } from "node:crypto";
import * as fake from "fake-indexeddb";
import "./test-env.mjs";
import { createController } from "../js/controller.js";
import { createReplay } from "../js/mock-transport.js";
import { EXPECTED_HELLO, EXPECTED_PINS } from "../js/protocol.js";
import { createRecording, listRecordings, recordingBlob } from "../js/recording.js";
import { WifiTransport } from "../js/wifi.js";

globalThis.indexedDB = new fake.IDBFactory();
globalThis.IDBKeyRange = fake.IDBKeyRange;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: {
  estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }),
  persist: async () => true,
} } });

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = name => readFileSync(path.join(repo, "app/demo", name), "utf8");
const TOKEN = "0123456789abcdef0123456789abcdef";
const PASSWORD = "ExamplePass9";
const AP_SSID = "SME105-DIRECT-2BF8";
const AP_DERIVED_TOKEN = "cbb4d68a0c00de650a1a307ef12b091a";

function apToken(password, ssid) {
  return pbkdf2Sync(password, `SME105-DCL-AUTH-V1:${ssid}`, 10_000, 16, "sha256").toString("hex");
}

const SAFE_STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 pad_rx=1 tx2_bench_used=1 tx2_bench_pass=1 read_used=0 observe_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 live_all=1 rx_batch=1 pad_evidence=2 fw=27";

/** Fake native Wi-Fi plugin models Android's AP choice and the authenticated bridge socket. */
class OfflineWifiBridge {
  constructor({ token = TOKEN, expectedToken = TOKEN, expectedApToken = AP_DERIVED_TOKEN, connectAp = async () => ({ ssid: AP_SSID }), onCommand = null } = {}) {
    this.token = token;
    this.expectedToken = expectedToken;
    this.expectedApToken = expectedApToken;
    this.connectAp = connectAp;
    this.onCommand = onCommand;
    this.listeners = new Map();
    this.wireLines = [];
    this.commands = [];
    this.apJoined = false;
    this.authenticated = false;
    this.connected = false;
    this.networkRequests = 0;
    this.tcpConnections = 0;
    this.credentialCalls = [];
    this.savedToken = token;
    this.savedPassword = "";
    this.mode = "ap";
    this.ssid = "";
    this.host = "";
    this.port = 8765;
  }

  async addListener(eventName, callback) {
    if (!this.listeners.has(eventName)) this.listeners.set(eventName, new Set());
    this.listeners.get(eventName).add(callback);
    return { remove: async () => this.listeners.get(eventName)?.delete(callback) };
  }

  emit(eventName, value) {
    for (const callback of this.listeners.get(eventName) || []) callback(value);
  }

  async connect(options) {
    const mode = options.mode ?? "ap";
    const host = options.host ?? "";
    const password = options.password || this.savedPassword;
    if (mode === "ap" && (!password || !/^[\x20-\x7E]{8,63}$/.test(password))) {
      throw new Error("SoftAP WPA2 password must contain 8–63 printable ASCII characters");
    }
    if (mode === "sta" && !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
      throw new Error("STA mode requires an explicit host IP address");
    }

    this.networkRequests += 1;
    this.mode = mode;
    this.ssid = options.ssid || "";
    this.host = host;
    this.port = options.port ?? 8765;
    const ap = await this.connectAp(options); // models Android's system Wi-Fi selection dialog
    if (mode === "ap") assert.equal(ap.ssid, options.ssid);
    this.apJoined = true;
    this.tcpConnections += 1;
    const tcpToken = mode === "ap" ? apToken(password, this.ssid) : options.token || this.savedToken;
    this.wireLines.push(`AUTH ${tcpToken}`);
    if (tcpToken !== (mode === "ap" ? this.expectedApToken : this.expectedToken)) {
      throw new Error("Authentication failed: DENIED auth");
    }
    this.connected = true;
    this.authenticated = true;
  }

  async getStatus() {
    return {
      connected: this.connected,
      authenticated: this.authenticated,
      mode: this.mode,
      ssid: this.ssid,
      host: this.host,
      port: this.port,
    };
  }

  async hasToken() {
    const hasToken = typeof this.savedToken === "string" && this.savedToken.length === 32;
    return { hasToken, configured: hasToken };
  }

  async saveToken({ token }) { this.savedToken = token; this.credentialCalls.push(["saveToken", token]); return { success: true }; }
  async hasPassword() {
    const hasPassword = /^[\x20-\x7E]{8,63}$/.test(this.savedPassword);
    return { hasPassword, configured: hasPassword };
  }

  async savePassword({ password }) { this.savedPassword = password; this.credentialCalls.push(["savePassword", password]); return { success: true }; }
  async clearPassword() { this.savedPassword = ""; this.credentialCalls.push(["clearPassword"]); return { cleared: true }; }

  async write({ data }) {
    if (!this.connected || !this.authenticated) throw new Error("Wi-Fi bridge is not authenticated");
    const command = data.replace(/\n$/, "");
    this.wireLines.push(command);
    this.commands.push(command);
    const lines = this.onCommand?.(command) || [];
    for (const line of lines) this.emit("line", { line });
  }

  async disconnect() {
    this.connected = false;
    this.authenticated = false;
    this.emit("disconnect", { reason: "Disconnected by client" });
  }
}

/** Production WifiTransport drives the fake Android/native boundary and real controller. */
class OfflineWifiLink {
  constructor(controller, options = {}) {
    this.controller = controller;
    this.bridge = new OfflineWifiBridge(options);
    this.transport = new WifiTransport({
      onLine: line => controller.handleLine(line),
      onDisconnect: () => controller.onDisconnected(),
      onError: error => { this.lastError = error; },
    }, { isNative: () => true, loadNative: async () => ({ WifiBridge: this.bridge }) });
  }

  get writes() { return this.bridge.wireLines; }
  get commands() { return this.bridge.commands; }
  get apJoined() { return this.bridge.apJoined; }

  async connect() {
    const result = await this.transport.connect({ mode: "ap", ssid: AP_SSID, password: PASSWORD, host: "10.77.13.1", port: 8765 });
    this.controller.onConnected(result.name, "wifi");
    this.controller.handleLine("AUTH OK");
    await this.drain();
  }

  write(command) { return this.transport.write(command); }

  async drain() {
    for (;;) {
      const current = this.transport.queue;
      await current;
      await Promise.resolve();
      if (current === this.transport.queue) return;
    }
  }
}

function makeIntegratedPeer({ storedReplay = createReplay(fixture("read-0e.txt")) } = {}) {
  let link;
  const commands = [];
  const controller = createController({ send: command => link.write(command) });
  const onCommand = command => {
    commands.push(command);
    if (command === "HELLO") return [EXPECTED_HELLO];
    if (command === "PINS") return [EXPECTED_PINS];
    if (command === "STATUS") return [SAFE_STATUS];
    if (command === "TX2_BENCH") return ["TX2_BENCH_END result=PASS_LOCAL_PAD completed=4 DE=LOW ecu_tx=0 no_auto_retry=1"];
    if (command.startsWith("ARM_")) return [`EVENT read_armed variant=${command.slice(4)} valid_ms=15000 no_tx_yet=1`];
    if (command === "READ_0E") return storedReplay.respond(command);
    if (command.startsWith("READ_")) return ["EVENT session=READ_CANDIDATE", "END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 DE=LOW"];
    if (command === "STOP") return ["EVENT stop=accepted DE=LOW"];
    return [];
  };
  link = new OfflineWifiLink(controller, { onCommand });
  return { controller, link, commands: link.commands };
}

async function makeWifiRecording(variant, extra = {}) {
  return createRecording(variant, () => {}, "metric", { transport: "wifi", ...extra });
}

test("SoftAP join authenticates TCP before HELLO, then verifies controller identity in order", async () => {
  const { controller, link, commands } = makeIntegratedPeer();
  const networkSteps = [];
  link.bridge.connectAp = async () => {
    networkSteps.push("system-wifi-dialog");
    return { ssid: AP_SSID };
  };

  await link.connect();

  assert.deepEqual(networkSteps, ["system-wifi-dialog"]);
  assert.deepEqual(await link.bridge.getStatus(), {
    connected: true,
    authenticated: true,
    mode: "ap",
    ssid: AP_SSID,
    host: "10.77.13.1",
    port: 8765,
  });
  assert.equal(apToken(PASSWORD, AP_SSID), AP_DERIVED_TOKEN);
  assert.deepEqual(link.writes.slice(0, 2), [`AUTH ${AP_DERIVED_TOKEN}`, "HELLO"]);
  assert.equal(link.transport.authenticated, true);
  assert.deepEqual(commands.slice(0, 3), ["HELLO", "PINS", "STATUS"]);
  assert.equal(controller.state.transport, "wifi");
  assert.equal(controller.state.link, "ready");
  assert.equal(controller.state.identity.auth, "OK");
  assert.equal(controller.state.identity.helloOk, true);
  assert.equal(controller.state.identity.pinsOk, true);
  assert.equal(controller.state.status.fields.DE, "LOW");
});

test("SoftAP without a WPA2 password fails before network, TCP, or ECU activity", async () => {
  const { controller, link } = makeIntegratedPeer();

  await assert.rejects(link.transport.connect({
    mode: "ap", ssid: AP_SSID, password: "", host: "10.77.13.1", port: 8765,
  }), /WPA2 password/);

  assert.equal(link.bridge.networkRequests, 0);
  assert.equal(link.bridge.tcpConnections, 0);
  assert.deepEqual(link.commands, []);
  assert.equal(controller.state.link, "disconnected");
});

test("SoftAP with a WPA2 password shorter than 8 characters fails closed", async () => {
  const { controller, link } = makeIntegratedPeer();

  await assert.rejects(link.transport.connect({
    mode: "ap", ssid: AP_SSID, password: "short", host: "10.77.13.1", port: 8765,
  }), /WPA2 password/);

  assert.equal(link.bridge.networkRequests, 0);
  assert.equal(link.bridge.tcpConnections, 0);
  assert.deepEqual(link.commands, []);
  assert.equal(controller.state.link, "disconnected");
});

test("STA without an explicit host IP never falls back to the SoftAP address", async () => {
  const { controller, link } = makeIntegratedPeer();

  await assert.rejects(link.transport.connect({
    mode: "sta", ssid: "shop-net", password: "router-password", host: "", port: 8765, token: TOKEN,
  }), /host is required in STA mode|explicit host IP/);

  assert.equal(link.bridge.host, "");
  assert.notEqual(link.bridge.host, "10.77.13.1");
  assert.equal(link.bridge.networkRequests, 0);
  assert.equal(link.bridge.tcpConnections, 0);
  assert.deepEqual(link.commands, []);
  assert.equal(controller.state.link, "disconnected");
});

test("native credential methods use normalized shapes and secrets stay out of browser storage and controller logs", async () => {
  const { controller, link } = makeIntegratedPeer();
  const storageWrites = [];
  const originalStorage = globalThis.localStorage;
  const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  const consoleOutput = [];
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem() { return null; },
      setItem(key, value) { storageWrites.push([key, value]); },
      removeItem(key) { storageWrites.push(["remove", key]); },
    },
  });
  for (const name of Object.keys(originalConsole)) console[name] = (...args) => consoleOutput.push(args.join(" "));

  try {
    const { WifiBridge } = await link.transport.loadPlugins();
    assert.deepEqual(await WifiBridge.hasToken(), { hasToken: true, configured: true });
    assert.deepEqual(await WifiBridge.hasPassword(), { hasPassword: false, configured: false });
    await link.transport.saveToken(TOKEN);
    assert.equal(await link.transport.hasToken(), true);
    await link.transport.savePassword(PASSWORD);
    assert.equal(await link.transport.hasPassword(), true);
    assert.deepEqual(await WifiBridge.hasPassword(), { hasPassword: true, configured: true });
    await link.connect();

    assert.deepEqual(await WifiBridge.getStatus(), {
      connected: true,
      authenticated: true,
      mode: "ap",
      ssid: AP_SSID,
      host: "10.77.13.1",
      port: 8765,
    });
    assert.deepEqual(storageWrites, []);
    assert.equal(consoleOutput.some(line => line.includes(TOKEN) || line.includes(PASSWORD)), false);
    assert.equal(JSON.stringify(controller.state.log).includes(TOKEN), false);
    assert.equal(JSON.stringify(controller.state.log).includes(PASSWORD), false);

    await link.transport.clearPassword();
    assert.deepEqual(await WifiBridge.hasPassword(), { hasPassword: false, configured: false });
    assert.deepEqual(link.bridge.credentialCalls, [
      ["saveToken", TOKEN],
      ["savePassword", PASSWORD],
      ["savePassword", PASSWORD],
      ["clearPassword"],
    ]);
  } finally {
    for (const [name, fn] of Object.entries(originalConsole)) console[name] = fn;
    if (originalStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalStorage });
  }
});

test("diagnostic bench, stored-code read, and live capture preserve Wi-Fi RAW recording provenance", async () => {
  const { controller, link, commands } = makeIntegratedPeer();
  await link.connect();

  assert.equal(controller.requestBench().ok, true);
  await link.drain();
  assert.equal(controller.state.bench.pass, true);
  assert.ok(commands.includes("TX2_BENCH"), "the diagnostic self-test was sent through the authenticated socket");

  const stored = await makeWifiRecording("0E", { operation: "stored-code-read" });
  controller.setArchive(stored);
  assert.equal(controller.requestVehicle("0E").ok, true);
  await link.drain();
  await controller.state.archive.finished;
  assert.ok(commands.includes("ARM_0E"));
  assert.ok(commands.includes("READ_0E"));
  assert.ok(controller.state.lastSession.codes.length > 0, "stored-code response was decoded from TCP evidence");

  const live = await makeWifiRecording("LIVE", { operation: "live-capture" });
  controller.setArchive(live);
  assert.equal(controller.requestVehicle("LIVE").ok, true);
  await link.drain();
  await controller.state.archive.finished;
  assert.ok(commands.includes("ARM_LIVE"));
  assert.ok(commands.includes("READ_LIVE"));
  assert.equal(controller.state.lastSession.verdict.end.reason, 16);

  for (const recording of [stored, live]) {
    const metadata = (await listRecordings()).find(item => item.id === recording.id);
    assert.equal(metadata.transport, "wifi");
    assert.equal(metadata.ended > 0, true);
    const raw = await recordingBlob(recording.id, "raw").then(blob => blob.text());
    assert.match(raw, /EVENT session=READ_CANDIDATE/);
    assert.match(raw, /END reason=16/);
  }
  const storedRaw = await recordingBlob(stored.id, "raw").then(blob => blob.text());
  assert.match(storedRaw, /RX t_us=\d+ byte=[0-9A-F]{2}/);
});

test("read-only discovery pass creates one Wi-Fi-provenance recording for each supported candidate", async () => {
  const { controller, link, commands } = makeIntegratedPeer();
  await link.connect();
  const archives = [];

  const result = await controller.startDiscoveryPass({
    createArchive: async (variant, candidate) => {
      const archive = await makeWifiRecording(variant, { discoveryCandidateId: candidate.id });
      archives.push({ archive, candidate });
      return archive;
    },
  });
  await Promise.all(archives.map(({ archive }) => archive.finished));

  assert.equal(result.pass.status, "complete");
  assert.ok(commands.includes("READ_0E"));
  assert.ok(commands.includes("READ_A4"));
  assert.equal(archives.length, result.pass.candidates.length);
  assert.deepEqual(archives.map(({ candidate }) => candidate.id), result.pass.candidates);
  for (const { archive } of archives) {
    const saved = (await listRecordings()).find(item => item.id === archive.id);
    assert.equal(saved.transport, "wifi");
    assert.equal(saved.ended > 0, true);
  }
});
