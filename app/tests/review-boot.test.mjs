import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as fake from 'fake-indexeddb';
import { createRecording } from '../js/recording.js';
const until = async fn => { for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('App did not finish booting'); };
test('actual app entry boots existing recording into offline dashboard and wires review/calibration controls', async () => {
  const dom=new JSDOM(readFileSync(new URL('../index.html',import.meta.url),'utf8'),{url:'https://offline.test/'});
  globalThis.window=dom.window; globalThis.document=dom.window.document; globalThis.localStorage=dom.window.localStorage;
  globalThis.indexedDB=new fake.IDBFactory(); globalThis.IDBKeyRange=fake.IDBKeyRange;
  globalThis.requestAnimationFrame=fn=>{queueMicrotask(fn);return 1;};
  globalThis.getComputedStyle=window.getComputedStyle.bind(window);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{storage:{estimate:async()=>({quota:10*1024**3,usage:0})}}});
  const rec=await createRecording('ALL');
  rec.sample({t:0,name:'ITP',raw:179,value:179});rec.sample({t:5,name:'ITP',raw:970,value:970}); await rec.finish({valid:false,status:'INCOMPLETE',reasons:['END reason=19']});
  const previous=setInterval,clear=clearInterval;const callbacks=[];
  globalThis.setInterval=(fn)=>{callbacks.push(fn);return callbacks.length;}; globalThis.clearInterval=()=>{};
  try {
    await import('../js/app.js');
    const $=id=>document.getElementById(id);
    await until(()=>$('review-selected').textContent.includes('2 samples') && $('tps-raw').textContent.includes('179 counts'));
    assert.equal($('tps-calibration-card').parentElement.id,'pinned-readings');
    assert.match($('tps-calibration-card').textContent,/Throttle calibrated/);
    assert.equal($('saved-recordings').value,rec.id);
    assert.equal($('review-mode').hidden,false);
    assert.equal($('live-start').disabled,true);
    $('review-position').value=5; $('review-position').dispatchEvent(new window.Event('input'));
    await until(()=>$('tps-raw').textContent.includes('970 counts'));
    assert.match($('live-banner').textContent,/INCOMPLETE/);
    $('tps-confirm').checked=true;$('tps-save').click();
    assert.match($('tps-context').textContent,/identity unrecorded/);
    $('tps-history-profile').checked=true;$('tps-history-profile').dispatchEvent(new window.Event('change'));
    assert.match($('tps-travel').textContent,/100.0$/);
    $('review-exit').click();assert.equal($('review-mode').hidden,true);
    assert.ok(callbacks.length>=2);
    assert.doesNotMatch($('message').textContent,/Application error|failed|unavailable/);
  } finally { globalThis.setInterval=previous;globalThis.clearInterval=clear; }
});
