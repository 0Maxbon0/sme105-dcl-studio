import test from "node:test";
import assert from "node:assert/strict";
import * as fake from "fake-indexeddb";
import JSZip from "jszip";
import { importKline } from "../js/kline.js";
test("durable full ZIP preserves K-Line raw metadata, human KOER events and old DTCs with verified checksums",async()=>{
  globalThis.indexedDB=new fake.IDBFactory();globalThis.IDBKeyRange=fake.IDBKeyRange;
  globalThis.window={JSZip};globalThis.document={createElement:()=>({click(){}})};
  let exported;
  const original=URL.createObjectURL;URL.createObjectURL=blob=>{exported=blob;return original(blob);};
  try {
    const d=await import("../js/diagnostics.js");const {exportDiagnosticZip}=await import("../js/exports.js");
    await d.startDiagnosticRun();
    const session=importKline(JSON.stringify({channel:"KLINE",t_us:1,byte:0x55,metadata:{init:"5-baud",inert:true}}));
    await d.recordDiagnosticEvent("KLINE_SESSION",session,"kline");
    await d.recordDiagnosticEvent("KOER_OPERATOR_EVENT",{channel:"DCL",source:"human",ecuConfirmed:false,action:"external-cue"},"koer");
    await d.recordDiagnosticEvent("SESSION_RESULT",{variant:"KOER",codes:[{code:"172",mode:0x25}]},"session");
    await d.recordDiagnosticEvent("SESSION_RESULT",{variant:"0E",codes:[{code:"111",mode:0x26}]},"session");
    await d.recordBridgeRaw("KLINE t_us=1 byte=55");
    await d.closeDiagnosticRun("test");await d.startDiagnosticRun();
    const before=await d.diagnosticSnapshot();assert.ok(before.events.some(e=>e.type==="KLINE_SESSION"));
    const result=await exportDiagnosticZip();assert.equal(result.size,exported.size);
    const zip=await JSZip.loadAsync(await exported.arrayBuffer());
    const imported=JSON.parse(await zip.file("kline-sessions.json").async("string"));
    assert.equal(imported[0].detail.records[0].metadata.init,"5-baud");assert.equal(imported[0].detail.hardwareVerified,false);
    assert.equal(JSON.parse(await zip.file("operator-events.json").async("string"))[0].detail.source,"human");
    assert.equal(JSON.parse(await zip.file("dtc-evidence.json").async("string")).length,2);
    for(const line of (await zip.file("sha256-manifest.txt").async("string")).trim().split("\n")) {
      const [expected,path]=line.split(/\s+/,2);const bytes=await zip.file(path).async("uint8array");
      const hash=Buffer.from(await crypto.subtle.digest("SHA-256",bytes)).toString("hex");assert.equal(hash,expected,path);
    }
    await d.closeDiagnosticRun("test");
  } finally {URL.createObjectURL=original;}
});
