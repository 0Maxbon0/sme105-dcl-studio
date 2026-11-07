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

async function timestampsFor(lines) {
  const recording = await createRecording("ECU_STATUS");
  lines.forEach(line => recording.line(line));
  await recording.finish({ valid: true, status: "VALID" });
  const archive = await exportExperimentArchive(recording.id);
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await archive.blob.arrayBuffer());
  const csv = await zip.file("ro-timestamps.csv").async("text");
  return csv.trim().split("\n").slice(1).map(line => Number(line.split(",")[1]));
}

test("RXB timestamp addition wraps modulo uint32", async () => {
  assert.deepEqual(await timestampsFor([
    "RXB t_us=4294967290 data=AABBCC dt=0,10,20",
  ]), [4294967290, 4, 14]);
});

test("RXB handles multiple bytes and repeated uint32 rollovers", async () => {
  assert.deepEqual(await timestampsFor([
    "RXB t_us=4294967295 data=AABB dt=1,4294967297",
    "RXB t_us=4294967290 data=CCDD dt=10,4294967301",
  ]), [0, 0, 4, 4294967295]);
});

test("RX timestamps are normalized to uint32", async () => {
  assert.deepEqual(await timestampsFor(["RX t_us=4294967296 byte=AA"]), [0]);
});
