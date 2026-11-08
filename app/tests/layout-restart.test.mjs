import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as fake from 'fake-indexeddb';
import { createRecording } from '../js/recording.js';
const until=async fn=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('Restart did not settle');};
test('fresh app boot restores saved derived-card order and mode-specific visibility',async()=>{
  const dom=new JSDOM(readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://offline.test/'});
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.localStorage=dom.window.localStorage;
  globalThis.indexedDB=new fake.IDBFactory();globalThis.IDBKeyRange=fake.IDBKeyRange;
  globalThis.requestAnimationFrame=fn=>{queueMicrotask(fn);return 1;};
  globalThis.getComputedStyle=window.getComputedStyle.bind(window);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{estimate:async()=>({quota:10*1024**3,usage:0})}}});
  const prefs={version:2,layouts:{ALL:['VS','THROTTLE_PERCENT','ITP'],LIVE:[],LIVE2:['ITP'],LIVE3:['VSBAR']},density:'dense',columns:'3'};
  localStorage.setItem('sme105-dashboard-prefs-v1',JSON.stringify(prefs));
  const rec=await createRecording('ALL');rec.sample({t:0,name:'VS',raw:0,value:0});rec.sample({t:0,name:'ITP',raw:871,value:871});await rec.finish({status:'INCOMPLETE',valid:false});
  const prior=setInterval,clear=clearInterval;globalThis.setInterval=()=>1;globalThis.clearInterval=()=>{};
  try{
    await import('../js/app.js');const $=id=>document.getElementById(id);
    const order=()=>[...$('pinned-readings').children].map(n=>n.dataset.pid);
    await until(()=>$('saved-recordings').options.length>=1);
    $('saved-recordings').value=rec.id;$('saved-recordings').dispatchEvent(new window.Event('change'));
    await until(()=>$('review-selected').textContent.includes('2 samples'));
    assert.deepEqual(order(),prefs.layouts.ALL);assert.equal($('pinned-readings').dataset.density,'dense');
    assert.equal($('pinned-readings').dataset.columns,'3');
    assert.equal($('dashboard-columns').value,'3');
    assert.equal($('dashboard-density').value,'dense');
    assert.equal($('throttle-percent-value').textContent,'87');
    assert.equal(document.querySelector('#pinned-readings [data-pid=VS] .reading-number').textContent,'0.0');
    $('live-set').value='LIVE';$('live-set').dispatchEvent(new window.Event('change'));
    assert.deepEqual(order(),[]); // A persisted removal is never migrated back in.
    assert.ok(document.querySelector('#live-cards [data-pid=THROTTLE_PERCENT]'));
    $('live-set').value='LIVE3';$('live-set').dispatchEvent(new window.Event('change'));
    assert.deepEqual(order(),['VSBAR']);assert.equal(document.querySelector('[data-pid=THROTTLE_PERCENT]'),null);
    $('live-set').value='ALL';$('live-set').dispatchEvent(new window.Event('change'));assert.deepEqual(order(),prefs.layouts.ALL);
    assert.equal($('live-start').disabled,true);
  }finally{globalThis.setInterval=prior;globalThis.clearInterval=clear;}
});
