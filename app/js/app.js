import { createReviewControls } from "./review-controls.js";
import { createIgnitionReview } from "./ignition-review.js";
import { reconcileOutcome } from "./session-history.js";
import { sessionWarning } from "./session-outcome.js";
import { warningsForDiagnosticSession } from "./dtc-history.js";
import { wireKline } from "./kline-ui.js";
import { createKoerGuide } from "./koer-guide.js";
import { BleTransport, bluetoothAvailable } from "./ble.js";
import { createController, candidateRequiresOperatorConfirmation, candidateRequiredStateText } from "./controller.js";
import { APP_VERSION, createLineBuffer, COMMAND_CATALOGUE, DCL_PROBE_VARIANTS, DCL_BLOCKED_CANDIDATES, EXPERIMENT_CATALOGUE, firmwareCompatibility } from "./protocol.js";
import { createMockTransport, createReplay } from "./mock-transport.js";
import { STR } from "./strings.js";
import { createRecording, exportExperimentArchive, exportDiscoveryPassArchive, exportAllExperimentsArchive, listRecordings, recordingBlob, recoverInterruptedRecordings } from "./recording.js";
import { applyStaticStrings, confirmDialog, exportCsv, exportLog, reorderPinnedSensor, pinnedSensors, getSelectedDclCandidates, isDashboardArranging, toggleDashboardArrangement, setDashboardDensity, setDashboardColumns, toggleDashboardFocus, inspectSensorChart, closeSensorDetails, openSensorDetails, refreshDashboardCharts, render, renderDclCommandExplorer, wireDclCommandExplorer, renderEventHistory, renderWarningHistory, setSensorChartRange, showView, toggleSensorPin } from "./ui.js";
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

const reviewControls = createReviewControls({ state: controller.state, render: renderApp, closeDetails: closeSensorDetails });
function latestDclCaptureLines(log) {
  let start = -1;
  for (let index = log.length - 1; index >= 0; --index) {
    if (String(log[index]).startsWith("EVENT session=READ_CANDIDATE")) { start = index; break; }
  }
  if (start < 0) return [];
  let first = start;
  for (let index = start - 1; index >= 0; --index) {
    if (String(log[index]).startsWith("EVENT read_armed ")) { first = index; break; }
    if (String(log[index]).startsWith("END ") || String(log[index]).startsWith("EVENT session=")) break;
  }
  let end = log.findIndex((line, index) => index > start && String(line).startsWith("END "));
  if (end < 0) end = log.length - 1;
  return log.slice(first, end + 1).map(String);
}

function renderSingleProbe(state) {
  const select = document.getElementById("dcl-probe-select");
  if (!select) return;
  const selected = DCL_PROBE_VARIANTS[select.value];
  const description = document.getElementById("dcl-probe-description");
  if (description) {
    const blockedSuffix = selected?.blockedReason ? ` · [BLOCKED: ${selected.blockedReason}]` : "";
    description.textContent = selected
      ? `${selected.word} · ${selected.description} ${selected.parityNote ? `${selected.parityNote} ` : ""}Source: ${selected.source}. ${selected.evidence}${blockedSuffix}`
      : "Select a fixed read candidate.";
  }
  const activeVariant = state.op?.kind === "probe" ? state.op.variant : "";
  const activeMeta = DCL_PROBE_VARIANTS[activeVariant];
  const activeLines = activeMeta ? latestDclCaptureLines(state.log) : [];
  const probe = activeMeta ? {
    ...activeMeta, variant: activeVariant, responseBytes: state.op?.session?.rx || 0,
    bridgeCaptureStatus: "IN_PROGRESS", rawLines: activeLines,
  } : state.lastDclProbe;
  const run = document.getElementById("dcl-probe-run");
  const exportButton = document.getElementById("dcl-probe-export");
  if (run) run.disabled = !selected || state.link !== "ready" || state.phase !== "idle" || state.transport === "demo";
  if (exportButton) exportButton.disabled = !probe || state.phase !== "idle" || !!state.op;
  const summary = document.getElementById("dcl-probe-summary");
  const raw = document.getElementById("dcl-probe-raw");
  if (!probe) {
    if (summary) summary.textContent = "No DCL discovery probe has been recorded yet.";
    if (raw) raw.textContent = "The selected command will be sent once after bridge prechecks. All received bytes are retained in the diagnostic journal.";
    return;
  }
  const status = probe.bridgeCaptureStatus || probe.verdict?.status || "UNKNOWN";
  const count = Number(probe.responseBytes || 0);
  if (summary) summary.textContent = activeMeta
    ? `Running ${probe.label} (${probe.word}) · ${count} raw RO byte(s) observed so far. ECU ownership is not verified.`
    : `Last probe: ${probe.label} (${probe.word}) · bridge capture ${status} · ${count} raw RO byte(s). ECU ownership and command support remain unverified.`;
  const lines = (probe.rawLines || []).filter(line => /^(EVENT read_armed |EVENT session=|TX_PAD |RX |RXB |FAULT |DENIED |END )/.test(line));
  if (raw) {
    if (!lines.length) raw.textContent = "Raw response lines are retained in the diagnostic journal. Use History → Export diagnostics to retrieve the complete raw transcript.";
    else {
      const shown = lines.slice(-160);
      raw.textContent = `${lines.length > shown.length ? `… ${lines.length - shown.length} earlier evidence lines omitted from this preview …\n` : ""}${shown.join("\n")}`;
    }
  }
}

function singleCandidateWarning(spec) {
  const effects = {
    READ_ONLY: "Fixed read candidate. This records raw RO bytes and does not verify ECU ownership or command meaning.",
    SELF_TEST: "Diagnostic self-test candidate. It may actuate relays or other test outputs; keep the vehicle stationary with the engine OFF.",
    STATE_CHANGING: "State-changing candidate. It can clear ECU DCL flags or change ECU state; capture stored codes first.",
    CONFIG_CHANGE: spec.word === "8174"
      ? "Baud configuration candidate. It may desynchronize the DCL link; no automatic baud recovery is performed."
      : "Configuration candidate. It may replace ECU map/configuration state; its payload and meaning are not verified for this ECU.",
    SEQUENCE_DEPENDENT: "Sequence-dependent control candidate. Use only when its stated ECU flow prerequisite is currently satisfied; it may stop an active PID stream or leave diagnostic mode.",
  }[spec.classification] || "Fixed candidate; command meaning remains unverified.";
  return [
    `Confirm that the vehicle is stationary, the transmission is in neutral, the parking brake is applied, ignition is ON, and the engine is OFF.`,
    `Classification: ${spec.classification} · risk ${spec.risk}. Required ECU state: ${spec.requiredEcuState}.`,
    effects,
    `Transmission: ${spec.armCommand} → ${spec.readCommand}. This sends one named fixed profile with no automatic retry or fallback.`,
    `Candidate semantics have not been validated on SME-105. Source: ${spec.source}${spec.sourceUrl ? ` · ${spec.sourceUrl}` : ""}.`,
  ].join("\n\n");
}

function renderApp(state) {
  reviewControls.update();
  render(state);
  renderSingleProbe(state);
  renderDclCommandExplorer(state);
}

const ignitionReview = createIgnitionReview({ controller, render: renderApp, refreshWarnings, refreshRecordings });
const refreshPendingIgnition = show => ignitionReview.refresh(show);

function acceptText(chunk) {
  for (const line of buffer.push(chunk)) controller.handleLine(line);
}

const ble = new BleTransport({
  onLine(line) { controller.handleLine(line); },
  onDisconnect() { controller.onDisconnected(); renderApp(controller.state); },
  onError(error) {
    controller.onDisconnected();
    controller.state.message = `Bluetooth transport failed: ${error?.message || String(error)}`;
    renderApp(controller.state);
  },
});

function demoEnabled() {
  return document.getElementById("demo-toggle").checked;
}

function demoKey() {
  return document.getElementById("demo-capture").value;
}

/** Simulation is only allowed after the operator deliberately enables Demo mode. */
function simulationSelected() {
  return controller.state.transport === "demo" ||
    (controller.state.link !== "ready" && demoEnabled());
}

async function refreshKoerJournal() {
  try {
    const events = await diagnosticHistory();
    document.getElementById("koer-operator-history").textContent = events.filter(e => e.type.startsWith("KOER_")).slice(-40)
      .map(e => `${e.utc} · ${e.type} · ${e.detail.source || "app"} · ${e.detail.action || e.detail.phase || e.detail.type || ""}`).join("\n") || "No operator markers saved.";
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
    for (; koerEvidenceCount < evidence.length; ++koerEvidenceCount) koerGuide.evidence({ ...evidence[koerEvidenceCount], source: state.op.source });
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
    for (; koerEvidenceCount < evidence.length; ++koerEvidenceCount) koerGuide.evidence({ ...evidence[koerEvidenceCount], source: session.source });
    koerGuide.finish({ disconnected: session.verdict?.reasons?.includes("link lost"),
    aborted: session.verdict?.end?.reason === 15, timedOut: session.verdict?.end?.reason === 16,
    captureIntegrity: session.verdict?.status });
  }
  const evidence = {
    recordingId: session.recordingId, bridgeStatus: session.bridgeStatus, denial: session.denial, channel: "DCL", source: session.source, hardwareVerified: false, variant: session.variant, kind: session.kind, startedAt: session.startedAt, completedAt: session.completedAt,
    verdict: session.verdict, outcome: session.outcome || null, requestedMode: session.requestedMode, observedModes: session.observedModes,
    dtcVerified: session.dtcVerified, selfTestComplete: session.selfTestComplete,
    dclProbe: session.dclProbe || null,
    integrity: session.integrity, ecuEvidence: session.ecuEvidence,
    codes: session.codes, blocks25: session.blocks25, blocks26: session.blocks26,
    rx: session.verdict?.end?.ro_bytes ?? null, parityRejects: session.parityRejects,
    codeParityRejects: session.codeParityRejects,
  };
  recordDiagnosticEvent("SESSION_RESULT", evidence, "session").then(refreshTestHistory);
  if (state.archive?.finished) void state.archive.finished.then(() => refreshRecordings());
  const warning = sessionWarning(session);
  if (warning) recordDiagnosticWarning(`session-${session.variant}-${session.completedAt}`, true, { ...warning, evidence });
  for (const {key, warning} of warningsForDiagnosticSession(session)) recordDiagnosticWarning(key, true, warning);
  // New datasets never resolve older warnings or imply a memory clear.
  refreshWarnings();
  if (session.outcome === "OPERATOR_CONFIRMATION_PENDING") {
    void (async () => {
      await state.archive?.finished;
      await refreshPendingIgnition(true);
    })().catch(error => { state.message = `Could not save confirmation: ${error.message}`; renderApp(state); });
  }
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
  renderApp(controller.state);
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
    renderApp(controller.state);
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
    renderApp(controller.state);
  } finally {
    button.disabled = false;
    renderApp(controller.state);
  }
}

async function ask(title, body, action) {
  if (controller.state.link !== "ready") {
    controller.state.message = "Connect the bridge before starting a test";
    renderApp(controller.state);
    return;
  }
  if (controller.state.phase !== "idle") {
    controller.state.message = `Bridge is not idle (current phase: ${controller.state.phase})`;
    renderApp(controller.state);
    return;
  }
  const ok = await confirmDialog(title, body);
  if (!ok) return;
  if (controller.state.link !== "ready") {
    controller.state.message = "Bridge disconnected while waiting for confirmation";
    renderApp(controller.state);
    return;
  }
  if (controller.state.phase !== "idle") {
    controller.state.message = `Bridge is busy (current phase: ${controller.state.phase})`;
    renderApp(controller.state);
    return;
  }
  recordDiagnosticEvent("OPERATOR_CONFIRMED_ACTION", { action: title }, "action");
  try {
    const result = await action();
    if (result && result.ok === false) controller.state.message = result.error;
  } catch (error) {
    controller.state.message = error?.message || String(error);
  }
  renderApp(controller.state);
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
  if (controller.state.review?.active) return { ok: false, error: "Exit offline review before starting a recording" };
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

async function startVehicleOperation(variant, experimentMetadata = {}) {
  if (controller.state.review?.active) return { ok: false, error: "Exit offline review before starting a vehicle operation" };
  try {
    const archive = await createRecording(variant, error => controller.failRecording(`Recording stopped: ${error.message}`), readStorage("eeciv-unit-system") || "metric", {
      appVersion: APP_VERSION,
      firmwareIdentity: firmwareIdentitySnapshot(),
      ...experimentMetadata,
    });
    archive.line(`CAPTURE_START variant=${variant} started=${archive.started}`);
    for (const line of [controller.state.identity.hello, controller.state.identity.pins, controller.state.status?.raw]) if (line) archive.line(line);
    if (controller.state.phase !== "idle" || controller.state.link !== "ready") {
      await archive.finish({ valid: false, status: "INCOMPLETE", reasons: ["Bridge connection changed before operation start"] });
      await refreshRecordings();
      return { ok: false, error: "Connect the bridge before starting a vehicle operation" };
    }
    controller.setArchive(archive);
    const result = controller.requestVehicle(variant);
    if (!result.ok) await archive.finish({ valid: false, status: "INCOMPLETE", reasons: [result.error] });
    await refreshRecordings();
    return result;
  } catch (error) {
    return { ok: false, error: `Cannot start recording: ${error.message}` };
  }
}

async function createExperimentRecording(variant, candidate, runMetadata = {}) {
  const metadata = {
    appVersion: APP_VERSION,
    firmwareIdentity: firmwareIdentitySnapshot(),
    experimentCandidateId: candidate?.id || "",
    experimentId: candidate?.id || "",
    commandWord: candidate?.commandWord || "",
    experimentClassification: candidate?.classification || "",
    memExperimentId: runMetadata.experimentId || "",
    procedureId: runMetadata.procedureId || "",
    ...runMetadata,
  };
  const archive = await createRecording(variant, error => controller.failRecording(`Experiment recording stopped: ${error.message}`), readStorage("eeciv-unit-system") || "metric", metadata);
  archive.line(`EXPERIMENT_START candidate=${metadata.experimentCandidateId || metadata.procedureId} variant=${variant} command=${metadata.commandWord || candidate?.commandWord || ""} started=${archive.started}`);
  for (const line of [controller.state.identity.hello, controller.state.identity.pins, controller.state.status?.raw]) if (line) archive.line(line);
  return archive;
}

function candidateNeedsConfirmation(candidate) {
  return candidateRequiresOperatorConfirmation(candidate);
}

function candidateConfirmationText(candidate) {
  const special = {
    CLEAR_DTC: "Clears stored continuous-memory DTCs. Export or write down the codes first.",
    CLEAR_A1: "May clear DCL status flags; its behavior is unverified for this ECU.",
    CLEAR_F4: "May clear DCL error state; its behavior is unverified for this ECU.",
    KOEO_253E: "Runs a key-on/engine-off self-test and may actuate relays and solenoids.",
    KOEO_ALT: "Runs an alternate key-on/engine-off self-test; exact ECU effects are unverified.",
    KOER_253E: "Runs a self-test with the engine running. Keep the car stationary, in neutral, parking brake applied, and hands clear of moving parts.",
    CHANGE_BAUD: "May change ECU DCL speed and desynchronize communication. No automatic baud recovery is provided.",
    DMRMAP_TX: "May replace or load an ECU memory-address map. The map and payload are unverified.",
    PIDMAP_TX: "Loads a PID map and begins repeated live requests; the capture may continue until Stop or timeout.",
    STOP_PID_FLOW: "Sends a sequence-dependent control that may terminate an active PID stream.",
    MEMORY_READ: "Experimental memory read: the address map and 22D3 continuation parity are unresolved.",
    MEM_OFF0: "Experimental memory read includes offset zero, which may be reserved rather than RAM.",
    MEM_SINGLE: "Experimental 42F3 request-only read; ECU response behavior is unknown.",
    MEM_PARITY: "Experimental memory read uses 2293 generic VPARITY continuation, which differs from the fixed firmware literal 22D3.",
    OUTPUT_SWITCH_TEST: "Guided EEC-IV KOEO factory diagnostic session. It initiates the self-test protocol and guides manual throttle/pedal inputs while logging raw DCL response. It does not verify actuator cycling unless live evidence supports it.",
    CYLINDER_BALANCE_TEST: "Guided EEC-IV KOER factory diagnostic session. It initiates the self-test protocol and guides manual throttle/pedal inputs while logging raw DCL response. It does not verify fuel-cut sequencing or cylinder identification unless live evidence supports it.",
    GO_OFFLINE: "Ends the diagnostic session and returns ECU bus ownership to autonomous mode.",
  }[candidate.id] || "This candidate may change ECU state or initiate a test sequence; the behavior is not validated on this ECU.";
  return [
    `Required vehicle state: ${candidate.requiredEcuState}. Keep the vehicle stationary, in neutral, and the parking brake applied.`,
    special,
    `Candidate: ${candidate.name} (${candidate.commandWord}); classification ${candidate.classification}, risk ${candidate.risk}.`,
    `Transmission is one fixed named operation with no automatic retry or fallback. ${candidate.source}${candidate.sourceUrl ? ` · ${candidate.sourceUrl}` : ""}`,
  ].join("\n\n");
}

async function simulateCandidate(candidate, metadata = {}) {
  if (!simulationSelected()) {
    return { ok: false, error: "Simulation is disabled. Connect a physical bridge or deliberately enable Demo mode." };
  }
  const variant = candidate.variantKey || metadata.variant || `PROCEDURE_${candidate.id}`;
  const archive = await createExperimentRecording(variant, candidate, { ...metadata, simulated: true });
  archive.line(`SIMULATION mode=offline no_bridge_tx=1 candidate=${candidate.id}`);
  archive.line(`TX_SIMULATED envelope=${candidate.envelope?.join(" ") || "procedure runner"}`);
  archive.line("RX_SIMULATED bytes=0 source=synthetic");
  const completedAt = Date.now();
  await archive.finish({ valid: false, status: "SIMULATED", reasons: ["No bridge was connected; this record contains no vehicle transmission."] }, {
    outcome: "SIMULATED", session: { variant, startedAt: archive.started, completedAt },
  });
  const result = {
    candidateId: candidate.id, variant, commandWord: candidate.commandWord, status: "SIMULATED",
    responseBytes: 0, recordingId: archive.id, startedAt: archive.started, completedAt,
    verdict: { valid: false, status: "SIMULATED", reasons: ["No bridge was connected; no vehicle response was observed."] },
  };
  controller.state.experimentResults.push(result);
  controller.state.message = `Simulated ${candidate.name}; no bridge command was transmitted.`;
  renderApp(controller.state);
  await refreshRecordings();
  return { ok: true, simulated: true, result };
}

async function runCatalogueCandidate(candidateId) {
  const candidate = Object.values(EXPERIMENT_CATALOGUE).find(item => item.id === candidateId);
  if (!candidate?.sendable) return;
  const demo = simulationSelected();
  const connected = controller.state.link === "ready";
  const compatibility = firmwareCompatibility(candidate, demo ? null : controller.state.status);
  if (connected && !demo && !compatibility.supported) {
    controller.state.message = compatibility.message;
    renderApp(controller.state);
    return;
  }
  if (!connected && !demo) {
    controller.state.message = `Connect an authenticated bridge or deliberately enable Demo mode before transmitting ${candidate.name}. Required vehicle state: ${candidateRequiredStateText(candidate)}.`;
    renderApp(controller.state);
    return;
  }
  const proceed = !candidateNeedsConfirmation(candidate) || await confirmDialog(
    `${candidate.runnerKey ? "Factory procedure" : "Confirm DCL candidate"} · ${candidate.commandWord}`,
    candidate.runnerKey ? `${candidateConfirmationText(candidate)}\n\nThe guide checks bridge safe IDLE before starting, then captures raw bytes until Stop or completion.` : candidateConfirmationText(candidate),
  );
  if (!proceed) {
    controller.state.message = `${candidate.name} was not transmitted. Required vehicle state: ${candidateRequiredStateText(candidate)}. No command was retried.`;
    renderApp(controller.state);
    return;
  }
  if (demo) {
    if (candidate.runnerKey) return simulateCandidate(candidate, { procedureId: candidate.id, variant: candidate.id });
    return simulateCandidate(candidate, { experimentCandidateId: candidate.id, experimentId: candidate.id });
  }
  if (candidate.runnerKey) {
    const result = await controller.startFactoryProcedure(candidate.runnerKey, { createArchive: createExperimentRecording });
    if (!result.ok) controller.state.message = result.error;
    renderApp(controller.state);
    return result;
  }
  const metadata = {
    experimentCandidateId: candidate.id, experimentId: candidate.id,
    commandWord: candidate.commandWord,
  };
  return startVehicleOperation(candidate.variantKey, metadata);
}

async function runSelectedCandidateBatch(candidateIds) {
  if (controller.state.candidateBatch?.status === "running") return;
  const candidates = candidateIds.map(id => Object.values(EXPERIMENT_CATALOGUE).find(item => item.id === id)).filter(item => item?.sendable && item.variantKey);
  if (!candidates.length) return;
  const demo = simulationSelected();
  const connected = controller.state.link === "ready";
  if (!connected && !demo) {
    controller.state.message = "Connect an authenticated bridge or deliberately enable Demo mode before running selected candidates. No simulated result was produced.";
    renderApp(controller.state);
    return;
  }
  const confirmCandidate = async candidate => {
    if (!candidateNeedsConfirmation(candidate)) return true;
    const approved = await confirmDialog(
      `Confirm ${candidate.name} · ${candidate.commandWord}`,
      [
        candidateConfirmationText(candidate),
        `Required vehicle state: ${candidateRequiredStateText(candidate)}.`,
        "This confirmation applies only to this command. The next state-changing, self-test, baud/map-writing, engine-running, or experimental command will ask again.",
        "Stop ends the active capture and prevents the next candidate from starting. No command is retried.",
      ].join("\n\n"),
    );
    if (!approved) controller.state.message = `${candidate.name} was skipped because its operator confirmation or required vehicle state was not provided.`;
    renderApp(controller.state);
    return approved;
  };
  if (demo) {
    const results = [];
    controller.state.candidateBatch = { status: "running", startedAt: Date.now(), results, candidateIds, currentId: "", stopRequested: false, error: "", skipped: [] };
    renderApp(controller.state);
    for (const candidate of candidates) {
      if (controller.state.candidateBatch.stopRequested) break;
      controller.state.candidateBatch.currentId = candidate.id;
      const startedAt = Date.now();
      if (!(await confirmCandidate(candidate))) {
        results.push({ candidateId: candidate.id, variant: candidate.variantKey, commandWord: candidate.commandWord, status: "CONFIRMATION_REQUIRED", responseBytes: 0, recordingId: null, error: "Operator confirmation or required vehicle state was not provided.", startedAt, completedAt: Date.now() });
        controller.state.candidateBatch.skipped.push(candidate.id);
        renderApp(controller.state);
        continue;
      }
      const simulated = await simulateCandidate(candidate, { experimentCandidateId: candidate.id, experimentId: candidate.id, batchId: controller.state.candidateBatch.startedAt });
      results.push(simulated.ok ? simulated.result : { candidateId: candidate.id, status: "SIMULATION_BLOCKED", responseBytes: 0, recordingId: null, error: simulated.error, startedAt, completedAt: Date.now() });
    }
    if (controller.state.candidateBatch.skipped.length) {
      controller.state.candidateBatch.error = `${controller.state.candidateBatch.skipped.length} command(s) were skipped because the operator confirmation or required vehicle state was not provided. No command was retried.`;
    }
    controller.state.candidateBatch.status = controller.state.candidateBatch.stopRequested ? "stopped" : controller.state.candidateBatch.error ? "failed" : "complete";
    controller.state.candidateBatch.completedAt = Date.now();
    controller.state.candidateBatch.currentId = "";
    renderApp(controller.state);
    return;
  }
  const outcome = await controller.runCandidateBatch({
    candidateIds,
    createArchive: createExperimentRecording,
    onProgress: () => renderApp(controller.state),
    confirmCandidate,
  });
  if (outcome.error) controller.state.message = outcome.error;
  await refreshRecordings();
  renderApp(controller.state);
}

async function runMemMatrix(experimentId = null) {
  const demo = simulationSelected();
  const connected = controller.state.link === "ready";
  if (!connected && !demo) {
    controller.state.message = "Connect an authenticated bridge or deliberately enable Demo mode before running MEM experiments. No simulated result was produced.";
    renderApp(controller.state);
    return;
  }
  const confirmation = await confirmDialog(
    experimentId ? `Run MEM experiment ${experimentId}` : "Run all MEM experiments",
    "Keep the vehicle stationary, in neutral, parking brake applied, ignition ON, and engine OFF. These memory-read profiles are experimental; the address map is not validated. Each run has a bounded capture, is stored separately in IndexedDB, and can be stopped without retry.",
  );
  if (!confirmation) return;
  if (demo) {
    const ids = experimentId ? [experimentId] : ["MEM", "MEM_OFF0", "MEM_SINGLE", "MEM_PARITY"];
    controller.state.memMatrix.status = "running";
    controller.state.memMatrix.stopRequested = false;
    controller.state.memMatrix.results = controller.state.memMatrix.results.filter(row => !ids.includes(row.experimentId));
    renderApp(controller.state);
    for (const id of ids) {
      if (controller.state.memMatrix.stopRequested) break;
      const candidate = Object.values(EXPERIMENT_CATALOGUE).find(item => item.variantKey === id);
      const simulated = await simulateCandidate(candidate, { experimentId: id, memExperimentId: id, matrixId: "MEM", variant: id });
      controller.state.memMatrix.results.push({
        experimentId: id, variant: id, title: id, status: simulated.ok ? "SIMULATED" : "SIMULATION_BLOCKED", responseBytes: 0, responseHex: "",
        txEnvelope: candidate.envelope, verdict: simulated.result?.verdict || null, recordingId: simulated.result?.recordingId || null,
        error: simulated.error || "",
        startedAt: simulated.result?.startedAt || Date.now(), completedAt: simulated.result?.completedAt || Date.now(),
      });
      controller.state.memMatrix.activeId = "";
      renderApp(controller.state);
    }
    controller.state.memMatrix.status = controller.state.memMatrix.stopRequested ? "stopped" : "complete";
    controller.state.memMatrix.completedAt = Date.now();
    renderApp(controller.state);
    return;
  }
  const outcome = experimentId
    ? await controller.runMemExperiment(experimentId, { createArchive: createExperimentRecording })
    : await controller.runAllMemExperiments({ createArchive: createExperimentRecording });
  if (outcome.error) controller.state.message = outcome.error;
  await refreshRecordings();
  renderApp(controller.state);
}

function firmwareIdentitySnapshot() {
  const status = controller.state.status;
  return {
    identity: status?.identity || "",
    firmwareVersion: status?.fields?.fw || null,
    hello: controller.state.identity.hello || "",
    pins: controller.state.identity.pins || "",
    status: status?.raw || "",
  };
}

async function createDiscoveryRecording(variant, candidate, pass) {
  const archive = await createRecording(
    variant,
    error => controller.failRecording(`Discovery recording stopped: ${error.message}`),
    readStorage("eeciv-unit-system") || "metric",
    {
      discoveryPassId: pass.id,
      discoveryCandidateId: candidate.id,
      commandWord: candidate.commandWord,
      appVersion: APP_VERSION,
      firmwareIdentity: firmwareIdentitySnapshot(),
    },
  );
  archive.line(`DISCOVERY_PASS id=${pass.id} candidate=${candidate.id} command=${candidate.commandWord}`);
  archive.line(`CAPTURE_START variant=${variant} started=${archive.started}`);
  for (const line of [controller.state.identity.hello, controller.state.identity.pins, controller.state.status?.raw]) if (line) archive.line(line);
  return archive;
}

async function refreshRecordings() { await reviewControls.refresh(); }

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
    renderApp(controller.state);
  } catch (error) {
    controller.state.message = `Diagnostic ZIP failed: ${error.message}`;
    renderApp(controller.state);
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
    select.replaceChildren(...savedTests.map((event, index) => {
      const probe = event.detail.dclProbe;
      const detail = probe ? `${probe.word} · ${probe.responseBytes ?? "?"} RO bytes` : `${event.detail.codes?.length || 0} codes`;
      return new Option(`${new Date(event.detail.completedAt).toLocaleString()} · ${event.detail.variant} · ${detail} · ${event.detail.verdict?.status || "UNKNOWN"}`, index);
    }));
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
    renderApp(controller.state);
  }
}

async function restoreLastDiagnosticResult() {
  const events = await diagnosticHistory();
  const resultEvent = events.filter(event => event.type === "SESSION_RESULT").at(-1);
  if (!resultEvent?.detail) return;
  const detail = { ...resultEvent.detail };
  const recording = (await listRecordings()).find(item => item.id === detail.recordingId);
  if (recording?.outcome) Object.assign(detail, { outcome: recording.outcome, operatorConfirmation: recording.operatorConfirmation });
  controller.state.lastSession = { ...detail, rows: [], pids: {}, mem: {}, rom: null, totalRows: 0 };
  if (detail.dclProbe) controller.state.lastDclProbe = {
    ...detail.dclProbe, variant: detail.variant, startedAt: detail.startedAt,
    completedAt: detail.completedAt, verdict: detail.verdict, rawLines: [],
    recordingId: detail.recordingId || detail.dclProbe.recordingId || null,
    result: {
      variant: detail.variant, verdict: detail.verdict,
      responseBytes: detail.dclProbe.responseBytes, completedAt: detail.completedAt,
    },
  };
  controller.state.trust = detail.verdict?.valid ? "valid" : "untrusted";
  if (detail.variant === "KOER") Object.assign(koerGuide.state, { phase: "ENDED_UNVERIFIED", sessionId: detail.startedAt, prompt: null, verifiedSuccess: false });
  previousSessionKey = `${detail.variant}:${detail.startedAt}:${detail.completedAt}`;
}

function wire() {
  applyStaticStrings();
  const probeSelect = document.getElementById("dcl-probe-select");
  probeSelect.replaceChildren(...Object.entries(DCL_PROBE_VARIANTS)
    .filter(([, spec]) => spec.sendable)
    .map(([variant, spec]) => {
    const option = document.createElement("option");
    option.value = variant;
    option.textContent = `${spec.label} · ${spec.word}`;
    return option;
  }));
  const blockedList = document.getElementById("dcl-probe-blocked");
  blockedList.replaceChildren(...DCL_BLOCKED_CANDIDATES.map(item => {
    const li = document.createElement("li");
    li.textContent = `${item.word} · ${item.label} — ${item.reason}`;
    return li;
  }));
  renderSingleProbe(controller.state);
  renderDclCommandExplorer(controller.state);
  wireDclCommandExplorer();
  document.getElementById("about-version").textContent = APP_VERSION;
  document.getElementById("secure-warning").hidden = window.isSecureContext;
  document.getElementById("bt-warning").hidden = bluetoothAvailable() || demoEnabled();
  const storedDemo = readStorage("eeciv-demo") === "1";
  const storedCapture = readStorage("eeciv-demo-capture");
  const manual = readStorage("eeciv-manual-gearbox") !== "0";
  document.getElementById("manual-gearbox-settings").checked = manual;
  const idleCheck = readStorage("eeciv-idle-check") === "1";
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
    try { const event = koerGuide.confirm(button.dataset.operatorMarker); if (!await operatorSave) throw new Error("Operator marker was not saved; diagnostic storage failed"); await refreshKoerJournal(); document.getElementById("operator-marker-status").textContent = `Human report saved: ${new Date(event.at).toLocaleTimeString()} · not ECU confirmed`; }
    catch (error) { document.getElementById("operator-marker-status").textContent = error.message; }
  }));
  const storedMode = readStorage("eeciv-stored-code-mode");
  if (storedMode === "0E" || storedMode === "A4") document.getElementById("stored-code-mode").value = storedMode;
  document.getElementById("stored-code-mode").addEventListener("change", (event) => {
    writeStorage("eeciv-stored-code-mode", event.target.value);
  });
  for (const id of ["manual-gearbox-settings"]) document.getElementById(id).addEventListener("change", (event) => {
    const value = event.target.checked;
    document.getElementById("manual-gearbox-settings").checked = value;
    writeStorage("eeciv-manual-gearbox", value ? "1" : "0");
    renderApp(controller.state);
  });
  for (const id of ["idle-check-settings"]) document.getElementById(id).addEventListener("change", (event) => {
    const value = event.target.checked;
    document.getElementById("idle-check-settings").checked = value;
    writeStorage("eeciv-idle-check", value ? "1" : "0");
    renderApp(controller.state);
  });
  document.getElementById("live-set").addEventListener("change", event => {
    writeStorage("eeciv-live-set", event.target.value); closeSensorDetails(); renderApp(controller.state);
  });
  document.getElementById("dashboard-density").addEventListener("change", event => {
    setDashboardDensity(event.target.value); renderApp(controller.state);
  });
  document.getElementById('dashboard-columns').addEventListener('change', event => {
    setDashboardColumns(event.target.value); renderApp(controller.state);
  });
  document.getElementById('dashboard-expand').addEventListener('click', () => {
    toggleDashboardFocus(); renderApp(controller.state);
    document.getElementById('dashboard-overview').scrollIntoView?.({ block: 'start' });
  });
  document.getElementById("arrange-dashboard").addEventListener("click", () => {
    if (isDashboardArranging()) endDrag();
    toggleDashboardArrangement(); renderApp(controller.state);
  });
  const pinnedGrid = document.getElementById('pinned-readings');
  let dragging = null;
  pinnedGrid.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-drag-pid]');
    const card = handle?.closest('.pinned-card');
    if (!isDashboardArranging() || !card || dragging || event.isPrimary === false || event.button > 0) return;
    event.preventDefault();
    dragging = { pid: card.dataset.pid, pointer: event.pointerId };
    pinnedGrid.setPointerCapture(event.pointerId); card.classList.add('dragging');
  });
  pinnedGrid.addEventListener('pointermove', event => {
    if (!dragging || event.pointerId !== dragging.pointer) return;
    event.preventDefault();
    const target = document.elementFromPoint(event.clientX,event.clientY)?.closest('.pinned-card');
    if (target && pinnedGrid.contains(target) && target.dataset.pid !== dragging.pid) {
      reorderPinnedSensor(dragging.pid, target.dataset.pid); renderApp(controller.state);
    }
  });
  const endDrag = () => {
    if (!dragging) return;
    const pointer = dragging.pointer;
    dragging = null;
    pinnedGrid.querySelectorAll('.dragging').forEach(card => card.classList.remove('dragging'));
    if (pinnedGrid.hasPointerCapture(pointer)) pinnedGrid.releasePointerCapture(pointer);
  };
  pinnedGrid.addEventListener('pointerup', endDrag);
  pinnedGrid.addEventListener('pointercancel', endDrag);
  pinnedGrid.addEventListener('lostpointercapture', endDrag);
  pinnedGrid.addEventListener('keydown', event => {
    if (!isDashboardArranging() || !event.target.matches('.pinned-card')) return;
    const offset = ['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : ['ArrowRight','ArrowDown'].includes(event.key) ? 1 : 0;
    if (!offset) return;
    event.preventDefault();
    const pins = pinnedSensors(), name = event.target.dataset.pid, target = pins[pins.indexOf(name)+offset];
    if (target) { reorderPinnedSensor(name,target); renderApp(controller.state); event.target.focus(); }
  });
  const sensorChart = document.getElementById('sensor-chart');
  sensorChart.addEventListener('pointerdown', event => { sensorChart.setPointerCapture(event.pointerId); inspectSensorChart(event.clientX); });
  sensorChart.addEventListener('pointermove', event => { if (event.buttons || event.pointerType === 'mouse') inspectSensorChart(event.clientX); });
  document.getElementById("live-group").addEventListener("change", (event) => {
    writeStorage("eeciv-live-group", event.target.value);
    renderApp(controller.state);
  });
  document.getElementById("theme-mode").addEventListener("change", (event) => {
    writeStorage("eeciv-theme", event.target.value); applyDisplayPreferences();
  });
  document.getElementById("unit-system").addEventListener("change", (event) => {
    writeStorage("eeciv-unit-system", event.target.value); renderApp(controller.state);
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
      renderApp(controller.state);
    });
  });
  const openLabBtn = document.getElementById("open-engineering-lab");
  if (openLabBtn) {
    openLabBtn.addEventListener("click", () => {
      showView("lab");
      recordDiagnosticEvent("SCREEN_VIEW", { view: "lab" }, "ui");
      renderApp(controller.state);
    });
  }
  document.querySelectorAll("[data-lab-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const targetSec = button.dataset.labSection;
      document.querySelectorAll("[data-lab-section]").forEach((b) => {
        const isTarget = b === button;
        b.classList.toggle("active", isTarget);
        b.setAttribute("aria-selected", String(isTarget));
      });
      document.querySelectorAll(".lab-section").forEach((sec) => {
        sec.hidden = sec.id !== `lab-sec-${targetSec}`;
      });
      // Keep the selected pill visible in the Lab's horizontal navigation on narrow phones.
      button.scrollIntoView?.({ block: "nearest", inline: "center", behavior: "auto" });
    });
  });
  document.getElementById("connect-btn").addEventListener("click", () => { connect(); });
  document.getElementById("connect-settings").addEventListener("click", () => { connect(); });
  document.getElementById("stop-btn").addEventListener("click", () => controller.requestStop());
  document.getElementById("view-live").addEventListener("click", (event) => {
    const pinButton = event.target.closest("[data-pin-pid]");
    if (pinButton) {
      event.stopPropagation(); toggleSensorPin(pinButton.dataset.pinPid); renderApp(controller.state); return;
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
    toggleSensorPin(event.currentTarget.dataset.pinPid); renderApp(controller.state);
  });
  document.getElementById("drawer-export-sensor").addEventListener("click", () => {
    exportSensorCsv(document.getElementById("drawer-export-sensor").dataset.sourcePid, { unitSystem: currentUnits() })
      .catch(error => { controller.state.message = `Sensor export failed: ${error.message}`; renderApp(controller.state); });
  });
  document.getElementById("export-group-btn").addEventListener("click", () => {
    exportGroupCsv(document.getElementById("live-group").value, { unitSystem: currentUnits(), manual: document.getElementById("manual-gearbox-settings").checked })
      .catch(error => { controller.state.message = `Group export failed: ${error.message}`; renderApp(controller.state); });
  });
  for (const id of ["warning-filter", "warning-sensor-filter", "warning-date-filter"]) document.getElementById(id).addEventListener("change", refreshWarnings);
  document.getElementById("export-diagnostics").addEventListener("click", saveFullDiagnostic);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !document.getElementById("sensor-drawer").hidden) {
      closeSensorDetails();
    }
  });
  document.getElementById("dcl-probe-select").addEventListener("change", () => renderSingleProbe(controller.state));
  document.addEventListener("dcl:run-candidate", event => { void runCatalogueCandidate(event.detail?.candidateId); });
  document.addEventListener("dcl:run-selected", event => { void runSelectedCandidateBatch(event.detail?.candidateIds || getSelectedDclCandidates()); });
  document.addEventListener("dcl:run-mem", event => { void runMemMatrix(event.detail?.experimentId); });
  document.addEventListener("dcl:run-mem-all", () => { void runMemMatrix(); });
  document.addEventListener("dcl:stop-mem", () => controller.stopMemExperiments());
  document.addEventListener("dcl:run-procedure", event => { void runCatalogueCandidate(event.detail?.procedureId); });
  document.addEventListener("dcl:procedure-next", () => controller.nextFactoryProcedureStep());
  document.addEventListener("dcl:procedure-stop", () => controller.stopFactoryProcedure());
  document.getElementById("dcl-stop-selected").addEventListener("click", () => controller.stopCandidateBatch());
  document.addEventListener("dcl:export-experiments", async () => {
    try {
      const archive = await exportAllExperimentsArchive({ appVersion: APP_VERSION, firmwareIdentity: firmwareIdentitySnapshot() });
      await saveOrShare(archive.blob, `sme105-experiments-${new Date().toISOString().replaceAll(":", "-")}.zip`);
      controller.state.message = `Experiment archive integrity verified · SHA-256 ${archive.archiveSha.slice(0, 8)}...`;
      renderApp(controller.state);
    } catch (error) {
      controller.state.message = `Experiment export failed: ${error.message}`;
      renderApp(controller.state);
    }
  });
  document.getElementById("discovery-run").addEventListener("click", async () => {
    if (controller.state.link !== "ready" || controller.state.phase !== "idle" || controller.state.transport === "demo") {
      controller.state.message = "Connect an authenticated physical bridge in safe IDLE before starting discovery.";
      renderApp(controller.state);
      return;
    }
    const confirmed = await confirmDialog(
      "Run supported read-only discovery pass",
      "Confirm all preconditions: the vehicle is stationary, the transmission is in neutral, the parking brake is applied, ignition is ON, and the engine is OFF. This pass sends exactly the eight passive read-only candidates in order: 0E (260E), A4 (26A4), 0381, 005E, 004E, 242E, 22C6, and 271E. No state-changing, self-test, baud, map-writing, or memory-read command is included. MEM experiments are a separate, dedicated MEM Experiment Matrix workflow. Each capture is recorded separately; the pass stops on bridge fault, unsafe status, or connection loss.",
    );
    if (!confirmed) return;
    try {
      const result = await controller.startDiscoveryPass({
        createArchive: createDiscoveryRecording,
        onProgress: () => renderApp(controller.state),
      });
      if (result.error) controller.state.message = result.error;
      await refreshRecordings();
      renderApp(controller.state);
    } catch (error) {
      controller.state.message = `Discovery pass failed: ${error.message}`;
      renderApp(controller.state);
    }
  });
  document.getElementById("discovery-stop").addEventListener("click", () => controller.stopDiscoveryPass());
  document.getElementById("discovery-export").addEventListener("click", async () => {
    const pass = controller.state.discoveryPass;
    try {
      const archive = await exportDiscoveryPassArchive(pass, {
        appVersion: APP_VERSION,
        firmwareIdentity: firmwareIdentitySnapshot(),
      });
      const safeId = String(pass.id || "pass").replace(/[^A-Za-z0-9_-]/g, "-");
      const fileName = `sme105-discovery-${safeId}.zip`;
      await saveOrShare(archive.blob, fileName);
      controller.state.message = `Exported discovery archive ${fileName} (SHA-256 ${archive.archiveSha.slice(0, 8)}...)`;
      renderApp(controller.state);
    } catch (error) {
      controller.state.message = `Discovery export failed: ${error.message}`;
      renderApp(controller.state);
    }
  });
  document.getElementById("dcl-probe-run").addEventListener("click", () => {
    const variant = document.getElementById("dcl-probe-select").value;
    const spec = DCL_PROBE_VARIANTS[variant];
    if (!spec) return;
    const candidate = Object.values(EXPERIMENT_CATALOGUE).find(item => item.variantKey === variant);
    if (candidate) void runCatalogueCandidate(candidate.id);
  });
  document.getElementById("dcl-probe-export").addEventListener("click", async () => {
    if (controller.state.phase !== "idle" || controller.state.op) {
      controller.state.message = "Finish the active probe before exporting evidence.";
      renderApp(controller.state);
      return;
    }
    const probe = controller.state.lastDclProbe;
    const variant = probe?.variant || "probe";
    const stamp = new Date(probe?.completedAt || Date.now()).toISOString().replaceAll(":", "-");
    const recId = probe?.recordingId;
    try {
      if (!probe || !recId) throw new Error("No finalized recording is associated with this probe.");
      const archive = await exportExperimentArchive(recId);
      const fileName = `sme105-dcl-${variant}-${stamp}.zip`;
      await saveOrShare(archive.blob, fileName);
      controller.state.message = `Exported probe archive ${fileName} (SHA-256 ${archive.archiveSha.slice(0, 8)}...)`;
      renderApp(controller.state);
    } catch (error) {
      controller.state.message = `DCL probe export failed: ${error.message}`;
      renderApp(controller.state);
    }
  });
  document.getElementById("read-codes-btn").addEventListener("click", () => {
    const variant = document.getElementById("stored-code-mode").value === "A4" ? "A4" : "0E";
    ask(`${STR.confirmStoredTitle} (${variant})`, `${STR.confirmStoredBody}\n\nSelected request: ${variant}; expected response mode: 26H.`, () => startVehicleOperation(variant));
  });
  document.getElementById("koeo-btn").addEventListener("click", () => ask(
    STR.confirmKoeoTitle, STR.confirmKoeoBody, () => startVehicleOperation("KOEO"),
  ));
  document.getElementById("koer-btn").addEventListener("click", () => ask(
    STR.confirmKoerTitle, STR.confirmKoerBody, () => startVehicleOperation("KOER"),
  ));
  document.getElementById("live-start").addEventListener("click", () => ask(
    STR.confirmLiveTitle, selectedLive() === "ALL" ? STR.confirmAllLiveBody : STR.confirmLiveBody,
    startLive,
  ));
  document.getElementById("offline-btn").addEventListener("click", () => ask(
    STR.confirmOffTitle, STR.confirmOffBody, () => startVehicleOperation("OFF"),
  ));
  document.getElementById("clear-btn").addEventListener("click", () => ask(
    STR.confirmClearTitle, STR.confirmClearBody, () => startVehicleOperation("CLR"),
  ));
  document.getElementById("mem-btn").addEventListener("click", () => {
    if (COMMAND_CATALOGUE.MEM_READ.sendable === false) {
      controller.state.message = COMMAND_CATALOGUE.MEM_READ.blockedReason;
      renderApp(controller.state);
      return;
    }
    ask(STR.confirmMemTitle, STR.confirmMemBody, () => startVehicleOperation("MEM"));
  });
  document.getElementById("reboot-btn").addEventListener("click", () => ask(
    STR.confirmRebootTitle, STR.confirmRebootBody, () => controller.requestReboot(),
  ));
  document.getElementById("bench-btn").addEventListener("click", () => {
    const result = controller.requestBench();
    if (result && result.ok === false) controller.state.message = result.error;
    renderApp(controller.state);
  });
  const reportExportError = error => { controller.state.message = `Export failed: ${error.message}`; renderApp(controller.state); };
  document.getElementById("export-btn").addEventListener("click", () => exportLog(controller.state).catch(reportExportError));
  document.getElementById("csv-btn").addEventListener("click", () => exportCsv(controller.state).catch(reportExportError));
  document.getElementById("saved-csv").addEventListener("click", () => downloadSaved("csv"));
  document.getElementById("saved-log").addEventListener("click", () => downloadSaved("raw"));
  reviewControls.wire();
  void reviewControls.refresh();
  void refreshPendingIgnition(true).catch(error => { controller.state.message = `Recording storage unavailable: ${error.message}`; renderApp(controller.state); });
  ignitionReview.wire();
  refreshTestHistory();

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
      renderApp(controller.state);
    });
  };
  controller.subscribe(state => { scheduleRender(); auditState(state); });
  setInterval(() => { if (!controller.state.recovering) controller.tick(); void reviewControls.player.tick().catch(error => { controller.state.message = `Playback failed: ${error.message}`; renderApp(controller.state); }); }, 250);
  setInterval(() => {
    if (controller.state.combined || controller.state.op?.kind === "live" || !document.getElementById("sensor-drawer").hidden) scheduleRender();
    auditFreshness(controller.state);
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    recordDiagnosticEvent(document.hidden ? "APP_BACKGROUND" : "APP_FOREGROUND", { phase: controller.state.phase }, "lifecycle");
    if (document.hidden) {
      reviewControls.player.pause();
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
      renderApp(controller.state);
    });
  }
  const initialView = new URLSearchParams(window.location.search).get("view") || "live";
  showView(initialView);
  const initialLabSec = new URLSearchParams(window.location.search).get("labSec");
  if (initialLabSec) {
    const pill = document.querySelector(`[data-lab-section="${initialLabSec}"]`);
    if (pill) pill.click();
  }
  renderApp(controller.state);
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
      if (wired) renderApp(controller.state);
    }
  });
  try {
    await startDiagnosticRun();
    await recoverInterruptedRecordings();
    await restoreLastDiagnosticResult();
    for (const item of await listRecordings()) if (item.operatorConfirmation && item.session) await reconcileOutcome(item);
  }
  catch (error) { document.getElementById("message").textContent = `Diagnostic storage is unavailable: ${error.message}`; }
  window.addEventListener("error", event => {
    recordDiagnosticEvent("UNCAUGHT_ERROR", { message: event.message, source: event.filename, line: event.lineno, stack: event.error?.stack || "" }, "error");
    controller.state.message = `Application error: ${event.message}`;
    if (wired) renderApp(controller.state);
  });
  window.addEventListener("unhandledrejection", event => {
    const error = event.reason;
    recordDiagnosticEvent("UNHANDLED_REJECTION", { message: error?.message || String(error), stack: error?.stack || "" }, "error");
    controller.state.message = `Application task failed: ${error?.message || String(error)}`;
    if (wired) renderApp(controller.state);
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
