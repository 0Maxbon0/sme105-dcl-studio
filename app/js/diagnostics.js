/** Private, append-only per-app-run evidence journal backed by IndexedDB. */
import { APP_VERSION } from "./protocol.js";
import { PIDS } from "./pids.js";

const DB_NAME = "sme105-diagnostics";
const DB_VERSION = 1;
const WRITE_BATCH_SIZE = 128;
const MAX_PENDING_WRITES = 4096;
const WRITE_FLUSH_MS = 80;
let database;
let run = null;
let sequence = 0;
let pendingWrites = [];
let flushTimer = null;
let flushTask = null;
let storageError = null;
let onStorageError = () => {};
const openedAt = globalThis.performance?.now?.() ?? Date.now();
const unsaved = { events: [], raw: [], samples: [], warnings: [] };
const PID_BY_NAME = new Map(Object.entries(PIDS).map(([pid, definition]) => [definition[0], pid]));

export function redactDiagnostic(value, key = "") {
  if (/passkey|pairing.?code|pin.?code/i.test(key)) return "[REDACTED_PASSKEY]";
  if (/ssid|wifi.?name/i.test(key)) return "[REDACTED_WIFI_SECRET]";
  if (/psk|password|wifi.?key/i.test(key)) return "[REDACTED_WIFI_SECRET]";
  if (/imei|android.?id|device.?id|mac.?address/i.test(key)) return "[REDACTED_DEVICE_ID]";
  if (Array.isArray(value)) return value.map(item => redactDiagnostic(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDiagnostic(v, k)]));
  if (typeof value !== "string") return value;
  return value
    .replace(/\b(?:passkey|pairing(?:\s+code)?|pin)\s*[:= ]\s*\d{4,8}\b/gi, "[REDACTED_PASSKEY]")
    .replace(/\b(?:ssid|wifi[_ -]?name)\s*[:=]\s*[^,;\s]+/gi, "[REDACTED_WIFI_SECRET]")
    .replace(/\b(?:psk|password|wifi[_ -]?(?:key|password))\s*[:=]\s*[^,;\s]+/gi, "[REDACTED_WIFI_SECRET]")
    .replace(/\b(?:imei|android[_ -]?id|device[_ -]?id|mac(?:[_ -]?address)?)\s*[:=]\s*[^,;\s]+/gi, "[REDACTED_DEVICE_ID]")
    .replace(/\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi, "[REDACTED_DEVICE_ID]")
    .replace(/\b(?:pair|pairing|passkey|pin)\b[^\n]{0,32}\b\d{6}\b/gi, "[REDACTED_PASSKEY]")
    .replace(/(?:\/home\/|\/media\/)[^\s]+/g, "[LOCAL_PATH]")
    .replace(/[A-Z]:\\Users\\[^\s]+/gi, "[LOCAL_PATH]");
}

function db() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const value = request.result;
      value.createObjectStore("runs", { keyPath: "id" });
      const events = value.createObjectStore("events", { keyPath: "id", autoIncrement: true });
      events.createIndex("runId", "runId");
      const raw = value.createObjectStore("raw", { keyPath: "id", autoIncrement: true });
      raw.createIndex("runId", "runId");
      const samples = value.createObjectStore("samples", { keyPath: "id", autoIncrement: true });
      samples.createIndex("runId", "runId");
      const warnings = value.createObjectStore("warnings", { keyPath: "id" });
      warnings.createIndex("runId", "runId");
      warnings.createIndex("key", "key");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Diagnostic storage is blocked by another open app copy"));
  });
  return database;
}

function done(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Diagnostic storage write failed"));
  });
}

function common() {
  const now = Date.now();
  const elapsed = (globalThis.performance?.now?.() ?? now) - openedAt;
  return {
    runId: run?.id || "",
    utc: new Date(now).toISOString(),
    monotonic_us: Math.max(0, Math.round(elapsed * 1000)),
    appBuild: APP_VERSION,
  };
}

export function setDiagnosticStorageErrorHandler(handler = () => {}) { onStorageError = handler; }

function retainUnsaved(operation) {
  for (const [store, values] of Object.entries(operation.fallback || {})) unsaved[store].push(...values);
}

function stopQueue(error, current = []) {
  if (!storageError) {
    storageError = error;
    onStorageError(error);
  }
  for (const operation of [...current, ...pendingWrites]) {
    retainUnsaved(operation);
    operation.resolve?.(false);
  }
  pendingWrites = [];
}

function queueOperation(operation) {
  if (!run || storageError) return Promise.resolve(false);
  const result = new Promise(resolve => { operation.resolve = resolve; });
  if (pendingWrites.length >= MAX_PENDING_WRITES) {
    stopQueue(new Error(`Diagnostic journal backlog reached ${MAX_PENDING_WRITES} writes; capture stopped to protect readings.`), [operation]);
    return result;
  }
  pendingWrites.push(operation);
  if (pendingWrites.length >= WRITE_BATCH_SIZE) void flushDiagnosticQueue();
  else if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; void flushDiagnosticQueue(); }, WRITE_FLUSH_MS);
  return result;
}

async function processWrites(batch) {
  for (let index = 0; index < batch.length && !storageError;) {
    const operation = batch[index];
    if (!operation.stores) {
      try { operation.resolve(await operation.run()); }
      catch (error) { stopQueue(error, batch.slice(index)); return false; }
      index += 1;
      continue;
    }

    let end = index + 1;
    const stores = new Set(operation.stores);
    while (end < batch.length && batch[end].stores && end - index < WRITE_BATCH_SIZE) {
      for (const store of batch[end].stores) stores.add(store);
      end += 1;
    }
    const group = batch.slice(index, end);
    try {
      const transaction = (await db()).transaction([...stores], "readwrite");
      for (const item of group) item.write(transaction);
      await done(transaction);
      group.forEach(item => item.resolve(true));
    } catch (error) {
      stopQueue(error, batch.slice(index));
      return false;
    }
    index = end;
  }
  return !storageError;
}

function flushDiagnosticQueue() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (flushTask) return flushTask;
  if (!pendingWrites.length) return Promise.resolve(!storageError);
  flushTask = (async () => {
    while (pendingWrites.length && !storageError) {
      const batch = pendingWrites.splice(0);
      if (!await processWrites(batch)) break;
    }
    return !storageError;
  })().finally(() => {
    flushTask = null;
    if (pendingWrites.length && !storageError) void flushDiagnosticQueue();
  });
  return flushTask;
}

export async function startDiagnosticRun() {
  await flushDiagnosticQueue();
  const database = await db();
  const prior = await new Promise((resolve, reject) => {
    const request = database.transaction("runs").objectStore("runs").getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  for (const old of prior.filter(item => !item.closedAt)) {
    const record = { ...common(), runId: old.id, id: undefined, sequence: null, category: "lifecycle", type: "SESSION_ABNORMAL_TERMINATION", detail: { discoveredOnLaunch: true } };
    delete record.id;
    const transaction = database.transaction(["runs", "events"], "readwrite");
    transaction.objectStore("events").add(record);
    transaction.objectStore("runs").put({ ...old, closedAt: Date.now(), status: "INCOMPLETE" });
    await done(transaction);
  }
  run = { id: crypto.randomUUID(), startedAt: Date.now(), closedAt: null, status: "OPEN", appBuild: APP_VERSION };
  sequence = 0;
  storageError = null;
  unsaved.events.length = unsaved.raw.length = unsaved.samples.length = unsaved.warnings.length = 0;
  const transaction = database.transaction("runs", "readwrite");
  transaction.objectStore("runs").add(run);
  await done(transaction);
  await recordDiagnosticEvent("SESSION_START", { source: "app-launch" }, "lifecycle");
  return run;
}

export function recordDiagnosticEvent(type, detail = {}, category = "app") {
  if (!run) return Promise.resolve(false);
  const record = { ...common(), sequence: ++sequence, category, type, detail: redactDiagnostic(detail) };
  return queueOperation({ stores: ["events"], fallback: { events: [record] },
    write(transaction) { transaction.objectStore("events").add(record); } });
}

export function recordBridgeRaw(line) {
  if (!run) return Promise.resolve(false);
  const value = { ...common(), line: redactDiagnostic(String(line)) };
  return queueOperation({ stores: ["raw"], fallback: { raw: [value] },
    write(transaction) { transaction.objectStore("raw").add(value); } });
}

export function recordDiagnosticSample(sample, context = {}) {
  if (!run) return Promise.resolve(false);
  const pid = PID_BY_NAME.get(sample.name);
  const value = { ...common(), pid: pid ? `0x${Number(pid).toString(16).padStart(2, "0").toUpperCase()}` : "",
    name: sample.name, variant: context.variant || "", t_s: sample.t, raw: sample.raw, value: sample.value, unit: sample.unit,
    receivedAt: sample.receivedAt ?? Date.now(), validity: "received", timeBasis: "ECU-relative" };
  return queueOperation({ stores: ["samples"], fallback: { samples: [value] },
    write(transaction) { transaction.objectStore("samples").add(value); } });
}

export async function recordDiagnosticWarning(key, active, warning) {
  if (!run) return false;
  const eventSequence = ++sequence;
  const stamp = common();
  const event = { ...stamp, sequence: eventSequence, category: "warning",
    type: active ? "WARNING_TRIGGERED" : "WARNING_RESOLVED", detail: { key, active,
      severity: warning?.severity || "", sensor: warning?.sensor || "", ruleId: warning?.ruleId || "",
      reason: redactDiagnostic(warning?.reason || ""), source: redactDiagnostic(warning?.source || ""),
      evidence: redactDiagnostic(warning?.evidence || {}) } };
  return queueOperation({ fallback: { events: [event] }, run: async () => {
    const database = await db();
    const transaction = database.transaction(["events", "warnings"], "readwrite");
    const completed = done(transaction);
    const warnings = transaction.objectStore("warnings");
    const matches = await new Promise((resolve, reject) => {
      const request = warnings.index("key").getAll(key);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const previous = matches.find(item => item.active) || null;
    if (active && previous) { await completed; return previous; }
    if (!active && !previous) { await completed; return null; }
    const writeStamp = common();
    const item = active
      ? { id: `${run.id}:${key}:${writeStamp.monotonic_us}`, ...writeStamp, triggeredRunId: run.id, key, active,
        severity: warning.severity, sensor: warning.sensor || "", ruleId: warning.ruleId || "",
        reason: redactDiagnostic(warning.reason || ""), source: redactDiagnostic(warning.source || ""),
        evidence: redactDiagnostic(warning.evidence || {}), triggeredAt: writeStamp.utc, resolvedAt: null }
      : { ...previous, ...writeStamp, runId: run.id, resolvedRunId: run.id, active: false, resolvedAt: writeStamp.utc };
    warnings.put(item);
    transaction.objectStore("events").add({ ...event, detail: item });
    await completed;
    return item;
  } });
}

export async function closeDiagnosticRun(reason = "pagehide") {
  if (!run || run.closedAt) return;
  await recordDiagnosticEvent("SESSION_CLOSE", { reason }, "lifecycle");
  await flushDiagnosticQueue();
  const closed = { ...run, closedAt: Date.now(), status: "CLOSED" };
  const transaction = (await db()).transaction("runs", "readwrite");
  transaction.objectStore("runs").put(closed);
  await done(transaction);
  run = closed;
}

async function byRun(store, runId) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction(store).objectStore(store).index("runId").getAll(runId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function diagnosticSnapshot() {
  await flushDiagnosticQueue();
  const database = await db();
  const readAll = store => new Promise((resolve, reject) => {
    const request = database.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const [runs, warnings, events, raw, samples] = await Promise.all([
    readAll("runs"), readAll("warnings"), readAll("events"), readAll("raw"), readAll("samples"),
  ]);
  return { run, runs, warnings: [...warnings, ...unsaved.warnings].sort((a,b) => (b.triggeredAt || "").localeCompare(a.triggeredAt || "")),
    events: [...events, ...unsaved.events].sort((a,b) => (a.id || Number.MAX_SAFE_INTEGER) - (b.id || Number.MAX_SAFE_INTEGER) || (a.sequence || 0) - (b.sequence || 0)),
    raw: [...raw, ...unsaved.raw], samples: [...samples, ...unsaved.samples],
    storage: { complete: !storageError && pendingWrites.length === 0, error: storageError?.message || "",
      pendingWrites: pendingWrites.length, unsaved: Object.fromEntries(Object.entries(unsaved).map(([key, values]) => [key, values.length])) } };
}

export async function recentDiagnosticEvents(limit = 100) {
  await flushDiagnosticQueue();
  const database = await db();
  const persisted = await new Promise((resolve, reject) => {
    const rows = [];
    const request = database.transaction("events").objectStore("events").openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) { resolve(rows); return; }
      rows.push(cursor.value); cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
  return [...persisted, ...unsaved.events].sort((a, b) =>
    (b.utc || "").localeCompare(a.utc || "") || (b.sequence || 0) - (a.sequence || 0)).slice(0, limit);
}

export function currentDiagnosticRun() { return run; }
