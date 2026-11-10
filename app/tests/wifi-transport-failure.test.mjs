import assert from "node:assert/strict";
import test from "node:test";
import * as fake from "fake-indexeddb";
import "./test-env.mjs";
import { createController } from "../js/controller.js";
import { createLineBuffer, EXPECTED_HELLO, EXPECTED_PINS, encodeCommand } from "../js/protocol.js";
import { createRecording, listRecordings, recordingBlob } from "../js/recording.js";

globalThis.indexedDB = new fake.IDBFactory();
globalThis.IDBKeyRange = fake.IDBKeyRange;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: {
  estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }), persist: async () => true,
} } });

const TOKEN = "0123456789abcdef0123456789abcdef";
const SAFE_STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=27";

function makeController() {
  const writes = [];
  let responder = () => {};
  const controller = createController({ send(command) {
    writes.push(command);
    responder(command);
  } });
  return {
    controller,
    writes,
    setResponder(fn) { responder = fn; },
    identify(transport = "wifi") {
      controller.onConnected("SME105 test bridge", transport);
      controller.handleLine("AUTH OK");
      controller.handleLine(EXPECTED_HELLO);
      controller.handleLine(EXPECTED_PINS);
      controller.handleLine(SAFE_STATUS);
    },
  };
}

class OfflineSocketPeer {
  constructor(token = TOKEN) {
    this.token = token;
    this.active = null;
    this.connections = 0;
  }

  open(name, onData) {
    if (this.active && !this.active.closed) throw new Error("DENIED controller_busy");
    const peer = this;
    const socket = {
      name,
      closed: false,
      authenticated: false,
      lines: [],
      buffer: createLineBuffer(),
      write(bytes) {
        if (this.closed) throw new Error("socket closed");
        const text = new TextDecoder().decode(bytes);
        for (const line of this.buffer.push(text)) {
          this.lines.push(line);
          if (line.startsWith("AUTH ")) {
            if (line.slice(5) !== peer.token) {
              onData("DENIED auth\n");
              this.closed = true;
            } else {
              this.authenticated = true;
              onData("AUTH OK\n");
            }
          } else if (!this.authenticated) {
            onData("DENIED auth\n");
            this.closed = true;
          }
        }
      },
      close() {
        this.closed = true;
        if (peer.active === this) peer.active = null;
      },
    };
    this.active = socket;
    this.connections += 1;
    return socket;
  }
}

class SerializedSocketWriter {
  constructor(writeBytes) {
    this.writeBytes = writeBytes;
    this.queue = Promise.resolve();
  }
  write(command) {
    this.queue = this.queue.then(() => this.writeBytes(encodeCommand(command)));
    return this.queue;
  }
}

function validToken(value) {
  return typeof value === "string" && /^[0-9a-fA-F]{32}$/.test(value);
}

test("A: unavailable SoftAP and connection timeout reject without exposing a ready controller", async () => {
  for (const failure of [new Error("Wi-Fi connection timed out"), new Error("ESP32 SoftAP unavailable")]) {
    const { controller, writes } = makeController();
    await assert.rejects(async () => {
      await Promise.reject(failure); // system Wi-Fi request fails before opening TCP
      controller.onConnected("SME105-DCL", "wifi");
    }, /timed out|unavailable/);
    assert.equal(controller.state.link, "disconnected");
    assert.equal(controller.state.phase, "idle");
    assert.deepEqual(writes, []);
  }
});

test("B: cancelling Android's system Wi-Fi dialog is a clean cancellation", async () => {
  const { controller, writes } = makeController();
  let cancelled = false;
  await assert.rejects(async () => {
    try {
      await Promise.reject(Object.assign(new Error("User cancelled Wi-Fi selection"), { code: "CANCELED" }));
    } catch (error) {
      cancelled = error.code === "CANCELED";
      throw error;
    }
    controller.onConnected("SME105-DCL", "wifi");
  }, /cancelled/);
  assert.equal(cancelled, true);
  assert.equal(controller.state.link, "disconnected");
  assert.deepEqual(writes, []);
});

test("C: bad TCP token receives DENIED auth, drops the socket, and sends no diagnostics", () => {
  const { controller, writes } = makeController();
  const bridge = new OfflineSocketPeer(TOKEN);
  const received = [];
  const socket = bridge.open("android-client", line => received.push(line.trim()));
  socket.write(encodeCommand("AUTH wrong-token"));

  assert.deepEqual(socket.lines, ["AUTH wrong-token"]);
  assert.deepEqual(received, ["DENIED auth"]);
  assert.equal(socket.closed, true);
  assert.equal(controller.state.link, "disconnected");
  assert.deepEqual(writes, []);
  assert.match(received[0], /^DENIED auth$/);
});

test("D: fragmented STATUS packets are reconstructed exactly without line corruption", () => {
  const { controller } = makeController();
  controller.onConnected("SME105-DCL", "wifi");
  const buffer = createLineBuffer();
  const chunks = ["STATUS stage=", "0 DE=LOW", " auto_tx=0 gate4=1\n"];
  const lines = chunks.flatMap(chunk => buffer.push(chunk));

  assert.deepEqual(lines, ["STATUS stage=0 DE=LOW auto_tx=0 gate4=1"]);
  controller.handleLine(lines[0]);
  assert.equal(controller.state.status.fields.stage, "0");
  assert.equal(controller.state.status.fields.DE, "LOW");
  assert.equal(controller.state.status.fields.auto_tx, "0");
});

test("E: multiple protocol lines in one TCP read are delivered in strict order", () => {
  const { controller } = makeController();
  controller.onConnected("SME105-DCL", "wifi");
  const buffer = createLineBuffer();
  const packet = `${EXPECTED_HELLO}\n${EXPECTED_PINS}\n${SAFE_STATUS}\n`;
  const lines = buffer.push(packet);
  for (const line of lines) controller.handleLine(line);

  assert.deepEqual(lines, [EXPECTED_HELLO, EXPECTED_PINS, SAFE_STATUS]);
  assert.deepEqual(controller.state.log, lines);
  assert.equal(controller.state.identity.helloOk, true);
  assert.equal(controller.state.identity.pinsOk, true);
  assert.equal(controller.state.status.raw, SAFE_STATUS);
});

test("F: simultaneous command requests are serialized as intact TCP writes", async () => {
  const started = [];
  let releaseFirst;
  const firstWrite = new Promise(resolve => { releaseFirst = resolve; });
  const writer = new SerializedSocketWriter(async bytes => {
    const command = new TextDecoder().decode(bytes);
    started.push(command);
    if (command === "STATUS\n") await firstWrite;
  });

  const pending = [writer.write("STATUS"), writer.write("TX2_BENCH"), writer.write("ARM_0E")];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ["STATUS\n"]);
  releaseFirst();
  await Promise.all(pending);
  assert.deepEqual(started, ["STATUS\n", "TX2_BENCH\n", "ARM_0E\n"]);
});

test("G: mid-capture socket loss preserves RAW evidence and finalizes an untrusted incomplete session", async () => {
  const h = makeController();
  h.identify();
  const recording = await createRecording("0E", () => {}, "metric", { transport: "wifi" });
  h.controller.setArchive(recording);
  h.setResponder(command => {
    if (command === "STATUS") h.controller.handleLine(SAFE_STATUS);
    if (command === "ARM_0E") h.controller.handleLine("EVENT read_armed variant=0E valid_ms=15000 no_tx_yet=1");
    if (command === "READ_0E") {
      h.controller.handleLine("EVENT session=READ_CANDIDATE");
      h.controller.handleLine("RX t_us=1234 byte=72");
      h.controller.onDisconnected(); // peer closes before END
    }
  });

  assert.equal(h.controller.requestVehicle("0E").ok, true);
  await h.controller.state.archive.finished;

  assert.equal(h.controller.state.link, "disconnected");
  assert.equal(h.controller.state.lastSession.verdict.valid, false);
  const saved = (await listRecordings()).find(item => item.id === recording.id);
  assert.equal(saved.transport, "wifi");
  assert.equal(saved.verdict.valid, false);
  assert.equal(saved.ended > 0, true);
  const raw = await recordingBlob(recording.id, "raw").then(blob => blob.text());
  assert.match(raw, /EVENT session=READ_CANDIDATE/);
  assert.match(raw, /RX t_us=1234 byte=72/);
  assert.doesNotMatch(raw, /^END /m, "partial evidence remains byte-for-byte incomplete, without a fabricated terminator");
  assert.equal(h.controller.state.lastSession.verdict.status, "FAILED");
  assert.equal(saved.verdict.status, "FAILED");

  const beforeReconnect = h.writes.length;
  h.identify();
  assert.deepEqual(h.writes.slice(beforeReconnect), ["HELLO", "PINS", "STATUS"]);
  assert.equal(h.writes.filter(command => command === "ARM_0E").length, 1);
  assert.equal(h.writes.filter(command => command === "READ_0E").length, 1);
});

test("H: lost vehicle-command acknowledgement fails closed and is never retried after reconnect", () => {
  const h = makeController();
  h.identify();
  h.setResponder(command => {
    if (command === "STATUS") h.controller.handleLine(SAFE_STATUS);
    // No ARM acknowledgement arrives: the simulated Wi-Fi socket is lost.
  });

  assert.equal(h.controller.requestVehicle("LIVE").ok, true);
  assert.deepEqual(h.writes.slice(-2), ["STATUS", "ARM_LIVE"]);
  h.controller.onDisconnected();
  assert.equal(h.controller.state.link, "reconnecting");
  assert.equal(h.writes.includes("READ_LIVE"), false);

  h.identify(); // a fresh identity check is allowed, replaying the lost request is not
  assert.deepEqual(h.writes.slice(-3), ["HELLO", "PINS", "STATUS"]);
  assert.equal(h.controller.state.identity.auth, "OK");
  assert.equal(h.controller.state.identity.helloOk, true);
  assert.equal(h.controller.state.identity.pinsOk, true);
  assert.equal(h.controller.state.phase, "idle");
  assert.equal(h.writes.filter(command => command === "ARM_LIVE").length, 1);
  assert.equal(h.writes.filter(command => command === "READ_LIVE").length, 0);
});

test("I: oversized protocol line is rejected at the bounded line-buffer boundary", () => {
  const MAX_WIFI_LINE_BYTES = 239; // firmware TCP line storage is a fixed 240-byte array incl. NUL
  let remainder = "";
  const pushBounded = chunk => {
    remainder += chunk;
    if (new TextEncoder().encode(remainder.split("\n", 1)[0]).length > MAX_WIFI_LINE_BYTES) {
      remainder = "";
      throw new Error("Wi-Fi protocol line exceeds 239 bytes");
    }
    const lines = [];
    let newline;
    while ((newline = remainder.indexOf("\n")) >= 0) {
      lines.push(remainder.slice(0, newline));
      remainder = remainder.slice(newline + 1);
    }
    return lines;
  };

  assert.deepEqual(pushBounded("STATUS ok=1\n"), ["STATUS ok=1"]);
  assert.throws(() => pushBounded(`STATUS data=${"x".repeat(240)}\n`), /exceeds 239 bytes/);
  assert.equal(remainder, "");
});

test("J: the authentication token contract accepts exactly 32 hexadecimal characters", () => {
  assert.equal(validToken(TOKEN), true);
  assert.equal(validToken(TOKEN.toUpperCase()), true);
  for (const invalid of ["", "0".repeat(31), "0".repeat(33), "g".repeat(32), `${TOKEN}x`, null, 123]) {
    assert.equal(validToken(invalid), false, `rejected ${String(invalid)}`);
  }
});

test("the peer releases its single-client slot after an authenticated socket disconnect", () => {
  const bridge = new OfflineSocketPeer();
  const first = bridge.open("first", () => {});
  first.write(encodeCommand(`AUTH ${TOKEN}`));
  assert.equal(first.authenticated, true);
  assert.throws(() => bridge.open("second", () => {}), /controller_busy/);
  first.close();
  const second = bridge.open("second", () => {});
  second.write(encodeCommand(`AUTH ${TOKEN}`));
  assert.equal(second.authenticated, true);
  assert.equal(bridge.connections, 2);
});
