/** Read originals, seed an isolated in-memory database, never touch phone or evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as fake from 'fake-indexeddb';
import { createRecording, listRecordings, recordingBlob } from '../js/recording.js';
import { createRecordingPlayer, recordingLabel } from '../js/recording-review.js';
import { formattedReading, formatReplayTime } from '../js/display-format.js';
import { bitPresentation } from '../js/bit-presentation.js';
const root=process.env.SME105_EVIDENCE_DIR;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
test('read-only November dashboard archive retains real speed precision, raw bits and pending incomplete outcome', {skip:!root}, async()=>{
  const dir=join(root,'phone-pull-1533-readonly');
  const manifest=JSON.parse(readFileSync(join(dir,'manifest.json')));
  for(const capture of manifest.sessions) for(const [file,proof] of Object.entries(capture.files)) {
    const bytes=readFileSync(join(dir,capture.directory,file));
    assert.equal(bytes.length,proof.bytes);assert.equal(hash(bytes),proof.sha256);
  }
  const capture=manifest.sessions.find(c=>c.outcome==='OPERATOR_CONFIRMATION_PENDING');
  assert.ok(capture);
  const folder=join(dir,capture.directory),metadata=JSON.parse(readFileSync(join(folder,'metadata.json')));
  const csv=readFileSync(join(folder,'original-readings.csv')),raw=readFileSync(join(folder,'original-raw.txt'));
  globalThis.indexedDB=new fake.IDBFactory();globalThis.IDBKeyRange=fake.IDBKeyRange;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{estimate:async()=>({quota:10*1024**3,usage:0})}}});
  const seed=await createRecording('ALL');await seed.finish({valid:false});
  const db=await new Promise(resolve=>{const request=indexedDB.open('eeciv-recordings',1);request.onsuccess=()=>resolve(request.result);});
  const tx=db.transaction(['captures','chunks'],'readwrite');tx.objectStore('captures').put(metadata);
  tx.objectStore('chunks').put({id:metadata.id,seq:0,csv:new Blob([csv]),raw:new Blob([raw])});
  await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});
  const before=await listRecordings(),player=createRecordingPlayer();await player.select(metadata.id);
  assert.equal(player.state.count,30192);assert.equal(player.state.duration,242.280126);
  assert.match(recordingLabel(metadata),/242\.3s.*INCOMPLETE.*operator confirmation pending/);
  const rows=csv.toString().trim().split('\n').map(line=>line.split(','));
  for(const [name,expected] of [['VS','19.2'],['VSBAR','17.7']]) {
    const point=rows.filter(r=>r[1]===name).reduce((a,b)=>Number(a[3])>Number(b[3])?a:b);
    await player.seek(Number(point[0]));
    const value=player.state.pids[name].summary.last;
    assert.equal(value,Number(point[3]));assert.equal(formattedReading(name,value).text,expected);
  }
  await player.seek(242.280126);
  assert.equal(player.state.position,242.280126);assert.equal(formatReplayTime(player.state.position),'242.3s');
  assert.equal(formattedReading('VS',player.state.pids.VS.summary.last).text,'0.0');
  assert.equal(player.state.pids.ITP.summary.rawLast,179);
  assert.equal(formattedReading('THROTTLE_PERCENT',player.state.pids.ITP.summary.last).text,'0');
  for(const name of ['BITMAP_0','BITMAP_1','FMEM_FLAGS','FMEM_FLAG2']) {
    const sample=player.state.pids[name].samples.at(-1),model=bitPresentation(name,sample.raw);
    assert.equal(model.rows.length,name.startsWith('BITMAP')?12:8);
    assert.match(model.note,/unverified/);
    if(name.startsWith('FMEM'))assert.equal(model.raw,'Raw byte: 0x00');
  }
  assert.equal(player.state.metadata.verdict.status,'INCOMPLETE');
  assert.equal(player.state.metadata.outcome,'OPERATOR_CONFIRMATION_PENDING');
  assert.deepEqual(await listRecordings(),before);
  assert.equal(hash(Buffer.from(await(await recordingBlob(metadata.id,'raw')).arrayBuffer())),hash(raw));
  assert.equal(hash(readFileSync(join(folder,'original-readings.csv'))),hash(csv));
  assert.equal(hash(readFileSync(join(folder,'original-raw.txt'))),hash(raw));
  db.close();
});
