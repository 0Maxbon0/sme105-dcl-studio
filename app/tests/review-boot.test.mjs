import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as fake from 'fake-indexeddb';
import { createRecording } from '../js/recording.js';
const until = async fn => { for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,5));}throw new Error('App did not finish booting'); };
test('actual app entry boots existing recording into offline dashboard and wires review and normal throttle card', async () => {
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
    const percent=()=>$('throttle-percent-value').textContent;
    await until(()=>$('review-selected').textContent.includes('2 samples') && percent()==='0');
    assert.equal($('tps-calibration-card'),null);
    assert.equal($('tps-profile-details'),null);
    assert.equal(document.querySelector('[data-pid=ITP] .reading-number').textContent,'179');
    assert.equal($('saved-recordings').value,rec.id);
    assert.equal($('review-mode').hidden,false);
    assert.equal($('live-start').disabled,true);
    $('review-position').value=5; $('review-position').dispatchEvent(new window.Event('input'));
    await until(()=>percent()==='100');
    assert.match($('live-banner').textContent,/INCOMPLETE/);
    $('review-exit').click();assert.equal($('review-mode').hidden,true);
    assert.ok(callbacks.length>=2);
    assert.doesNotMatch($('message').textContent,/Application error|failed|unavailable/);
  } finally { globalThis.setInterval=previous;globalThis.clearInterval=clear; }
});
