import test from 'node:test';
import assert from 'node:assert/strict';
import * as fake from 'fake-indexeddb';
import { createController } from '../js/controller.js';
import { EXPECTED_HELLO, EXPECTED_PINS, TIMEOUTS } from '../js/protocol.js';
import { createRecording, listRecordings, recordingBlob } from '../js/recording.js';
import { startDiagnosticRun, diagnosticHistory, recordDiagnosticEvent, recordDiagnosticWarning, flushDiagnosticQueue } from '../js/diagnostics.js';
import { sessionWarning } from '../js/session-outcome.js';
import { reconcileOutcome } from '../js/session-history.js';
import { createIgnitionReview } from '../js/ignition-review.js';

globalThis.indexedDB = new fake.IDBFactory();
globalThis.IDBKeyRange = fake.IDBKeyRange;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }) } } });
const status = (extra = '') => `STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 fault=0 live_all=1 out_overflow=0 transport_lost=0 usb_skipped=0 fw=27 pad_evidence=2 ${extra}`;
function harness() {
  let now = 1000;
  const sent = [];
  const c = createController({ now: () => now, send: cmd => sent.push(cmd) });
  c.onConnected('offline', 'ble'); c.handleLine('AUTH OK transport=BLE'); c.handleLine(EXPECTED_HELLO); c.handleLine(EXPECTED_PINS); c.handleLine(status());
  return { c, sent, advance(ms) { now += ms; } };
}
function begin(h, variant) {
  assert.equal(h.c.requestVehicle(variant).ok, true);
  h.c.handleLine(status());
  h.c.handleLine(`EVENT read_armed variant=${variant} valid_ms=15000 no_tx_yet=1`);
  h.c.handleLine('EVENT session=READ_CANDIDATE epoch=5 boot_id=77');
}
function samples(c) {
  let count = 0;
  const pair = raw => [raw & 255, (((raw & 15) ^ ((raw >> 4) & 15) ^ ((raw >> 8) & 15) ^ 10) << 4) | (raw >> 8)];
  const add = (t, bytes) => bytes.forEach((b, i) => { c.handleLine(`RX t_us=${t + i * 1042} byte=${b.toString(16).padStart(2, '0').toUpperCase()}`); count++; });
  for (let frame = 0; frame < (c.state.op.variant === 'ALL' ? 65 : 33); frame++) {
    const t = 100000 + frame * 22500, id = frame % 16;
    add(t, [0, 0]); add(t + 2500, [0, ((id ^ 10) << 4) | id]); add(t + 5000, pair(id === 4 ? (c.state.op.variant === 'ALL' && frame >= 16 && frame < 32 ? 0x41 : 0x21) : 0)); add(t + 7500, pair(64));
  }
  return count;
}
function end(c, count, { reason = 19, boot = 77, lost = 0 } = {}) {
  for (const [slot, word] of ['01B0', 'FF5F', '4196', '00A0'].entries()) c.handleLine(`TX_PAD slot=${slot} expected=${word} observed=${word} tx_us=${1000 + slot * 3000} done_us=${3000 + slot * 3000} match=1 evidence=2 epoch=5 boot_id=77 tx_seq=${slot + 1} block=0 complete=1`);
  c.handleLine(`END reason=${reason} ro_bytes=${count} ro_lost=${lost} uart_errors=0 evidence=2 epoch=5 boot_id=${boot} witness_started=20 witness_verified=20 pad_verified=4 words_started=4 DE=LOW`);
}
function nodes() {
  const values = new Map();
  return { getElementById(id) { if (!values.has(id)) values.set(id, { hidden: true, disabled: false, addEventListener(type, fn) { this[type] = fn; } }); return values.get(id); } };
}

test('all LIVE variants persist pending, restore review after restart, resolve Yes/No once and preserve raw integrity', async () => {
  await startDiagnosticRun();
  for (const variant of ['LIVE', 'LIVE2', 'LIVE3', 'ALL']) {
    for (const answer of ['yes', 'no']) {
      const h = harness();
      const rec = await createRecording(variant);
      h.c.setArchive(rec); begin(h, variant);
      const count = samples(h.c);
      h.c.handleLine('FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW');
      h.c.requestStop(); // automatic fault STOP must not become an operator Stop
      h.c.handleLine('FAULT reason=19 cause=RX_SILENCE no_auto_retry=1 DE=LOW');
      end(h.c, count);
      const session = h.c.state.lastSession;
      assert.equal(session.outcome, 'OPERATOR_CONFIRMATION_PENDING', JSON.stringify({ variant, verdict:session.verdict, totalRows:session.totalRows, parity:session.parityRejects }));
      assert.equal(session.verdict.valid, false);
      assert.equal(sessionWarning(session), null);
      assert.equal(h.sent.filter(cmd => cmd === 'STOP').length, 1);
      const finished = rec.finished;
      h.c.handleLine('END reason=19'); h.c.handleLine('FAULT reason=19 cause=RX_SILENCE');
      assert.equal(h.c.state.lastSession, session);
      assert.equal(rec.finished, finished);
      await finished;
      const original = await (await recordingBlob(rec.id, 'raw')).text();
      const verdict = structuredClone(session.verdict);
      await recordDiagnosticEvent('SESSION_RESULT', { ...session, pids: {}, rows: [] }, 'session');
      await flushDiagnosticQueue();
      const doc = nodes();
      let review = createIgnitionReview({ controller: h.c, document: doc, render() {}, refreshWarnings: async () => {} });
      review.wire(); await review.refresh(true);
      assert.equal(doc.getElementById('ignition-confirmation').hidden, false);
      await doc.getElementById('ignition-later').click();
      assert.equal(doc.getElementById('ignition-confirmation').hidden, true);
      assert.equal((await listRecordings()).find(x => x.id === rec.id).outcome, 'OPERATOR_CONFIRMATION_PENDING');
      // New app run and new UI instance use the persisted recording, not the old controller.
      await startDiagnosticRun();
      const restarted = { state: {} };
      review = createIgnitionReview({ controller: restarted, document: doc, render() {}, refreshWarnings: async () => {} });
      review.wire(); await review.refresh(true);
      await Promise.all([doc.getElementById(`ignition-${answer}`).click(), doc.getElementById(`ignition-${answer}`).click()]);
      const item = (await listRecordings()).find(x => x.id === rec.id);
      assert.equal(item.outcome, answer === 'yes' ? 'USER_CONFIRMED_IGNITION_OFF' : 'UNEXPECTED_ECU_SILENCE');
      assert.equal(item.operatorConfirmation.answer, answer);
      assert.ok(item.operatorConfirmation.confirmedAt);
      assert.deepEqual(item.verdict, verdict);
      assert.equal(await (await recordingBlob(rec.id, 'raw')).text(), original);
      await reconcileOutcome(item); // repeat startup reconciliation is idempotent
      const events = await diagnosticHistory();
      assert.equal(events.filter(e => e.type === 'SESSION_OUTCOME_RESOLVED' && e.detail.recordingId === rec.id).length, 1);
      assert.equal(events.find(e => e.type === 'SESSION_RESULT' && e.detail.recordingId === rec.id).detail.outcome, 'OPERATOR_CONFIRMATION_PENDING');
      const warning = (await diagnosticHistory('warnings')).find(w => w.key === `session-${variant}-${session.completedAt}` && w.active);
      assert.equal(!!warning, answer === 'no');
      if (warning) await recordDiagnosticWarning(warning.key, false, {});
    }
  }
});

test('manual Stop, link loss, corrupt provenance and transport faults do not ask ignition question', () => {
  for (const cause of ['manual', 'link', 'foreign', 'lost', 'pad', 'backpressure']) {
    const h = harness(); begin(h, 'LIVE'); const count = samples(h.c);
    if (cause === 'manual') h.c.requestStop();
    if (cause === 'link') { h.c.onDisconnected(); assert.equal(h.c.state.lastSession.outcome, undefined); continue; }
    h.c.handleLine(cause === 'pad' ? 'FAULT reason=11 cause=PAD_MISMATCH DE=LOW' : cause === 'backpressure' ? 'FAULT reason=17 cause=TRANSPORT_BACKPRESSURE DE=LOW' : 'FAULT reason=19 cause=RX_SILENCE DE=LOW');
    end(h.c, count, { boot: cause === 'foreign' ? 78 : 77, lost: cause === 'lost' ? 1 : 0 });
    assert.notEqual(h.c.state.lastSession.outcome, 'OPERATOR_CONFIRMATION_PENDING', cause);
  }
});

test('read lock is current, safe, authenticated and never issues ARM or a retry', () => {
  for (const variant of ['LIVE', 'LIVE2', 'LIVE3', 'ALL', 'KOEO']) {
    const h = harness(); h.c.requestVehicle(variant);
    h.c.handleLine(status().replace('read_used=0', 'read_used=1').replace('fault=0', 'fault=19'));
    assert.equal(h.c.state.lastSession.verdict.status, 'BRIDGE_READ_ALREADY_USED');
    assert.match(h.c.state.lastSession.bridgeStatus.raw, /read_used=1/);
    h.advance(100000); h.c.tick();
    assert.equal(h.sent.some(cmd => /^(ARM_|READ_|REBOOT|RESET)/.test(cmd)), false);
  }
  for (const edit of [s => s.replace('stage=0', 'stage=2'), s => s.replace('transport_lost=0', 'transport_lost=1'), s => s.replace('DE=LOW', 'DE=HIGH'), s => s.replace('out_overflow=0', 'out_overflow=1'), s => s.replace('fault=0', 'fault=11')]) {
    const h = harness(); h.c.requestVehicle('LIVE'); h.c.handleLine(edit(status().replace('read_used=0', 'read_used=1')));
    assert.notEqual(h.c.state.lastSession.verdict.status, 'BRIDGE_READ_ALREADY_USED');
    assert.equal(h.sent.some(cmd => cmd.startsWith('ARM_')), false);
  }
  for (const stale of [false, true]) {
    const h = harness(); h.c.requestVehicle('LIVE'); h.c.handleLine(status());
    h.c.handleLine(status().replace('read_used=0', 'read_used=1'));
    if (stale) h.advance(TIMEOUTS.status + 1);
    h.c.handleLine('DENIED read_used_or_busy');
    assert.equal(h.c.state.lastSession.verdict.status, stale ? 'INCOMPLETE' : 'BRIDGE_READ_ALREADY_USED');
    assert.equal(h.c.state.lastSession.denial, 'DENIED read_used_or_busy');
  }
  const h = harness(); h.c.onDisconnected(); h.c.onConnected('new'); h.c.handleLine(EXPECTED_HELLO); h.c.handleLine(EXPECTED_PINS); h.c.handleLine(status());
  assert.match(h.c.requestVehicle('LIVE').error, /authentication/);
});

test('every live Start failure reason preserves evidence and sends no automatic retry', () => {
  for (const variant of ['LIVE', 'LIVE2', 'LIVE3', 'ALL']) for (const reason of [3, 4, 19]) {
    const h = harness(); begin(h, variant);
    h.c.handleLine('EVENT ack=candidate_11_echo_plus_01 source=UNVERIFIED');
    h.c.handleLine(`FAULT reason=${reason} cause=${reason === 19 ? 'RX_SILENCE' : 'HSK_ACK'} DE=LOW`);
    h.c.handleLine(`END reason=${reason} ro_bytes=93380 ro_lost=0 uart_errors=0 DE=LOW`);
    const result = h.c.state.lastSession;
    assert.equal(result.outcome, 'NOT_STARTED_ECU_NO_RESPONSE');
    assert.match(result.verdict.reasons.join(' '), /RX lines 0 != ro_bytes 93380/);
    assert.match(h.c.state.message, /ignition may be off/);
    h.advance(100000); h.c.tick();
    assert.equal(h.sent.filter(cmd => cmd === `READ_${variant}`).length, 1);
    assert.equal(h.sent.filter(cmd => cmd === `ARM_${variant}`).length, 1);
  }
});

test('confirmed ignition off resolves a raced warning append-only but keeps independent integrity warnings', async () => {
  await startDiagnosticRun();
  for (const independent of [false, true]) {
    const rec = await createRecording('LIVE');
    const session = { variant: 'LIVE', completedAt: independent ? 4321 : 4320 };
    const key = `session-LIVE-${session.completedAt}`;
    const verdict = { valid: false, status: 'INCOMPLETE', reasons: ['FAULT reason=19', 'END reason=19 (RX_SILENCE (no UART1 bytes for five seconds))', ...(independent ? ['RX lines 0 != ro_bytes 25'] : [])] };
    await rec.finish(verdict, { outcome: 'OPERATOR_CONFIRMATION_PENDING', session });
    await recordDiagnosticWarning(key, true, { severity: 'amber', ruleId: 'SESSION-INCOMPLETE', reason: 'Original warning', source: 'test' });
    const { resolveRecordingOutcome } = await import('../js/recording.js');
    const item = await resolveRecordingOutcome(rec.id, 'USER_CONFIRMED_IGNITION_OFF');
    await startDiagnosticRun(); // crash after recording commit, before journal resolution
    await reconcileOutcome(item);
    await reconcileOutcome(item);
    const events = await diagnosticHistory();
    assert.equal(events.filter(e => e.type === 'WARNING_RESOLVED' && e.detail.key === key).length, 1);
    const active = (await diagnosticHistory('warnings')).find(w => w.key === key && w.active);
    assert.equal(!!active, independent);
    if (independent) assert.match(active.reason, /RX lines 0 != ro_bytes 25/);
    assert.equal(events.filter(e => e.type === 'SESSION_OUTCOME_RESOLVED' && e.detail.recordingId === rec.id).length, 1);
  }
});

test('ZIP carries resolved disposition, confirmation time, original verdict and untouched raw bytes', async () => {
  const { default: JSZip } = await import('jszip');
  const { exportDiagnosticZip } = await import('../js/exports.js');
  const { resolveRecordingOutcome } = await import('../js/recording.js');
  await startDiagnosticRun();
  const rec = await createRecording('LIVE');
  const raw = 'FAULT reason=19 cause=RX_SILENCE\nEND reason=19\n';
  raw.trim().split('\n').forEach(line => rec.line(line));
  const verdict = { valid: false, status: 'INCOMPLETE', reasons: ['FAULT reason=19'] };
  const first = rec.finish(verdict, { outcome: 'OPERATOR_CONFIRMATION_PENDING', session: { variant: 'LIVE', completedAt: 5000 } });
  assert.equal(rec.finish({ valid: true }), first);
  await first;
  const item = await resolveRecordingOutcome(rec.id, 'USER_CONFIRMED_IGNITION_OFF', 123456);
  await reconcileOutcome(item);
  const originalUrl = URL.createObjectURL;
  let blob;
  globalThis.window = { JSZip };
  globalThis.document = { createElement: () => ({ click() {} }) };
  URL.createObjectURL = value => { blob = value; return originalUrl(value); };
  try {
    await exportDiagnosticZip();
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const manifest = JSON.parse(await zip.file('run-manifest.json').async('string'));
    const saved = manifest.recordings.find(entry => entry.id === rec.id);
    assert.equal(saved.outcome, 'USER_CONFIRMED_IGNITION_OFF');
    assert.equal(saved.operatorConfirmation.confirmedAt, 123456);
    assert.deepEqual(saved.verdict, verdict);
    const file = `recordings/${rec.id.replace(/[^a-z0-9._-]/gi, '_')}.raw.txt`;
    assert.equal(await zip.file(file).async('string'), raw);
    assert.match(await zip.file('journal.jsonl').async('string'), /SESSION_OUTCOME_RESOLVED/);
    const warnings = JSON.parse(await zip.file('warnings.json').async('string'));
    assert.equal(warnings.some(w => w.key === 'session-LIVE-5000' && w.active), false);
  } finally { URL.createObjectURL = originalUrl; }
});
