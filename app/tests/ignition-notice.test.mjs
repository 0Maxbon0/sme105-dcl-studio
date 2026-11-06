import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as fake from 'fake-indexeddb';
import { createRecording, listRecordings, recordingBlob } from '../js/recording.js';
import { createIgnitionReview } from '../js/ignition-review.js';
import { startDiagnosticRun, diagnosticHistory } from '../js/diagnostics.js';
const until = async fn => { for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Notice did not settle'); };

test('global notice survives foreground/background, Later, restart and delayed archive completion; decision is durable once', async () => {
  globalThis.indexedDB = new fake.IDBFactory();globalThis.IDBKeyRange=fake.IDBKeyRange;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{estimate:async()=>({quota:10*1024**3,usage:0})}}});
  const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://offline.test/',pretendToBeVisual:true});
  let doc=dom.window.document;
  const $=id=>doc.getElementById(id);
  const controller={state:{}};
  const create=()=>createIgnitionReview({controller,document:doc,render(){},refreshWarnings:async()=>{}});
  let review=create();review.wire();await review.refresh(true);
  assert.equal($('ignition-confirmation').hidden,true);
  const rec=await createRecording('ALL');
  rec.sample({t:242.280126,name:'ITP',raw:179,value:179});
  rec.line('FAULT reason=19 cause=RX_SILENCE');rec.line('END reason=19');
  const verdict={status:'INCOMPLETE',valid:false,reasons:['FAULT reason=19'],end:{reason:19}};
  // No outcome exists until the archive transaction completes. The app waits for this promise.
  await review.refresh(true);assert.equal($('ignition-confirmation').hidden,true);
  Object.defineProperty(doc,'hidden',{configurable:true,value:true});
  await rec.finish(verdict,{outcome:'OPERATOR_CONFIRMATION_PENDING',session:{variant:'ALL',completedAt:12345}});
  await review.refresh(true);
  const raw=await (await recordingBlob(rec.id,'raw')).text();
  assert.equal($('ignition-confirmation').closest('.view'),null);
  assert.equal($('ignition-review').closest('.view'),null);
  assert.equal($('ignition-question').textContent,'Did you switch off the ignition yourself?');
  Object.defineProperty(doc,'hidden',{configurable:true,value:false});
  doc.dispatchEvent(new dom.window.Event('visibilitychange'));
  await until(() => !$('ignition-confirmation').hidden);
  for (const screen of doc.querySelectorAll('.view')) {
    for(const other of doc.querySelectorAll('.view'))other.hidden=other!==screen;
    assert.equal($('ignition-confirmation').closest('[hidden]'),null);
  }
  $('ignition-later').click();assert.equal($('ignition-confirmation').hidden,true);
  assert.equal($('ignition-review').hidden,false);
  assert.equal((await listRecordings()).find(r=>r.id===rec.id).outcome,'OPERATOR_CONFIRMATION_PENDING');
  dom.window.dispatchEvent(new dom.window.Event('sme105-native-resume'));
  await until(()=>!$('ignition-confirmation').hidden);
  $('ignition-later').click();
  // A new app/document reads only persistent state; no old component memory is used.
  const restarted=new JSDOM(html,{url:'https://offline.test/',pretendToBeVisual:true});doc=restarted.window.document;
  review=create();review.wire();await review.refresh(true);
  assert.equal($('ignition-confirmation').hidden,false);
  controller.state.review={metadata:{id:rec.id,verdict:structuredClone(verdict),outcome:'OPERATOR_CONFIRMATION_PENDING'}};
  await startDiagnosticRun();
  await Promise.all([review.resolve('USER_CONFIRMED_IGNITION_OFF'),review.resolve('UNEXPECTED_ECU_SILENCE')]);
  const saved=(await listRecordings()).find(r=>r.id===rec.id);
  assert.equal(saved.outcome,'USER_CONFIRMED_IGNITION_OFF');
  assert.equal(controller.state.review.metadata.outcome,saved.outcome);
  assert.deepEqual(controller.state.review.metadata.verdict,verdict);
  assert.equal(saved.operatorConfirmation.answer,'yes');assert.ok(saved.operatorConfirmation.confirmedAt);
  assert.deepEqual(saved.verdict,verdict);assert.equal(saved.duration,242.280126);
  assert.equal(await (await recordingBlob(rec.id,'raw')).text(),raw);
  assert.equal((await diagnosticHistory()).filter(e=>e.type==='SESSION_OUTCOME_RESOLVED'&&e.detail.recordingId===rec.id).length,1);
  assert.equal($('ignition-confirmation').hidden,true);assert.equal($('ignition-review').hidden,true);
  dom.window.close();restarted.window.close();
});
