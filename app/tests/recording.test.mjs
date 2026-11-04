import assert from "node:assert/strict";
import test from "node:test";
import { createRecording, listRecordings, recordingBlob } from "../js/recording.js";

// No browser/product dependency: point this to a temporary fake-indexeddb
// installation to exercise native IndexedDB transactions under Node.
const modulePath = process.env.FAKE_INDEXEDDB_MODULE;
let fake;
if (modulePath) {
  fake = await import(modulePath);
  globalThis.indexedDB = new fake.IDBFactory();
  globalThis.IDBKeyRange = fake.IDBKeyRange;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: {
    estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }),
    persist: async () => true,
  } } });
}
const options = { skip: !modulePath && "Set FAKE_INDEXEDDB_MODULE to a temporary fake-indexeddb ESM installation" };

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

test("a failed atomic write stops recording and retains its queued data for export", options, async () => {
  let failures = 0;
  const recording = await createRecording("ALL", () => failures++);
  const original = fake.IDBDatabase.prototype.transaction;
  fake.IDBDatabase.prototype.transaction = function(stores,mode,...args) {
    const tx = original.call(this, stores, mode, ...args);
    if (stores === "chunks" && mode === "readwrite") queueMicrotask(() => tx.abort());
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
