import test from 'node:test';
import assert from 'node:assert/strict';
import * as fake from 'fake-indexeddb';
import { indexRecording, createRecordingPlayer, recordingLabel } from '../js/recording-review.js';
import { createRecording, listRecordings, recordingBlob } from '../js/recording.js';
import { sensorSeries } from '../js/ui.js';
import { rowsToCsv } from '../js/pids.js';
import { createController } from '../js/controller.js';
globalThis.indexedDB = new fake.IDBFactory(); globalThis.IDBKeyRange = fake.IDBKeyRange;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }) } } });
const row = (t, name, raw) => ({ t, name, raw, value: raw });
const storage = () => { const data = new Map(); return { getItem: k => data.get(k), setItem: (k,v) => data.set(k,v) }; };

test('read-only indexed seek uses actual last-known samples, never future or invented values', async () => {
  const blob = new Blob([rowsToCsv([row(.2, 'ITP', 103), row(.5, 'N', 0), row(1, 'ITP', 179), row(2, 'ITP', 970), row(3, 'VBAT', 512)])]);
  const index = await indexRecording(blob);
  assert.equal(index.count, 5); assert.equal(index.duration, 3);
  assert.deepEqual((await index.at(0)).pids, {});
  let p = await index.at(.9);
  assert.equal(p.pids.ITP.summary.rawLast, 103); assert.equal(p.pids.ITP.sampleTime, .2); assert.equal(p.pids.ITP.newAtPosition, false);
  assert.equal(p.pids.VBAT, undefined);
  p = await index.at(1); assert.equal(p.pids.ITP.summary.rawLast, 179); assert.equal(p.pids.ITP.newAtPosition, true);
  assert.equal((await index.at(9)).pids.ITP.summary.rawLast, 970);
  assert.equal(index.stats.blockReads, 1);
});

test('existing IndexedDB listing, older/newer selection, playback and restart preserve original data and verdicts', async () => {
  const older = await createRecording('ALL'); older.sample(row(1, 'ITP', 103)); older.sample(row(2, 'ITP', 179)); older.sample(row(3, 'N', 0));
  older.line('FAULT reason=19'); await older.finish({ valid: false, status: 'INCOMPLETE', reasons: ['FAULT reason=19'] });
  const newer = await createRecording('LIVE'); newer.sample(row(1, 'ITP', 970)); newer.sample(row(4, 'VBAT', 400)); await newer.finish({ valid: true, status: 'VALID' });
  const before = await listRecordings(); const bytes = await (await recordingBlob(older.id, 'csv')).text();
  assert.equal(before[0].id, newer.id);
  assert.match(recordingLabel(before[0]), /LIVE.*4.0s.*2 samples.*VALID/);
  let clock = 0; const mem = storage(), p = createRecordingPlayer({ now: () => clock, storage: mem });
  await p.select(newer.id); await p.seek(1);
  assert.equal(p.state.pids.ITP.summary.rawLast, 970);
  await p.select(older.id); assert.deepEqual(p.state.pids, {});
  assert.equal(p.state.metadata.verdict.status, 'INCOMPLETE');
  p.play(); clock = 1000; await p.tick(); assert.equal(p.state.position, 1); assert.equal(p.state.pids.ITP.summary.rawLast, 103);
  p.pause(); clock = 3000; await p.tick(); assert.equal(p.state.position, 1);
  await p.seek(2); assert.equal(p.state.pids.ITP.summary.rawLast, 179);
  await p.restart(); assert.equal(p.state.position, 0); assert.deepEqual(p.state.pids, {});
  const reopened = createRecordingPlayer({ storage: mem }); assert.equal(reopened.remembered(), older.id); await reopened.select(reopened.remembered()); await reopened.seek(2);
  assert.equal(reopened.state.pids.ITP.summary.rawLast, 179);
  const selected = { review: reopened.state, cart: { snapshot: () => ({ pids: { VBAT: { summary: { rawLast: 999 } } } }) }, lastSession: { pids: { VBAT: { summary: { rawLast: 777 } } } } };
  assert.equal(sensorSeries(selected, 'VBAT'), null); // Never fall through to a different capture/live value.
  assert.equal(await (await recordingBlob(older.id, 'csv')).text(), bytes);
  assert.deepEqual(await listRecordings(), before);
  const commands = [], controller = createController({ send: cmd => commands.push(cmd) }); controller.state.review = reopened.state;
  assert.equal(controller.requestVehicle('LIVE').ok, false); assert.equal(controller.requestBench().ok, false); assert.equal(controller.requestReboot().ok, false); assert.deepEqual(commands, []);
});

test('large recording indexing and repeated nearby seeking retain bounded blocks', async () => {
  const parts = ['t_s,pid,raw,value,unit\n'];
  for (let i = 0; i < 100000; i++) parts.push(`${i / 100},${i % 2 ? 'ITP' : 'N'},${i % 2 ? 179 : 0},${i % 2 ? 179 : 0},counts\n`);
  const index = await indexRecording(new Blob(parts));
  assert.equal(index.count, 100000); assert.ok(index.stats.checkpoints < 50);
  await index.at(700); const reads = index.stats.blockReads;
  for (let t = 700; t < 701; t += .01) assert.equal((await index.at(t)).pids.ITP.summary.rawLast, 179);
  assert.equal(index.stats.blockReads, reads); assert.ok(index.stats.cachedBlocks <= 3);
  assert.equal((await index.at(10)).pids.ITP.sampleTime, 9.99);
});

test('empty, malformed, denied, missing and overlapping selection never fall back to other recordings', async () => {
  const index = await indexRecording(new Blob(['t_s,pid,raw,value,unit\n1,ITP,,10,counts\n2,ITP,179,179,counts\n']));
  assert.equal(index.invalid, 1); assert.equal((await index.at(1)).pids.ITP, undefined);
  await assert.rejects(indexRecording(new Blob(['2,ITP,179,179\n1,ITP,103,103\n'])), /out of order/);
  const player = createRecordingPlayer({ load: async id => { if (id === 'missing') throw new Error('Missing selected file'); return { metadata: { id, verdict: { status: 'INCOMPLETE' } }, blob: new Blob(['t_s,pid,raw,value,unit\n']) }; } });
  await player.select('denied'); assert.equal(player.state.count, 0); player.play(); assert.equal(player.state.playing, false);
  await player.select('missing'); assert.match(player.state.error, /Missing/); assert.equal(player.state.metadata.id, 'missing'); assert.deepEqual(player.state.pids, {});
  let release; const slow = new Promise(resolve => { release = resolve; });
  const race = createRecordingPlayer({ load: async id => { if (id === 'old') await slow; return { metadata: { id }, blob: new Blob([rowsToCsv([row(0, 'ITP', id === 'old' ? 103 : 179)])]) }; } });
  const first = race.select('old'); await race.select('new'); release(); await first;
  assert.equal(race.state.metadata.id, 'new'); assert.equal(race.state.pids.ITP.summary.rawLast, 179);
});
