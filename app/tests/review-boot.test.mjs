import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import * as fake from 'fake-indexeddb';
import './test-env.mjs';
import { createRecording, listRecordings } from '../js/recording.js';
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
    const interrupted=await createRecording('ECU_STATUS');
    interrupted.line('STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW');
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('eeciv-recordings',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction('captures','readwrite'),store=tx.objectStore('captures'),request=store.get(interrupted.id);request.onsuccess=()=>store.put({...request.result,writerHeartbeat:Date.now()-16000});tx.oncomplete=resolve;tx.onabort=tx.onerror=()=>reject(tx.error);});
    await import('../js/app.js');
    const $=id=>document.getElementById(id);
    const percent=()=>$('throttle-percent-value').textContent;
    await until(()=>$('saved-recordings').options.length>=2);
    $('saved-recordings').value=rec.id;$('saved-recordings').dispatchEvent(new window.Event('change'));
    await until(()=>$('review-selected').textContent.includes('2 samples') && percent()==='0');
    const recovered=(await listRecordings()).find(item=>item.id===interrupted.id);
    assert.ok(recovered?.ended);
    assert.equal(recovered.verdict.status,'INCOMPLETE');
    assert.equal($('tps-calibration-card'),null);
    assert.equal($('tps-profile-details'),null);
    assert.equal(document.querySelector('[data-pid=ITP] .reading-number').textContent,'179');
    assert.equal($('saved-recordings').value,rec.id);
    assert.equal($('review-mode').hidden,false);
    assert.equal($('live-start').disabled,true);
    assert.equal($('mem-btn'), null);
    assert.equal($('identity-out'), null);
    for (const id of ['dcl-probe-select', 'dcl-probe-description', 'dcl-probe-run', 'dcl-probe-summary', 'dcl-probe-export', 'dcl-probe-raw']) {
      assert.equal($(id), null, `legacy probe control #${id} must be removed`);
    }
    const candidateRunner = document.querySelectorAll('#view-lab .dcl-runner-panel .dcl-run-bar button.primary');
    assert.equal(candidateRunner.length, 1);
    assert.equal(candidateRunner[0].id, 'dcl-run-action');
    assert.ok($('dcl-toggle-multiselect'));
    assert.equal($('dcl-run-action').disabled, true); // The canonical action stays inert without a live bridge.
    assert.equal($('dcl-run-selected'), null);
    assert.doesNotMatch($('dcl-probe-blocked').textContent,/01A1/);
    assert.match($('dcl-probe-blocked').textContent,/FF5F/);
    $('review-position').value=5; $('review-position').dispatchEvent(new window.Event('input'));
    await until(()=>percent()==='100');
    assert.match($('live-banner').textContent,/INCOMPLETE/);
    // The derived card uses the same handlers and persisted order as real channels.
    const grid=$('pinned-readings');
    const order=()=>[...grid.children].map(n=>n.dataset.pid);
    const saved=()=>JSON.parse(localStorage.getItem('sme105-dashboard-prefs-v1'));
    assert.ok(order().length > 8);
    assert.equal(order()[0],'THROTTLE_PERCENT');
    const style=document.createElement('style');style.textContent=readFileSync(new URL('../styles.css',import.meta.url),'utf8');document.head.append(style);
    for(const name of ['VS','DSDRPM','BITMAP_1']) document.querySelector(`#live-cards [data-pid="${name}"] [data-pin-pid]`).click();
    assert.equal(order().length,12);
    const initialOrder=order();
    for(const density of ['small','dense','comfortable','compact']) {
      $('dashboard-density').value=density;$('dashboard-density').dispatchEvent(new window.Event('change'));
      assert.equal(grid.dataset.density,density);assert.equal(saved().density,density);
      assert.equal($('dashboard-columns').disabled,density==='compact');
      assert.deepEqual(order(),initialOrder);
      assert.equal(percent(),'100');
    }
    $('dashboard-density').value='dense';$('dashboard-density').dispatchEvent(new window.Event('change'));
    $('dashboard-columns').value='3';$('dashboard-columns').dispatchEvent(new window.Event('change'));
    assert.equal(grid.dataset.columns,'3');assert.equal(saved().columns,'3');
    $('dashboard-expand').click();
    assert.equal(document.body.classList.contains('dashboard-focus'),true);
    assert.equal($('dashboard-expand').getAttribute('aria-pressed'),'true');
    assert.equal(getComputedStyle(document.querySelector('.recording-panel')).display,'none');
    assert.notEqual(getComputedStyle($('dashboard-overview')).display,'none');
    assert.notEqual(getComputedStyle(document.querySelector('header.top')).display,'none');
    assert.equal(order().length,12);
    assert.match($('dashboard-context').textContent,/Recorded Data — Offline Review/);
    assert.equal($('stop-btn').closest('#view-live'),null); // Stop remains in the global header.
    assert.equal($('ignition-notice').closest('#view-live'),null);
    $('dashboard-expand').click();assert.equal(document.body.classList.contains('dashboard-focus'),false);
    assert.notEqual(getComputedStyle(document.querySelector('.recording-panel')).display,'none');
    $('dashboard-expand').click();
    document.querySelector('nav [data-view="codes"]').click();
    assert.equal(document.body.classList.contains('dashboard-focus'),false);
    document.querySelector('nav [data-view="live"]').click();
    $('dashboard-density').value='comfortable';$('dashboard-density').dispatchEvent(new window.Event('change'));
    $('dashboard-columns').value='auto';$('dashboard-columns').dispatchEvent(new window.Event('change'));
    $('arrange-dashboard').click();
    // JSDOM does not compute touch-action; inspect the actual parsed CSS declarations.
    const touch=selector=>[...style.sheet.cssRules].find(rule=>rule.selectorText===selector).style.getPropertyValue('touch-action');
    assert.equal(touch('.arranging .pinned-card'),'pan-y');
    assert.equal(touch('.arranging .pinned-open'),'pan-y');
    assert.equal(touch('.pinned-card > .reorder-handle'),'none');
    $('throttle-percent-card').dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
    assert.equal(order()[1],'THROTTLE_PERCENT');
    assert.equal(saved().layouts.ALL[1],'THROTTLE_PERCENT');
    // Exercise actual pointer drag handlers offline (WebView capture APIs stubbed).
    grid.setPointerCapture=()=>{};grid.hasPointerCapture=()=>false;
    document.elementFromPoint=()=>grid.firstElementChild;
    const pointer=type=>{const e=new window.Event(type,{bubbles:true,cancelable:true});Object.defineProperty(e,'pointerId',{value:1});return e;};
    const beforeScroll=order();
    const swipe=pointer('pointerdown');
    $('throttle-percent-card').querySelector('.pinned-open').dispatchEvent(swipe);
    assert.equal(swipe.defaultPrevented,false); // Native page scrolling remains available.
    grid.dispatchEvent(pointer('pointermove'));grid.dispatchEvent(pointer('pointerup'));
    assert.deepEqual(order(),beforeScroll);
    const handle=$('throttle-percent-card').querySelector('.reorder-handle');
    assert.equal(handle.hidden,false);
    const drag=pointer('pointerdown');handle.dispatchEvent(drag);
    assert.equal(drag.defaultPrevented,true);
    grid.dispatchEvent(pointer('pointermove'));grid.dispatchEvent(pointer('pointerup'));
    assert.equal(order()[0],'THROTTLE_PERCENT');
    // Cancelled drags cannot reorder on subsequent movement.
    handle.dispatchEvent(pointer('pointerdown'));grid.dispatchEvent(pointer('pointercancel'));
    const afterCancel=order();document.elementFromPoint=()=>grid.lastElementChild;
    grid.dispatchEvent(pointer('pointermove'));assert.deepEqual(order(),afterCancel);
    $('arrange-dashboard').click();
    assert.equal(handle.hidden,true);
    $('throttle-percent-card').querySelector('[data-pin-pid]').click();
    assert.equal($('throttle-percent-card'),null);
    assert.ok(!saved().layouts.ALL.includes('THROTTLE_PERCENT'));
    callbacks.forEach(fn=>fn()); // Subsequent renders must not restore an unpinned card.
    assert.equal($('throttle-percent-card'),null);
    const regular=document.querySelector('#live-cards [data-pid="THROTTLE_PERCENT"]');
    assert.equal(regular.querySelector('.reading-number').textContent,'100');
    regular.querySelector('[data-open-pid]').click();
    assert.equal($('drawer-pin').hidden,false);
    assert.equal($('drawer-export-sensor').dataset.sourcePid,'ITP');
    $('drawer-pin').click();$('drawer-close').click();
    assert.equal(order().at(-1),'THROTTLE_PERCENT');
    const restored=(await import('../js/dashboard-layout.js')).normalizeDashboardPrefs(saved());
    assert.deepEqual(restored.layouts.ALL,order());
    $('review-exit').click();assert.equal($('review-mode').hidden,true);
    assert.ok(callbacks.length>=2);
    assert.doesNotMatch($('message').textContent,/Application error|failed|unavailable/);
  } finally { globalThis.setInterval=previous;globalThis.clearInterval=clear; }
});
