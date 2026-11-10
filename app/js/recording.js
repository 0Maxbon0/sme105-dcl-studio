/** Chunked on-device recordings: retain every raw line and CSV row outside RAM. */
import { rowsToCsv } from "./pids.js";

const HEADER = rowsToCsv([]);
const activeRecordings = new Map();
const DEFAULT_EXPERIMENT_NOTES = Object.freeze({
  ignition: "UNKNOWN",
  engine: "UNKNOWN",
  operatingConditions: "",
  operatorObservations: "",
  comments: "",
});

/** `navigator` is absent in Node 18 and some headless runners; never reference it directly. */
function storageManager() {
  try {
    return typeof navigator !== "undefined" ? navigator.storage : undefined;
  } catch {
    return undefined;
  }
}
const WRITER_HEARTBEAT_MS = 5000;
const WRITER_LEASE_MS = 15000;
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
    request.onsuccess = () => resolve(request.result.map(capture => ({
      ...capture,
      notes: capture.notes ?? { ...DEFAULT_EXPERIMENT_NOTES },
      analysis: capture.analysis ?? null,
    })).sort((a,b) => (b.started || Date.parse(b.id) || 0) - (a.started || Date.parse(a.id) || 0) || b.id.localeCompare(a.id)));
    request.onerror = () => reject(request.error);
  });
}

function normalizeNotes(input = {}, existing = DEFAULT_EXPERIMENT_NOTES) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Experiment notes must be an object");
  const notes = {};
  for (const field of Object.keys(DEFAULT_EXPERIMENT_NOTES)) {
    const value = Object.prototype.hasOwnProperty.call(input, field) ? input[field] : existing[field];
    if (field === "ignition" || field === "engine") {
      if (!["ON", "OFF", "UNKNOWN"].includes(value)) throw new TypeError(`${field} must be ON, OFF, or UNKNOWN`);
      notes[field] = value;
    } else {
      if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
      notes[field] = value;
    }
  }
  return notes;
}

function copyAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Recording analysis must be a JSON object");
  let copy;
  try { copy = JSON.parse(JSON.stringify(value)); }
  catch { throw new TypeError("Recording analysis must contain only JSON data"); }
  return copy;
}

async function updateRecordingAnnotations(recordingId, update) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("captures", "readwrite");
    const store = transaction.objectStore("captures");
    const captureRequest = store.get(recordingId);
    let updated, failure;
    const fail = error => {
      reject(error);
    };
    captureRequest.onsuccess = () => {
      const capture = captureRequest.result;
      if (!capture) {
        failure = new Error(`Recording ${recordingId} not found`);
        transaction.abort();
        return;
      }
      try {
        updated = update({
          ...capture,
          notes: capture.notes ?? { ...DEFAULT_EXPERIMENT_NOTES },
          analysis: capture.analysis ?? null,
        });
        store.put(updated);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    captureRequest.onerror = () => { failure = transaction.error; transaction.abort(); };
    transaction.oncomplete = () => resolve(updated);
    transaction.onabort = transaction.onerror = () => fail(failure || transaction.error || new Error("Could not save recording annotations"));
  });
}

/** Return notes and attached analysis without changing the capture record or its raw chunks. */
export async function getRecordingAnnotations(recordingId) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("captures").objectStore("captures").get(recordingId);
    request.onsuccess = () => resolve({
      recordingId,
      notes: request.result?.notes ?? { ...DEFAULT_EXPERIMENT_NOTES },
      analysis: request.result?.analysis ?? null,
      analysisAttachedAt: request.result?.analysisAttachedAt ?? null,
      updatedAt: request.result?.annotationsUpdatedAt ?? null,
    });
    request.onerror = () => reject(request.error || new Error("Could not load recording annotations"));
  });
}

export async function getRecordingNotes(recordingId) {
  return (await getRecordingAnnotations(recordingId)).notes;
}

/** Update only the selected experiment-note fields; capture metadata and raw timestamps remain untouched. */
export async function saveRecordingNotes(recordingId, notes) {
  return updateRecordingAnnotations(recordingId, current => ({
    ...current,
    notes: normalizeNotes(notes, current.notes || DEFAULT_EXPERIMENT_NOTES),
    annotationsUpdatedAt: Date.now(),
  }));
}

/** Attach JSON comparison or other analysis separately from immutable capture evidence. */
export async function attachRecordingAnalysis(recordingId, analysis) {
  const copy = copyAnalysis(analysis);
  const attachedAt = Date.now();
  return updateRecordingAnnotations(recordingId, current => ({
    ...current,
    analysis: copy,
    analysisAttachedAt: attachedAt,
    annotationsUpdatedAt: attachedAt,
  }));
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

export async function createRecording(variant, onError = () => {}, unitSystem = "metric", extraMetadata = {}, writerContext = null) {
  const database = await db();
  let metadata;
  if (writerContext?.takeover) {
    metadata = writerContext.metadata;
  } else {
    const isContinuous = ["LIVE", "LIVE2", "LIVE3", "ALL"].includes(variant);
    const requiredSpace = isContinuous ? 1024 ** 3 : 20 * 1024 ** 2;
    let estimate = null;
    try { estimate = await storageManager()?.estimate?.(); } catch { estimate = null; }
    if (estimate && estimate.quota - estimate.usage < requiredSpace) {
      const msg = isContinuous
        ? "Less than 1 GB of recording space is available. Free phone storage before a long capture."
        : "Less than 20 MB of recording space is available. Free phone storage before starting an experiment.";
      throw new Error(msg);
    }
    // The browser decides whether persistence can be granted. No data is deleted.
    let persistent = false;
    try { persistent = !!(await storageManager()?.persist?.()); } catch { persistent = false; }
    const id = new Date().toISOString() + "-" + crypto.randomUUID();
    const writerToken = crypto.randomUUID();
    metadata = {
      id, sessionId: id, variant, persistent, unitSystem, started: Date.now(),
      ...extraMetadata,
      sequenceGaps: [],
      writerToken, writerHeartbeat: Date.now(), fencingGen: 1,
    };
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("captures", "readwrite");
      transaction.objectStore("captures").add(metadata);
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
    });
  }
  const { id, writerToken, fencingGen } = metadata;
  let recordedGaps = [...(metadata.sequenceGaps || [])];
  let raw = [], csv = [], pendingBytes = 0, seq = writerContext?.nextChunkSeq || 0, failure = null;
  let flushing = false, closed = false, finalizing = false, finishPromise = null, fenced = false;
  let fenceError = null;
  let inFlightHeartbeat = null, heartbeatStopped = false;
  let sampleCount = Number(metadata.sampleCount) || 0, duration = Number(metadata.duration) || 0;
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
    if (flushing || failure || fenced || !queue.length) return idle;
    flushing = true;
    idle = (async () => {
      while (queue.length && !failure && !fenced) {
        const chunk = queue[0];
        await new Promise(resolve => {
          const transaction = database.transaction(["captures", "chunks"], "readwrite");
          const captures = transaction.objectStore("captures");
          const request = captures.get(id);
          request.onsuccess = () => {
            const capture = request.result;
            if (!capture || capture.ended || capture.writerToken !== writerToken ||
                capture.fencingGen !== fencingGen) {
              fenced = true;
              fenceError = new Error("Recording writer was fenced; capture is no longer writable");
              transaction.abort();
              return;
            }
            transaction.objectStore("chunks").add(chunk);
          };
          transaction.oncomplete = () => { queue.shift(); resolve(); };
          transaction.onabort = transaction.onerror = () => {
            if (fenced) fail(fenceError);
            else fail(transaction.error || new Error("Recording chunk write failed"));
            resolve();
          };
        });
      }
    })().catch(fail).finally(() => { flushing = false; });
    return idle;
  }
  function heartbeat() {
    if (fenced || heartbeatStopped || (closed && !finalizing)) return Promise.resolve();
    let settleHeartbeat;
    const heartbeatPromise = new Promise(resolve => { settleHeartbeat = resolve; });
    inFlightHeartbeat = inFlightHeartbeat
      ? inFlightHeartbeat.then(() => heartbeatPromise, () => heartbeatPromise)
      : heartbeatPromise;

    try {
      const transaction = database.transaction("captures", "readwrite");
      const store = transaction.objectStore("captures");
      const request = store.get(id);
      request.onsuccess = () => {
        if (heartbeatStopped) return;
        const capture = request.result;
        if (!capture || capture.ended || capture.writerToken !== writerToken ||
            capture.fencingGen !== fencingGen) {
          fenced = true;
          fenceError = new Error("Recording writer was fenced; capture is no longer writable");
          heartbeatStopped = true;
          clearInterval(heartbeatTimer);
          fail(fenceError);
          return;
        }
        store.put({ ...capture, writerHeartbeat: Date.now() });
      };
      transaction.oncomplete = () => settleHeartbeat();
      transaction.onabort = transaction.onerror = () => {
        if (!fenced && !heartbeatStopped && (!closed || finalizing)) {
          fail(transaction.error || new Error("Recording heartbeat failed"));
        }
        settleHeartbeat();
      };
    } catch (err) {
      if (!fenced && !heartbeatStopped && (!closed || finalizing)) fail(err);
      settleHeartbeat();
    }
    return heartbeatPromise;
  }
  function checkBacklog(bytes) {
    pendingBytes += bytes;
    if (pendingBytes + queue.reduce((sum, chunk) => sum + chunk.bytes, 0) > 4 * 1024 ** 2)
      fail(new Error("Recording storage is too slow; capture stopped to preserve queued data"));
  }
  const timer = setInterval(flush, 1000);
  const heartbeatTimer = setInterval(heartbeat, WRITER_HEARTBEAT_MS);
  const recording = {
    ...metadata,
    get error() { return failure?.message || ""; },
    line(line) {
      if (closed || fenced) return;
      const verbatimLine = String(line);
      raw.push(verbatimLine + "\n"); checkBacklog(verbatimLine.length + 1);
    },
    sample(sample) {
      if (closed || fenced) return;
      sampleCount++; duration = Math.max(duration, sample.t || 0);
      const line = rowsToCsv([sample], { unitSystem }).slice(HEADER.length);
      csv.push(line); checkBacklog(line.length);
    },
    recordGap(lost, from, to) {
      if (closed || fenced) return null;
      const count = Number(lost);
      if (!Number.isSafeInteger(count) || count <= 0) return null;
      const first = from != null && Number.isSafeInteger(Number(from)) ? Number(from) : null;
      const last = to != null && Number.isSafeInteger(Number(to)) ? Number(to) : null;
      if (recordedGaps.some(gap => gap.lost === count && gap.from === first && gap.to === last)) return recordedGaps.find(gap => gap.lost === count && gap.from === first && gap.to === last);
      const gap = { lost: count, from: first, to: last, recordedAt: Date.now() };
      recordedGaps.push(gap);
      const line = `EVENT sequence_gap lost=${count} from=${first ?? "unknown"} to=${last ?? "unknown"}`;
      raw.push(`${line}\n`);
      checkBacklog(line.length + 1);
      return gap;
    },
    finish(verdict, outcomeDetails = {}) {
      if (finishPromise) return finishPromise;
      finalizing = true;
      closed = true;
      clearInterval(timer);
      finishPromise = (async () => {
        try {
          await flush();
          // Stop new heartbeat triggers once final chunk flushing is complete.
          heartbeatStopped = true;
          clearInterval(heartbeatTimer);

          // Wait for any heartbeat currently in flight to settle before final metadata commit.
          if (inFlightHeartbeat) {
            await inFlightHeartbeat;
          }

          if (fenced) throw fenceError || new Error("Recording writer was fenced; capture is no longer writable");
          // Preserve a final validity record beside the original received evidence.
          const transaction = database.transaction("captures", "readwrite");
          const store = transaction.objectStore("captures");
          const request = store.get(id);
          request.onsuccess = () => {
            const capture = request.result;
            if (!capture || capture.ended || capture.writerToken !== writerToken ||
                capture.fencingGen !== fencingGen) {
              fenced = true;
              fenceError = new Error("Recording writer was fenced; capture cannot be finalized");
              transaction.abort();
              return;
            }
            const suppliedVerdict = verdict || { valid: false, status: "INCOMPLETE", reasons: [] };
            const finalVerdict = failure
              ? { ...suppliedVerdict, valid: false, status: "INCOMPLETE", reasons: [...(suppliedVerdict.reasons || []), failure.message] }
              : suppliedVerdict.status === "INCOMPLETE"
                ? { ...suppliedVerdict, valid: false }
                : suppliedVerdict;
            store.put({
              ...capture, ...metadata, sampleCount, duration, sequenceGaps: recordedGaps,
              sequenceGapCount: recordedGaps.reduce((sum, gap) => sum + gap.lost, 0), verdict: finalVerdict,
              ...outcomeDetails, ...(failure ? { outcome: "STORAGE_FAILURE" } : {}),
              error: failure?.message || "", ended: Date.now(), writerToken: null,
              writerHeartbeat: null, fencingGen,
            });
          };
          await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onabort = transaction.onerror = () => reject(
              fenceError || transaction.error || new Error("Recording metadata write failed"),
            );
          });
        } finally {
          heartbeatStopped = true;
          clearInterval(heartbeatTimer);
          finalizing = false;
        }
      })();
      finishPromise.then(
        () => { if (activeRecordings.get(id) === activeEntry) activeRecordings.delete(id); },
        () => { if (activeRecordings.get(id) === activeEntry) activeRecordings.delete(id); },
      );
      return finishPromise;
    },
    async export(kind) {
      await flush();
      // A failed atomic write stays queued and can still be exported in this tab.
      const extras = queue.map(chunk => chunk[kind]);
      return recordingBlob(id, kind, extras);
    },
    getNotes() { return getRecordingNotes(id); },
    updateNotes(notes) { return saveRecordingNotes(id, notes); },
    attachAnalysis(analysis) { return attachRecordingAnalysis(id, analysis); },
    get closed() { return closed; },
    get sequenceGaps() { return [...recordedGaps]; },
  };
  const activeEntry = { recording, get finishPromise() { return finishPromise; } };
  activeRecordings.set(id, activeEntry);
  return recording;
}

/** Reopen an unfinished recording after the prior WebView writer has gone away. */
export async function takeoverRecording(id, onError = () => {}) {
  const active = activeRecordings.get(id);
  if (active && !active.recording.closed && !active.finishPromise) return active.recording;
  if (active?.finishPromise) throw new Error(`Recording ${id} is already finalizing`);

  const database = await db();
  const writerToken = crypto.randomUUID();
  const metadata = await new Promise((resolve, reject) => {
    const transaction = database.transaction("captures", "readwrite");
    const store = transaction.objectStore("captures");
    const request = store.get(id);
    let result = null;
    request.onsuccess = () => {
      const capture = request.result;
      if (!capture) {
        transaction.abort();
        reject(new Error(`Recording ${id} not found`));
        return;
      }
      if (capture.ended) {
        transaction.abort();
        reject(new Error(`Recording ${id} is already finalized`));
        return;
      }
      result = {
        ...capture,
        writerToken,
        writerHeartbeat: Date.now(),
        fencingGen: (Number(capture.fencingGen) || 0) + 1,
        writerTakeovers: (Number(capture.writerTakeovers) || 0) + 1,
        writerTakeoverAt: Date.now(),
      };
      store.put(result);
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error(`Recording ${id} could not be taken over`));
  });

  const nextChunkSeq = await new Promise((resolve, reject) => {
    const request = database.transaction("chunks").objectStore("chunks").index("capture").getAll(IDBKeyRange.only(id));
    request.onsuccess = () => resolve(request.result.reduce((next, chunk) => Math.max(next, Number(chunk.seq) + 1), 0));
    request.onerror = () => reject(request.error || new Error(`Recording ${id} chunks could not be read`));
  });
  return createRecording(metadata.variant, onError, metadata.unitSystem || "metric", {}, {
    takeover: true, metadata, nextChunkSeq,
  });
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
      const heartbeat = Number(capture.writerHeartbeat);
      const leaseFresh = Number.isFinite(heartbeat) && Date.now() - heartbeat < WRITER_LEASE_MS;
      if (!capture.ended && !leaseFresh) {
        const updated = {
          ...capture,
          fencingGen: (Number(capture.fencingGen) || 0) + 1,
          writerToken: null,
          writerHeartbeat: null,
          ended: Date.now(),
          recovered: true,
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

function addAnnotationFiles(files, folder, annotation) {
  const notesPath = `${folder}notes.json`;
  files.set(notesPath, new TextEncoder().encode(`${JSON.stringify({ recordingId: annotation.recordingId, notes: annotation.notes }, null, 2)}\n`));
  let analysisPath = null;
  if (annotation.analysis != null) {
    analysisPath = `${folder}analysis.json`;
    files.set(analysisPath, new TextEncoder().encode(`${JSON.stringify({
      recordingId: annotation.recordingId,
      attachedAt: annotation.analysisAttachedAt ?? null,
      analysis: annotation.analysis,
    }, null, 2)}\n`));
  }
  return { notes: notesPath, ...(analysisPath ? { analysis: analysisPath } : {}) };
}

function captureMetadataForExport(capture) {
  const { notes, analysis, analysisAttachedAt, annotationsUpdatedAt, ...metadata } = capture;
  return metadata;
}

/** Build an independent export archive for a single durable recording with verified SHA256SUMS. */
export async function exportExperimentArchive(id) {
  const active = activeRecordings.get(id);
  if (active?.finishPromise) await active.finishPromise;
  else if (active) throw new Error("Cannot export active or unfinalized recording " + id);

  const database = await db();
  const capture = await new Promise((resolve, reject) => {
    const tx = database.transaction("captures", "readonly");
    const req = tx.objectStore("captures").get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (!capture) throw new Error(`Recording ${id} not found`);
  if (!capture.ended) throw new Error("Cannot export active or unfinalized recording " + id);
  if (!capture.verdict) throw new Error("Cannot export recording without finalized verdict " + id);

  const annotations = await getRecordingAnnotations(id);
  const rawBlob = await recordingBlob(id, "raw");
  const rawBytes = new Uint8Array(await rawBlob.arrayBuffer());
  const rawText = new TextDecoder().decode(rawBytes);

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
        const tUs = parseInt(match[1], 10) >>> 0;
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
          const tUs = (baseUs + dt) >>> 0;
          roBytesList.push(byteVal);
          roTimestampsList.push(`${roIndex++},${tUs},${dataHex.slice(i, i + 2).toUpperCase()}`);
        }
      }
    }
  }

  const roBin = new Uint8Array(roBytesList);
  const metadataText = JSON.stringify(captureMetadataForExport(capture), null, 2) + "\n";
  const eventsText = eventLines.map(l => JSON.stringify({ line: l })).join("\n") + (eventLines.length ? "\n" : "");
  const txPadText = padLines.map(l => JSON.stringify({ line: l })).join("\n") + (padLines.length ? "\n" : "");
  const roTimestampsText = roTimestampsList.join("\n") + "\n";

  const files = new Map();
  files.set("metadata.json", new TextEncoder().encode(metadataText));
  files.set("raw.txt", rawBytes);
  files.set("events.jsonl", new TextEncoder().encode(eventsText));
  files.set("ro.bin", roBin);
  files.set("ro-timestamps.csv", new TextEncoder().encode(roTimestampsText));
  files.set("tx-pad.jsonl", new TextEncoder().encode(txPadText));
  const annotationPaths = addAnnotationFiles(files, "", annotations);

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

  return { blob: zipBlob, sha256Sums: shaText, archiveSha, id, capture, annotations, annotationPaths };
}

/** Bundle every finalized capture from one discovery pass with a verified manifest and checksums. */
export async function exportDiscoveryPassArchive(pass, { appVersion = "", firmwareIdentity = null } = {}) {
  if (!pass || !Array.isArray(pass.results) || !pass.results.length) throw new Error("No discovery pass captures are available to export.");
  if (pass.status === "running") throw new Error("Stop or finish the discovery pass before exporting it.");
  const recordings = new Map((await listRecordings()).map(item => [item.id, item]));
  const files = new Map();
  const manifestCandidates = [];

  for (let index = 0; index < pass.results.length; index += 1) {
    const result = pass.results[index];
    const recordingId = result.recordingId || null;
    let paths = null;
    if (recordingId) {
      const capture = recordings.get(recordingId);
      if (!capture) throw new Error(`Discovery recording ${recordingId} is missing from the archive.`);
      if (!capture.ended || !capture.verdict) throw new Error(`Discovery recording ${recordingId} is not finalized.`);
      const folder = `captures/${String(index + 1).padStart(2, "0")}-${String(result.candidateId || "candidate").replace(/[^A-Za-z0-9_-]/g, "_")}`;
      const rawPath = `${folder}/raw.txt`;
      const metadataPath = `${folder}/recording-metadata.json`;
      const annotation = await getRecordingAnnotations(recordingId);
      const annotationPaths = addAnnotationFiles(files, `${folder}/`, annotation);
      files.set(rawPath, new Uint8Array(await (await recordingBlob(recordingId, "raw")).arrayBuffer()));
      files.set(metadataPath, new TextEncoder().encode(`${JSON.stringify(captureMetadataForExport(capture), null, 2)}\n`));
      paths = { rawCapture: rawPath, recordingMetadata: metadataPath, ...annotationPaths };
    }
    manifestCandidates.push({
      ...result,
      recordingId,
      responseByteCount: Number(result.responseBytes ?? result.verdict?.end?.ro_bytes ?? 0),
      executionStartedAt: result.startedAt ?? null,
      executionCompletedAt: result.completedAt ?? null,
      files: paths,
    });
  }

  const checksums = {};
  for (const [name, bytes] of files) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    checksums[name] = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  const manifest = {
    schemaVersion: 1,
    discoveryPassId: pass.id,
    status: pass.status,
    startedAt: pass.startedAt,
    completedAt: pass.completedAt ?? null,
    summary: {
      candidateCount: pass.candidates?.length ?? manifestCandidates.length,
      completedCount: pass.completed?.length ?? 0,
      failedCount: pass.failed?.length ?? 0,
      remainingCount: pass.remaining?.length ?? 0,
      error: pass.error || "",
    },
    appVersion,
    firmwareIdentity,
    originalRecordingIds: manifestCandidates.map(item => item.recordingId).filter(Boolean),
    candidates: manifestCandidates,
    fileSha256: checksums,
  };
  files.set("discovery-manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));

  const checksumLines = [];
  const checksumMap = new Map();
  for (const [name, bytes] of files) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    checksumMap.set(name, hash);
    checksumLines.push(`${hash}  ${name}`);
  }
  const shaText = `${checksumLines.join("\n")}\n`;
  files.set("SHA256SUMS", new TextEncoder().encode(shaText));

  const JSZip = await getJSZip();
  const zip = new JSZip();
  for (const [name, bytes] of files) zip.file(name, bytes);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 5 } });
  const verifiedZip = await JSZip.loadAsync(await blob.arrayBuffer());
  for (const [name, expected] of checksumMap) {
    const entry = verifiedZip.file(name);
    if (!entry) throw new Error(`Discovery archive is missing ${name}`);
    const digest = await crypto.subtle.digest("SHA-256", await entry.async("uint8array"));
    const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== expected) throw new Error(`Discovery archive checksum verification failed for ${name}`);
  }
  const archiveDigest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const archiveSha = [...new Uint8Array(archiveDigest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { blob, archiveSha, sha256Sums: shaText, manifest };
}

/** Bundle every finalized experiment and procedure recording into a consolidated ZIP archive with verified checksums. */
export async function exportAllExperimentsArchive({ appVersion = "", firmwareIdentity = null } = {}) {
  const recordings = await listRecordings();
  const endedRecordings = recordings.filter(r => r.ended && r.verdict);
  if (!endedRecordings.length) throw new Error("No finalized experiment recordings are available to export.");

  const files = new Map();
  const manifestCandidates = [];

  for (let index = 0; index < endedRecordings.length; index += 1) {
    const capture = endedRecordings[index];
    const recordingId = capture.id;
    const folder = `captures/${String(index + 1).padStart(2, "0")}-${String(capture.variant || "experiment").replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const rawPath = `${folder}/raw.txt`;
    const metadataPath = `${folder}/recording-metadata.json`;
    const annotation = await getRecordingAnnotations(recordingId);
    const annotationPaths = addAnnotationFiles(files, `${folder}/`, annotation);
    files.set(rawPath, new Uint8Array(await (await recordingBlob(recordingId, "raw")).arrayBuffer()));
    files.set(metadataPath, new TextEncoder().encode(`${JSON.stringify(captureMetadataForExport(capture), null, 2)}\n`));
    manifestCandidates.push({
      recordingId,
      variant: capture.variant,
      status: capture.verdict?.status || (capture.ended ? "ENDED" : "UNKNOWN"),
      responseByteCount: Number(capture.verdict?.end?.ro_bytes ?? 0),
      executionStartedAt: capture.startedAt ?? null,
      executionCompletedAt: capture.endedAt ?? null,
      files: { rawCapture: rawPath, recordingMetadata: metadataPath, ...annotationPaths },
    });
  }

  const checksums = {};
  for (const [name, bytes] of files) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    checksums[name] = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  const manifest = {
    schemaVersion: 1,
    exportedAt: Date.now(),
    appVersion,
    firmwareIdentity,
    recordingCount: manifestCandidates.length,
    recordings: manifestCandidates,
    fileSha256: checksums,
  };
  files.set("experiment-manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));

  const checksumLines = [];
  const checksumMap = new Map();
  for (const [name, bytes] of files) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    checksumMap.set(name, hash);
    checksumLines.push(`${hash}  ${name}`);
  }
  const shaText = `${checksumLines.join("\n")}\n`;
  files.set("SHA256SUMS", new TextEncoder().encode(shaText));

  const JSZip = await getJSZip();
  const zip = new JSZip();
  for (const [name, bytes] of files) zip.file(name, bytes);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 5 } });
  const verifiedZip = await JSZip.loadAsync(await blob.arrayBuffer());
  for (const [name, expected] of checksumMap) {
    const entry = verifiedZip.file(name);
    if (!entry) throw new Error(`Experiment archive is missing ${name}`);
    const digest = await crypto.subtle.digest("SHA-256", await entry.async("uint8array"));
    const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    if (actual !== expected) throw new Error(`Experiment archive checksum verification failed for ${name}`);
  }
  const archiveDigest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const archiveSha = [...new Uint8Array(archiveDigest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return { blob, archiveSha, sha256Sums: shaText, manifest };
}
