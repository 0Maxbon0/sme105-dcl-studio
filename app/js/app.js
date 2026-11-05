import { warningsForDiagnosticSession } from "./dtc-history.js";
import { wireKline } from "./kline-ui.js";
import { createKoerGuide } from "./koer-guide.js";
import { BleTransport, bluetoothAvailable } from "./ble.js";
import { createController } from "./controller.js";
import { APP_VERSION, createLineBuffer } from "./protocol.js";
import { createMockTransport, createReplay } from "./mock-transport.js";
import { STR } from "./strings.js";
import { createRecording, listRecordings, recordingBlob } from "./recording.js";
import { applyStaticStrings, confirmDialog, exportCsv, exportLog, reorderPinnedSensor, pinnedSensors, isDashboardArranging, toggleDashboardArrangement, setDashboardDensity, inspectSensorChart, closeSensorDetails, restoreDashboardCapture, openSensorDetails, refreshDashboardCharts, render, renderEventHistory, renderWarningHistory, setSensorChartRange, showView, toggleSensorPin } from "./ui.js";
import { closeDiagnosticRun, flushDiagnosticQueue, diagnosticHistory, recentDiagnosticEvents, recordDiagnosticEvent, recordDiagnosticWarning, setDiagnosticStorageErrorHandler, startDiagnosticRun } from "./diagnostics.js";
import { exportDiagnosticZip, exportGroupCsv, exportSensorCsv, saveOrShare } from "./exports.js";
import { lookupCode } from "./codes-db.js";
import { sensorFreshnessTransitions } from "./live-dashboard.js";

import { savedDiagnosticTests, diagnosticTestReport } from "./test-history.js";

const DEMO_FILES = {
  "0E": "./demo/read-0e.txt",
  KOEO: "./demo/koeo.txt",
  LIVE: "./demo/live-engine-off.txt",
};

const buffer = createLineBuffer();
let transport = null;
let previousAudit = { link: null, phase: null, message: null };
let previousSessionKey = "";
const previousFreshness = new Map();
let wired = false;
let resumeWork = null;
let protectedCapture = false;
let operatorSave = Promise.resolve(false);
const koerGuide = createKoerGuide({ journal: (type, detail) => {
  const pending = recordDiagnosticEvent(type, detail, "koer");
  if (type === "KOER_OPERATOR_EVENT") operatorSave = pending;
  return pending;
} });
let koerEvidenceCount = 0;
const nativeApp = () => !!window.Capacitor?.isNativePlatform?.();

const controller = createController({
  send(command) {
    if (!transport) return;
    transport.write(command);
  },
});

function acceptText(chunk) {
  for (const line of buffer.push(chunk)) controller.handleLine(line);
}

const ble = new BleTransport({
  onLine(line) { controller.handleLine(line); },
  onDisconnect() { controller.onDisconnected(); },
  onError(error) {
    controller.onDisconnected();
    controller.state.message = `Bluetooth transport failed: ${error?.message || String(error)}`;
    render(controller.state);
  },
});

function demoEnabled() {
  return document.getElementById("demo-toggle").checked;
}

function demoKey() {
  return document.getElementById("demo-capture").value;
}

async function refreshKoerJournal() {
  try {
    const events = await diagnosticHistory();
    document.getElementById("koer-operator-history").textContent = events.filter(e => e.type.startsWith("KOER_")).slice(-40)
      .map(e => `${e.utc} · ${e.type} · ${e.detail.source || "app"} · ${e.detail.action || e.detail.phase || e.detail.type || ""}`).join("\n") || "No operator markers saved. / لا توجد علامات مشغّل محفوظة.";
  } catch (error) { document.getElementById("koer-operator-history").textContent = `Journal unavailable: ${error.message}`; }
}

function refreshWarnings() {
  return diagnosticHistory("warnings").then(renderWarningHistory)
    .catch(error => { document.getElementById("warning-history").textContent = `Warning history unavailable: ${error.message}`; });
}

function refreshJournal() {
  return recentDiagnosticEvents(100).then(renderEventHistory)
    .catch(error => { document.getElementById("event-history").textContent = `Event journal unavailable: ${error.message}`; });
}

function auditState(state) {
  if (state.op?.variant === "KOER") {
    if (koerGuide.state.sessionId !== state.op.startedAt) { koerGuide.start(state.op.startedAt); koerEvidenceCount = 0; }
    const evidence = state.cart?.snapshot()?.evidence || [];
    for (; koerEvidenceCount < evidence.length; ++koerEvidenceCount) koerGuide.evidence({ ...evidence[koerEvidenceCount], source: state.transport === "demo" ? "simulation" : "bridge" });
  }

  state.koerGuide = koerGuide.state;
  const capturing = !!state.op;
  if (capturing !== protectedCapture) {
    protectedCapture = capturing;
    if (transport === ble) ble.setRecording(capturing).catch(error => {
      if (capturing) controller.failRecording(`Background recording protection failed: ${error.message}`);
    });
  }
  if (state.link !== previousAudit.link) {
    recordDiagnosticEvent("BLE_STATE", { state: state.link, transport: state.transport || "", deviceName: state.deviceName || "", auth: state.identity.auth || "" }, "bluetooth");
    previousAudit.link = state.link;
  }
  if (state.phase !== previousAudit.phase) {
    recordDiagnosticEvent("OPERATION_STATE", { phase: state.phase, variant: state.op?.variant || "" }, "state");
    previousAudit.phase = state.phase;
  }
  if (state.message && state.message !== previousAudit.message) {
    // CAPTURE_TIMEOUT (reason 16) is the expected end of a bounded live run.
    const error = /failure|failed|error|denied|incomplete|timed out|storage/i.test(state.message);
    recordDiagnosticEvent(error ? "APP_STATE_WARNING" : "APP_MESSAGE", { message: state.message }, error ? "error" : "state");
    previousAudit.message = state.message;
  }
  const session = state.lastSession;
  if (!session?.completedAt) return;
  const key = `${session.variant}:${session.startedAt}:${session.completedAt}`;
  if (key === previousSessionKey) return;
  previousSessionKey = key;
  if (session.variant === "KOER") {
    const evidence = session.ecuEvidence || [];
    for (; koerEvidenceCount < evidence.length; ++koerEvidenceCount) koerGuide.evidence({ ...evidence[koerEvidenceCount], source: state.transport === "demo" ? "simulation" : "bridge" });
    koerGuide.finish({ disconnected: session.verdict?.reasons?.includes("link lost"),
    aborted: session.verdict?.end?.reason === 15, timedOut: session.verdict?.end?.reason === 16,
    captureIntegrity: session.verdict?.status });
  }
  const evidence = {
    channel: "DCL", source: state.transport === "demo" ? "simulation" : "bridge", hardwareVerified: false, variant: session.variant, kind: session.kind, startedAt: session.startedAt, completedAt: session.completedAt,
    verdict: session.verdict, requestedMode: session.requestedMode, observedModes: session.observedModes,
    dtcVerified: session.dtcVerified, selfTestComplete: session.selfTestComplete,
    integrity: session.integrity, ecuEvidence: session.ecuEvidence,
    codes: session.codes, blocks25: session.blocks25, blocks26: session.blocks26,
    rx: session.verdict?.end?.rx ?? null, parityRejects: session.parityRejects,
    codeParityRejects: session.codeParityRejects,
  };
  recordDiagnosticEvent("SESSION_RESULT", evidence, "session").then(refreshTestHistory);
  if (!session.verdict?.valid) {
    const failed = session.verdict?.status === "FAILED";
    const warningKey = `session-${session.variant}-${session.completedAt}`;
    recordDiagnosticWarning(warningKey, true, { severity: failed ? "red" : "amber", sensor: "Session",
      ruleId: `SESSION-${session.verdict?.status || "INCOMPLETE"}`, reason: (session.verdict?.reasons || ["Session incomplete"]).join("; "),
      source: `${session.variant} session validity checks`, evidence });
  }
  for (const {key, warning} of warningsForDiagnosticSession(session)) recordDiagnosticWarning(key, true, warning);
  // New datasets never resolve older warnings or imply a memory clear.
  refreshWarnings();
}

function auditFreshness(state) {
  const snapshot = state.cart?.snapshot();
  const changes = sensorFreshnessTransitions(snapshot?.pids || {}, previousFreshness, {
    active: (state.op?.kind === "live" && state.phase === "read") || !!state.combined?.active,
    now: Date.now(),
  });
  for (const change of changes) {
    recordDiagnosticEvent("SENSOR_FRESHNESS_CHANGED", {
      name: change.name, pid: change.pid, state: change.state, priorState: change.priorState,
      sampleCount: change.sampleCount, sampleAgeMs: change.ageMs, expectedIntervalMs: change.intervalMs,
      last: change.last,
      variant: state.op?.variant || state.lastSession?.variant || "",
    }, "sensor");
  }
}

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

async function reconcileBridgeConnection() {
  if (!nativeApp() || demoEnabled() || !ble.connectionWanted || ble.connecting) return;
  if (resumeWork) return resumeWork;
  transport = ble;
  controller.state.recovering = true;
  render(controller.state);
  resumeWork = (async () => {
    const result = await ble.reconcile();
    recordDiagnosticEvent("BLE_FOREGROUND_CHECK", { connected: result.connected, reconnected: !!result.reconnected }, "bluetooth");
    if (result.connected && (result.reconnected || controller.state.link === "disconnected")) {
      controller.onConnected(result.device?.name || ble.device?.name || "SME105-DCL", "ble");
      // onConnected sends only HELLO/PINS/STATUS. Interrupted vehicle operations
      // remain saved and are never automatically armed or started again.
    }
  })().catch(async error => {
    await ble.discardNative();
    controller.onDisconnected();
    controller.state.message = `Bluetooth recovery failed: ${error.message}. Tap Connect to retry.`;
    recordDiagnosticEvent("BLE_RECOVERY_FAILED", { reason: error.message }, "error");
  }).finally(() => {
    controller.state.recovering = false;
    resumeWork = null;
    render(controller.state);
  });
  return resumeWork;
}

async function connect() {
  if (resumeWork) return resumeWork;
  const button = document.getElementById("connect-btn");
  button.disabled = true;
  recordDiagnosticEvent("BLE_CONNECT_REQUESTED", { demo: demoEnabled() }, "bluetooth");
  try {
    if (controller.state.link === "ready" || controller.state.link === "denied") {
      await transport?.disconnect();
      return;
    }
    if (demoEnabled()) {
      const response = await fetch(DEMO_FILES[demoKey()]);
      if (!response.ok) throw new Error("demo capture missing");
      const replay = createReplay(await response.text());
      transport = createMockTransport(replay, {
        onText: acceptText,
        onDisconnect() { controller.onDisconnected(); },
      });
      await transport.connect();
      controller.onConnected("SME105-DCL demo", "demo");
      recordDiagnosticEvent("BLE_DEMO_CONNECTED", { transport: "mock" }, "bluetooth");
      return;
    }
    if (!window.isSecureContext) throw new Error(STR.secureWarning);
    transport = ble;
    const device = await ble.connect();
    controller.onConnected(device.name || "SME105");
    recordDiagnosticEvent("BLE_CONNECTED", { transport: window.Capacitor?.isNativePlatform?.() ? "native" : "web-bluetooth", deviceName: device.name || "SME105", mtu: device.mtu ?? null }, "bluetooth");
  } catch (error) {
    controller.state.message = error?.message || String(error);
    recordDiagnosticEvent("BLE_CONNECT_FAILED", { message: controller.state.message }, "error");
    render(controller.state);
  } finally {
    button.disabled = false;
    render(controller.state);
  }
}

async function ask(title, body, action) {
  if (controller.state.phase !== "idle") return;
  const ok = await confirmDialog(title, body);
  if (!ok) return;
  recordDiagnosticEvent("OPERATOR_CONFIRMED_ACTION", { action: title }, "action");
  if (controller.state.phase !== "idle") return;
  const result = await action();
  if (result && result.ok === false) controller.state.message = result.error;
  render(controller.state);
}

function selectedLive() {
  const value = document.getElementById("live-set").value;
  return ["LIVE", "LIVE2", "LIVE3", "ALL"].includes(value) ? value : "LIVE";
}

function chooseLiveSet(value) {
  document.getElementById("live-set").value = value;
  writeStorage("eeciv-live-set", value);
}

function applyDisplayPreferences() {
  const theme = readStorage("eeciv-theme") || "system";
  const effectiveTheme = theme === "system"
    ? (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : theme;
  document.body.dataset.theme = effectiveTheme;
  document.body.classList.toggle("large-text", readStorage("eeciv-font-size") === "large");
  document.body.classList.toggle("high-contrast", readStorage("eeciv-high-contrast") === "1");
  document.body.classList.toggle("reduce-motion", readStorage("eeciv-reduce-motion") === "1");
}

async function startLive() {
  const variant = selectedLive();
  try {
    const archive = await createRecording(variant, error => controller.failRecording(`Recording stopped: ${error.message}`), readStorage("eeciv-unit-system") || "metric");
    if (controller.state.phase !== "idle" || controller.state.link !== "ready") {
      await archive.finish({ valid: false, reasons: ["Connection changed while opening recording"] });
      return { ok: false, error: "Connect the bridge before starting a recording" };
    }
    for (const line of [controller.state.identity.hello, controller.state.identity.pins, controller.state.status?.raw]) if (line) archive.line(line);
    controller.setArchive(archive);
    const result = variant === "ALL" ? controller.requestAllLive() : controller.requestVehicle(variant);
    if (!result.ok) await archive.finish({ valid: false, reasons: [result.error] });
    await refreshRecordings();
    return result;
  } catch (error) {
    return { ok: false, error: `Cannot start recording: ${error.message}` };
  }
}

async function refreshRecordings() {
  const select = document.getElementById("saved-recordings");
  const previous = select.value;
  try {
    const entries = await listRecordings();
    select.replaceChildren(...entries.map(entry => new Option(`${entry.started ? new Date(entry.started).toLocaleString() : entry.id} · ${entry.variant}`, entry.id)));
    if (entries.some(entry => entry.id === previous)) select.value = previous;
    document.getElementById("saved-csv").disabled = !entries.length;
    document.getElementById("saved-log").disabled = !entries.length;
  } catch (error) {
    document.getElementById("recording-status").textContent = `Recording storage unavailable: ${error.message}`;
  }
}

async function downloadSaved(kind) {
  try {
    const id = document.getElementById("saved-recordings").value;
    if (!id) return;
    const blob = controller.state.archive?.id === id
      ? await controller.state.archive.export(kind) : await recordingBlob(id, kind);
    await saveOrShare(blob, `eec-iv-${id.slice(0,19).replaceAll(":", "-")}.${kind === "csv" ? "csv" : "txt"}`);
  } catch (error) {
    document.getElementById("recording-status").textContent = `Export failed: ${error.message}`;
  }
}

function currentUnits() { return readStorage("eeciv-unit-system") || "metric"; }

async function saveFullDiagnostic() {
  const button = document.getElementById("export-diagnostics");
  button.disabled = true;
  try {
    const result = await exportDiagnosticZip({ activeArchive: controller.state.archive, unitSystem: currentUnits() });
    controller.state.message = `Diagnostic ZIP integrity verified · ${result.size.toLocaleString()} bytes · SHA-256 ${result.sha256}`;
    render(controller.state);
  } catch (error) {
    controller.state.message = `Diagnostic ZIP failed: ${error.message}`;
    render(controller.state);
  } finally { button.disabled = false; }
}

let savedTests = [];
function showSavedTest() {
  const event = savedTests[Number(document.getElementById("saved-tests").value)];
  document.getElementById("saved-test-detail").textContent = event
    ? diagnosticTestReport(event).split("\nOriginal saved evidence:")[0] : "No saved diagnostic tests yet.";
}
async function refreshTestHistory() {
  try {
    const events = await diagnosticHistory();
    const select = document.getElementById("saved-tests");
    const prior = savedTests[Number(select.value)];
    savedTests = savedDiagnosticTests(events);
    select.replaceChildren(...savedTests.map((event, index) => new Option(
      `${new Date(event.detail.completedAt).toLocaleString()} · ${event.detail.variant} · ${event.detail.codes?.length || 0} codes · ${event.detail.verdict?.status || "UNKNOWN"}`, index)));
    const index = prior ? savedTests.findIndex(event => event.id === prior.id && event.runId === prior.runId) : -1;
    if (index >= 0) select.value = String(index);
    document.getElementById("export-saved-test").disabled = !savedTests.length;
    document.getElementById("export-all-tests").disabled = !savedTests.length;
    showSavedTest();
  } catch (error) {
    document.getElementById("saved-test-detail").textContent = `Saved tests unavailable: ${error.message}`;
  }
}
async function exportSavedTests(all = false) {
  const selected = all ? savedTests : [savedTests[Number(document.getElementById("saved-tests").value)]].filter(Boolean);
  if (!selected.length) return;
  const stamp = new Date(all ? Date.now() : selected[0].detail.completedAt).toISOString().replaceAll(":", "-");
  try {
    await saveOrShare(new Blob([selected.map(diagnosticTestReport).join("\n\n")], { type: "text/plain" }), `sme105-${all ? "all-tests" : selected[0].detail.variant}-codes-${stamp}.txt`);
  } catch (error) {
    controller.state.message = `Code export failed: ${error.message}`;
    render(controller.state);
  }
}

async function restoreLastDiagnosticResult() {
  const events = await diagnosticHistory();
  const resultEvent = events.filter(event => event.type === "SESSION_RESULT").at(-1);
  if (!resultEvent?.detail) return;
  const detail = resultEvent.detail;
  controller.state.lastSession = { ...detail, rows: [], pids: {}, mem: {}, rom: null, totalRows: 0 };
  controller.state.trust = detail.verdict?.valid ? "valid" : "untrusted";
  if (detail.variant === "KOER") Object.assign(koerGuide.state, { phase: "ENDED_UNVERIFIED", sessionId: detail.startedAt, prompt: null, verifiedSuccess: false });
  previousSessionKey = `${detail.variant}:${detail.startedAt}:${detail.completedAt}`;
}

function wire() {
  applyStaticStrings();
  document.getElementById("about-version").textContent = APP_VERSION;
  document.getElementById("secure-warning").hidden = window.isSecureContext;
  document.getElementById("bt-warning").hidden = bluetoothAvailable() || demoEnabled();
  const storedDemo = readStorage("eeciv-demo") === "1";
  const storedCapture = readStorage("eeciv-demo-capture");
  const manual = readStorage("eeciv-manual-gearbox") !== "0";
  document.getElementById("manual-gearbox").checked = manual;
  document.getElementById("manual-gearbox-settings").checked = manual;
  const idleCheck = readStorage("eeciv-idle-check") === "1";
  document.getElementById("idle-check").checked = idleCheck;
  document.getElementById("idle-check-settings").checked = idleCheck;
  const selectedSet = readStorage("eeciv-live-set");
  if (["LIVE", "LIVE2", "LIVE3", "ALL"].includes(selectedSet)) chooseLiveSet(selectedSet);
  const selectedGroup = readStorage("eeciv-live-group");
  if (["overview", "engine", "fuel", "temp", "switches", "advanced"].includes(selectedGroup)) document.getElementById("live-group").value = selectedGroup;
  document.getElementById("theme-mode").value = readStorage("eeciv-theme") || "system";
  document.getElementById("unit-system").value = readStorage("eeciv-unit-system") || "metric";
  document.getElementById("font-size").value = readStorage("eeciv-font-size") || "normal";
  document.getElementById("high-contrast").checked = readStorage("eeciv-high-contrast") === "1";
  document.getElementById("reduce-motion").checked = readStorage("eeciv-reduce-motion") === "1";
  applyDisplayPreferences();
  wireKline();
  void refreshKoerJournal();
  document.querySelectorAll("[data-operator-marker]").forEach(button => button.addEventListener("click", async () => {
    try { const event = koerGuide.confirm(button.dataset.operatorMarker); if (!await operatorSave) throw new Error("Operator marker was not saved; diagnostic storage failed"); await refreshKoerJournal(); document.getElementById("operator-marker-status").textContent = `Human report saved: ${new Date(event.at).toLocaleTimeString()} · not ECU confirmed / تقرير بشري غير مؤكد من وحدة التحكم`; }
    catch (error) { document.getElementById("operator-marker-status").textContent = error.message; }
  }));
  const storedMode = readStorage("eeciv-stored-code-mode");
  if (storedMode === "0E" || storedMode === "A4") document.getElementById("stored-code-mode").value = storedMode;
  document.getElementById("stored-code-mode").addEventListener("change", (event) => {
    writeStorage("eeciv-stored-code-mode", event.target.value);
  });
  for (const id of ["manual-gearbox", "manual-gearbox-settings"]) document.getElementById(id).addEventListener("change", (event) => {
    const value = event.target.checked;
    document.getElementById("manual-gearbox").checked = value;
    document.getElementById("manual-gearbox-settings").checked = value;
    writeStorage("eeciv-manual-gearbox", value ? "1" : "0");
    render(controller.state);
  });
  for (const id of ["idle-check", "idle-check-settings"]) document.getElementById(id).addEventListener("change", (event) => {
    const value = event.target.checked;
    document.getElementById("idle-check").checked = value;
    document.getElementById("idle-check-settings").checked = value;
    writeStorage("eeciv-idle-check", value ? "1" : "0");
    render(controller.state);
  });
  document.getElementById("live-set").addEventListener("change", event => {
    writeStorage("eeciv-live-set", event.target.value); closeSensorDetails(); render(controller.state); void restoreDashboardCapture(controller.state);
  });
  document.getElementById("dashboard-density").addEventListener("change", event => {
    setDashboardDensity(event.target.value); render(controller.state);
  });
  document.getElementById("arrange-dashboard").addEventListener("click", () => {
    toggleDashboardArrangement(); render(controller.state);
  });
  const pinnedGrid = document.getElementById('pinned-readings');
  let dragging = null;
  pinnedGrid.addEventListener('pointerdown', event => {
    const card = event.target.closest('.pinned-card');
    if (!isDashboardArranging() || !card || event.target.closest('[data-pin-pid]')) return;
    event.preventDefault();
    dragging = { pid: card.dataset.pid, pointer: event.pointerId };
    pinnedGrid.setPointerCapture(event.pointerId); card.classList.add('dragging');
  });
  pinnedGrid.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== dragging.pointer) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX,event.clientY)?.closest('.pinned-card');
    if (target && target.dataset.pid !== dragging.pid) {
      reorderPinnedSensor(dragging.pid, target.dataset.pid); render(controller.state);
    }
  });
  const endDrag = () => {
    if (!dragging) return;
    pinnedGrid.querySelectorAll('.dragging').forEach(card => card.classList.remove('dragging'));
    if (pinnedGrid.hasPointerCapture(dragging.pointer)) pinnedGrid.releasePointerCapture(dragging.pointer);
    dragging = null;
  };
  pinnedGrid.addEventListener('pointerup', endDrag);
  pinnedGrid.addEventListener('pointercancel', endDrag);
  pinnedGrid.addEventListener('keydown', event => {
    if (!isDashboardArranging() || !event.target.matches('.pinned-card')) return;
    const offset = ['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : ['ArrowRight','ArrowDown'].includes(event.key) ? 1 : 0;
    if (!offset) return;
    event.preventDefault();
    const pins = pinnedSensors(), name = event.target.dataset.pid, target = pins[pins.indexOf(name)+offset];
    if (target) { reorderPinnedSensor(name,target); render(controller.state); event.target.focus(); }
  });
  const sensorChart = document.getElementById('sensor-chart');
  sensorChart.addEventListener('pointerdown', event => { sensorChart.setPointerCapture(event.pointerId); inspectSensorChart(event.clientX); });
  sensorChart.addEventListener('pointermove', event => { if (event.buttons || event.pointerType === 'mouse') inspectSensorChart(event.clientX); });
  document.getElementById("live-group").addEventListener("change", (event) => {
    writeStorage("eeciv-live-group", event.target.value);
    render(controller.state);
  });
  document.getElementById("theme-mode").addEventListener("change", (event) => {
    writeStorage("eeciv-theme", event.target.value); applyDisplayPreferences();
  });
  document.getElementById("unit-system").addEventListener("change", (event) => {
    writeStorage("eeciv-unit-system", event.target.value); render(controller.state);
  });
  document.getElementById("font-size").addEventListener("change", (event) => {
    writeStorage("eeciv-font-size", event.target.value); applyDisplayPreferences();
  });
  document.getElementById("high-contrast").addEventListener("change", (event) => {
    writeStorage("eeciv-high-contrast", event.target.checked ? "1" : "0"); applyDisplayPreferences();
  });
  document.getElementById("reduce-motion").addEventListener("change", (event) => {
    writeStorage("eeciv-reduce-motion", event.target.checked ? "1" : "0"); applyDisplayPreferences();
  });
  document.getElementById("dismiss-onboarding").addEventListener("click", () => {
    writeStorage("sme105-onboarding-dismissed", "1"); document.getElementById("onboarding").hidden = true;
  });
  if (storedDemo) document.getElementById("demo-toggle").checked = true;
  if (storedCapture) document.getElementById("demo-capture").value = storedCapture;
  document.getElementById("bt-warning").hidden = bluetoothAvailable() || demoEnabled();

  document.querySelectorAll("nav button").forEach((button) => {
    button.addEventListener("click", () => {
      showView(button.dataset.view);
      recordDiagnosticEvent("SCREEN_VIEW", { view: button.dataset.view }, "ui");
      if (button.dataset.view === "codes") refreshTestHistory();
      if (button.dataset.view === "log") { refreshWarnings(); refreshJournal(); }
      render(controller.state);
    });
  });
  document.getElementById("connect-btn").addEventListener("click", () => { connect(); });
  document.getElementById("connect-settings").addEventListener("click", () => { connect(); });
  document.getElementById("stop-btn").addEventListener("click", () => controller.requestStop());
  document.getElementById("view-live").addEventListener("click", (event) => {
    const pinButton = event.target.closest("[data-pin-pid]");
    if (pinButton) {
      event.stopPropagation(); toggleSensorPin(pinButton.dataset.pinPid); render(controller.state); return;
    }
    if (isDashboardArranging() && event.target.closest('#pinned-readings')) return;
    const openButton = event.target.closest("[data-open-pid]");
    const metric = event.target.closest(".sensor-hit[data-pid]");
    const pid = openButton?.dataset.openPid || metric?.dataset.pid;
    if (pid) openSensorDetails(controller.state, pid);
  });
  document.getElementById("drawer-close").addEventListener("click", () => {
    closeSensorDetails();
  });
  document.getElementById("sensor-drawer").addEventListener("click", (event) => {
    if (event.target.id === "sensor-drawer") closeSensorDetails();
    const rangeButton = event.target.closest("[data-range]");
    if (rangeButton) {
      for (const button of document.querySelectorAll("[data-range]")) button.setAttribute("aria-pressed", String(button === rangeButton));
      setSensorChartRange(rangeButton.dataset.range);
    }
  });
  document.getElementById("drawer-pin").addEventListener("click", (event) => {
    toggleSensorPin(event.currentTarget.dataset.pinPid); render(controller.state);
  });
  document.getElementById("drawer-export-sensor").addEventListener("click", () => {
    exportSensorCsv(document.getElementById("drawer-pin").dataset.pinPid, { unitSystem: currentUnits() })
      .catch(error => { controller.state.message = `Sensor export failed: ${error.message}`; render(controller.state); });
  });
  document.getElementById("export-group-btn").addEventListener("click", () => {
    exportGroupCsv(document.getElementById("live-group").value, { unitSystem: currentUnits(), manual: document.getElementById("manual-gearbox").checked })
      .catch(error => { controller.state.message = `Group export failed: ${error.message}`; render(controller.state); });
  });
  for (const id of ["warning-filter", "warning-sensor-filter", "warning-date-filter"]) document.getElementById(id).addEventListener("change", refreshWarnings);
  document.getElementById("export-diagnostics").addEventListener("click", saveFullDiagnostic);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("sensor-drawer").hidden) {
      closeSensorDetails();
    }
  });
  document.getElementById("read-codes-btn").addEventListener("click", () => {
    const variant = document.getElementById("stored-code-mode").value === "A4" ? "A4" : "0E";
    ask(`${STR.confirmStoredTitle} (${variant})`, `${STR.confirmStoredBody}\n\nSelected request: ${variant}; expected response mode: 26H.`, () => controller.requestVehicle(variant));
  });
  document.getElementById("koeo-btn").addEventListener("click", () => ask(
    STR.confirmKoeoTitle, STR.confirmKoeoBody, () => controller.requestVehicle("KOEO"),
  ));
  document.getElementById("koer-btn").addEventListener("click", () => ask(
    STR.confirmKoerTitle, STR.confirmKoerBody, () => controller.requestVehicle("KOER"),
  ));
  document.getElementById("live-start").addEventListener("click", () => ask(
    STR.confirmLiveTitle, selectedLive() === "ALL" ? STR.confirmAllLiveBody : STR.confirmLiveBody,
    startLive,
  ));
  document.getElementById("offline-btn").addEventListener("click", () => ask(
    STR.confirmOffTitle, STR.confirmOffBody, () => controller.requestVehicle("OFF"),
  ));
  document.getElementById("clear-btn").addEventListener("click", () => ask(
    STR.confirmClearTitle, STR.confirmClearBody, () => controller.requestVehicle("CLR"),
  ));
  document.getElementById("mem-btn").addEventListener("click", () => ask(
    STR.confirmMemTitle, STR.confirmMemBody, () => controller.requestVehicle("MEM"),
  ));
  document.getElementById("reboot-btn").addEventListener("click", () => ask(
    STR.confirmRebootTitle, STR.confirmRebootBody, () => controller.requestReboot(),
  ));
  document.getElementById("bench-btn").addEventListener("click", () => {
    const result = controller.requestBench();
    if (result && result.ok === false) controller.state.message = result.error;
    render(controller.state);
  });
  const reportExportError = error => { controller.state.message = `Export failed: ${error.message}`; render(controller.state); };
  document.getElementById("export-btn").addEventListener("click", () => exportLog(controller.state).catch(reportExportError));
  document.getElementById("csv-btn").addEventListener("click", () => exportCsv(controller.state).catch(reportExportError));
  document.getElementById("saved-csv").addEventListener("click", () => downloadSaved("csv"));
  document.getElementById("saved-log").addEventListener("click", () => downloadSaved("raw"));
  refreshRecordings();
  refreshTestHistory();
  void restoreDashboardCapture(controller.state);
  document.getElementById("saved-tests").addEventListener("change", showSavedTest);
  document.getElementById("export-saved-test").addEventListener("click", () => exportSavedTests());
  document.getElementById("export-all-tests").addEventListener("click", () => exportSavedTests(true));
  document.getElementById("demo-toggle").addEventListener("change", () => {
    writeStorage("eeciv-demo", demoEnabled() ? "1" : "0");
    document.getElementById("bt-warning").hidden = bluetoothAvailable() || demoEnabled();
  });
  document.getElementById("demo-capture").addEventListener("change", () => {
    writeStorage("eeciv-demo-capture", demoKey());
  });
  document.getElementById("play-demo").addEventListener("click", async () => {
    document.getElementById("demo-toggle").checked = true;
    writeStorage("eeciv-demo", "1");
    writeStorage("eeciv-demo-capture", demoKey());
    if (controller.state.link === "ready" || controller.state.link === "denied") {
      await transport?.disconnect();
    }
    await connect();
    showView(demoKey() === "LIVE" ? "live" : "codes");
  });
  let renderPending = false;
  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      render(controller.state);
    });
  };
  controller.subscribe(state => { scheduleRender(); auditState(state); });
  setInterval(() => { if (!controller.state.recovering) controller.tick(); }, 250);
  setInterval(() => {
    if (controller.state.combined || controller.state.op?.kind === "live" || !document.getElementById("sensor-drawer").hidden) scheduleRender();
    auditFreshness(controller.state);
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    recordDiagnosticEvent(document.hidden ? "APP_BACKGROUND" : "APP_FOREGROUND", { phase: controller.state.phase }, "lifecycle");
    if (document.hidden) {
      void flushDiagnosticQueue();
      if ((!nativeApp() || transport !== ble) && controller.state.phase !== "idle") {
        recordDiagnosticEvent("BACKGROUND_CAPTURE_STOP_REQUESTED", { reason: "browser/demo left foreground" }, "lifecycle");
        controller.requestStop();
      }
    } else {
      scheduleRender();
      void reconcileBridgeConnection();
    }
  });
  window.addEventListener("sme105-native-resume", () => { scheduleRender(); void reconcileBridgeConnection(); });
  window.addEventListener("resize", () => { scheduleRender(); requestAnimationFrame(refreshDashboardCharts); });
  if ("serviceWorker" in navigator && !window.Capacitor?.isNativePlatform?.()) {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      controller.state.message = `Offline cache unavailable: ${error.message}`;
      render(controller.state);
    });
  }
  showView("live");
  render(controller.state);
  wired = true;
  auditState(controller.state);
  refreshWarnings();
  void reconcileBridgeConnection();
}

async function boot() {
  setDiagnosticStorageErrorHandler(error => {
    const message = `Diagnostic journal write failed: ${error.message}`;
    if (controller.state.op || controller.state.combined?.active) controller.failRecording(message);
    else {
      controller.state.message = message;
      if (wired) render(controller.state);
    }
  });
  try {
    await startDiagnosticRun();
    await restoreLastDiagnosticResult();
  }
  catch (error) { document.getElementById("message").textContent = `Diagnostic storage is unavailable: ${error.message}`; }
  window.addEventListener("error", event => {
    recordDiagnosticEvent("UNCAUGHT_ERROR", { message: event.message, source: event.filename, line: event.lineno, stack: event.error?.stack || "" }, "error");
    controller.state.message = `Application error: ${event.message}`;
    if (wired) render(controller.state);
  });
  window.addEventListener("unhandledrejection", event => {
    const error = event.reason;
    recordDiagnosticEvent("UNHANDLED_REJECTION", { message: error?.message || String(error), stack: error?.stack || "" }, "error");
    controller.state.message = `Application task failed: ${error?.message || String(error)}`;
    if (wired) render(controller.state);
  });
  window.addEventListener("pagehide", () => {
    if (nativeApp()) void flushDiagnosticQueue();
    else void closeDiagnosticRun("pagehide");
  });
  wire();
}

boot().catch(error => {
  document.getElementById("message").textContent = `Startup failed: ${error.message}`;
});
