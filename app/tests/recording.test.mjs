import assert from "node:assert/strict";
import test from "node:test";
import * as fake from "fake-indexeddb";
import "./test-env.mjs";
import {
  attachRecordingAnalysis,
  createRecording,
  exportExperimentArchive,
  listRecordings,
  recordingBlob,
  saveRecordingNotes,
} from "../js/recording.js";
import { compareReferencePair } from "../js/capture-comparison.js";

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

test("editable notes and attached analysis export separately without changing capture metadata or raw checksum", options, async () => {
  const recording = await createRecording("DCL_EXPERIMENT");
  recording.line("RXB t_us=123456 data=72E126E0 dt=0,42500");
  recording.line("END reason=COMPLETE at_ms=9876");
  await recording.finish({ valid: true, status: "COMPLETE" });

  const rawBefore = new Uint8Array(await (await recordingBlob(recording.id, "raw")).arrayBuffer());
  const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const rawHashBefore = await hash(rawBefore);
  const listedBefore = (await listRecordings()).find(item => item.id === recording.id);
  const {
    notes: _notesBefore, analysis: _analysisBefore, analysisAttachedAt: _analysisTimeBefore,
    annotationsUpdatedAt: _notesTimeBefore, ...captureBefore
  } = listedBefore;

  await recording.updateNotes({ ignition: "ON", engine: "OFF", operatingConditions: "Key on, engine stopped." });
  await saveRecordingNotes(recording.id, { operatorObservations: "No decoded PID map.", comments: "Repeat at warm idle." });
  const analysis = compareReferencePair("260E-vs-26A4");
  await recording.attachAnalysis(analysis);
  assert.deepEqual(await recording.getNotes(), {
    ignition: "ON", engine: "OFF", operatingConditions: "Key on, engine stopped.",
    operatorObservations: "No decoded PID map.", comments: "Repeat at warm idle.",
  });
  assert.deepEqual((await listRecordings()).find(item => item.id === recording.id).analysis, analysis);
  await assert.rejects(saveRecordingNotes(recording.id, { ignition: "RUNNING" }), /ignition must be ON, OFF, or UNKNOWN/);

  const rawAfter = new Uint8Array(await (await recordingBlob(recording.id, "raw")).arrayBuffer());
  assert.deepEqual(rawAfter, rawBefore);
  assert.equal(await hash(rawAfter), rawHashBefore);
  const listedAfter = (await listRecordings()).find(item => item.id === recording.id);
  const {
    notes: _notesAfter, analysis: _analysisAfter, analysisAttachedAt: _analysisTimeAfter,
    annotationsUpdatedAt: _notesTimeAfter, ...captureAfter
  } = listedAfter;
  assert.deepEqual(captureAfter, captureBefore);

  const archive = await exportExperimentArchive(recording.id);
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
  assert.equal(await zip.file("raw.txt").async("uint8array").then(hash), rawHashBefore);
  assert.deepEqual(JSON.parse(await zip.file("notes.json").async("string")).notes, await recording.getNotes());
  assert.deepEqual(JSON.parse(await zip.file("analysis.json").async("string")).analysis, analysis);
  assert.equal(JSON.parse(await zip.file("metadata.json").async("string")).id, recording.id);
  const sumForRaw = (await zip.file("SHA256SUMS").async("string")).split("\n").find(line => line.endsWith("  raw.txt"));
  assert.equal(sumForRaw.split("  ")[0], rawHashBefore);
});

test("annotation APIs reject missing recordings and analysis that is not JSON data", async () => {
  await assert.rejects(attachRecordingAnalysis("not-a-recording", { verdict: "DIFFERENT" }), /Recording not-a-recording not found/);
  const recording = await createRecording("DCL_EXPERIMENT");
  try {
    await assert.rejects(recording.attachAnalysis("not-an-object"), /JSON object/);
  } finally {
    await recording.finish({ valid: false });
  }
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
