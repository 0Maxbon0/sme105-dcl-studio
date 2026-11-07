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
    request.onsuccess = () => resolve(request.result.sort((a,b) => (b.started || Date.parse(b.id) || 0) - (a.started || Date.parse(a.id) || 0) || b.id.localeCompare(a.id)));
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

export async function createRecording(variant, onError = () => {}, unitSystem = "metric") {
  const database = await db();
  const isContinuous = ["LIVE", "LIVE2", "LIVE3", "ALL"].includes(variant);
  const requiredSpace = isContinuous ? 1024 ** 3 : 20 * 1024 ** 2;
  const estimate = await navigator.storage?.estimate?.();
  if (estimate && estimate.quota - estimate.usage < requiredSpace) {
    const msg = isContinuous
      ? "Less than 1 GB of recording space is available. Free phone storage before a long capture."
      : "Less than 20 MB of recording space is available. Free phone storage before starting an experiment.";
    throw new Error(msg);
  }
  // The browser decides whether persistence can be granted. No data is deleted.
  const persistent = await navigator.storage?.persist?.().catch(() => false) || false;
  const id = new Date().toISOString() + "-" + crypto.randomUUID();
  const metadata = { id, sessionId: id, variant, persistent, unitSystem, started: Date.now() };
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("captures", "readwrite");
    transaction.objectStore("captures").add(metadata);
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
  let raw = [], csv = [], pendingBytes = 0, seq = 0, failure = null;
  let flushing = false, closed = false, finishTask = null;
  let sampleCount = 0, duration = 0;
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
    line(line) {
      if (closed) return;
      const verbatimLine = String(line);
      raw.push(verbatimLine + "\n"); checkBacklog(verbatimLine.length + 1);
    },
    sample(sample) {
      if (closed) return;
      sampleCount++; duration = Math.max(duration, sample.t || 0);
      const line = rowsToCsv([sample], { unitSystem }).slice(HEADER.length);
      csv.push(line); checkBacklog(line.length);
    },
    finish(verdict, outcomeDetails = {}) {
      if (finishTask) return finishTask;
      closed = true; clearInterval(timer);
      finishTask = (async () => {
        await flush();
        // Preserve a final validity record beside the original received evidence.
        const transaction = database.transaction("captures", "readwrite");
        transaction.objectStore("captures").put({ ...metadata, sampleCount, duration, verdict: failure ? { ...verdict, valid: false, status: "INCOMPLETE", reasons: [...(verdict.reasons || []), failure.message] } : verdict, ...outcomeDetails, ...(failure ? { outcome: "STORAGE_FAILURE" } : {}), error: failure?.message || "", ended: Date.now() });
        await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Recording metadata write failed")); });
      })();
      return finishTask;
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

// Resolve once in a single transaction; raw chunks and the integrity verdict never change.
export async function resolveRecordingOutcome(id, outcome, confirmedAt = Date.now()) {
  if (!["USER_CONFIRMED_IGNITION_OFF", "UNEXPECTED_ECU_SILENCE"].includes(outcome)) throw new Error("Invalid operator response");
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("captures", "readwrite");
    const store = tx.objectStore("captures");
    const request = store.get(id);
    let updated = null;
    request.onsuccess = () => {
      const item = request.result;
      if (item?.outcome !== "OPERATOR_CONFIRMATION_PENDING") return;
      updated = { ...item, outcome, operatorConfirmation: { outcome, answer: outcome === "USER_CONFIRMED_IGNITION_OFF" ? "yes" : "no", confirmedAt, source: "operator" } };
      store.put(updated);
    };
    tx.oncomplete = () => resolve(updated);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error("Could not save operator response"));
  });
}

/** Scan IndexedDB captures at boot and mark any unended/interrupted capture as incomplete. */
export async function recoverInterruptedRecordings() {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("captures", "readwrite");
    const store = tx.objectStore("captures");
    const request = store.openCursor();
    let recoveredCount = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const capture = cursor.value;
      if (!capture.ended) {
        const updated = {
          ...capture,
          ended: Date.now(),
          verdict: {
            valid: false,
            status: "INCOMPLETE",
            reasons: ["Abnormal session termination / crash"],
            witnessStatus: "LEGACY_UNVERIFIED",
            verifiedSuccess: false,
            end: null,
          },
          error: "Abnormal session termination / crash",
        };
        cursor.update(updated);
        recoveredCount++;
      }
      cursor.continue();
    };
    tx.oncomplete = () => resolve(recoveredCount);
    tx.onabort = tx.onerror = () => reject(tx.error || new Error("Crash recovery transaction failed"));
  });
}

async function getJSZip() {
  if (typeof window !== "undefined" && window.JSZip) return window.JSZip;
  try {
    const mod = await import("jszip");
    return mod.default || mod;
  } catch {
    throw new Error("Offline ZIP library is unavailable");
  }
}

/** Build an independent export archive for a single durable recording with verified SHA256SUMS. */
export async function exportExperimentArchive(id) {
  const database = await db();
  const capture = await new Promise((resolve, reject) => {
    const tx = database.transaction("captures", "readonly");
    const req = tx.objectStore("captures").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!capture) throw new Error(`Recording ${id} not found`);

  const rawBlob = await recordingBlob(id, "raw");
  const rawText = await rawBlob.text();

  const lines = rawText.split("\n");
  const padLines = [];
  const eventLines = [];
  const roBytesList = [];
  const roTimestampsList = ["index,t_us,byte_hex"];

  let roIndex = 0;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("TX_PAD ")) {
      padLines.push(line);
    } else if (
      line.startsWith("EVENT ") || line.startsWith("FAULT ") ||
      line.startsWith("DENIED ") || line.startsWith("END ") ||
      line.startsWith("STATUS ") || line.startsWith("PINS ") ||
      line.startsWith("BOOT ") || line.startsWith("HELLO ")
    ) {
      eventLines.push(line);
    }
    if (line.startsWith("RX ")) {
      const match = /^RX t_us=(\d+) byte=([0-9A-Fa-f]{2})/.exec(line);
      if (match) {
        const tUs = match[1];
        const hex = match[2].toUpperCase();
        roBytesList.push(parseInt(hex, 16));
        roTimestampsList.push(`${roIndex++},${tUs},${hex}`);
      }
    } else if (line.startsWith("RXB ")) {
      const match = /^RXB t_us=(\d+) data=([0-9A-Fa-f]+)(?: dt=([0-9,]+))?/.exec(line);
      if (match) {
        const baseUs = parseInt(match[1], 10);
        const dataHex = match[2];
        const dts = match[3] ? match[3].split(",").map(Number) : [];
        for (let i = 0; i < dataHex.length; i += 2) {
          const byteVal = parseInt(dataHex.slice(i, i + 2), 16);
          const dt = dts[i / 2] || 0;
          roBytesList.push(byteVal);
          roTimestampsList.push(`${roIndex++},${baseUs + dt},${dataHex.slice(i, i + 2).toUpperCase()}`);
        }
      }
    }
  }

  const roBin = new Uint8Array(roBytesList);
  const metadataText = JSON.stringify(capture, null, 2) + "\n";
  const eventsText = eventLines.map(l => JSON.stringify({ line: l })).join("\n") + (eventLines.length ? "\n" : "");
  const txPadText = padLines.map(l => JSON.stringify({ line: l })).join("\n") + (padLines.length ? "\n" : "");
  const roTimestampsText = roTimestampsList.join("\n") + "\n";

  const files = new Map();
  files.set("metadata.json", new TextEncoder().encode(metadataText));
  files.set("raw.txt", new TextEncoder().encode(rawText));
  files.set("events.jsonl", new TextEncoder().encode(eventsText));
  files.set("ro.bin", roBin);
  files.set("ro-timestamps.csv", new TextEncoder().encode(roTimestampsText));
  files.set("tx-pad.jsonl", new TextEncoder().encode(txPadText));

  const shaLines = [];
  const checksumMap = new Map();
  for (const [name, data] of files) {
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    checksumMap.set(name, hash);
    shaLines.push(`${hash}  ${name}`);
  }
  const shaText = shaLines.join("\n") + "\n";
  files.set("SHA256SUMS", new TextEncoder().encode(shaText));

  const JSZip = await getJSZip();
  const zip = new JSZip();
  for (const [name, data] of files) {
    zip.file(name, data);
  }
  const zipBlob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 5 },
  });

  // Verification: read all files from the generated ZIP and verify SHA256SUMS
  const verifiedZip = await JSZip.loadAsync(await zipBlob.arrayBuffer());
  for (const [name, expectedHash] of checksumMap) {
    const fileEntry = verifiedZip.file(name);
    if (!fileEntry) throw new Error(`Generated archive missing file ${name}`);
    const fileData = await fileEntry.async("uint8array");
    const digest = await crypto.subtle.digest("SHA-256", fileData);
    const actualHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (actualHash !== expectedHash) {
      throw new Error(`Integrity verification failed for ${name} in experiment archive`);
    }
  }

  const shaDigest = await crypto.subtle.digest("SHA-256", await zipBlob.arrayBuffer());
  const archiveSha = [...new Uint8Array(shaDigest)].map(b => b.toString(16).padStart(2, "0")).join("");

  return { blob: zipBlob, sha256Sums: shaText, archiveSha, id, capture };
}
