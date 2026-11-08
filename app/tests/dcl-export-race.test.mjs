import assert from "node:assert/strict";
import test from "node:test";
import * as fake from "fake-indexeddb";
import "./test-env.mjs";
import { createRecording, exportExperimentArchive } from "../js/recording.js";

globalThis.indexedDB = new fake.IDBFactory();
globalThis.IDBKeyRange = fake.IDBKeyRange;
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: {
  estimate: async () => ({ quota: 10 * 1024 ** 3, usage: 0 }), persist: async () => true,
} } });

async function zipFiles(blob) {
  const JSZip = (await import("jszip")).default;
  return JSZip.loadAsync(await blob.arrayBuffer());
}

test("export API rejects an active capture until finalization", async () => {
  const recording = await createRecording("ECU_STATUS");
  await assert.rejects(exportExperimentArchive(recording.id), new RegExp(`active or unfinalized recording ${recording.id}`));
  await recording.finish({ valid: false, status: "INCOMPLETE" });
});

test("export started during finish waits for the same finalization promise", async () => {
  const recording = await createRecording("PIDMAP");
  recording.line("EVENT session=READ_CANDIDATE");
  const original = fake.IDBDatabase.prototype.transaction;
  let release;
  let signalFinalized;
  const gate = new Promise(resolve => { release = resolve; });
  const finalizing = new Promise(resolve => { signalFinalized = resolve; });
  fake.IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
    const tx = original.call(this, stores, mode, ...args);
    if (stores === "captures" && mode === "readwrite") {
      let callback = null;
      Object.defineProperty(tx, "oncomplete", {
        configurable: true,
        get() { return callback; },
        set(handler) {
          callback = handler && (event => {
            signalFinalized();
            gate.then(() => handler.call(tx, event));
          });
        },
      });
    }
    return tx;
  };
  try {
    const finishPromise = recording.finish({ valid: true, status: "VALID" });
    assert.equal(recording.finish({ valid: false }), finishPromise);
    await finalizing;
    let settled = false;
    const exportPromise = exportExperimentArchive(recording.id).finally(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "archive must wait for the in-memory finish promise");
    release();
    const result = await exportPromise;
    await finishPromise;
    assert.ok(result.capture.ended);
    assert.equal(result.capture.verdict.status, "VALID");
  } finally {
    release();
    fake.IDBDatabase.prototype.transaction = original;
  }
});

test("export immediately after completion contains consistent metadata and exact evidence bytes", async () => {
  const recording = await createRecording("ECU_STATUS");
  const lines = [
    "EVENT session=READ_CANDIDATE",
    "RX t_us=10 byte=AA",
    "RXB t_us=4294967290 data=BBCC dt=10,20",
    "END reason=15 ro_bytes=3",
  ];
  lines.forEach(line => recording.line(line));
  await recording.finish({ valid: true, status: "VALID", end: { reason: 15 } });
  const archive = await exportExperimentArchive(recording.id);
  const zip = await zipFiles(archive.blob);
  const metadata = JSON.parse(await zip.file("metadata.json").async("text"));
  assert.equal(metadata.id, recording.id);
  assert.equal(metadata.variant, "ECU_STATUS");
  assert.ok(metadata.ended);
  assert.deepEqual(metadata.verdict, { valid: true, status: "VALID", end: { reason: 15 } });
  assert.deepEqual(await zip.file("raw.txt").async("uint8array"), new TextEncoder().encode(`${lines.join("\n")}\n`));
  assert.deepEqual(await zip.file("ro.bin").async("uint8array"), new Uint8Array([0xaa, 0xbb, 0xcc]));
});

test("a completed capture remains exportable while a different capture is active", async () => {
  const oldProbe = await createRecording("ECU_STATUS");
  oldProbe.line("END reason=15");
  await oldProbe.finish({ valid: true, status: "VALID" });
  const activeProbe = await createRecording("PIDMAP");
  const oldArchive = await exportExperimentArchive(oldProbe.id);
  assert.equal(oldArchive.capture.id, oldProbe.id);
  await assert.rejects(exportExperimentArchive(activeProbe.id), /active or unfinalized/);
  await activeProbe.finish({ valid: false, status: "INCOMPLETE" });
});

test("missing recording ID and failed finalization reject export clearly", async () => {
  await assert.rejects(exportExperimentArchive("missing-recording"), /Recording missing-recording not found/);
  const recording = await createRecording("DMRMAP");
  const original = fake.IDBDatabase.prototype.transaction;
  fake.IDBDatabase.prototype.transaction = function(stores, mode, ...args) {
    const tx = original.call(this, stores, mode, ...args);
    if (stores === "captures" && mode === "readwrite") queueMicrotask(() => tx.abort());
    return tx;
  };
  try {
    const finishPromise = recording.finish({ valid: true, status: "VALID" });
    await assert.rejects(exportExperimentArchive(recording.id), /Recording metadata write failed/);
    await assert.rejects(finishPromise, /Recording metadata write failed/);
  } finally {
    fake.IDBDatabase.prototype.transaction = original;
  }
});
