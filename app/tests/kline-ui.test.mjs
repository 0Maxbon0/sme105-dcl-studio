import test from "node:test";
import assert from "node:assert/strict";
import * as fake from "fake-indexeddb";
import { diagnosticHistory, startDiagnosticRun, closeDiagnosticRun } from "../js/diagnostics.js";
import { wireKline } from "../js/kline-ui.js";
test("K-Line UI records, stops, restores and exports only its own explicitly simulated session",async()=>{
  globalThis.indexedDB=new fake.IDBFactory();globalThis.IDBKeyRange=fake.IDBKeyRange;globalThis.window={};
  const nodes=new Map();
  globalThis.document={getElementById(id){if(!nodes.has(id))nodes.set(id,{value:"",textContent:"",disabled:false,replaceChildren(...children){this.children=children;this.value=children[0]?.value||"";}});return nodes.get(id);},createElement:()=>({value:"",textContent:"",click(){}})};
  const originalInterval=globalThis.setInterval,originalClear=globalThis.clearInterval,originalUrl=URL.createObjectURL;
  let tick,exported;
  globalThis.setInterval=fn=>{tick=fn;return 1;};globalThis.clearInterval=()=>{tick=null;};URL.createObjectURL=blob=>{exported=blob;return originalUrl(blob);};
  try {
    await startDiagnosticRun();await wireKline();
    assert.match(nodes.get("kline-session-status").textContent,/Hardware absent/);
    await nodes.get("kline-simulate").onclick();assert.equal(nodes.get("kline-stop").disabled,false);
    await tick();await tick();
    assert.match(nodes.get("kline-session-status").textContent,/RECORDING_SIMULATION/);
    await nodes.get("kline-stop").onclick();assert.equal(nodes.get("kline-stop").disabled,true);
    await closeDiagnosticRun("test");await startDiagnosticRun();await wireKline();
    assert.match(nodes.get("kline-session-status").textContent,/STOPPED.*simulation.*hardwareVerified=false.*2 records/);
    await nodes.get("kline-export").onclick();const csv=await exported.text();assert.match(csv,/KLINE/);assert.match(csv,/simulation/);assert.doesNotMatch(csv,/"DCL"/);
    const events=await diagnosticHistory();assert.equal(events.filter(e=>e.type==="KLINE_RX").length,2);
    assert.ok(events.filter(e=>e.type==="KLINE_RX").every(e=>e.detail.hardwareVerified===false));
    // Simulate process death during another recording; persisted RX remains.
    await nodes.get("kline-simulate").onclick();await tick();globalThis.clearInterval();
    await closeDiagnosticRun("test");await startDiagnosticRun();await wireKline();
    assert.match(nodes.get("kline-session-status").textContent,/INTERRUPTED.*1 records/);
    await closeDiagnosticRun("test");
  } finally {globalThis.setInterval=originalInterval;globalThis.clearInterval=originalClear;URL.createObjectURL=originalUrl;}
});
