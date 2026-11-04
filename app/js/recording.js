/** Chunked on-device recordings: retain every raw line and CSV row outside RAM. */
import { rowsToCsv } from "./pids.js";

const HEADER = rowsToCsv([]);
let database;
function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open("eeciv-recordings", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("captures", { keyPath: "id" });
      request.result.createObjectStore("chunks", { keyPath: ["id", "seq"] }).createIndex("capture", "id");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Recording storage is blocked by another app tab"));
  });
  return database;
}

export async function listRecordings() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("captures").objectStore("captures").getAll();
    request.onsuccess = () => resolve(request.result.sort((a,b) => b.id.localeCompare(a.id)));
    request.onerror = () => reject(request.error);
  });
}

export async function recordingBlob(id, kind, extras = []) {
  const database = await db();
  const parts = kind === "csv" ? [HEADER] : [];
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("chunks");
    const request = transaction.objectStore("chunks").index("capture").openCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      parts.push(cursor.value[kind]);
      cursor.continue();
    };
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  return new Blob([...parts, ...extras], { type: kind === "csv" ? "text/csv" : "text/plain" });
}

export async function createRecording(variant, onError = () => {}) {
  const database = await db();
  const estimate = await navigator.storage?.estimate?.();
  if (estimate && estimate.quota - estimate.usage < 1024 ** 3) {
    throw new Error("Less than 1 GB of recording space is available. Free phone storage before a long capture.");
  }
  // The browser decides whether persistence can be granted. No data is deleted.
  const persistent = await navigator.storage?.persist?.().catch(() => false) || false;
  const id = new Date().toISOString() + "-" + crypto.randomUUID();
  const metadata = { id, variant, persistent, started: Date.now() };
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("captures", "readwrite");
    transaction.objectStore("captures").add(metadata);
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  let raw = [], csv = [], pendingBytes = 0, seq = 0, failure = null;
  let flushing = false, closed = false;
  const queue = [];
  let idle = Promise.resolve();
  const fail = error => {
    if (failure) return;
    failure = error || new Error("Recording storage failed");
    onError(failure);
  };
  function enqueue() {
    if (!raw.length && !csv.length) return;
    const chunk = { id, seq: seq++, raw: new Blob(raw), csv: new Blob(csv), bytes: pendingBytes };
    raw = []; csv = []; pendingBytes = 0;
    queue.push(chunk);
  }
  function flush() {
    enqueue();
    if (flushing || failure || !queue.length) return idle;
    flushing = true;
    idle = (async () => {
      while (queue.length && !failure) {
        const chunk = queue[0];
        await new Promise(resolve => {
          const transaction = database.transaction("chunks", "readwrite");
          transaction.objectStore("chunks").add(chunk);
          transaction.oncomplete = () => { queue.shift(); resolve(); };
          transaction.onabort = () => { fail(transaction.error); resolve(); };
        });
      }
    })().catch(fail).finally(() => { flushing = false; });
    return idle;
  }
  function checkBacklog(bytes) {
    pendingBytes += bytes;
    if (pendingBytes + queue.reduce((sum, chunk) => sum + chunk.bytes, 0) > 4 * 1024 ** 2)
      fail(new Error("Recording storage is too slow; capture stopped to preserve queued data"));
  }
  const timer = setInterval(flush, 1000);
  return {
    ...metadata,
    get error() { return failure?.message || ""; },
    line(line) { raw.push(line + "\n"); checkBacklog(line.length + 1); },
    sample(sample) {
      const line = rowsToCsv([sample]).slice(HEADER.length);
      csv.push(line); checkBacklog(line.length);
    },
    async finish(verdict) {
      closed = true; clearInterval(timer);
      await flush();
      // Preserve a final validity record beside the original received evidence.
      const transaction = database.transaction("captures", "readwrite");
      transaction.objectStore("captures").put({ ...metadata, verdict, error: failure?.message || "", ended: Date.now() });
      transaction.onerror = () => fail(transaction.error);
    },
    async export(kind) {
      await flush();
      // A failed atomic write stays queued and can still be exported in this tab.
      const extras = queue.map(chunk => chunk[kind]);
      return recordingBlob(id, kind, extras);
    },
    get closed() { return closed; },
  };
}
