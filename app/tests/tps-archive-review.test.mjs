import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as fake from 'fake-indexeddb';
import { createRecording, listRecordings, recordingBlob } from '../js/recording.js';
import { createRecordingPlayer } from '../js/recording-review.js';
import { sensorSamplesFromCsv } from '../js/chart-series.js';
import { throttlePercent } from '../js/throttle-display.js';
const root = process.env.SME105_EVIDENCE_DIR;
const hash = data => createHash('sha256').update(data).digest('hex');
test('November 6 recordings load from original IndexedDB schema and expose real TPS plateaus without changing evidence', { skip: !root }, async () => {
  globalThis.indexedDB = new fake.IDBFactory(); globalThis.IDBKeyRange = fake.IDBKeyRange;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { storage: { estimate: async () => ({quota:10*1024**3,usage:0}) } } });
  const seed = await createRecording('ALL'); await seed.finish({ valid:false });
  const dir = join(root,'tps-followup-1120');
  const manifest = JSON.parse(readFileSync(join(dir,'extracted-recordings-manifest.json')));
  const captures = manifest.captures.filter(c => /T(07:44:58|07:45:56|08:50:29|09:06:52)/.test(c.id));
  assert.equal(captures.length,4);
  const database = await new Promise(resolve => { const r = indexedDB.open('eeciv-recordings',1); r.onsuccess=()=>resolve(r.result); });
  const refs={freeRest:103,mountedClosed:179,maximum:970};
  const expectedCounts=[294,505,4679,387];
  let i=0;
  for(const capture of captures) {
    const csv=readFileSync(join(dir,capture.csv.file)),raw=readFileSync(join(dir,capture.raw.file));
    assert.equal(hash(csv),capture.csv.sha256); assert.equal(hash(raw),capture.raw.sha256);
    const tx=database.transaction(['captures','chunks'],'readwrite');
    tx.objectStore('captures').put(capture);
    tx.objectStore('chunks').put({id:capture.id,seq:0,csv:new Blob([csv.subarray(csv.indexOf(10)+1)]),raw:new Blob([raw])});
    await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
    const before=await listRecordings();
    const samples=await sensorSamplesFromCsv(new Blob([csv]),'ITP');
    assert.equal(samples.length,expectedCounts[i++]);
    const player=createRecordingPlayer(); await player.select(capture.id);
    assert.equal(player.state.error,''); assert.equal(player.state.metadata.id,capture.id);
    for(const target of [103,179,970,0,1013]) {
      const point=samples.find(s=>s.raw===target); if(!point) continue;
      await player.seek(point.t);
      assert.equal(player.state.pids.ITP.summary.rawLast,target);
      assert.equal(player.state.pids.ITP.sampleTime,point.t);
      const travel=throttlePercent(target);
      if(target===179||target===103) assert.equal(travel,0);
      if(target===970) assert.equal(travel,100);
      if(target===0) assert.equal(travel,0);
      if(target===1013) assert.equal(travel,100);
    }
    if(capture.id.includes('T09:06:52')) {
      assert.ok(samples.every(s=>s.raw===179));
      await player.seek(samples.at(-1).t);
      assert.equal(throttlePercent(player.state.pids.ITP.summary.rawLast),0);
    }
    assert.deepEqual(await listRecordings(),before);
    assert.equal(hash(Buffer.from(await (await recordingBlob(capture.id,'raw')).arrayBuffer())),capture.raw.sha256);
    assert.equal(hash(Buffer.from(await (await recordingBlob(capture.id,'csv')).arrayBuffer())),capture.csv.sha256);
    assert.equal(hash(readFileSync(join(dir,capture.csv.file))),capture.csv.sha256);
    assert.equal(hash(readFileSync(join(dir,capture.raw.file))),capture.raw.sha256);
  }
  database.close();
});
