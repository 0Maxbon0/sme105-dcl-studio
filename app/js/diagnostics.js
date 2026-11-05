/** Private, append-only per-app-run evidence journal backed by IndexedDB. */
import { APP_VERSION } from "./protocol.js";
import { PIDS } from "./pids.js";

const DB_NAME = "sme105-diagnostics";
const DB_VERSION = 1;
let database;
let run = null;
let sequence = 0;
let writeChain = Promise.resolve();
let onStorageError = () => {};
const openedAt = globalThis.performance?.now?.() ?? Date.now();

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

function enqueue(work) {
  const result = writeChain.then(work);
  writeChain = result.catch(error => { onStorageError(error); return false; });
  return writeChain;
}

export async function startDiagnosticRun() {
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
  const transaction = database.transaction("runs", "readwrite");
  transaction.objectStore("runs").add(run);
  await done(transaction);
  await recordDiagnosticEvent("SESSION_START", { source: "app-launch" }, "lifecycle");
  return run;
}

export function recordDiagnosticEvent(type, detail = {}, category = "app") {
  if (!run) return Promise.resolve(false);
  return enqueue(async () => {
    const record = { ...common(), sequence: ++sequence, category, type, detail: redactDiagnostic(detail) };
    const transaction = (await db()).transaction("events", "readwrite");
    transaction.objectStore("events").add(record);
    await done(transaction);
    return record;
  });
}

export function recordBridgeRaw(line) {
  if (!run) return Promise.resolve(false);
  return enqueue(async () => {
    const database = await db();
    const stamp = common();
    const safeLine = redactDiagnostic(String(line));
    const transaction = database.transaction(["raw", "events"], "readwrite");
    transaction.objectStore("raw").add({ ...stamp, line: safeLine });
    transaction.objectStore("events").add({ ...stamp, sequence: ++sequence, category: "bridge", type: "BRIDGE_RX", detail: { line: safeLine } });
    await done(transaction);
    return true;
  });
}

export function recordDiagnosticSample(sample, context = {}) {
  if (!run) return Promise.resolve(false);
  return enqueue(async () => {
    const pid = Object.entries(PIDS).find(([, definition]) => definition[0] === sample.name)?.[0];
    const value = { ...common(), pid: pid ? `0x${Number(pid).toString(16).padStart(2, "0").toUpperCase()}` : "",
      name: sample.name, variant: context.variant || "", t_s: sample.t, raw: sample.raw, value: sample.value, unit: sample.unit,
      receivedAt: sample.receivedAt ?? Date.now(), validity: "received", timeBasis: "ECU-relative" };
    const database = await db();
    const transaction = database.transaction("samples", "readwrite");
    transaction.objectStore("samples").add(value);
    await done(transaction);
    return true;
  });
}

export async function recordDiagnosticWarning(key, active, warning) {
  if (!run) return false;
  return enqueue(async () => {
    const database = await db();
    const transaction = database.transaction(["events", "warnings"], "readwrite");
    const warnings = transaction.objectStore("warnings");
    const matches = await new Promise((resolve, reject) => {
      const request = warnings.index("key").getAll(key);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
    const previous = matches.find(item => item.active) || null;
    if (active && previous) { await done(transaction); return previous; }
    if (!active && !previous) { await done(transaction); return null; }
    const stamp = common();
    const item = active
      ? { id: `${run.id}:${key}:${stamp.monotonic_us}`, ...stamp, triggeredRunId: run.id, key, active,
        severity: warning.severity, sensor: warning.sensor || "", ruleId: warning.ruleId || "",
        reason: redactDiagnostic(warning.reason || ""), source: redactDiagnostic(warning.source || ""),
        evidence: redactDiagnostic(warning.evidence || {}), triggeredAt: stamp.utc, resolvedAt: null }
      : { ...previous, ...stamp, runId: run.id, resolvedRunId: run.id, active: false, resolvedAt: stamp.utc };
    warnings.put(item);
    transaction.objectStore("events").add({ ...stamp, sequence: ++sequence, category: "warning",
      type: active ? "WARNING_TRIGGERED" : "WARNING_RESOLVED", detail: item });
    await done(transaction);
    return item;
  });
}

export async function closeDiagnosticRun(reason = "pagehide") {
  if (!run || run.closedAt) return;
  await recordDiagnosticEvent("SESSION_CLOSE", { reason }, "lifecycle");
  await writeChain;
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
  const database = await db();
  const readAll = store => new Promise((resolve, reject) => {
    const request = database.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const [runs, warnings, events, raw, samples] = await Promise.all([
    readAll("runs"), readAll("warnings"), readAll("events"), readAll("raw"), readAll("samples"),
  ]);
  return { run, runs, warnings: warnings.sort((a,b) => b.triggeredAt.localeCompare(a.triggeredAt)),
    events: events.sort((a,b) => a.id - b.id), raw, samples };
}

export async function recentDiagnosticEvents(limit = 100) {
  const database = await db();
  return new Promise((resolve, reject) => {
    const rows = [];
    const request = database.transaction("events").objectStore("events").openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || rows.length >= limit) { resolve(rows); return; }
      rows.push(cursor.value); cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export function currentDiagnosticRun() { return run; }
