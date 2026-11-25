import assert from 'node:assert/strict';
import test from 'node:test';
import { createController } from '../js/controller.js';
import { EXPECTED_HELLO, EXPECTED_PINS } from '../js/protocol.js';

const SAFE_STATUS = 'STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=27';
const PROFILE_MISMATCH = 'Old Wi-Fi bridge profile no longer matches Settings. Connect to the selected bridge again.';

function connectedCapture() {
  let clock = 10_000;
  const writes = [];
  const archive = {
    id: 'bridge-profile-abort-test', variant: 'LIVE', lines: [], closed: false,
    line(value) { this.lines.push(String(value)); },
    sample() {},
    finish(verdict) { this.verdict = verdict; this.closed = true; return Promise.resolve(); },
  };
  const controller = createController({ now: () => clock, send: command => writes.push(command) });
  controller.onConnected('SME105 bridge', 'wifi');
  controller.handleLine('AUTH OK');
  controller.handleLine(EXPECTED_HELLO);
  controller.handleLine(EXPECTED_PINS);
  controller.handleLine(SAFE_STATUS);
  controller.setArchive(archive);
  assert.equal(controller.requestVehicle('LIVE').ok, true);
  controller.handleLine(SAFE_STATUS);
  controller.handleLine('EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1');
  controller.handleLine('EVENT session=READ_CANDIDATE epoch=9 boot_id=77 session_id=31');
  controller.handleLine('RX t_us=100 byte=AA seq=100');
  assert.ok(controller.state.op);
  return { controller, archive, writes, advance(n) { clock += n; } };
}

test('real controller immediately finalizes a revoked native profile as INCOMPLETE, not a 30-second fake reconnect', async () => {
  const h = connectedCapture();
  const { state } = h.controller;
  h.controller.onDisconnected();
  assert.equal(state.link, 'reconnecting');
  assert.ok(state.recoveryDeadline, 'before profile rejection the live session may legitimately resume');
  const previousWrites = h.writes.length;
  const previousRaw = h.archive.lines.filter(s => s.startsWith('RX ')).length;
  assert.equal(h.controller.abortUnrecoverableRecovery(PROFILE_MISMATCH), true);
  await h.archive.finished;
  assert.equal(state.link, 'disconnected');
  assert.equal(state.phase, 'idle');
  assert.equal(state.op, null);
  assert.equal(state.recoveryDeadline, null);
  assert.equal(state.resuming, false);
  assert.equal(state.identity.auth, '');
  assert.equal(state.trust, 'untrusted');
  assert.equal(h.archive.closed, true);
  assert.equal(h.archive.verdict.valid, false);
  assert.equal(h.archive.verdict.status, 'INCOMPLETE');
  assert.ok(h.archive.verdict.reasons.includes(PROFILE_MISMATCH));
  assert.equal(h.archive.verdict.end, null, 'never invent an ECU terminator');
  assert.ok(h.archive.lines.some(line => line === 'EVENT recovery_aborted reason=wifi_bridge_profile_mismatch'));
  assert.equal(h.archive.lines.filter(s => s.startsWith('RX ')).length, previousRaw, 'preserve raw original telemetry');
  assert.equal(h.archive.lines.some(line => line.startsWith('END ')), false);
  assert.equal(h.writes.length, previousWrites, 'no STOP, RESUME, ARM or ECU command sent on aborted native owner');
  h.advance(30_001);
  assert.equal(h.controller.tick(), false, 'do not later overwrite the original mismatch reason with generic timeout');
  assert.ok(h.controller.state.lastSession.verdict.reasons.includes(PROFILE_MISMATCH));
  assert.equal(h.controller.abortUnrecoverableRecovery('repeat'), false, 'idempotent terminal abort');
  assert.equal(h.writes.length, previousWrites);
});

test('an idle controller does not produce a fictional recording when rejecting an unrelated native profile', () => {
  const c = createController();
  assert.equal(c.abortUnrecoverableRecovery(PROFILE_MISMATCH), false);
  assert.equal(c.state.lastSession, null);
  assert.equal(c.state.op, null);
});
