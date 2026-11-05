import test from "node:test";
import assert from "node:assert/strict";
import * as fake from "fake-indexeddb";
import { redactDiagnostic } from "../js/diagnostics.js";

test("diagnostic redaction removes labeled pairing, Wi-Fi, path, and device identifiers", () => {
  const safe = redactDiagnostic("pair=123456 ssid=garage psk=private mac=AA:BB:CC:DD:EE:FF /home/maxim/private.txt");
  assert.doesNotMatch(safe, /123456|garage|private|AA:BB:CC|\/home\/maxim/);
  assert.match(safe, /REDACTED_PASSKEY/);
  assert.match(safe, /REDACTED_WIFI_SECRET/);
  assert.match(safe, /REDACTED_DEVICE_ID/);
  assert.match(safe, /LOCAL_PATH/);
});

test("structured run log persists raw, samples, warnings, and marks an unclosed prior run", async () => {
  globalThis.indexedDB = new fake.IDBFactory();
  globalThis.IDBKeyRange = fake.IDBKeyRange;
  const { startDiagnosticRun, recordBridgeRaw, recordDiagnosticSample, recordDiagnosticWarning,
    diagnosticSnapshot, closeDiagnosticRun } = await import("../js/diagnostics.js?durable-test");

  const first = await startDiagnosticRun();
  await recordBridgeRaw("RXB t_us=1 data=00 pair=123456");
  await recordDiagnosticSample({ name: "N", t: 0.5, raw: 242, value: 968, unit: "rpm", receivedAt: 1000 }, { variant: "LIVE" });
  await recordDiagnosticWarning("stored-157", true, { severity: "amber", sensor: "DTC 157", ruleId: "DTC-157", reason: "MAF circuit context", source: "0E read mode 26H", evidence: { raw: [1, 2] } });
  let snapshot = await diagnosticSnapshot();
  assert.equal(snapshot.raw.length, 1);
  assert.doesNotMatch(snapshot.raw[0].line, /123456/);
  assert.equal(snapshot.samples[0].pid, "0x01");
  assert.equal(snapshot.warnings[0].active, true);
  await closeDiagnosticRun("test");

  await startDiagnosticRun();
  await recordDiagnosticWarning("stored-157", false, {});
  await closeDiagnosticRun("test");
  const interrupted = await startDiagnosticRun();
  await startDiagnosticRun();
  snapshot = await diagnosticSnapshot();
  assert.ok(snapshot.events.some(event => event.runId === interrupted.id && event.type === "SESSION_ABNORMAL_TERMINATION"));
  assert.equal(snapshot.warnings.find(item => item.key === "stored-157").active, false);
  assert.ok(snapshot.events.every(event => event.utc && Number.isFinite(event.monotonic_us) && event.appBuild && event.category));
});

test("a burst of raw, sensor, and event rows is journaled in one IndexedDB batch", async () => {
  globalThis.indexedDB = new fake.IDBFactory();
  globalThis.IDBKeyRange = fake.IDBKeyRange;
  const { startDiagnosticRun, recordBridgeRaw, recordDiagnosticSample, recordDiagnosticEvent,
    diagnosticSnapshot, closeDiagnosticRun } = await import("../js/diagnostics.js?batch-test");
  const run = await startDiagnosticRun();
  const request = indexedDB.open("sme105-diagnostics", 1);
  const database = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const prototype = Object.getPrototypeOf(database);
  const original = prototype.transaction;
  let writes = 0;
  prototype.transaction = function(stores, mode, ...rest) {
    if (mode === "readwrite") writes += 1;
    return original.call(this, stores, mode, ...rest);
  };
  try {
    const operations = [];
    for (let index = 0; index < 40; index += 1) {
      operations.push(recordBridgeRaw(`RX batch=${index}`));
      operations.push(recordDiagnosticSample({ name: "N", t: index, raw: index, value: index * 4, unit: "rpm" }));
      operations.push(recordDiagnosticEvent("BATCH_TEST", { index }));
    }
    assert.ok((await Promise.all(operations)).every(Boolean));
    assert.equal(writes, 1);
  } finally {
    prototype.transaction = original;
    database.close();
  }
  const snapshot = await diagnosticSnapshot();
  assert.equal(snapshot.storage.complete, true);
  assert.equal(snapshot.raw.filter(item => item.runId === run.id).length, 40);
  assert.equal(snapshot.samples.filter(item => item.runId === run.id).length, 40);
  const burst = snapshot.events.filter(item => item.runId === run.id && item.type === "BATCH_TEST");
  assert.equal(burst.length, 40);
  assert.deepEqual(burst.map(item => item.sequence), [...burst.map(item => item.sequence)].sort((a, b) => a - b));
  await closeDiagnosticRun("batch-test");
});

test("journal write failure retains queued evidence and marks the snapshot incomplete", async () => {
  globalThis.indexedDB = new fake.IDBFactory();
  globalThis.IDBKeyRange = fake.IDBKeyRange;
  const { startDiagnosticRun, recordBridgeRaw, recordDiagnosticSample, recordDiagnosticEvent,
    diagnosticSnapshot, setDiagnosticStorageErrorHandler } = await import("../js/diagnostics.js?failure-test");
  const run = await startDiagnosticRun();
  const request = indexedDB.open("sme105-diagnostics", 1);
  const database = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const prototype = Object.getPrototypeOf(database);
  const original = prototype.transaction;
  let reported = "";
  setDiagnosticStorageErrorHandler(error => { reported = error.message; });
  prototype.transaction = function(stores, mode, ...rest) {
    if (mode === "readwrite" && Array.isArray(stores) && stores.includes("raw")) throw new Error("simulated storage full");
    return original.call(this, stores, mode, ...rest);
  };
  try {
    await Promise.all([
      recordBridgeRaw("RX retained"),
      recordDiagnosticSample({ name: "N", t: 1, raw: 2, value: 8, unit: "rpm" }),
      recordDiagnosticEvent("FAILURE_TEST", { retained: true }),
    ]);
  } finally {
    prototype.transaction = original;
    database.close();
  }
  const snapshot = await diagnosticSnapshot();
  assert.match(reported, /simulated storage full/);
  assert.equal(snapshot.storage.complete, false);
  assert.match(snapshot.storage.error, /simulated storage full/);
  assert.equal(snapshot.raw.filter(item => item.runId === run.id).length, 1);
  assert.equal(snapshot.samples.filter(item => item.runId === run.id).length, 1);
  assert.ok(snapshot.events.some(item => item.runId === run.id && item.type === "FAILURE_TEST"));
});

test("focused history reads avoid raw/sample stores and retain complete event provenance",async()=>{
  globalThis.indexedDB=new fake.IDBFactory();globalThis.IDBKeyRange=fake.IDBKeyRange;
  const d=await import("../js/diagnostics.js?focused-history");await d.startDiagnosticRun();
  await d.recordDiagnosticEvent("KLINE_SESSION",{channel:"KLINE",source:"simulation",hardwareVerified:false},"kline");
  const request=indexedDB.open("sme105-diagnostics",1);
  const database=await new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const proto=Object.getPrototypeOf(database),original=proto.transaction;
  proto.transaction=function(stores,...args){assert.ok(![stores].flat().some(s=>["raw","samples"].includes(s)));return original.call(this,stores,...args);};
  try {const events=await d.diagnosticHistory();assert.equal(events.find(e=>e.type==="KLINE_SESSION").detail.source,"simulation");}
  finally {proto.transaction=original;database.close();await d.closeDiagnosticRun("test");}
});
