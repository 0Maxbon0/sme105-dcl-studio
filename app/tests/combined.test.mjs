import assert from "node:assert/strict";
import test from "node:test";
import { createController } from "../js/controller.js";
import { COMBINED_LIMIT_MS, GROUP_WINDOW_MS } from "../js/combined.js";
import { ALL_LIVE_PIDS, rowsToCsv } from "../js/pids.js";
import { EXPECTED_HELLO, EXPECTED_PINS, TIMEOUTS } from "../js/protocol.js";

const STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 fault=15";

function harness() {
  let now = 1000;
  const sent = [];
  const c = createController({ now: () => now, send: command => sent.push(command) });
  c.onConnected("test");
  c.handleLine(EXPECTED_HELLO);
  c.handleLine(EXPECTED_PINS);
  c.handleLine(STATUS);
  return { c, sent, advance: ms => { now += ms; } };
}

function begin(h, group) {
  h.c.handleLine(STATUS);
  assert.equal(h.sent.at(-1), `ARM_${group}`);
  h.c.handleLine(`EVENT read_armed variant=${group} valid_ms=15000 no_tx_yet=1`);
  assert.equal(h.sent.at(-1), `READ_${group}`);
  h.c.handleLine("EVENT session=READ_CANDIDATE");
}

// Independently encode two 16-frame mode-21 blocks plus a boundary.
// Slot 2 carries mode/status; slot 3 carries a parity-valid raw value.
function samples(h) {
  const pair = raw => [raw & 255, (((raw & 15) ^ ((raw >> 4) & 15) ^ ((raw >> 8) & 15) ^ 10) << 4) | (raw >> 8)];
  const lines = [];
  const add = (t, pair) => pair.forEach((byte, i) => lines.push(`RX t_us=${t + i * 1042} byte=${byte.toString(16).padStart(2, "0").toUpperCase()}`));
  for (let frame = 0; frame < 33; frame += 1) {
    const t = 100000 + frame * 22500;
    const id = frame % 16;
    add(t, [0, 0]);
    add(t + 2500, [0, ((id ^ 10) << 4) | id]);
    add(t + 5000, pair(id === 4 ? 0x21 : 0));
    add(t + 7500, pair(64));
  }
  for (const line of lines) h.c.handleLine(line);
  return lines.length;
}

function end(h, count, { lost = 0, map = 15 } = {}) {
  for (const [slot, word] of ["01B0", "FF5F", "21F6", "00A0"].entries()) h.c.handleLine(`TX_PAD slot=${slot} expected=${word} observed=${word} match=1`);
  h.c.handleLine(`EVENT live_pid_map set=1 sent=${map} verified=${map}`);
  h.c.handleLine(`END reason=15 ro_bytes=${count} ro_lost=${lost} uart_errors=0 pad_verified=4 words_started=4 DE=LOW`);
}

function rotate(h, count, options) {
  h.advance(GROUP_WINDOW_MS);
  h.c.tick();
  assert.equal(h.sent.at(-1), "STOP");
  h.c.handleLine("EVENT stop=accepted DE=LOW");
  assert.equal(h.c.state.phase, "stopping", "wait for drained data and END");
  end(h, count, options);
}

test("one start cycles all three groups, merges all 39 channels and exports provenance", () => {
  const h = harness();
  assert.equal(h.c.requestSurvey().ok, true);
  for (const group of ["LIVE", "LIVE2", "LIVE3"]) {
    begin(h, group);
    const count = samples(h);
    rotate(h, count);
    assert.equal(h.c.state.combined.active, true);
    assert.equal(h.c.state.phase, "idle");
    h.c.tick();
  }
  const record = h.c.state.combined;
  assert.equal(ALL_LIVE_PIDS.length - 1, 39);
  assert.equal(Object.keys(record.pids).length, 39);
  assert.equal(record.segments.length, 3);
  assert.ok(record.rows.every(row => row.validity === "valid"));
  assert.ok(record.rows.find(row => row.segment === 2).t >= 5);
  assert.ok(record.rows.find(row => row.segment === 3).t >= 10);
  assert.equal(h.sent.at(-1), "STATUS", "recheck status before the next read");
  const csv = rowsToCsv(record.rows);
  assert.match(csv, /segment,group,segment_t_s,sample_status,time_basis/);
  assert.match(csv, /,LIVE2,/);
  assert.match(csv, /,LIVE3,/);
  assert.match(csv, /host-arrival-aligned/);
  assert.equal(csv.trim().split("\n").length, record.rows.length + 1);
});

test("Stop cancels pending rotation; another command cannot race between groups", () => {
  const h = harness();
  h.c.requestSurvey(); begin(h, "LIVE");
  rotate(h, samples(h));
  assert.equal(h.c.requestVehicle("CLR").ok, false);
  assert.equal(h.c.requestBench().ok, false);
  assert.equal(h.c.requestReboot().ok, false);
  h.c.requestStop();
  const count = h.sent.length;
  h.advance(20000); h.c.tick();
  assert.equal(h.sent.length, count);
  assert.equal(h.c.state.combined.active, false);
  assert.ok(h.c.state.combined.rows.length > 0);
});

test("incomplete data or map evidence stops the recording without a retry", () => {
  for (const failure of [{ lost: 1 }, { map: 14 }]) {
    const h = harness();
    h.c.requestSurvey(); begin(h, "LIVE");
    rotate(h, samples(h), failure);
    assert.equal(h.c.state.combined.active, false);
    assert.equal(h.c.state.combined.failed, true);
    assert.equal(h.c.state.trust, "untrusted");
    assert.ok(h.c.state.combined.rows.every(row => row.validity === "untrusted"));
    const count = h.sent.length;
    h.advance(20000); h.c.tick();
    assert.equal(h.sent.length, count);
  }
});

test("disconnect, denial, missing END and overall duration limit cannot continue cycling", () => {
  for (const failure of ["disconnect", "denied", "missing-end", "duration"]) {
    const h = harness();
    h.c.requestSurvey(); begin(h, "LIVE"); samples(h);
    if (failure === "disconnect") h.c.onDisconnected();
    if (failure === "denied") h.c.handleLine("DENIED test");
    if (failure === "missing-end") {
      h.advance(GROUP_WINDOW_MS); h.c.tick();
      h.c.handleLine("EVENT stop=accepted DE=LOW");
      h.advance(TIMEOUTS.stop + 1); h.c.tick();
    }
    if (failure === "duration") {
      h.advance(COMBINED_LIMIT_MS); h.c.tick();
    }
    assert.equal(h.c.state.combined.active, false, failure);
    const count = h.sent.length;
    h.c.tick();
    assert.equal(h.sent.length, count, failure);
  }
});
