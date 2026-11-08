import assert from "node:assert/strict";
import test from "node:test";
import * as fake from "fake-indexeddb";
import JSZip from "jszip";
import "./test-env.mjs";
import { createRecording, exportDiscoveryPassArchive } from "../js/recording.js";

async function withFakeIndexedDB(run) {
  const previousIndexedDB = globalThis.indexedDB;
  const previousRange = globalThis.IDBKeyRange;
  globalThis.indexedDB = new fake.IDBFactory();
  globalThis.IDBKeyRange = fake.IDBKeyRange;
  try {
    return await run();
  } finally {
    if (previousIndexedDB === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = previousIndexedDB;
    if (previousRange === undefined) delete globalThis.IDBKeyRange;
    else globalThis.IDBKeyRange = previousRange;
  }
}

test("consolidated discovery ZIP includes the manifest, original IDs, raw captures, and verified checksums", async () => {
  const previousNavigator = globalThis.navigator;
  try {
    await withFakeIndexedDB(async () => {
      const first = await createRecording("ECU_STATUS", () => {}, "metric", {
        discoveryPassId: "pass-1", discoveryCandidateId: "ECU_STATUS", appVersion: "1.8.12",
      });
      first.line("EVENT session=READ_CANDIDATE");
      first.line("RX t_us=10 byte=01");
      first.line("END reason=16 ro_bytes=1 ro_lost=0 uart_errors=0 DE=LOW");
      await first.finish({ valid: true, status: "VALID", reasons: [], end: { reason: 16, ro_bytes: 1 } });

      const second = await createRecording("PIDMAP_ALT", () => {}, "metric", {
        discoveryPassId: "pass-1", discoveryCandidateId: "PIDMAP_ALT", appVersion: "1.8.12",
      });
      second.line("EVENT session=READ_CANDIDATE");
      second.line("END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 DE=LOW");
      await second.finish({ valid: true, status: "VALID", reasons: [], end: { reason: 16, ro_bytes: 0 } });

      const pass = {
        id: "pass-1", status: "complete", startedAt: 100, completedAt: 200,
        candidates: ["ECU_STATUS", "PIDMAP_ALT"],
        completed: [{ candidateId: "ECU_STATUS" }, { candidateId: "PIDMAP_ALT" }],
        failed: [], remaining: [], error: "",
        results: [
          { candidateId: "ECU_STATUS", variant: "ECU_STATUS", commandWord: "0381", recordingId: first.id, status: "VALID", responseBytes: 1, startedAt: 110, completedAt: 120, verdict: { status: "VALID", end: { reason: 16, ro_bytes: 1 } } },
          { candidateId: "PIDMAP_ALT", variant: "PIDMAP_ALT", commandWord: "004E", recordingId: second.id, status: "ZERO_RESPONSE", responseBytes: 0, startedAt: 130, completedAt: 140, verdict: { status: "VALID", end: { reason: 16, ro_bytes: 0 } } },
        ],
      };
      const archive = await exportDiscoveryPassArchive(pass, {
        appVersion: "1.8.12",
        firmwareIdentity: { identity: "SME105_USB_BRIDGE_V1", firmwareVersion: "24" },
      });
      const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
      const manifest = JSON.parse(await zip.file("discovery-manifest.json").async("text"));
      assert.equal(manifest.discoveryPassId, "pass-1");
      assert.equal(manifest.appVersion, "1.8.12");
      assert.equal(manifest.firmwareIdentity.firmwareVersion, "24");
      assert.deepEqual(manifest.originalRecordingIds, [first.id, second.id]);
      assert.equal(manifest.candidates[0].recordingId, first.id);
      assert.equal(manifest.candidates[1].status, "ZERO_RESPONSE");
      assert.equal(manifest.candidates[1].responseByteCount, 0);
      assert.ok(manifest.candidates.every(item => item.executionStartedAt != null && item.executionCompletedAt != null));
      const rawPath = manifest.candidates[0].files.rawCapture;
      assert.match(await zip.file(rawPath).async("text"), /RX t_us=10 byte=01/);
      const metadata = JSON.parse(await zip.file(manifest.candidates[0].files.recordingMetadata).async("text"));
      assert.equal(metadata.id, first.id);
      assert.equal(metadata.discoveryCandidateId, "ECU_STATUS");
      assert.equal(metadata.discoveryPassId, "pass-1");

      const sums = await zip.file("SHA256SUMS").async("text");
      assert.match(sums, /discovery-manifest\.json/);
      assert.match(sums, /captures\/01-ECU_STATUS\/raw\.txt/);
      for (const line of sums.trim().split("\n")) {
        const [expected, name] = line.split(/\s{2,}/);
        const bytes = await zip.file(name).async("uint8array");
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
        assert.equal(actual, expected, name);
        if (manifest.fileSha256[name]) assert.equal(manifest.fileSha256[name], actual, `manifest hash ${name}`);
      }
      assert.equal(archive.archiveSha.length, 64);
    });
  } finally {
    if (previousNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: previousNavigator });
  }
});

test("createRecording works when the navigator global is absent", async () => {
  const previousNavigator = globalThis.navigator;
  try {
    await withFakeIndexedDB(async () => {
      Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: undefined });
      const recording = await createRecording("ECU_STATUS", () => {}, "metric", {
        discoveryPassId: "pass-no-navigator", discoveryCandidateId: "ECU_STATUS", appVersion: "1.8.12",
      });
      recording.line("EVENT session=READ_CANDIDATE");
      recording.line("END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 DE=LOW");
      await recording.finish({ valid: true, status: "VALID", reasons: [], end: { reason: 16, ro_bytes: 0 } });
      assert.equal(recording.id.length > 0, true);
    });
  } finally {
    if (previousNavigator === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: previousNavigator });
  }
});
