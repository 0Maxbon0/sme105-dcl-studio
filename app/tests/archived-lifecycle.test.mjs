/** Optional private evidence replay. Originals stay outside Git and are never written. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createController } from '../js/controller.js';
const root = process.env.SME105_EVIDENCE_DIR;
const digest = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function replay(text) {
  const sent = [];
  const c = createController({ send: cmd => sent.push(cmd) });
  c.onConnected('archived', 'usb');
  // Archive sink bounds decoded history while replaying every original byte.
  let requested = false;
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    c.handleLine(line);
    if (!requested && c.state.phase === 'idle') { c.setArchive({ id: 'offline', line() {}, sample() {}, finish: async () => {} }); assert.equal(c.requestVehicle('ALL').ok, true); requested = true; }
  }
  return { result: c.state.lastSession, sent };
}
test('private archived live silence, failed Starts, double lock denial and fresh boot replay unchanged', { skip: !root }, () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json')));
  for (const item of manifest.files) assert.equal(digest(join(root, 'phone-downloads', item.name)), item.sha256);
  const dir = join(root, 'tps-followup-1120');
  const captures = JSON.parse(readFileSync(join(dir, 'extracted-recordings-manifest.json'))).captures;
  for (const item of captures) for (const kind of ['raw', 'csv']) assert.equal(digest(join(dir, item[kind].file)), item[kind].sha256);
  const live = replay(readFileSync(join(root, 'phone-downloads/eec-iv-2026-11-06T05-21-36.txt'), 'utf8'));
  assert.equal(live.result.outcome, 'OPERATOR_CONFIRMATION_PENDING');
  assert.equal(live.result.verdict.valid, false);
  assert.equal(live.result.verdict.end.ro_bytes, 780080);
  assert.equal(live.sent.filter(cmd => cmd === 'STOP').length, 1);
  for (const item of captures.filter(item => /T09:0[56]:/.test(item.id))) {
    const { result, sent } = replay(readFileSync(join(dir, item.raw.file), 'utf8'));
    if (/T09:06:(13|25)/.test(item.id)) {
      assert.equal(result.verdict.status, 'BRIDGE_READ_ALREADY_USED');
      assert.equal(sent.some(cmd => /^(ARM_|READ_)/.test(cmd)), false);
    } else if (/T09:(05:59|06:43)/.test(item.id)) assert.equal(result.outcome, 'NOT_STARTED_ECU_NO_RESPONSE');
    else assert.equal(result.verdict.valid, true);
    assert.ok(sent.filter(cmd => cmd === 'READ_ALL').length <= 1);
    assert.equal(sent.some(cmd => /^(REBOOT|RESET|CLEAR)/.test(cmd)), false);
  }
  for (const item of captures) for (const kind of ['raw', 'csv']) assert.equal(digest(join(dir, item[kind].file)), item[kind].sha256);
});
