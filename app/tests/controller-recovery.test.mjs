import assert from "node:assert/strict";
import test from "node:test";
import { createController } from "../js/controller.js";
import { EXPECTED_HELLO, EXPECTED_PINS, parseLine } from "../js/protocol.js";

const SAFE_STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=27";

function harness() {
  let clock = 10_000;
  const writes = [];
  const archive = {
    id: "recovery-recording",
    variant: "LIVE",
    lines: [],
    gaps: [],
    closed: false,
    line(line) { this.lines.push(String(line)); },
    sample() {},
    recordGap(lost, from, to) { this.gaps.push({ lost, from, to }); },
    finish(verdict) { this.closed = true; this.verdict = verdict; return Promise.resolve(); },
  };
  const controller = createController({ now: () => clock, send: command => writes.push(command) });
  controller.onConnected("SME105 test bridge", "wifi");
  controller.handleLine("AUTH OK");
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine(SAFE_STATUS);
  controller.setArchive(archive);
  assert.equal(controller.requestVehicle("LIVE").ok, true);
  controller.handleLine(SAFE_STATUS);
  controller.handleLine("EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1");
  controller.handleLine("EVENT session=READ_CANDIDATE epoch=9 boot_id=77 session_id=31");
  controller.handleLine("RX t_us=100 byte=AA seq=100");
  return {
    controller, writes, archive,
    advance(milliseconds) { clock += milliseconds; },
  };
}

test("identical active connection reattaches without commands or state replacement", () => {
  const h = harness();
  const { state } = h.controller;
  const before = {
    archive: state.archive,
    cart: state.cart,
    status: state.status,
    lastSession: state.lastSession = { marker: "previous" },
    combined: state.combined = { active: true, marker: "survey" },
    op: state.op,
  };
  const commandCount = h.writes.length;

  assert.deepEqual(h.controller.onConnected("SME105 test bridge", "wifi"), { reattached: true });

  assert.equal(h.writes.length, commandCount);
  for (const key of Object.keys(before)) assert.equal(state[key], before[key], `${key} reference was preserved`);
});

test("live recovery sends RESUME, records bridge gaps and continues the existing decoder", () => {
  const h = harness();
  const { state } = h.controller;
  const archive = state.archive;
  const cart = state.cart;
  const status = state.status;
  const previousSession = state.lastSession = { marker: "prior result" };
  const combined = state.combined = { active: true, marker: "survey" };
  const readCount = state.op.session.rx;

  h.controller.onDisconnected();
  assert.equal(state.link, "reconnecting");
  assert.ok(state.recoveryDeadline);
  assert.equal(state.op.session.rx, readCount);
  assert.equal(state.archive, archive);
  assert.equal(state.cart, cart);
  assert.equal(state.status, status);
  assert.equal(state.lastSession, previousSession);
  assert.equal(state.combined, combined);

  const beforeReconnect = h.writes.length;
  assert.deepEqual(h.controller.onConnected("SME105 test bridge", "wifi"), { resumed: true });
  assert.deepEqual(h.writes.slice(beforeReconnect), ["RESUME 77 31 100"]);
  h.controller.handleLine("EVENT telemetry_gap lost=9 from=101 to=109");
  h.controller.handleLine("RESUME OK boot_id=77 session_id=31 gap=9 from=101 to=109");
  assert.deepEqual(h.archive.gaps, [{ lost: 9, from: 101, to: 109 }]);
  assert.equal(state.op.session.sequenceGaps.length, 1, "matching EVENT and RESUME gap reports are recorded once");
  assert.deepEqual(state.op.session.sequenceGaps[0], { lost: 9, from: 101, to: 109, source: "telemetry_gap" });
  assert.equal(state.op.session.lastSeq, 109);

  h.controller.handleLine("EVENT session=READ_CANDIDATE epoch=9 boot_id=77 session_id=31");
  h.controller.handleLine("RX t_us=110 byte=AB seq=100");
  h.controller.handleLine("RXB t_us=120 seq_start=108 data=ACADAEAF dt=0,10,20,30");
  assert.equal(state.op.session.problems.includes("duplicate session start"), false);
  assert.equal(state.op.session.rx, readCount + 2, "batch duplicates were skipped and replay sequence 110 was ingested");
  assert.equal(state.op.session.lastSeq, 111);
  assert.equal(state.archive, archive);
  assert.equal(state.cart, cart);
  assert.equal(state.status, status);
  assert.equal(state.lastSession, previousSession);
  assert.equal(state.combined, combined);
  assert.equal(state.phase, "read");
  assert.equal(state.link, "ready");
});

test("native reconnect notification resumes an active session even without a prior disconnect callback", () => {
  const h = harness();
  const before = h.writes.length;

  assert.deepEqual(h.controller.onConnected("SME105 test bridge", "wifi", { reconnected: true }), { resumed: true });

  assert.deepEqual(h.writes.slice(before), ["RESUME 77 31 100"]);
  assert.equal(h.controller.state.archive, h.archive);
  assert.equal(h.controller.state.phase, "read");
});

test("zero-valued RESUME gap fields do not create a gap", () => {
  const h = harness();
  h.controller.onDisconnected();
  h.controller.onConnected("SME105 test bridge", "wifi");
  h.controller.handleLine("RESUME OK boot_id=77 session_id=31 gap=0 from=0 to=0");

  assert.deepEqual(h.archive.gaps, []);
  assert.deepEqual(h.controller.state.op.session.sequenceGaps, []);
  assert.equal(h.controller.state.op.session.lastSeq, 100);
});

test("denied resume finalizes the recording incomplete without an invented END", async () => {
  const h = harness();
  h.controller.onDisconnected();
  h.controller.onConnected("SME105 test bridge", "wifi");
  h.controller.handleLine("RESUME DENIED reason=session_expired");
  await h.controller.state.archive.finished;

  const { state } = h.controller;
  assert.equal(state.phase, "idle");
  assert.equal(state.lastSession.verdict.valid, false);
  assert.equal(state.lastSession.verdict.status, "INCOMPLETE");
  assert.equal(state.lastSession.verdict.end, null);
  assert.match(state.lastSession.verdict.reasons.join(" "), /Wi-Fi session expired or bridge reset/);
  assert.equal(h.archive.lines.some(line => line.startsWith("END ")), false);
});

test("recovery deadline finalizes incomplete with raw evidence and leaves no fabricated terminator", async () => {
  const h = harness();
  h.controller.onDisconnected();
  h.advance(29_999);
  assert.equal(h.controller.tick(), false);
  assert.equal(h.controller.state.link, "reconnecting");
  h.advance(1);
  assert.equal(h.controller.tick(), true);
  await h.controller.state.archive.finished;

  assert.equal(h.controller.state.link, "disconnected");
  assert.equal(h.controller.state.lastSession.verdict.status, "INCOMPLETE");
  assert.equal(h.controller.state.lastSession.verdict.end, null);
  assert.match(h.controller.state.lastSession.verdict.reasons.join(" "), /Wi-Fi session expired or bridge reset/);
  assert.ok(h.archive.lines.some(line => line.includes("recovery_timeout")));
  assert.equal(h.archive.lines.some(line => line.startsWith("END ")), false);
});

test("a silent RESUME response also expires as incomplete after the recovery window", async () => {
  const h = harness();
  h.controller.onDisconnected();
  h.controller.onConnected("SME105 test bridge", "wifi");
  h.advance(30_000);

  assert.equal(h.controller.tick(), true);
  await h.controller.state.archive.finished;
  assert.equal(h.controller.state.lastSession.verdict.status, "INCOMPLETE");
  assert.equal(h.controller.state.lastSession.verdict.end, null);
  assert.equal(h.controller.state.link, "disconnected");
  assert.equal(h.archive.lines.some(line => line.startsWith("END ")), false);
});

test("idle reconnect uses the standard HELLO, PINS and STATUS exchange", () => {
  const writes = [];
  const controller = createController({ send: command => writes.push(command) });
  controller.onConnected("bridge", "wifi");
  controller.handleLine("AUTH OK");
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine(SAFE_STATUS);
  controller.onDisconnected();
  const before = writes.length;

  controller.onConnected("bridge", "wifi");

  assert.deepEqual(writes.slice(before), ["HELLO"]);
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  assert.equal(writes.at(-1), "STATUS");
});

test("operator stop during reconnect aborts retained session and sends STOP on recovery", () => {
  const h = harness();
  h.controller.onDisconnected();
  assert.equal(h.controller.state.link, "reconnecting");
  h.controller.requestStop();
  assert.equal(h.controller.state.op.operatorStop, true);
  h.controller.state.op.operatorStop = false;

  const before = h.writes.length;
  assert.deepEqual(h.controller.onConnected("SME105 test bridge", "wifi", { reconnected: true }), { stopped: true });
  assert.deepEqual(h.writes.slice(before), ["STOP"]);
  assert.equal(h.controller.state.phase, "stopping");
  assert.equal(h.controller.state.resuming, false);
  assert.equal(h.controller.state.recoveryDeadline, null);
});

test("RXB parses sequence starts before or after its payload metadata", () => {
  const leading = parseLine("RXB t_us=10 seq_start=700 data=AABB dt=0,5");
  const trailing = parseLine("RXB t_us=10 data=AABB dt=0,5 seq_start=800");

  assert.deepEqual(leading.events.map(event => event.seq), [700, 701]);
  assert.deepEqual(trailing.events.map(event => event.seq), [800, 801]);
  assert.deepEqual(parseLine("RXB t_us=10 data=AABB dt=0,5").events.map(event => event.seq), [null, null]);
});
