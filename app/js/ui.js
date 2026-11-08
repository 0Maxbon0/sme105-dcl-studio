import { formatMeasurement, formattedReading, formatReplayTime } from './display-format.js';
import { renderBitPanel } from './bit-presentation.js';
import { dashboardReading } from "./throttle-display.js";
/** Stable, keyed dashboard rendering for browser and native WebView. */

import { lookupCode } from "./codes-db.js";
import { AUTOMATIC_PIDS, judgeReading, PID_TEXT, PIDS, rowsToCsv, summarizeSeries } from "./pids.js";
import { combinedSnapshot } from "./combined.js";
import { COMMAND_CATALOGUE, EXPERIMENT_CATALOGUE, MEM_EXPERIMENTS, dclVParityByte, firmwareCompatibility, reasonText, stageText, VARIANTS } from "./protocol.js";
import * as PROTOCOL from "./protocol.js";
import { STR } from "./strings.js";
import { readingReference, VEHICLE_PROFILE } from "./reference.js";
import { LIVE_GROUP_HELP, LIVE_GROUP_TITLES, sensorsForGroup, sensorFreshness } from "./live-dashboard.js";
import { redactDiagnostic } from "./diagnostics.js";
import { saveOrShare } from "./exports.js";
import { listRecordings, recordingBlob } from "./recording.js";
import { normalizeDashboardPrefs, normalizeDashboardDensity, normalizeDashboardColumns, dashboardSensors, dashboardChannels, dashboardSensor, reorderedPins } from "./dashboard-layout.js";
import { chartPoints, chartEnvelope, chartBounds, sensorSamplesFromCsv } from "./chart-series.js";

const $ = (id) => document.getElementById(id);
const cardNodes = new Map();
const pinnedNodes = new Map();
const fmemNodes = new Map();
let detailPid = null;
let detailPercent = false;
let detailRange = "30";
let latestState = null;
let arranging = false;
let dashboardFocused = false;
let detailHistory = null;
let detailLoad = 0;
let chartProbe = null;
let activeView = "live";
let dclSearch = "";
let dclCategory = "ALL";
let dclFirmwareStatus = "ALL";
let dclSelectedId = "";
let dclState = null;
let dclRenderedIds = "";
const selectedDclCandidates = new Set();

const PREF_KEY = "sme105-dashboard-prefs-v1";

function readPrefs() {
  try { return normalizeDashboardPrefs(JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); }
  catch { return normalizeDashboardPrefs(); }
}
function dashboardSet() { return $("live-set")?.value || "ALL"; }
function writePrefs(prefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* Private browsing may disable storage. */ }
}

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function unitSystem() { return readStored("eeciv-unit-system") === "imperial" ? "imperial" : "metric"; }

export function pinnedSensors() { return readPrefs().layouts[dashboardSet()] || []; }
export function toggleSensorPin(name) {
  if (!dashboardChannels(dashboardSet()).includes(name)) return pinnedSensors();
  const prefs = readPrefs(), variant = dashboardSet();
  const pins = prefs.layouts[variant];
  prefs.layouts[variant] = pins.includes(name) ? pins.filter(item => item !== name) : [...pins, name];
  writePrefs(prefs);
  return prefs.layouts[variant];
}
export function reorderPinnedSensor(name, target) {
  const prefs = readPrefs(), variant = dashboardSet();
  prefs.layouts[variant] = reorderedPins(prefs.layouts[variant], name, target);
  writePrefs(prefs);
}
export function setDashboardDensity(value) {
  const prefs = readPrefs(); prefs.density = normalizeDashboardDensity(value); writePrefs(prefs);
}
export function setDashboardColumns(value) {
  const prefs = readPrefs(); prefs.columns = normalizeDashboardColumns(value); writePrefs(prefs);
}
export function setDashboardFocus(value) {
  dashboardFocused = !!value;
  document.body.classList.toggle('dashboard-focus', dashboardFocused && activeView === 'live');
}
export function toggleDashboardFocus() { setDashboardFocus(!dashboardFocused); }
export function toggleDashboardArrangement() { arranging = !arranging; }
export function isDashboardArranging() { return arranging; }

function setReadingValue(node, name, summary, manual) {
  let number = node.querySelector('.reading-number');
  if (!number) {
    number = document.createElement('span'); number.className = 'reading-number';
    const unit = document.createElement('small'); unit.className = 'reading-unit'; node.append(number, unit);
  }
  const reading = summary ? dashboardReading(name, summary.last, { unitSystem: unitSystem() }) : null;
  setText(number, reading ? formatMeasurement(name, reading.value, reading.unit) : '—');
  node.classList.toggle('long-number', number.textContent.length > 6);
  setText(node.querySelector('.reading-unit'), reading ? reading.unit : '');
}

export function applyStaticStrings() {
  document.querySelectorAll("[data-str]").forEach((node) => {
    const value = STR[node.getAttribute("data-str")];
    if (typeof value === "string") node.textContent = value;
  });
  document.querySelectorAll("nav button").forEach((button) => {
    button.textContent = STR.tabs[button.dataset.view];
  });
  $("demo-capture").options[0].textContent = STR.capture0e;
  $("demo-capture").options[1].textContent = STR.captureKoeo;
  $("demo-capture").options[2].textContent = STR.captureLive;
  $("secure-warning").textContent = STR.secureWarning;
  $("bt-warning").textContent = STR.noBluetooth;
  $("modal-cancel").textContent = STR.cancel;
  $("modal-ok").textContent = STR.proceed;
  $("vehicle-profile").textContent = VEHICLE_PROFILE;
}

export function showView(name) {
  const view = name === "history" ? "log" : name === "faults" ? "codes" : name;
  activeView = view;
  if (view !== "live") setDashboardFocus(false);
  document.querySelectorAll(".view").forEach((item) => {
    item.hidden = item.id !== `view-${view}`;
  });
  document.querySelectorAll("nav button").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.view === view ? "page" : "false");
  });
}

export function confirmDialog(title, body) {
  const modal = $("modal");
  $("modal-title").textContent = title;
  $("modal-body").textContent = body;
  modal.hidden = false;
  modal.classList.add("open");
  $("modal-cancel").focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      modal.hidden = true;
      modal.classList.remove("open");
      $("modal-ok").removeEventListener("click", onOk);
      $("modal-cancel").removeEventListener("click", onCancel);
      resolve(value);
    };
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    $("modal-ok").addEventListener("click", onOk);
    $("modal-cancel").addEventListener("click", onCancel);
  });
}

const DCL_CLASS_LABELS = Object.freeze({
  READ_ONLY: "Read-only · Class A",
  SELF_TEST: "Self-test · Class B",
  STATE_CHANGING: "State-changing · Class C",
  CONFIG_CHANGE: "Config/Baud · Class D",
  SEQUENCE_DEPENDENT: "Sequence-dependent · Class E",
  FACTORY_PROCEDURE: "Factory procedure · Class F",
  CONTROL: "Control word",
});

function normalizeHexSearch(value) {
  return String(value || "").toUpperCase().replace(/^0X/, "").replace(/[\s_-]/g, "");
}

/** The three fixed envelope words are framing references, never standalone executable commands. */
export function protocolFramingEntries() {
  const reference = PROTOCOL.PROTOCOL_FRAMING_REFERENCE;
  if (reference) return Array.isArray(reference) ? [...reference] : Object.values(reference);
  return Object.values(EXPERIMENT_CATALOGUE).filter(item => item.classification === "CONTROL");
}

/** The Explorer lists only the 26 actual executable candidates, including the two guided procedures. */
export function executableCatalogueEntries(catalogue = EXPERIMENT_CATALOGUE) {
  return Object.values(catalogue).filter(item => item.classification !== "CONTROL");
}

export function filterDclCatalogue({ query = "", category = "ALL", firmwareStatus = "ALL", firmwareVersion = null } = {}, catalogue = EXPERIMENT_CATALOGUE) {
  const text = String(query).trim().toLocaleLowerCase();
  const hex = normalizeHexSearch(query);
  const searchAsHex = !!hex && /^[0-9A-F]+$/.test(hex);
  return executableCatalogueEntries(catalogue).filter(item => {
    if (category !== "ALL" && item.classification !== category) return false;
    const compatible = item.sendable && firmwareCompatibility(item, firmwareVersion).supported;
    if (firmwareStatus === "SUPPORTED" && !compatible) return false;
    if (firmwareStatus === "DEFERRED" && compatible) return false;
    if (!text) return true;
    const nameMatch = [item.id, item.name, item.variantKey, item.armCommand, item.readCommand]
      .some(value => String(value || "").toLocaleLowerCase().includes(text));
    const wordMatch = searchAsHex && normalizeHexSearch(item.commandWord).includes(hex);
    return nameMatch || wordMatch;
  });
}

function wordsAsBytes(words) {
  if (!Array.isArray(words) || !words.length) return "Procedure only; no raw command bytes.";
  return words.map(word => String(word).match(/[0-9A-Fa-f]{4}/g)?.map(group => `${group.slice(0, 2).toUpperCase()} ${group.slice(2).toUpperCase()}`).join(" / ") || String(word)).join(" → ");
}

function parityDescription(item) {
  const candidateWords = String(item.commandWord || "").match(/[0-9A-F]{4}/gi) || [];
  const envelopeWords = (item.envelope || []).filter(word => /^[0-9A-F]{4}$/i.test(word));
  const words = [...new Set([...envelopeWords, ...candidateWords])];
  if (!words.length) return "No parity calculation applies to this factory procedure.";
  const results = words.map(word => {
    const first = Number.parseInt(word.slice(0, 2), 16);
    const listed = Number.parseInt(word.slice(2), 16);
    const id = listed & 0x0f;
    const calculated = dclVParityByte(first, id);
    return `${word.slice(0, 2)} ${word.slice(2)} → ${first.toString(16).toUpperCase().padStart(2, "0")} ${calculated.toString(16).toUpperCase().padStart(2, "0")} (${calculated === listed ? "match" : "listed literal differs"})`;
  });
  return `VPARITY: high nibble = ((first >> 4) XOR (first AND 0x0F) XOR id XOR 0x0A) AND 0x0F; low nibble = id. ${results.join("; ")}`;
}

function addDetail(body, label, value) {
  const row = document.createElement("div");
  row.className = "dcl-detail-row";
  const heading = document.createElement("strong");
  heading.textContent = label;
  const content = document.createElement("p");
  content.textContent = String(value ?? "—");
  row.append(heading, content);
  body.append(row);
}

function previousResult(state, item) {
  const batch = state?.discoveryPass?.results?.filter(result => result.candidateId === item.id).at(-1);
  if (batch) return `${batch.status} · ${batch.responseBytes ?? 0} RO byte(s) · recording ${batch.recordingId || "not created"}`;
  const session = state?.lastSession;
  if (session && session.variant === item.variantKey) {
    return `${session.verdict?.status || "UNKNOWN"} · ${session.verdict?.end?.ro_bytes ?? 0} RO byte(s) · ${session.completedAt ? new Date(session.completedAt).toISOString() : "completion time unavailable"} · recording ${session.recordingId || "not created"}`;
  }
  return "No result recorded for this candidate.";
}

function getVehicleConditions(item) {
  const isRunning = item.requiredEcuState === "KEY_ON_ENGINE_RUNNING" ||
                    item.id === "KOER_253E" ||
                    item.id === "CYLINDER_BALANCE_TEST";
  const isKeyOff = item.requiredEcuState === "KEY_OFF";
  return {
    ignition: isKeyOff ? "OFF" : "ON",
    engine: isRunning ? "ON" : "OFF",
  };
}

function selectedCommand(state, item) {
  const title = $("dcl-command-detail-title");
  const body = $("dcl-command-detail-body");
  if (!title || !body) return;
  title.textContent = `${item.name} · ${item.commandWord}`;
  body.replaceChildren();

  // Prominent vehicle preconditions: Ignition and Engine ONLY
  const cond = getVehicleConditions(item);
  const condCard = document.createElement("div");
  condCard.className = "dcl-condition-card";
  condCard.innerHTML = `
    <div class="dcl-condition-item">
      <span class="dcl-cond-label">Ignition:</span>
      <strong class="dcl-cond-val ${cond.ignition === "ON" ? "cond-on" : "cond-off"}">${cond.ignition}</strong>
    </div>
    <div class="dcl-condition-item">
      <span class="dcl-cond-label">Engine:</span>
      <strong class="dcl-cond-val ${cond.engine === "ON" ? "cond-on" : "cond-off"}">${cond.engine}</strong>
    </div>
  `;
  body.append(condCard);

  const actions = document.createElement("div");
  actions.className = "dcl-candidate-actions";
  const selection = document.createElement("label");
  selection.className = "check dcl-candidate-select";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.disabled = !!item.runnerKey || !item.variantKey;
  checkbox.checked = selectedDclCandidates.has(item.id);
  checkbox.setAttribute("aria-label", `Select ${item.name} for batch execution`);
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selectedDclCandidates.add(item.id);
    else selectedDclCandidates.delete(item.id);
    updateCandidateBatchControls();
  });
  selection.append(checkbox, document.createTextNode(checkbox.disabled ? "Run procedure individually" : "Include in batch"));
  const execute = document.createElement("button");
  execute.type = "button";
  execute.className = "primary";
  execute.textContent = item.classification === "FACTORY_PROCEDURE" ? "Run Guided Procedure" : "Transmit / Run Experiment";
  execute.disabled = !item.sendable;
  execute.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:run-candidate", { detail: { candidateId: item.id } })));
  actions.append(selection, execute);
  body.append(actions);

  // Raw technical metadata (hidden from view to prevent mobile clutter while preserving assertions)
  const rawMeta = document.createElement("div");
  rawMeta.className = "dcl-command-tech-meta";
  rawMeta.hidden = true;
  const sequence = item.armCommand && item.readCommand
    ? `STATUS safety check → ${item.armCommand} → wait for read_armed → ${item.readCommand} → stream raw RO bytes through END.`
    : item.variantKey ? `${item.armCommand || "No arm command"} → ${item.readCommand || "No read command"}; see description for sequence constraints.`
    : "No direct bridge transmission; see provenance and procedure details.";
  let exactBytes = wordsAsBytes(item.envelope);
  if (item.id === "MEMORY_READ") exactBytes += "; fixed continuation: 22 D3 (address map remains experimental).";
  const prerequisites = [
    `ECU state: ${item.requiredEcuState || "unspecified"}`,
    `Repeats: ${item.repeats ? "yes" : "no"}`,
    item.requiresMapOrQualifier ? "Requires a configured map or qualifier." : "No map or qualifier prerequisite recorded.",
    "Bridge: authenticated, safe IDLE, stage 0, read_used 0; TX2_BENCH runs first if required.",
  ].join(" ");
  addDetail(rawMeta, "Exact bytes", exactBytes);
  addDetail(rawMeta, "Transmission sequence", sequence);
  if (item.runnerKey) {
    addDetail(rawMeta, "Guided factory session", "Initiates the EEC-IV self-test protocol (KOEO or KOER) and guides the technician through manual throttle/pedal inputs while logging raw DCL response. Actuator cycling, fuel-cut sequencing, and cylinder identification are not claimed as verified ECU operations without live evidence.");
  }
  addDetail(rawMeta, "Parity calculation", parityDescription(item));
  addDetail(rawMeta, "Source provenance", `${item.source}${item.sourceUrl ? ` · ${item.sourceUrl}` : ""}`);
  addDetail(rawMeta, "Prerequisites", prerequisites);
  addDetail(rawMeta, "Classification / risk", `${DCL_CLASS_LABELS[item.classification] || item.classification} · ${item.risk}`);
  const compatibility = firmwareCompatibility(item, state?.transport === "demo" ? null : state?.status);
  addDetail(rawMeta, "Firmware requirement", `Firmware v${item.requiredFirmwareVersion}+ required. ${state?.transport === "demo" ? "Demo mode uses simulated execution and does not require bridge firmware." : compatibility.message || (compatibility.connected == null ? "Bridge version is unavailable; inspect all details and use simulated execution while disconnected." : `Connected bridge firmware v${compatibility.connected} is compatible.`)}`);
  addDetail(rawMeta, "Transmission status", item.sendable ? "Operational transmission path available." : `Deferred / Needs Setup · ${item.blockedReason || "Not directly sendable."}`);
  addDetail(rawMeta, "Previous result", previousResult(state, item));
  body.append(rawMeta);
}

function updateCandidateBatchControls() {
  const run = $("dcl-run-selected");
  if (run) run.disabled = !selectedDclCandidates.size;
}

function commandLabel(id) {
  const item = Object.values(EXPERIMENT_CATALOGUE).find(entry => entry.id === id);
  return item ? `${item.name} · ${item.commandWord}` : id;
}

function renderDiscoveryPass(state) {
  const pass = state?.discoveryPass;
  const active = $("discovery-active");
  const progress = $("discovery-progress");
  const run = $("discovery-run");
  const stop = $("discovery-stop");
  const exportButton = $("discovery-export");
  if (!active || !progress || !run || !stop || !exportButton) return;
  const total = pass?.candidates?.length || 8;
  const finished = (pass?.completed?.length || 0) + (pass?.failed?.length || 0);
  const activeCount = pass?.status === "running" ? Math.min(total, (pass.currentIndex || 0) + 1) : finished;
  progress.max = total;
  progress.value = activeCount;
  active.textContent = !pass ? "No discovery pass has been run."
    : pass.status === "running" ? `${activeCount} of ${total} · Active: ${pass.activeVariant || "checking bridge"}`
    : `${pass.status.toUpperCase()} · ${finished} of ${total} attempted${pass.error ? ` · ${pass.error}` : ""}`;
  const canStart = state?.link === "ready" && state?.phase === "idle" && state?.transport !== "demo" &&
    state?.identity?.helloOk === true && state?.identity?.pinsOk === true &&
    (state?.transport !== "ble" || state?.identity?.auth === "OK") && pass?.status !== "running";
  run.disabled = !canStart;
  stop.disabled = pass?.status !== "running";
  exportButton.disabled = pass?.status === "running" || !pass?.results?.some(result => result.recordingId);
  const batchStatus = $("dcl-batch-status");
  if (batchStatus) {
    const batch = state?.candidateBatch;
    batchStatus.textContent = !batch ? "No candidate batch is running."
      : `${String(batch.status || "idle").toUpperCase()} · ${batch.results?.length || 0} candidate(s) executed${batch.error ? ` · ${batch.error}` : ""}`;
  }
  const runSelected = $("dcl-run-selected");
  const stopSelected = $("dcl-stop-selected");
  const exportExperiments = $("dcl-experiment-export");
  if (runSelected) runSelected.disabled = selectedDclCandidates.size === 0 || state?.candidateBatch?.status === "running";
  if (stopSelected) stopSelected.disabled = state?.candidateBatch?.status !== "running";
  if (exportExperiments) exportExperiments.disabled = !(state?.experimentResults?.length || state?.memMatrix?.results?.length || state?.discoveryPass?.results?.length || state?.lastSession?.dclProbe);
  const list = (id, rows, kind) => {
    const node = $(id);
    if (!node) return;
    const fragments = rows?.length ? rows.map(item => {
      const li = document.createElement("li");
      li.textContent = kind === "remaining" ? commandLabel(item) :
        `${commandLabel(item.candidateId)} · ${item.status || "UNKNOWN"}${item.responseBytes != null ? ` · ${item.responseBytes} byte(s)` : ""}${item.error ? ` · ${item.error}` : ""}`;
      return li;
    }) : [Object.assign(document.createElement("li"), { textContent: "None" })];
    node.replaceChildren(...fragments);
  };
  list("discovery-completed", pass?.completed || [], "completed");
  list("discovery-failed", pass?.failed || [], "failed");
  list("discovery-remaining", pass?.remaining || [], "remaining");
}

function appendCell(row, value) {
  const cell = document.createElement("td");
  cell.textContent = String(value ?? "—");
  row.append(cell);
  return cell;
}

function renderMemExperimentMatrix(state) {
  const body = $("mem-matrix-body");
  const comparison = $("mem-matrix-comparison");
  const status = $("mem-matrix-status");
  const runAll = $("mem-run-all");
  const stop = $("mem-stop");
  const cardsContainer = $("mem-cards-container");
  if (!body || !comparison || !status || !runAll || !stop) return;
  const matrix = state?.memMatrix || { status: "idle", results: [] };
  const latest = new Map((matrix.results || []).map(result => [result.experimentId, result]));
  const isRunning = matrix.status === "running";

  body.replaceChildren(...MEM_EXPERIMENTS.map(experiment => {
    const result = latest.get(experiment.id);
    const row = document.createElement("tr");
    appendCell(row, experiment.id);
    appendCell(row, experiment.initialWord);
    appendCell(row, experiment.continuationWord);
    appendCell(row, experiment.offsetScope);
    appendCell(row, experiment.parityMethod);
    appendCell(row, experiment.firmwareVariant);
    appendCell(row, result?.status || "NOT RUN");
    appendCell(row, result?.responseBytes ?? "—");
    appendCell(row, result?.verdict?.status || result?.error || "—");
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.memRun = experiment.id;
    button.textContent = "Run";
    button.disabled = isRunning;
    button.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:run-mem", { detail: { experimentId: experiment.id } })));
    action.append(button);
    row.append(action);
    return row;
  }));

  if (cardsContainer) {
    cardsContainer.replaceChildren(...MEM_EXPERIMENTS.map(experiment => {
      const result = latest.get(experiment.id);
      const card = document.createElement("article");
      card.className = "mem-card";
      card.dataset.experimentId = experiment.id;

      const header = document.createElement("header");
      header.className = "mem-card-header";
      const titleGroup = document.createElement("div");
      titleGroup.className = "mem-card-title-group";
      const badge = document.createElement("span");
      badge.className = "mem-card-id-badge mono";
      badge.textContent = experiment.id;
      const h4 = document.createElement("h4");
      h4.className = "mem-card-title";
      h4.textContent = experiment.title || experiment.id;
      titleGroup.append(badge, h4);

      const statusBadge = document.createElement("span");
      const vStatus = result?.verdict?.status || result?.status || "NOT RUN";
      const statusClass = vStatus === "PASSED" || vStatus === "VERIFIED" ? "status-pass"
        : vStatus === "FAILED" ? "status-fail"
        : vStatus === "RUNNING" ? "status-running" : "status-idle";
      statusBadge.className = `mem-status-badge ${statusClass}`;
      statusBadge.textContent = vStatus;
      header.append(titleGroup, statusBadge);

      const summary = document.createElement("div");
      summary.className = "mem-card-summary";

      const wordsRow = document.createElement("div");
      wordsRow.className = "mem-summary-row";
      wordsRow.innerHTML = `<span class="mem-label">Words:</span> <code class="mono">${experiment.initialWord}</code> &rarr; <code class="mono">${experiment.continuationWord}</code>`;

      const scopeRow = document.createElement("div");
      scopeRow.className = "mem-summary-row";
      scopeRow.innerHTML = `<span class="mem-label">Scope:</span> <span>${experiment.offsetScope}</span>`;

      const resultRow = document.createElement("div");
      resultRow.className = "mem-summary-row";
      const byteText = result?.responseBytes != null ? `${result.responseBytes} byte(s)` : "None";
      const resultLabel = document.createElement("span");
      resultLabel.className = "mem-label";
      resultLabel.textContent = "Result:";
      const resultValue = document.createElement("span");
      resultValue.textContent = byteText;
      resultRow.append(resultLabel, resultValue);
      if (result?.responseHex) {
        const resultHex = document.createElement("code");
        resultHex.className = "mono";
        resultHex.textContent = result.responseHex;
        resultRow.append(resultHex);
      }

      summary.append(wordsRow, scopeRow, resultRow);

      const actions = document.createElement("div");
      actions.className = "mem-card-actions";
      const runBtn = document.createElement("button");
      runBtn.type = "button";
      runBtn.className = "primary mem-run-btn";
      runBtn.dataset.memRun = experiment.id;
      runBtn.textContent = isRunning && matrix.activeId === experiment.id ? "Running…" : "Run Experiment";
      runBtn.disabled = isRunning;
      runBtn.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:run-mem", { detail: { experimentId: experiment.id } })));
      actions.append(runBtn);

      const details = document.createElement("details");
      details.className = "mem-card-details";
      const summaryElem = document.createElement("summary");
      summaryElem.textContent = "Technical Details & Envelope";
      const dl = document.createElement("dl");
      dl.className = "facts compact";
      const detailRow = (label, value, className = "") => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = label;
        dd.textContent = String(value ?? "—");
        if (className) dd.className = className;
        dl.append(dt, dd);
      };
      detailRow("Parity Method", experiment.parityMethod);
      detailRow("Firmware Variant", experiment.firmwareVariant, "mono");
      detailRow("TX Envelope", result?.txEnvelope?.join(" → ") || "—", "mono");
      detailRow("Response Hex", result?.responseHex || "—", "mono");
      detailRow("Verdict Status", result?.verdict?.status || result?.status || "—");
      if (result?.error) detailRow("Error", result.error, "warn");
      details.append(summaryElem, dl);

      card.append(header, summary, actions, details);
      return card;
    }));
  }

  comparison.replaceChildren(...(matrix.results || []).map(result => {
    const row = document.createElement("tr");
    appendCell(row, result.experimentId);
    appendCell(row, result.responseBytes);
    appendCell(row, result.responseHex || "(zero bytes)");
    appendCell(row, result.txEnvelope?.join(" → ") || "—");
    appendCell(row, result.verdict?.status || result.status);
    return row;
  }));
  status.textContent = matrix.status === "running"
    ? `Running ${matrix.activeId || "MEM experiment"} · ${matrix.results?.length || 0} result(s) captured.`
    : matrix.status === "idle" ? "No MEM experiments have been run."
      : `${String(matrix.status).toUpperCase()} · ${matrix.results?.length || 0} result(s) · ${matrix.error || "Each result retains its raw IndexedDB capture."}`;
  runAll.disabled = matrix.status === "running";
  stop.disabled = matrix.status !== "running";
}

function renderFactoryProcedure(state) {
  const procedure = state?.factoryProcedure;
  const status = $("factory-procedure-status");
  const steps = $("factory-procedure-steps");
  const next = $("factory-procedure-next");
  const stop = $("factory-procedure-stop");
  if (!status || !steps || !next || !stop) return;
  if (!procedure) {
    status.textContent = "No factory procedure is running.";
    steps.replaceChildren();
    next.disabled = true;
    stop.disabled = true;
    return;
  }
  const running = ["preflight", "running", "stopping"].includes(procedure.status);
  status.textContent = `${procedure.title} · ${String(procedure.status).toUpperCase()} · Required: ${procedure.ecuState}` +
    (procedure.status === "running" ? ` · ${procedure.responseBytes || 0} raw response byte(s) so far.` : "") +
    (procedure.error ? ` ${procedure.error}` : "") +
    (procedure.status === "complete" || procedure.status === "stopped" || procedure.status === "incomplete"
      ? ` Verdict: ${procedure.verdict?.status || "UNKNOWN"}; decoded codes: ${procedure.codes?.map(item => item.code).join(", ") || "none"}.` : "");
  const instruction = procedure.status === "preflight"
    ? `Step 1 — Pre-flight: ${procedure.ecuState}`
    : procedure.status === "running"
      ? `Step ${procedure.stepIndex + 2} — ${procedure.prompts[procedure.stepIndex] || "All operator prompts completed; ending the capture."}`
      : `${procedure.prompts.length + 2} guided steps; capture status: ${procedure.verdict?.status || procedure.status}.`;
  const items = [instruction,
    procedure.guidance || "Guided factory diagnostic session: initiates the EEC-IV self-test protocol and guides the technician through manual throttle/pedal inputs while logging raw DCL response.",
    `Step 2 — Transmit the ${procedure.variant} initiation request (253E) to start the EEC-IV self-test protocol.`,
    ...(procedure.prompts || []).map((prompt, index) => `${procedure.completedPrompts?.includes(prompt) ? "✓" : "○"} ${prompt}`),
    procedure.evidenceScope || "Raw DCL response capture only. Actuator cycling, fuel-cut sequencing, and cylinder identification are not claimed as verified ECU operations without live evidence.",
    `Live capture: ${procedure.responseBytes || 0} response byte(s); raw TX/RX transcript is saved in recording ${procedure.recordingId || "when finalized"}.`];
  steps.replaceChildren(...items.map(text => Object.assign(document.createElement("li"), { textContent: text })));
  next.disabled = procedure.status !== "running";
  next.textContent = procedure.stepIndex >= (procedure.prompts?.length || 0) - 1 ? "Finish and Stop Cleanly" : "Next Procedure Step";
  stop.disabled = !running;
}

function renderProtocolFramingReference() {
  const list = $("protocol-framing-list");
  if (!list) return;
  const entries = protocolFramingEntries();
  list.replaceChildren(...entries.map(item => {
    const row = document.createElement("li");
    const word = document.createElement("strong");
    word.className = "mono";
    word.textContent = item.commandWord || item.word || "—";
    const name = document.createElement("span");
    name.textContent = ` · ${item.name || item.label || "Framing word"}`;
    const description = document.createElement("span");
    description.textContent = item.description ? ` — ${item.description}` : "";
    row.append(word, name, description);
    return row;
  }));
  const count = $("dcl-catalogue-count");
  if (count) {
    const executable = executableCatalogueEntries().length;
    count.textContent = `${executable} executable command candidates; ${entries.length} framing reference words are listed separately below.`;
  }
}

export function renderDclCommandExplorer(state) {
  dclState = state;
  const list = $("dcl-command-list");
  if (!list) return;
  renderProtocolFramingReference();
  const filtered = filterDclCatalogue({ query: dclSearch, category: dclCategory, firmwareStatus: dclFirmwareStatus, firmwareVersion: state?.transport === "demo" ? null : state?.status });
  if (!filtered.some(item => item.id === dclSelectedId)) dclSelectedId = filtered[0]?.id || "";
  const renderedIds = filtered.map(item => item.id).join("|");
  if (renderedIds !== dclRenderedIds) {
    const buttons = filtered.map(item => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dcl-command-card";
      button.setAttribute("role", "listitem");
      button.setAttribute("aria-pressed", String(item.id === dclSelectedId));
      const heading = document.createElement("strong");
      heading.textContent = item.name;
      const word = document.createElement("span");
      word.className = "mono";
      word.textContent = item.commandWord;
      const status = document.createElement("small");
      const compatibility = firmwareCompatibility(item, dclState?.transport === "demo" ? null : dclState?.status);
      status.textContent = `${DCL_CLASS_LABELS[item.classification] || item.classification} · ${!item.sendable ? "Not sendable" : dclState?.transport === "demo" ? "Demo simulation available" : compatibility.message || `Requires fw v${item.requiredFirmwareVersion}+`}`;
      button.append(heading, word, status);
      button.addEventListener("click", () => {
        dclSelectedId = item.id;
        renderDclCommandExplorer(dclState);
      });
      return button;
    });
    list.replaceChildren(...buttons);
    dclRenderedIds = renderedIds;
  } else {
    [...list.children].forEach((button, index) => button.setAttribute("aria-pressed", String(filtered[index]?.id === dclSelectedId)));
  }
  const selected = filtered.find(item => item.id === dclSelectedId);
  const body = $("dcl-command-detail-body");
  if (selected) selectedCommand(state, selected);
  else {
    $("dcl-command-detail-title").textContent = "No matching candidates";
    if (body) body.textContent = "Change the search or filters to show catalogue entries.";
  }
  renderDiscoveryPass(state);
  renderMemExperimentMatrix(state);
  renderFactoryProcedure(state);
  updateCandidateBatchControls();
}

export function wireDclCommandExplorer() {
  $("dcl-command-search")?.addEventListener("input", event => { dclSearch = event.currentTarget.value; renderDclCommandExplorer(dclState); });
  $("dcl-command-category")?.addEventListener("change", event => { dclCategory = event.currentTarget.value; renderDclCommandExplorer(dclState); });
  $("dcl-command-firmware")?.addEventListener("change", event => { dclFirmwareStatus = event.currentTarget.value; renderDclCommandExplorer(dclState); });
  $("dcl-run-selected")?.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:run-selected", { detail: { candidateIds: [...selectedDclCandidates] } })));
  $("mem-run-all")?.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:run-mem-all")));
  $("mem-stop")?.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:stop-mem")));
  $("dcl-experiment-export")?.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:export-experiments")));
  $("factory-procedure-next")?.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:procedure-next")));
  $("factory-procedure-stop")?.addEventListener("click", () => document.dispatchEvent(new document.defaultView.CustomEvent("dcl:procedure-stop")));
  document.querySelectorAll("[data-run-procedure]").forEach(button => button.addEventListener("click", () =>
    document.dispatchEvent(new document.defaultView.CustomEvent("dcl:run-procedure", { detail: { procedureId: button.dataset.runProcedure } }))));
}

export function getSelectedDclCandidates() { return [...selectedDclCandidates]; }

function hexByte(value) {
  if (value == null) return STR.notKnown;
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function activeCodes(state) {
  if (state.review?.active) return [];
  if (state.trust === "progress" && state.cart) {
    return state.cart.snapshot().codes.map((entry) => ({
      ...entry,
      source: entry.mode === 0x25
        ? (state.op?.variant || "self-test")
        : `stored request ${state.op?.variant || "unknown"}`,
    }));
  }
  return state.lastSession?.codes || [];
}

function activeSnap(state) { return state.review?.active ? state.review : state.cart?.snapshot() || null; }

function renderFailureMemory(state) {
  const container = $("fmem-values");
  const desired = [];
  for (const name of ["FMEM_FLAGS", "FMEM_FLAG2"]) {
    let block = fmemNodes.get(name);
    if (!block) {
      block = document.createElement("section"); block.className = "fmem-byte";
      fmemNodes.set(name, block);
    }
    const samples = sensorSeries(state, name)?.samples || [];
    const latest = samples.at(-1);
    renderBitPanel(block, name, latest?.raw);
    const title = document.createElement('strong');
    title.textContent = name === 'FMEM_FLAGS' ? 'Failure-memory byte 1' : 'Failure-memory byte 2';
    block.prepend(title);
    const time = document.createElement('p'); time.className = 'meta';
    time.textContent = !latest ? '' : state.review?.active
      ? `Recorded Data — Offline Review · sample ${formatReplayTime(latest.t)}`
      : `Received ${latest.receivedAt ? new Date(latest.receivedAt).toISOString() : 'time unavailable'}`;
    block.append(time);
    desired.push(block);
  }
  syncChildren(container, desired);
}

function progressValue(state) {
  if (state.phase !== "read" || !state.op || state.deadline == null) return 0;
  const spec = VARIANTS[state.op.variant];
  if (!spec) return 0;
  const elapsed = spec.timeoutMs - (state.deadline - Date.now());
  return Math.max(0, Math.min(100, (elapsed / spec.expectMs) * 100));
}

export function sensorSeries(state, name) {
  if (name === "THROTTLE_PERCENT") name = "ITP";
  if (state.review?.active) return state.review.pids[name] || null;
  const snap = activeSnap(state);
  const live = state.combined ? combinedSnapshot(state.combined) : null;
  return live?.pids?.[name] || snap?.pids?.[name] || state.lastSession?.pids?.[name] || null;
}

function activeStream(state) {
  if (state.review?.active) return false;
  return !!(state.op?.kind === "live" && state.phase === "read") || !!state.combined?.active;
}

function setText(node, value) {
  const next = String(value ?? "");
  if (node.textContent !== next) node.textContent = next;
}

function setState(node, state) {
  node.dataset.state = state;
  node.className = `state-label state-${state}`;
}

const RAW_SIGNALS = new Set(["IACT", "IECT", "ITP", "IEGO1", "RATCH", "INDS", "IOCC", "IVCAL", "IEGR", "MAF", "ITOT"]);
const SUPPORT_UNVERIFIED = new Set(["MAP", "MAP_FREQ", "EGRDC", "IEGR", "MAF"]);
const DTC_SENSOR_LINKS = Object.freeze({ "113": ["ACT"], "122": ["ITP"], "214": ["N"], "452": ["VS"] });

function sensorValue(name, summary, { manual = true } = {}) {
  if (!summary) return "—";
  if (manual && AUTOMATIC_PIDS.has(name)) return "N/A · manual";
  if (RAW_SIGNALS.has(name)) return `${formatMeasurement(name, summary.last, "counts")} counts`;
  const view = dashboardReading(name, summary.last, { unitSystem: unitSystem() });
  return `${formatMeasurement(name, view.value, view.unit)} ${view.unit}`.trim();
}

function sensorExplanation(name, summary, freshness, { manual = true, idleCheck = false, verdict = null, dtc = null } = {}) {
  if (!summary) return "No sample in the selected capture.";
  if (manual && AUTOMATIC_PIDS.has(name)) return "Not applicable to this manual gearbox. Raw values remain available in Advanced and exports.";
  if (dtc) return `DTC ${dtc.code} was reported in a valid ${dtc.variant} response (${dtc.mode.toString(16).toUpperCase()}H). ${dtc.description} This is historical code context, not proof this live sensor currently failed.${name === "MAF" ? " PID 0x26 meaning and scaling remain unverified." : ""}`;
  if (SUPPORT_UNVERIFIED.has(name) && summary.min === 0 && summary.max === 0) {
    return "Zero was received. Equipment and ECU support are unverified; this is not a failed-sensor verdict.";
  }
  if (name === "N" && summary.last === 0) return "Zero RPM was received; the engine was stopped in this sample. This is not a sensor-failure verdict.";
  if (verdict?.level === "warn" || verdict?.level === "bad") return verdict.text;
  if (freshness.state === "stale") return "No new sample within three times this signal’s observed update interval.";
  if (freshness.state === "historical") return "Last captured value. No live stream is active.";
  if (freshness.state === "learning") return "Reading received; this signal’s update interval is still being established.";
  if (freshness.state === "unknown") return "Sample time was not retained.";
  if (name === "ACT") return "ECU intake-air temperature; this may be a fallback value, not a direct sensor measurement.";
  if (RAW_SIGNALS.has(name)) return "Raw counts are shown exactly. Calibration and a factory fault limit are not verified for this ECU.";
  if (name === "KAMRF1") return "Displayed correction is relative to unity: a factor of 1.00 equals 0% correction.";
  if (name === "N" && idleCheck && verdict) return verdict.text;
  if (name === "DSDRPM") return "Current target can change with warm-up and loads; compare with actual RPM only in the same capture.";
  if (name === "FUELPW1") return "Injector command in ECU ticks. Milliseconds are not verified.";
  if (name === "LAMBSE1") return "Requested mixture, not measured exhaust mixture.";
  if (name === "EGRDC") return "Electrical command, not measured valve position or exhaust flow.";
  return "Signal received. This value alone is not a sensor-health verdict.";
}

function chartColor(state) {
  const token = state === "fresh" ? "--cyan" : "--gray";
  return getComputedStyle(document.body).getPropertyValue(token).trim() || (state === "fresh" ? "#4ad9e6" : "#95a2ac");
}

function chartSummary(samples, name, range) {
  const points = chartPoints(samples, name, range, unitSystem());
  if (!points.length) return null;
  let min = points[0].value, max = points[0].value;
  for (const point of points) {
    min = Math.min(min, point.value);
    max = Math.max(max, point.value);
  }
  return { min, max, n: points.length };
}

function formatTimeAgo(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (!seconds) return "now";
  if (seconds % 60 === 0) return `${seconds / 60}m ago`;
  return `${seconds}s ago`;
}

function drawTimeChart(canvas, samples, range = "30", color = "#42d9e8") {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const key = `${detailPid}:${detailPercent}:${samples.length}:${samples.at(-1)?.t}:${samples.at(-1)?.value}:${range}:${unitSystem()}:${rect.width}:${rect.height}:${chartProbe}:${color}`;
  if (canvas.dataset.chartKey === key) return;
  canvas.dataset.chartKey = key;
  canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
  const ctx = canvas.getContext('2d'); if (!ctx) return;
  ctx.scale(ratio, ratio);
  const width = rect.width, height = rect.height;
  const left = 52, right = width-14, top = 18, bottom = height-30;
  ctx.clearRect(0,0,width,height);
  const points = chartPoints(samples, detailPercent ? "THROTTLE_PERCENT" : detailPid, range, unitSystem());
  const textColor = getComputedStyle(document.body).getPropertyValue('--muted').trim();
  ctx.font = '11px sans-serif'; ctx.fillStyle = textColor;
  if (!points.length) { ctx.fillText('No recorded samples for this reading', 16, height/2); return; }
  const { min, max, step } = chartBounds(points, RAW_SIGNALS.has(detailPid) || ['N','DSDRPM','VS','VSBAR'].includes(detailPid));
  const captureStart=points[0].time, last=points.at(-1).time;
  const duration=range === 'full' ? Math.max(1,last-captureStart) : Number(range)*1000;
  const first=range === 'full' ? captureStart : last-duration;
  const x=time=>left+(time-first)/duration*(right-left);
  const y=value=>bottom-(value-min)/(max-min)*(bottom-top);
  ctx.strokeStyle=getComputedStyle(document.body).getPropertyValue('--line').trim();ctx.lineWidth=1;
  for(let value=min;value<=max+step/100;value+=step) {
    const yy=y(value);
    ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(right,yy);ctx.stroke();
    ctx.textAlign='right';ctx.fillText(formatMeasurement(detailPercent ? "THROTTLE_PERCENT" : detailPid, value, dashboardReading(detailPercent ? "THROTTLE_PERCENT" : detailPid, 0, {unitSystem:unitSystem()}).unit),left-7,yy+4);
  }
  for(let tick=0;tick<=2;tick++) {
    const time=first+duration*tick/2;
    const label=range === 'full' ? formatReplayTime(time / 1000) : formatTimeAgo(last-time);
    ctx.textAlign=tick===0?'left':tick===2?'right':'center';ctx.fillText(label,x(time),height-8);
  }
  const gaps=points.slice(1).map((point,index)=>point.time-points[index].time).filter(gap=>gap>0).sort((a,b)=>a-b);
  const gapLimit=gaps.length?Math.max(gaps[Math.floor(gaps.length/2)]*3,1):Infinity;
  const segments=[]; let segment=[];
  for(const point of points) {
    if(segment.length && point.time-segment.at(-1).time>gapLimit) { segments.push(segment); segment=[]; }
    segment.push(point);
  }
  if(segment.length)segments.push(segment);
  ctx.strokeStyle=color;ctx.lineWidth=2;ctx.lineJoin='round';
  for(const segment of segments) {
    ctx.beginPath();chartEnvelope(segment,Math.max(1,Math.floor(right-left))).forEach((point,index)=>{
      if(index)ctx.lineTo(x(point.time),y(point.value));else ctx.moveTo(x(point.time),y(point.value));
    });ctx.stroke();
    if(segment.length===1) {ctx.fillStyle=color;ctx.beginPath();ctx.arc(x(segment[0].time),y(segment[0].value),2.5,0,Math.PI*2);ctx.fill();}
  }
  if(chartProbe!==null) {
    const time=first+chartProbe*duration;
    let low=0,high=points.length-1;
    while(low<high){const mid=Math.floor((low+high)/2);if(points[mid].time<time)low=mid+1;else high=mid;}
    const point=low>0&&Math.abs(points[low-1].time-time)<Math.abs(points[low].time-time)?points[low-1]:points[low];
    ctx.strokeStyle=textColor;ctx.setLineDash([3,3]);ctx.beginPath();ctx.moveTo(x(point.time),top);ctx.lineTo(x(point.time),bottom);ctx.stroke();ctx.setLineDash([]);
    ctx.fillStyle=color;ctx.beginPath();ctx.arc(x(point.time),y(point.value),4,0,Math.PI*2);ctx.fill();
    setText($("chart-reading"),`${formatReplayTime(point.time / 1000)} · ${formatMeasurement(detailPercent ? "THROTTLE_PERCENT" : detailPid, point.value, dashboardReading(detailPercent ? "THROTTLE_PERCENT" : detailPid, 0, {unitSystem:unitSystem()}).unit)} ${dashboardReading(detailPercent ? "THROTTLE_PERCENT" : detailPid,0,{unitSystem:unitSystem()}).unit}`);
  } else setText($("chart-reading"),'Drag across the chart to inspect a recorded sample.');
}

function makeSensorCard(name) {
  const card = document.createElement("article");
  card.className = "sensor-card";
  card.dataset.pid = name;
  const head = document.createElement("div");
  head.className = "sensor-card-head";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "sensor-open";
  open.dataset.openPid = name;
  const title = document.createElement("strong"); title.className = "sensor-title";
  const value = document.createElement("span"); value.className = "sensor-value";
  const status = document.createElement("span"); status.className = "state-label";
  open.append(title, value, status);
  const pin = document.createElement("button");
  pin.type = "button"; pin.className = "pin-button"; pin.dataset.pinPid = name;
  head.append(open, pin);
  card.append(head);
  return card;
}

function syncChildren(container, nodes) {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
  }
  while (container.children.length > nodes.length) container.lastElementChild.remove();
}

function sensorHealth(name, series, state, manual, idleCheck) {
  const samples = series?.samples || [];
  const summary = series?.summary || (samples.length ? summarizeSeries(samples) : null);
  const freshness = series?.saved ? { state:'historical', label: state.review?.active ? `Recorded · sample ${formatReplayTime(series.sampleTime ?? samples.at(-1)?.t)} · ${series.newAtPosition ? 'sample at position' : 'last known'}` : 'Saved reading' } : sensorFreshness(samples, { active: activeStream(state), now: Date.now() });
  const dtc = !state.review?.active && state.lastSession?.verdict?.valid
    ? (state.lastSession.codes || []).find(code => (DTC_SENSOR_LINKS[code.code] || []).includes(name))
      ? { ...state.lastSession.codes.find(code => (DTC_SENSOR_LINKS[code.code] || []).includes(name)), variant: state.lastSession.variant,
        description: lookupCode(state.lastSession.codes.find(code => (DTC_SENSOR_LINKS[code.code] || []).includes(name)).code).description }
      : null
    : null;
  const verdict = summary && name === "N" && idleCheck && freshness.state === "fresh"
    ? judgeReading(name, summary, {
      rpm: summary.last,
      ect: sensorSeries(state, "ECT")?.summary?.last ?? null,
      iact: sensorSeries(state, "ACT")?.summary?.last ?? null,
      itp: sensorSeries(state, "ITP")?.summary?.last ?? null,
      idleCheck,
    })
    : null;
  let colorState = freshness.state;
  if (manual && AUTOMATIC_PIDS.has(name)) colorState = "na";
  else if (dtc) colorState = "warn";
  else if (verdict?.level === "ok" || verdict?.level === "warn" || verdict?.level === "bad") colorState = verdict.level;
  return { samples, summary, freshness, verdict, dtc, colorState, explanation: sensorExplanation(name, summary, freshness, { manual, idleCheck, verdict, dtc }) };
}

function updateCard(card, sensor, state, manual, idleCheck, pins) {
  const { name, title, unit, notApplicable } = sensor;
  const series = sensorSeries(state, name);
  const health = sensorHealth(name, series, state, manual, idleCheck);
  const [, , help] = PID_TEXT[name] || [title, unit, ""];
  setText(card.querySelector(".sensor-title"), title);
  const value = card.querySelector(".sensor-value");
  setReadingValue(value, name, health.summary, manual);
  value.dataset.state = health.colorState;
  setState(card.querySelector(".state-label"), notApplicable ? "na" : health.colorState);
  const status = card.querySelector(".state-label");
  setText(status, notApplicable ? "NOT APPLICABLE" : health.freshness.label);
  if (health.dtc) setText(status, `! DTC ${health.dtc.code} · ${health.dtc.variant} history`);
  else if (health.verdict?.level === "ok") setText(status, "✓ VERIFIED RANGE");
  else if (health.verdict?.level === "warn") setText(status, `! ${health.verdict.text}`);

  status.hidden = !status.textContent;
  const pin = card.querySelector(".pin-button");
  pin.textContent = "☆";
  pin.setAttribute("aria-label", `Pin ${title}`);
  card.classList.toggle("not-applicable", notApplicable);
  card.classList.toggle("stale", ["none", "stale", "historical", "unknown"].includes(health.freshness.state) || notApplicable);
  card.classList.toggle("warning", health.colorState === "warn");
  card.querySelector("[data-open-pid]").setAttribute("aria-label", `${title}, ${value.textContent}, ${status.textContent}. Open details.`);
}

function renderPinned(state, manual, idleCheck, pins) {
  const section = $("pinned-section");
  section.hidden = false;
  $("dashboard-title").textContent = ({LIVE:'Engine', LIVE2:'Idle & switches', LIVE3:'Air sensor & spark', ALL:'My diagnostics'})[dashboardSet()];
  const prefs = readPrefs();
  $("dashboard-density").value = prefs.density;
  $("dashboard-columns").value = prefs.columns;
  $("dashboard-columns").disabled = prefs.density === 'compact';
  setText($("dashboard-expand"), dashboardFocused ? 'Exit expanded view' : 'Expand dashboard');
  $("dashboard-expand").setAttribute('aria-pressed', String(dashboardFocused));
  setText($("dashboard-context"), state.review?.active
    ? `Recorded Data — Offline Review · ${state.review.metadata?.id || 'Loading'} · ${formatReplayTime(state.review.position)}`
    : activeStream(state) ? 'LIVE · recording on this device' : 'Saved readings · no live stream');
  $("arrange-dashboard").textContent = arranging ? 'Done' : 'Arrange';
  $("arrange-dashboard").setAttribute('aria-pressed', String(arranging));
  $("dashboard-hint").textContent = arranging ? 'Swipe cards to scroll. Drag the ↕ handle to reorder. Keyboard: focus a card and use the arrow keys. Tap Done when finished.' : pins.length ? 'Tap a reading for its chart. Star other readings below to add them.' : 'Star a reading below to build this dashboard.';
  const container = $("pinned-readings");
  container.dataset.density = prefs.density;
  container.dataset.columns = prefs.columns;
  container.classList.toggle("arranging", arranging);
  // Reuse the approved card markup, but let the normal layout own its placement.
  const approved = $("throttle-percent-card");
  if (approved && !pinnedNodes.has('THROTTLE_PERCENT')) {
    approved.dataset.pid = 'THROTTLE_PERCENT';
    const remove = document.createElement('button'); remove.type = 'button';
    remove.dataset.pinPid = 'THROTTLE_PERCENT'; remove.textContent = '★';
    remove.setAttribute('aria-label', 'Unpin Throttle'); approved.append(remove);
    pinnedNodes.set('THROTTLE_PERCENT', approved);
  }
  const desired = [];
  for (const name of pins) {
    let item = pinnedNodes.get(name);
    if (!item) {
      item = document.createElement("div"); item.className = "pinned-card"; item.dataset.pid = name;
      const open = document.createElement("button"); open.type = "button"; open.className = "pinned-open"; open.dataset.openPid = name;
      const title = document.createElement("span"); title.className = "pinned-title";
      const value = document.createElement("strong"); value.className = "pinned-value";
      const stateLabel = document.createElement("small"); stateLabel.className = "state-label";
      open.append(title, value, stateLabel);
      const remove = document.createElement("button"); remove.type = "button"; remove.dataset.pinPid = name; remove.setAttribute("aria-label", `Unpin ${name}`); remove.textContent = "★";
      item.append(open, remove); pinnedNodes.set(name, item);
    }
    const sensor = dashboardSensor(name);
    if (!sensor) continue;
    const health = sensorHealth(name, sensorSeries(state, name), state, manual, idleCheck);
    setText(item.querySelector(".pinned-title"), sensor.title);
    setReadingValue(item.querySelector(".pinned-value"), name, health.summary, manual);
    setState(item.querySelector(".state-label"), health.colorState);
    setText(item.querySelector(".state-label"), health.dtc ? `DTC ${health.dtc.code} · saved` : health.verdict?.level === "warn" ? health.verdict.text : health.freshness.label);
    item.querySelector(".state-label").hidden = !item.querySelector(".state-label").textContent;
    let handle = item.querySelector('.reorder-handle');
    if (!handle) {
      handle = document.createElement('button'); handle.type = 'button';
      handle.className = 'reorder-handle'; handle.dataset.dragPid = name;
      handle.textContent = '↕'; item.append(handle);
    }
    handle.hidden = !arranging;
    handle.setAttribute('aria-label', `Drag to reorder ${sensor.title}`);
    item.tabIndex = arranging ? 0 : -1;
    item.setAttribute('aria-label', `${sensor.title}${arranging ? ', use arrow keys to reorder' : ''}`);
    item.querySelector(".pinned-value").dataset.state = health.colorState;
    desired.push(item);
  }
  syncChildren(container, desired);
}

async function loadChartHistory(state, name) {
  const token = ++detailLoad;
  detailHistory = { name, samples: [], loading: true, message: 'Loading saved capture…' };
  try {
    const compatible = entry => entry.variant === dashboardSet() || entry.variant === 'ALL';
    const received = sensorSeries(state, name);
    const reviewMetadata = state.review?.active ? state.review.metadata : null;
    const archive = state.archive && (compatible(state.archive) || (received && !received.saved && dashboardChannels(state.archive.variant).includes(name))) ? state.archive : null;
    const metadata = reviewMetadata || archive || (await listRecordings()).find(compatible);
    if (!metadata) {
      if (token === detailLoad) { detailHistory.loading = false; detailHistory.message = 'Recent received samples; no saved capture available.'; }
      return;
    }
    const blob = metadata === archive ? await archive.export('csv') : await recordingBlob(metadata.id, 'csv');
    const samples = await sensorSamplesFromCsv(blob, name);
    if (token !== detailLoad || detailPid !== name) return;
    detailHistory = { name, id: metadata.id, samples, loading: false,
      message: `Capture: ${new Date(metadata.started).toLocaleString()} · ${samples.length.toLocaleString()} recorded samples` };
  } catch (error) {
    if (token === detailLoad) { detailHistory.loading = false; detailHistory.message = `Saved chart unavailable: ${error.message}. Showing recent received samples.`; }
  } finally {
    if (token === detailLoad && latestState && !$("sensor-drawer").hidden) renderSensorDrawer(latestState);
  }
}

function renderSensorDrawer(state) {
  if (!detailPid || $("sensor-drawer").hidden) return;
  const sensor = sensorsForGroup("advanced", { manual: false }).find((entry) => entry.name === detailPid);
  if (!sensor) return;
  const { name, title, unit, pid } = sensor;
  const received = sensorSeries(state, name);
  const saved = detailHistory?.name === name
    && (!state.review?.active || detailHistory.id === state.review.metadata?.id) ? detailHistory : null;
  const series = received || (saved?.samples.length ? { samples: saved.samples, summary: summarizeSeries(saved.samples) } : null);
  const health = sensorHealth(name, series, state, $("manual-gearbox-settings").checked, $("idle-check-settings").checked);
  if (!received && saved?.samples.length) { health.freshness = { state: 'historical', label: 'Saved reading' }; health.colorState = 'historical'; health.explanation = 'Recorded values from the saved capture.'; }
  let chartSamples = health.samples;
  if (saved?.samples.length && (!received || received.saved || state.archive?.id === saved.id)) {
    const lastTime = saved.samples.at(-1).t;
    for (const sample of health.samples) if (sample.t > saved.samples.at(-1).t) saved.samples.push(sample);
    chartSamples = saved.samples;
    if (activeStream(state) && received?.samples.length > 2 && state.archive?.id === saved.id) {
      const cadence = received.samples[1].t-received.samples[0].t;
      if (!saved.loading && received.samples[0].t-lastTime > Math.max(cadence*3,1)) void loadChartHistory(state,name);
    }
  }
  if (state.review?.active && detailRange !== "full") {
    chartSamples = chartSamples.filter(sample => sample.t <= state.review.position);
  }
  setText($("chart-history-note"), state.review?.active ? `Selected recording ${state.review.metadata.id} · recent recorded samples through ${formatReplayTime(state.review.position)}` : saved?.message || 'Recent received samples');
  const summary = health.summary;
  const chartName = detailPercent ? "THROTTLE_PERCENT" : name;
  const chartStats = chartSummary(chartSamples, chartName, detailRange);
  const chartUnit = dashboardReading(chartName, 0, { unitSystem: unitSystem() }).unit;
  const reference = readingReference(name, { manual: $("manual-gearbox-settings").checked });
  setText($("drawer-group"), [...Object.keys(LIVE_GROUP_TITLES)].find((group) => LIVE_GROUPSForUi(group).includes(name))
    ? LIVE_GROUP_TITLES[Object.keys(LIVE_GROUP_TITLES).find((group) => LIVE_GROUPSForUi(group).includes(name))]
    : "Advanced");
  const displayName = detailPercent ? "THROTTLE_PERCENT" : name;
  setText($("drawer-title"), detailPercent ? "Throttle" : title);
  setText($("drawer-state"), `${health.freshness.label} · ${health.explanation}`);
  $("drawer-state").dataset.state = health.colorState;
  setText($("drawer-value"), summary ? formattedReading(displayName, summary.last, {unitSystem:unitSystem()}).text : "—");
  $("drawer-value").dataset.state = health.colorState;
  setText($("drawer-unit"), detailPercent ? "%" : RAW_SIGNALS.has(name) ? "raw ECU counts" : dashboardReading(name, summary?.last ?? 0, { unitSystem: unitSystem() }).unit);
  setText($("drawer-raw"), summary ? `${summary.rawLast} (0x${Math.trunc(summary.rawLast).toString(16).toUpperCase().padStart(3,"0")})` : "No sample");
  setText($("drawer-min"), chartStats ? formatMeasurement(displayName, chartStats.min, chartUnit) : "—");
  setText($("drawer-max"), chartStats ? formatMeasurement(displayName, chartStats.max, chartUnit) : "—");
  setText($("drawer-count"), chartStats?.n ?? 0);
  const latest = health.samples.at(-1);
  setText($("drawer-time"), `PID 0x${pid.toString(16).toUpperCase().padStart(2, "0")}`);
  setText($("drawer-meaning"), health.explanation);
  setText($("drawer-reference"), detailPercent ? "179 counts = 0%; 970 counts = 100%." : reference.normal);
  setText($("drawer-source"), detailPercent ? "Owner-defined display range. Original raw counts are retained." : `${reference.meaning} ${reference.source ? `Source: ${reference.source}` : "No vehicle-specific limit source verified."}`);
  const pins = pinnedSensors();
  setText($("drawer-pin"), pins.includes(displayName) ? "Unpin reading" : "Pin reading");
  $("drawer-pin").dataset.pinPid = displayName;
  $("drawer-export-sensor").dataset.sourcePid = name;
  $("drawer-pin").hidden = !dashboardChannels(dashboardSet()).includes(displayName);
  renderBitPanel($("drawer-bit-panel"), name, latest?.raw);
  drawTimeChart($("sensor-chart"), chartSamples, detailRange, chartColor(health.freshness.state));
}

function LIVE_GROUPSForUi(group) {
  return sensorsForGroup(group, { manual: false }).map((sensor) => sensor.name);
}

export function openSensorDetails(state, name) {
  detailPercent = name === "THROTTLE_PERCENT";
  detailPid = detailPercent ? "ITP" : name;
  detailRange = "30";
  chartProbe = null;
  detailHistory = null;
  for (const button of document.querySelectorAll('[data-range]')) button.setAttribute('aria-pressed', String(button.dataset.range === '30'));
  $("sensor-drawer").hidden = false;
  renderSensorDrawer(state);
  $("drawer-close").focus();
  void loadChartHistory(state, detailPid);
}

export function closeSensorDetails() {
  detailPid = null;
  detailLoad += 1;
  detailHistory = null;
  $("sensor-drawer").hidden = true;
}

export function render(state) {
  latestState = state;
  const busy = state.phase !== "idle" || !!state.combined?.active;
  const linked = state.link === "ready";
  const codesWarning = $("codes-link-warning"); if (codesWarning) codesWarning.hidden = linked;
  const dclWarning = $("dcl-link-warning"); if (dclWarning) dclWarning.hidden = linked;
  const authenticated = linked && state.identity.auth === "OK";
  const demoTransport = state.transport === "demo";
  $("link-pill").textContent = demoTransport ? "DEMO · REPLAY" : authenticated ? "BLE · AUTH" : linked ? "BLE · CHECKING" : state.link === "denied" ? "AUTH DENIED" : STR.disconnected;
  $("link-pill").dataset.state = linked ? "connected" : state.link === "denied" ? "error" : "disconnected";
  $("link-pill").title = state.deviceName || state.link;
  $("link-pill").setAttribute("aria-label", demoTransport ? "Demo replay; no Bluetooth connection or vehicle communication" : linked ? `Bluetooth connected to ${state.deviceName || "bridge"}; ${authenticated ? "authenticated" : "bridge checks pending"}` : state.link === "denied" ? "Bridge authentication denied" : "Bluetooth bridge disconnected");
  $("stop-btn").disabled = !busy;
  $("stop-btn").hidden = !busy;
  $("stop-btn").classList.toggle("stop-active", busy);
  const connectText = linked || state.link === "denied" ? STR.disconnectAction : STR.connectAction;
  $("connect-btn").textContent = connectText;
  $("connect-settings").textContent = connectText;
  $("connect-settings").disabled = busy || !!state.recovering;
  $("connect-btn").disabled = !!state.recovering;
  $("message").textContent = state.message || "";

  const onboardingDismissed = readStored("sme105-onboarding-dismissed") === "1";
  $("onboarding").hidden = onboardingDismissed;
  $("onboarding").classList.toggle("step-one-done", linked);
  setText($("onboarding-connect-step"), linked ? "Connected" : "Connect");

  const fields = state.status?.fields || {};
  $("auth-value").textContent = state.identity.auth || STR.waiting;
  $("hello-value").textContent = state.identity.helloOk == null ? STR.waiting : state.identity.helloOk ? STR.pass : STR.fail;
  $("pins-value").textContent = state.identity.pinsOk == null ? STR.waiting : state.identity.pinsOk ? STR.pass : STR.fail;
  $("de-value").textContent = fields.DE || STR.notKnown;
  $("stage-value").textContent = fields.stage != null ? stageText(fields.stage) : STR.notKnown;
  $("bench-value").textContent = state.bench?.pass ? STR.benchPass : STR.benchNeeded;
  const rom = state.review?.active ? null : state.rom || activeSnap(state)?.rom;
  $("rom-value").textContent = rom ? `${hexByte(rom.low)} ${hexByte(rom.high)}` : STR.notKnown;
  const vbat = state.review?.active ? activeSnap(state)?.pids?.VBAT?.samples?.at(-1)?.value : state.battery ?? activeSnap(state)?.pids?.VBAT?.samples?.at(-1)?.value;
  $("battery-value").textContent = vbat == null ? STR.notKnown : `${formatMeasurement("VBAT", vbat, "V")} V`;
  $("status-raw").textContent = redactDiagnostic(state.status?.raw || state.identity.hello || "");

  const statusConn = $("settings-conn-status");
  if (statusConn) {
    statusConn.textContent = demoTransport ? "Demo Replay" : authenticated ? "Connected & Authenticated" : linked ? "Connected (Verifying)" : state.link === "denied" ? "Auth Denied" : STR.disconnected;
  }
  const statusDot = $("settings-status-dot");
  if (statusDot) {
    statusDot.className = "status-indicator-dot " + (demoTransport ? "dot-demo" : authenticated ? "dot-connected" : linked ? "dot-checking" : state.link === "denied" ? "dot-error" : "dot-disconnected");
  }
  const deviceName = $("settings-device-name");
  if (deviceName) {
    deviceName.textContent = state.deviceName || "SME105 BLE Bridge";
  }
  const fwVersion = $("settings-fw-version");
  if (fwVersion) {
    const fw = fields.fw || state.status?.fields?.fw;
    fwVersion.textContent = fw ? `Firmware: v${fw}` : (linked ? "Firmware: Identifying…" : "Firmware: Not connected");
  }

  const actions = ["read-codes-btn", "koeo-btn", "koer-btn", "live-start", "offline-btn", "bench-btn", "reboot-btn", "clear-btn", "mem-btn"];
  for (const id of actions) $(id).disabled = !linked || busy || !!state.recovering || !!state.review?.active;
  if (COMMAND_CATALOGUE.MEM_READ.sendable === false) $("mem-btn").disabled = true;
  $("stored-code-mode").disabled = busy;
  $("live-set").disabled = busy || !!state.recovering;

  const banner = (node) => {
    if (state.trust === "progress") { node.hidden = false; node.textContent = STR.inProgress; node.className = "banner"; }
    else if (state.trust === "untrusted") { node.hidden = false; node.textContent = STR.untrusted; node.className = "banner warn"; }
    else { node.hidden = true; node.textContent = ""; }
  };
  banner($("codes-banner"));
  banner($("live-banner"));
  if (state.review?.active) { $("live-banner").hidden = false; $("live-banner").className = "banner"; $("live-banner").textContent = `Recorded Data — Offline Review · ${state.review.metadata?.verdict?.status || "Unfinished"}`; }
  const pct = progressValue(state);
  const variant = state.op?.variant || state.lastSession?.variant;
  $("codes-progress").value = ["KOEO", "KOER", "0E", "A4"].includes(variant) ? pct : 0;
  $("live-progress").value = ["ALL", "LIVE", "LIVE2", "LIVE3"].includes(variant) ? pct : 0;
  $("kline-bridge").textContent = `Bridge firmware: ${state.status?.fields?.fw || "not identified"} · Receiver backend: NONE · protocol/service set: UNKNOWN`;
  const promptBox = $("koer-prompt");
  promptBox.hidden = variant !== "KOER";
  promptBox.setAttribute("role", "status");
  promptBox.textContent = `${state.koerGuide?.phase || "PREPARATION"} · No authenticated ECU operator prompt is available. Do not act on a countdown or fault code.`;

  const snap = activeSnap(state);
  const result = state.review?.active ? state.review.metadata : state.op ? null : state.lastSession;
  const diagnosticVariant = state.op?.variant || result?.variant || "";
  const expectedMode = ["0E", "A4"].includes(diagnosticVariant) ? 0x26
    : ["KOEO", "KOER"].includes(diagnosticVariant) ? 0x25 : null;
  const observedModes = result?.observedModes || [
    ...((snap?.blocks25 || 0) > 0 ? [0x25] : []), ...((snap?.blocks26 || 0) > 0 ? [0x26] : []),
  ];
  if (activeView === "codes") {
  const codeMeta = expectedMode == null ? [] : [
    `Requested mode: ${expectedMode.toString(16).toUpperCase()}H`,
    `Observed mode: ${observedModes.length ? observedModes.map((mode) => `${mode.toString(16).toUpperCase()}H`).join(", ") : "not yet seen"}`,
    `Codes decoded: ${activeCodes(state).length}`,
    `Witness: ${result?.verdict?.witnessStatus || "not yet verified"}`,
    "KOER success / operator completeness: unverified",
    `Bridge ECU DTC verification: ${result ? (result.dtcVerified ? "reported" : "not reported") : "pending"}`,
  ];
  if (expectedMode === 0x25) {
    const flag = snap?.selfTestComplete ?? result?.selfTestComplete;
    const frame7 = snap?.frame7Last ?? result?.frame7Last;
    codeMeta.push(`${STR.selfTestFlag}: ${flag ? STR.flagSet : STR.flagClear}`);
    codeMeta.push(`${STR.frame7}: ${frame7 == null ? STR.notKnown : hexByte(frame7)}`);
  }
  $("codes-meta").textContent = codeMeta.join(" · ");
  const list = $("codes-list");
  const codes = activeCodes(state);
  list.classList.toggle("untrusted", state.trust === "untrusted");
  list.replaceChildren();
  if (!codes.length) {
    const empty = document.createElement("li");
    empty.textContent = state.trust === "progress" ? "Waiting for response words."
      : state.trust === "valid" ? "No code words decoded in this complete capture; this does not certify ECU code status."
        : result?.verdict ? "No code words decoded; capture incomplete or failed. Review the validity details above." : STR.noCodes;
    list.append(empty);
  } else {
    for (const entry of codes) {
      const info = lookupCode(entry.code);
      const item = document.createElement("li"); item.className = "fault-result";
      const code = document.createElement("strong"); code.className = "code"; code.textContent = info.code;
      const meaning = document.createElement("span"); meaning.textContent = info.description;
      const category = document.createElement("span"); category.className = "tag"; category.textContent = info.category || STR.category;
      const source = document.createElement("span"); source.className = "tag"; source.textContent = `${STR.source}: ${entry.source}`;
      const note = document.createElement("p"); note.className = "help"; note.textContent = info.note; note.hidden = !info.note;
      const raw = document.createElement("p"); raw.className = "help raw-provenance";
      raw.textContent = `Observed mode ${entry.mode == null ? "unknown" : `${entry.mode.toString(16).toUpperCase()}H`} · raw ${entry.rawBytes?.map(hexByte).join(" ") || "not retained"} · frame ${entry.frame ?? "?"} slot ${entry.slot ?? "?"} · RX ${entry.rxTimeUs ?? "?"} µs`;
      item.append(code, meaning, category, source, note, raw); list.append(item);
    }
  }
  renderFailureMemory(state);
  }

  const manual = $("manual-gearbox-settings").checked;
  const idleCheck = $("idle-check-settings").checked;
  $("manual-gearbox-settings").checked = manual;
  $("idle-check-settings").checked = idleCheck;

  const pins = pinnedSensors();
  renderPinned(state, manual, idleCheck, pins);

  const variantSet = dashboardSet();
  for (const option of $("live-group").options) option.disabled = !dashboardSensors(option.value, variantSet).length;
  if ($("live-group").selectedOptions[0]?.disabled) $("live-group").value = 'overview';
  const group = $("live-group").value;
  setText($("group-title"), 'Add readings');
  setText($("group-help"), 'Star a reading to move it to your dashboard.');
  setText($("live-set-help"), state.review?.active ? `${dashboardChannels(variantSet).length} dashboard channels · recorded samples only. Use the timeline to inspect values.` : `${dashboardChannels(variantSet).length} dashboard channels. Start records the selected set automatically.`);
  const cards = $("live-cards");
  cards.hidden = false;
  const sensors = dashboardSensors(group, variantSet).filter(sensor => !pins.includes(sensor.name));
  if (!sensors.length) setText($('group-help'), 'These readings are already on your dashboard. Unstar a card to move it back here.');
  const nodes = sensors.map((sensor) => {
    let card = cardNodes.get(sensor.name);
    if (!card) { card = makeSensorCard(sensor.name); cardNodes.set(sensor.name, card); }
    updateCard(card, sensor, state, manual, idleCheck, pins);
    return card;
  });
  syncChildren(cards, nodes);

  const live = state.combined ? combinedSnapshot(state.combined) : (snap || result);
  const rows = live?.rows || [];
  $("csv-btn").disabled = !!state.review?.active || rows.length === 0;
  $("export-group-btn").disabled = !!state.review?.active;
  $("drawer-export-sensor").disabled = !!state.review?.active;
  const captureTime = state.archive?.started || result?.startedAt;
  $("live-meta").textContent = state.review?.active ? `Recorded Data — Offline Review · ${state.review.metadata?.id} · ${formatReplayTime(state.review.position)}` : activeStream(state) ? 'Recording automatically on this device' : captureTime ? `Capture · ${new Date(captureTime).toLocaleString()}` : '';
  $("recording-status").textContent = state.archive?.error
    ? `Saving needs attention: ${state.archive.error}`
    : `${activeStream(state) ? "Recording and saving automatically. Stop ends this session. " : "Saved sessions remain on this phone. "}Exports save to Downloads/SME105 DCL Studio, then open the share sheet.`;

  const mem = snap?.mem || result?.mem || {};
  const memLines = Object.keys(mem).sort((a, b) => a - b).map((key) => `byte ${key}: ${mem[key].toString(16).toUpperCase().padStart(2, "0")}`);
  $("identity-out").textContent = [
    rom ? `ECU software ID: ${hexByte(rom.low)} ${hexByte(rom.high)}` : "ECU software ID: no reading yet",
    memLines.length ? `Memory bytes (addresses 1–15):\n${memLines.join("\n")}` : "Memory bytes: no reading yet",
  ].join("\n");

  if (activeView === "log") {
    const verdict = result?.verdict;
    const summary = [];
    if (result?.outcome) summary.push(`Session ending: ${result.outcome.replaceAll("_", " ").toLowerCase()}`);
    if (result?.operatorConfirmation) summary.push(`Operator response saved: ${new Date(result.operatorConfirmation.confirmedAt).toLocaleString()}`);
    if (!verdict) summary.push(STR.notKnown);
    else {
      const label = verdict.valid ? STR.valid : verdict.status === "FAILED" ? STR.failed : STR.incomplete;
      const why = verdict.end ? reasonText(verdict.end.reason) : STR.unknownEnd;
      summary.push(`${label}${verdict.valid ? ` — ${why}` : ""}`);
      if (!verdict.valid && verdict.reasons.length) summary.push(verdict.reasons.join("\n"));
      if (result.offlineQuietUs != null) summary.push(`${STR.quiet}: ${result.offlineQuietUs} µs`);
      if (verdict.end) summary.push(`ro_bytes=${verdict.end.ro_bytes} ro_lost=${verdict.end.ro_lost} uart_errors=${verdict.end.uart_errors} pad_verified=${verdict.end.pad_verified}`);
    }
    $("log-summary").textContent = summary.join("\n");
    $("log-pre").textContent = state.log.slice(-400).map(line => redactDiagnostic(line)).join("\n");
  }
  renderSensorDrawer(state);
}

export function refreshDashboardCharts() {
  if (!latestState) return;
  renderSensorDrawer(latestState);
}

export function setSensorChartRange(range) {
  if (!["30", "120", "full"].includes(range)) return;
  detailRange = range;
  chartProbe = null;
  refreshDashboardCharts();
}

export function renderWarningHistory(warnings) {
  const list = $("warning-history");
  const severity = $("warning-filter").value;
  const sensor = $("warning-sensor-filter").value;
  const date = $("warning-date-filter").value;
  const filtered = warnings.filter(item => (severity === "all" || item.severity === severity)
    && (sensor === "all" || item.sensor === sensor)
    && (!date || item.triggeredAt?.startsWith(date)));
  const choices = [...new Set(warnings.map(item => item.sensor).filter(Boolean))].sort();
  const sensorSelect = $("warning-sensor-filter");
  const previous = sensorSelect.value;
  sensorSelect.replaceChildren(new Option("All sensors", "all"), ...choices.map(name => new Option(name, name)));
  if (choices.includes(previous)) sensorSelect.value = previous;
  list.replaceChildren();
  if (!filtered.length) {
    const empty = document.createElement("p"); empty.className = "help"; empty.textContent = "No matching warnings in saved history."; list.append(empty); return;
  }
  for (const warning of filtered) {
    const row = document.createElement("article"); row.className = "warning-row"; row.dataset.level = warning.severity;
    const title = document.createElement("strong");
    title.textContent = `${warning.severity.toUpperCase()} · ${warning.ruleId || warning.sensor || "Diagnostic warning"}`;
    const reason = document.createElement("p"); reason.textContent = warning.ruleId === "DTC-111" ? "Historical Code 111: no fault code reported in that dataset. Earlier evidence remains; no global all-clear or memory-clear proof." : warning.reason;
    const evidence = document.createElement("small");
    evidence.textContent = `${warning.triggeredAt} · ${warning.ruleId?.startsWith("DTC-") ? "historical observation" : warning.active ? "active" : `resolved ${warning.resolvedAt}`} · ${warning.source || "Source unavailable"}`;
    row.append(title, reason, evidence); list.append(row);
  }
}

export function renderEventHistory(events) {
  const list = $("event-history");
  list.replaceChildren();
  for (const item of events) {
    const row = document.createElement("article"); row.className = "event-row";
    const title = document.createElement("strong"); title.textContent = `${item.category} · ${item.type}`;
    const detail = document.createElement("span");
    const summary = item.type === "KLINE_SESSION" ? { id: item.detail.id, source: item.detail.source, status: item.detail.status, records: item.detail.records?.length, note: "Full raw evidence retained in ZIP and K-Line history" } : item.detail;
    const preview = JSON.stringify(summary);
    detail.textContent = redactDiagnostic(preview.slice(0, 2000)) + (preview.length > 2000 ? " … Full evidence retained in ZIP." : "");
    const time = document.createElement("small"); time.textContent = `${item.utc} · ${item.monotonic_us} µs`;
    row.append(title, detail, time); list.append(row);
  }
  if (!events.length) list.textContent = "No saved events yet.";
}

export async function exportLog(state) {
  const blob = state.archive ? await state.archive.export("raw") : new Blob([`${state.log.map(line => redactDiagnostic(line)).join("\n")}\n`], { type: "text/plain" });
  await saveOrShare(blob, "eec-iv-session.txt");
}

export async function exportCsv(state) {
  const rows = state.combined?.rows || state.cart?.snapshot().rows || state.lastSession?.rows || [];
  const blob = state.archive ? await state.archive.export("csv") : new Blob([rowsToCsv(rows, { unitSystem: unitSystem() })], { type: "text/csv" });
  await saveOrShare(blob, "eec-iv-live.csv");
}

export function inspectSensorChart(clientX) {
  const rect = $("sensor-chart").getBoundingClientRect();
  chartProbe = Math.max(0, Math.min(1, (clientX-rect.left-52)/Math.max(1,rect.width-66)));
  refreshDashboardCharts();
}
