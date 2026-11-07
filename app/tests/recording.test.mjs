import assert from "node:assert/strict";
import test from "node:test";
import * as fake from "fake-indexeddb";
import "./test-env.mjs";
import { createRecording, listRecordings, recordingBlob } from "../js/recording.js";

globalThis.indexedDB = new fake.IDBFactory();
globalThis.IDBKeyRange = fake.IDBKeyRange;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: {
  estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }), persist: async () => true,
} } });
const options = {};

test("recording chunks retain all rows/raw data, export while active, and survive reopening", options, async () => {
  const failures = [];
  const recording = await createRecording("ALL", e => failures.push(e));
  const sample = { t: 1, name: "N", raw: 250, value: 1000 };
  recording.line("EVENT session=READ_CANDIDATE"); recording.sample(sample);
  const first = await recording.export("csv");
  assert.match(await first.text(), /1,N,250,1000/);
  recording.sample({ ...sample, t: 2 }); recording.line("END reason=16");
  await recording.finish({ valid: true });
  assert.equal((await (await recordingBlob(recording.id,"csv")).text()).split("\n").filter(Boolean).length, 3);
  assert.equal(await (await recordingBlob(recording.id,"raw")).text(), "EVENT session=READ_CANDIDATE\nEND reason=16\n");
  const second = await createRecording("LIVE"); await second.finish({ valid: false });
  assert.ok((await listRecordings()).some(e => e.id === recording.id && e.verdict.valid));
  assert.equal(failures.length, 0);
});

test("vehicle transcript chunks preserve status, pad and RO lines verbatim", options, async () => {
  const recording = await createRecording("ECU_STATUS");
  const lines = [
    "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW",
    "TX_PAD slot=2 expected=0381 observed=0381 match=1",
    "RX t_us=16000 byte=AA",
  ];
  lines.forEach(line => recording.line(line));
  await recording.finish({ valid: false, status: "INCOMPLETE", reasons: ["test capture"] });
  assert.equal(await (await recordingBlob(recording.id, "raw")).text(), `${lines.join("\n")}\n`);
});

test("a failed atomic write stops recording and retains its queued data for export", options, async () => {
  let failures = 0;
  const recording = await createRecording("ALL", () => failures++);
  const original = fake.IDBDatabase.prototype.transaction;
  fake.IDBDatabase.prototype.transaction = function(stores,mode,...args) {
    const tx = original.call(this, stores, mode, ...args);
    if ((stores === "chunks" || stores.includes?.("chunks")) && mode === "readwrite") queueMicrotask(() => tx.abort());
    return tx;
  };
  try {
    recording.line("RXB t_us=1 data=00 dt=0");
    const blob = await recording.export("raw");
    assert.equal(failures,1); assert.ok(recording.error);
    assert.equal(await blob.text(), "RXB t_us=1 data=00 dt=0\n");
  } finally {
    fake.IDBDatabase.prototype.transaction = original;
    await recording.finish({ valid: false });
  }
});

test("low available storage blocks capture before starting a writer", options, async () => {
  const previous = navigator.storage.estimate;
  navigator.storage.estimate = async () => ({ quota: 100, usage: 90 });
  try { await assert.rejects(createRecording("ALL"), /Less than 1 GB/); }
  finally { navigator.storage.estimate = previous; }
});

test("pending confirmation survives reopening and resolves once without changing evidence", async () => {
  const { resolveRecordingOutcome } = await import("../js/recording.js");
  for (const outcome of ["USER_CONFIRMED_IGNITION_OFF", "UNEXPECTED_ECU_SILENCE"]) {
    const rec = await createRecording("LIVE");
    rec.line("FAULT reason=19 cause=RX_SILENCE"); rec.line("END reason=19");
    const verdict = { valid: false, status: "INCOMPLETE", reasons: ["END reason=19"] };
    await rec.finish(verdict, { outcome: "OPERATOR_CONFIRMATION_PENDING", session: { variant: "LIVE", completedAt: 12 } });
    assert.equal((await listRecordings()).find(x => x.id === rec.id).outcome, "OPERATOR_CONFIRMATION_PENDING");
    const resolved = await resolveRecordingOutcome(rec.id, outcome, 1234);
    assert.equal(resolved.operatorConfirmation.confirmedAt, 1234);
    assert.equal(await resolveRecordingOutcome(rec.id, "UNEXPECTED_ECU_SILENCE"), null);
    const restored = (await listRecordings()).find(x => x.id === rec.id);
    assert.equal(restored.outcome, outcome); assert.deepEqual(restored.verdict, verdict);
    assert.equal(await (await recordingBlob(rec.id, "raw")).text(), "FAULT reason=19 cause=RX_SILENCE\nEND reason=19\n");
  }
});

test("storage failure cannot persist an ignition confirmation or a valid verdict", async () => {
  const recording = await createRecording("LIVE");
  const original = fake.IDBDatabase.prototype.transaction;
  fake.IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
    const tx = original.call(this, stores, mode, ...args);
    if ((stores === "chunks" || stores.includes?.("chunks")) && mode === "readwrite") queueMicrotask(() => tx.abort());
    return tx;
  };
  try {
    recording.line("END reason=19");
    await recording.finish({ valid: false, status: "INCOMPLETE" }, { outcome: "OPERATOR_CONFIRMATION_PENDING" });
    const saved = (await listRecordings()).find(item => item.id === recording.id);
    assert.equal(saved.outcome, "STORAGE_FAILURE");
    assert.equal(saved.verdict.valid, false);
  } finally { fake.IDBDatabase.prototype.transaction = original; }
});
