/** Stable, keyed dashboard rendering for browser and native WebView. */

import { lookupCode } from "./codes-db.js";
import { AUTOMATIC_PIDS, bitRows, displayReading, formatValue, judgeReading, PID_TEXT, PIDS, rowsToCsv, summarizeSeries } from "./pids.js";
import { combinedSnapshot } from "./combined.js";
import { reasonText, stageText, VARIANTS } from "./protocol.js";
import { STR } from "./strings.js";
import { readingReference, VEHICLE_PROFILE } from "./reference.js";
import { LIVE_GROUP_HELP, LIVE_GROUP_TITLES, sensorsForGroup, sensorFreshness } from "./live-dashboard.js";
import { redactDiagnostic } from "./diagnostics.js";
import { saveOrShare } from "./exports.js";

const $ = (id) => document.getElementById(id);
const cardNodes = new Map();
const pinnedNodes = new Map();
const fmemNodes = new Map();
const fmemBitNodes = new Map();
let detailPid = null;
let detailRange = "30";
let latestState = null;
let lastHeroSamples = null;
let activeView = "live";

const PREF_KEY = "sme105-dashboard-prefs-v1";

function readPrefs() {
  try {
    const value = JSON.parse(localStorage.getItem(PREF_KEY) || "{}");
    return { pins: Array.isArray(value.pins) ? value.pins.filter((x) => typeof x === "string") : [] };
  } catch { return { pins: [] }; }
}

function writePrefs(prefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* Private browsing may disable storage. */ }
}

function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function unitSystem() { return readStored("eeciv-unit-system") === "imperial" ? "imperial" : "metric"; }

export function pinnedSensors() { return readPrefs().pins; }

export function toggleSensorPin(name) {
  const prefs = readPrefs();
  prefs.pins = prefs.pins.includes(name) ? prefs.pins.filter((item) => item !== name) : [...prefs.pins, name];
  writePrefs(prefs);
  return prefs.pins;
}

export function movePinnedSensor(name, direction) {
  const prefs = readPrefs();
  const index = prefs.pins.indexOf(name);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= prefs.pins.length) return prefs.pins;
  [prefs.pins[index], prefs.pins[next]] = [prefs.pins[next], prefs.pins[index]];
  writePrefs(prefs);
  return prefs.pins;
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

function hexByte(value) {
  if (value == null) return STR.notKnown;
  return value.toString(16).toUpperCase().padStart(2, "0");
}

function activeCodes(state) {
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

function activeSnap(state) { return state.cart?.snapshot() || null; }

function renderFailureMemory(state) {
  const container = $("fmem-values");
  const desired = [];
  for (const name of ["FMEM_FLAGS", "FMEM_FLAG2"]) {
    let block = fmemNodes.get(name);
    if (!block) {
      block = document.createElement("section"); block.className = "fmem-byte";
      const title = document.createElement("strong"); title.className = "fmem-title";
      const value = document.createElement("p"); value.className = "meta";
      const list = document.createElement("ul"); list.className = "bits";
      block.append(title, value, list); fmemNodes.set(name, block);
    }
    const samples = sensorSeries(state, name)?.samples || [];
    const latest = samples.at(-1);
    setText(block.querySelector(".fmem-title"), name === "FMEM_FLAGS" ? "Failure-memory byte 1" : "Failure-memory byte 2");
    setText(block.querySelector("p"), latest ? `Raw byte: ${hexByte(latest.raw & 0xff)} · received ${latest.receivedAt ? new Date(latest.receivedAt).toISOString() : "time unavailable"}` : "No sample in the selected capture.");
    const bits = block.querySelector("ul");
    const bitList = latest ? bitRows(name, latest.value) : [];
    let nodes = fmemBitNodes.get(name);
    if (!nodes) { nodes = new Map(); fmemBitNodes.set(name, nodes); }
    syncChildren(bits, bitList.map((bit) => {
      let li = nodes.get(bit.bit);
      if (!li) { li = document.createElement("li"); nodes.set(bit.bit, li); }
      li.classList.toggle("on", bit.on);
      setText(li, `${bit.on ? "●" : "○"} Bit ${bit.bit}: ${bit.on ? "set" : "clear"} · ${bit.label}`);
      return li;
    }));
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

function sensorSeries(state, name) {
  const snap = activeSnap(state);
  const live = state.combined ? combinedSnapshot(state.combined) : null;
  return live?.pids?.[name] || snap?.pids?.[name] || state.lastSession?.pids?.[name] || null;
}

function activeStream(state) {
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
const DTC_SENSOR_LINKS = Object.freeze({ "113": ["ACT"], "122": ["ITP"], "157": ["MAF"], "214": ["N"], "452": ["VS"] });

function sensorValue(name, summary, { manual = true } = {}) {
  if (!summary) return "—";
  if (manual && AUTOMATIC_PIDS.has(name)) return "N/A · manual";
  if (RAW_SIGNALS.has(name)) return `${formatValue(summary.last)} counts`;
  const view = displayReading(name, summary.last, { unitSystem: unitSystem() });
  return `${formatValue(view.value)} ${view.unit}`.trim();
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

function sampleTime(sample) {
  if (Number.isFinite(sample?.receivedAt)) return sample.receivedAt;
  if (Number.isFinite(sample?.t)) return sample.t * 1000;
  return null;
}

function chartColor(state) {
  const token = state === "fresh" ? "--cyan" : "--gray";
  return getComputedStyle(document.body).getPropertyValue(token).trim() || (state === "fresh" ? "#4ad9e6" : "#95a2ac");
}

function drawTimeChart(canvas, samples, range = "30", color = "#42d9e8") {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.round(rect.width * ratio);
  const height = Math.round(rect.height * ratio);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  if (!samples?.length) return;

  const points = samples.slice(-1200).map((sample) => ({ sample, time: sampleTime(sample), value: sample.value }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.value));
  if (!points.length) return;
  const end = points.at(-1).time;
  const spanMs = range === "full" ? Infinity : Number(range) * 1000;
  const visible = points.filter((point) => end - point.time <= spanMs);
  if (!visible.length) return;
  let min = Math.min(...visible.map((point) => point.value));
  let max = Math.max(...visible.map((point) => point.value));
  if (min === max) { min -= 1; max += 1; }
  const firstTime = visible[0].time;
  const duration = Math.max(1, end - firstTime);
  const gaps = [];
  for (let i = 1; i < visible.length; i += 1) {
    const gap = visible[i].time - visible[i - 1].time;
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const gapLimit = gaps.length ? gaps[Math.floor(gaps.length / 2)] * 3 : Infinity;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * ratio;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  let active = false;
  for (let i = 0; i < visible.length; i += 1) {
    const point = visible[i];
    const x = 8 * ratio + ((point.time - firstTime) / duration) * (width - 16 * ratio);
    const y = height - 8 * ratio - ((point.value - min) / (max - min)) * (height - 16 * ratio);
    if (!active || (i > 0 && point.time - visible[i - 1].time > gapLimit)) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    active = true;
  }
  ctx.stroke();
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
  const note = document.createElement("span"); note.className = "sensor-reason";
  open.append(title, value, status, note);
  const pin = document.createElement("button");
  pin.type = "button"; pin.className = "pin-button"; pin.dataset.pinPid = name;
  head.append(open, pin);
  const series = document.createElement("p"); series.className = "sensor-count";
  const actions = document.createElement("div"); actions.className = "pin-order";
  const up = document.createElement("button"); up.type = "button"; up.dataset.movePid = name; up.dataset.direction = "-1"; up.textContent = "Move up";
  const down = document.createElement("button"); down.type = "button"; down.dataset.movePid = name; down.dataset.direction = "1"; down.textContent = "Move down";
  actions.append(up, down);
  card.append(head, series, actions);
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
  const freshness = sensorFreshness(samples, { active: activeStream(state), now: Date.now() });
  const dtc = state.lastSession?.verdict?.valid
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
  setText(value, sensorValue(name, health.summary, { manual }));
  value.dataset.state = health.colorState;
  setState(card.querySelector(".state-label"), notApplicable ? "na" : health.colorState);
  const status = card.querySelector(".state-label");
  setText(status, notApplicable ? "NOT APPLICABLE" : health.freshness.label);
  if (health.dtc) setText(status, `! DTC ${health.dtc.code} · ${health.dtc.variant} history`);
  else if (health.verdict?.level === "ok") setText(status, "✓ VERIFIED RANGE");
  else if (health.verdict?.level === "warn") setText(status, `! ${health.verdict.text}`);
  setText(card.querySelector(".sensor-reason"), health.explanation || help);
  setText(card.querySelector(".sensor-count"), health.summary
    ? `${health.summary.n} samples · raw ${health.summary.rawLast} · ${health.summary.min === health.summary.max ? "unchanged in this capture" : "changing in this capture"}`
    : "No sample in this data set");
  const pin = card.querySelector(".pin-button");
  pin.textContent = pins.includes(name) ? "★" : "☆";
  pin.setAttribute("aria-label", pins.includes(name) ? `Unpin ${title}` : `Pin ${title}`);
  const pinned = pins.includes(name);
  card.querySelector(".pin-order").hidden = !pinned;
  card.classList.toggle("not-applicable", notApplicable);
  card.classList.toggle("stale", ["none", "stale", "historical", "unknown"].includes(health.freshness.state) || notApplicable);
  card.classList.toggle("warning", health.colorState === "warn");
  card.querySelector("[data-open-pid]").setAttribute("aria-label", `${title}, ${value.textContent}, ${status.textContent}. Open details.`);
}

function renderMetric(name, valueId, stateId, state, manual, idleCheck) {
  const node = document.querySelector(`.metric[data-pid="${name}"]`);
  const value = $(valueId);
  const label = $(stateId);
  const series = sensorSeries(state, name);
  const health = sensorHealth(name, series, state, manual, idleCheck);
  setText(value, sensorValue(name, health.summary, { manual }));
  value.dataset.state = health.colorState;
  setState(label, health.colorState);
  setText(label, health.freshness.label);
  node.classList.toggle("stale", ["none", "stale", "historical", "unknown"].includes(health.freshness.state));
  node.setAttribute("aria-label", `${name}: ${value.textContent}; ${label.textContent}. Open details.`);
}

function renderHero(state, manual, idleCheck) {
  const series = sensorSeries(state, "N");
  const health = sensorHealth("N", series, state, manual, idleCheck);
  const value = $("rpm-value");
  setText(value, health.summary ? formatValue(health.summary.last) : "No sample");
  value.dataset.state = health.colorState;
  setState($("rpm-state"), health.colorState);
  setText($("rpm-state"), health.freshness.label);
  setText($("rpm-age"), health.summary
    ? `${health.summary.n} samples · ${health.freshness.label.toLowerCase()}`
    : "Waiting for a sample in the selected data set");
  const idle = $("idle-result");
  idle.hidden = !idleCheck || !health.verdict;
  if (!idle.hidden) {
    idle.dataset.state = health.verdict.level;
    setText(idle, health.verdict.text);
  }
  const scope = state.combined ? "ALL" : state.op?.variant || state.lastSession?.variant || "";
  const target = sensorSeries(state, "DSDRPM")?.samples || [];
  const targetSeriesPresent = ["LIVE2", "ALL"].includes(scope) && health.samples.length > 0 && target.length > 0;
  const targetNode = $("idle-target");
  targetNode.hidden = !targetSeriesPresent;
  if (targetSeriesPresent) setText(targetNode, `Target ${formatValue(target.at(-1).value)} rpm · same ${scope} capture`);
  const samples = health.samples;
  const last = samples.length ? `${samples.length}:${samples.at(-1).receivedAt ?? samples.at(-1).t}:${health.freshness.state}` : `none:${health.freshness.state}`;
  if (last !== lastHeroSamples) {
    drawTimeChart($("rpm-trend"), samples, "30", chartColor(health.freshness.state));
    lastHeroSamples = last;
  }
  $("rpm-hero").classList.toggle("stale", ["none", "stale", "historical", "unknown"].includes(health.freshness.state));
}

function renderPinned(state, manual, idleCheck, pins) {
  const section = $("pinned-section");
  section.hidden = !pins.length;
  const container = $("pinned-readings");
  const desired = [];
  for (const name of pins) {
    let item = pinnedNodes.get(name);
    if (!item) {
      item = document.createElement("div"); item.className = "pinned-card";
      const open = document.createElement("button"); open.type = "button"; open.className = "pinned-open"; open.dataset.openPid = name;
      const title = document.createElement("span"); title.className = "pinned-title";
      const value = document.createElement("strong"); value.className = "pinned-value";
      const stateLabel = document.createElement("small"); stateLabel.className = "state-label";
      open.append(title, value, stateLabel);
      const up = document.createElement("button"); up.type = "button"; up.dataset.movePid = name; up.dataset.direction = "-1"; up.setAttribute("aria-label", `Move ${name} earlier`); up.textContent = "↑";
      const down = document.createElement("button"); down.type = "button"; down.dataset.movePid = name; down.dataset.direction = "1"; down.setAttribute("aria-label", `Move ${name} later`); down.textContent = "↓";
      const remove = document.createElement("button"); remove.type = "button"; remove.dataset.pinPid = name; remove.setAttribute("aria-label", `Unpin ${name}`); remove.textContent = "★";
      item.append(open, up, down, remove); pinnedNodes.set(name, item);
    }
    const sensor = sensorsForGroup("advanced", { manual: false }).find((entry) => entry.name === name);
    if (!sensor) continue;
    const health = sensorHealth(name, sensorSeries(state, name), state, manual, idleCheck);
    setText(item.querySelector(".pinned-title"), sensor.title);
    setText(item.querySelector(".pinned-value"), sensorValue(name, health.summary, { manual }));
    setState(item.querySelector(".state-label"), health.colorState);
    setText(item.querySelector(".state-label"), health.freshness.label);
    item.querySelector(".pinned-value").dataset.state = health.colorState;
    desired.push(item);
  }
  syncChildren(container, desired);
}

function renderSensorDrawer(state) {
  if (!detailPid || $("sensor-drawer").hidden) return;
  const sensor = sensorsForGroup("advanced", { manual: false }).find((entry) => entry.name === detailPid);
  if (!sensor) return;
  const { name, title, unit, pid } = sensor;
  const series = sensorSeries(state, name);
  const health = sensorHealth(name, series, state, $("manual-gearbox").checked, $("idle-check").checked);
  const summary = health.summary;
  const reference = readingReference(name, { manual: $("manual-gearbox").checked });
  setText($("drawer-group"), [...Object.keys(LIVE_GROUP_TITLES)].find((group) => LIVE_GROUPSForUi(group).includes(name))
    ? LIVE_GROUP_TITLES[Object.keys(LIVE_GROUP_TITLES).find((group) => LIVE_GROUPSForUi(group).includes(name))]
    : "Advanced");
  setText($("drawer-title"), title);
  setText($("drawer-state"), `${health.freshness.label} · ${health.explanation}`);
  $("drawer-state").dataset.state = health.colorState;
  setText($("drawer-value"), sensorValue(name, summary, { manual: false }));
  $("drawer-value").dataset.state = health.colorState;
  setText($("drawer-unit"), RAW_SIGNALS.has(name) ? "raw ECU counts" : displayReading(name, summary?.last ?? 0, { unitSystem: unitSystem() }).unit);
  setText($("drawer-raw"), summary ? `${summary.rawLast} (0x${hexByte(summary.rawLast & 0xff)})` : "No sample");
  setText($("drawer-min"), summary ? formatValue(displayReading(name, summary.min, { unitSystem: unitSystem() }).value) : "—");
  setText($("drawer-max"), summary ? formatValue(displayReading(name, summary.max, { unitSystem: unitSystem() }).value) : "—");
  setText($("drawer-count"), summary?.n ?? 0);
  const latest = health.samples.at(-1);
  setText($("drawer-time"), latest
    ? `PID 0x${pid.toString(16).toUpperCase().padStart(2, "0")} · receive ${latest.receivedAt ? new Date(latest.receivedAt).toISOString() : "time unavailable"} · ECU sample t=${latest.t}s · ${health.freshness.label}`
    : `PID 0x${pid.toString(16).toUpperCase().padStart(2, "0")} · no sample in this capture`);
  setText($("drawer-meaning"), health.explanation);
  setText($("drawer-reference"), reference.normal);
  setText($("drawer-source"), `${reference.meaning} ${reference.source ? `Source: ${reference.source}` : "No vehicle-specific limit source verified."}`);
  const pins = pinnedSensors();
  setText($("drawer-pin"), pins.includes(name) ? "Unpin reading" : "Pin reading");
  $("drawer-pin").dataset.pinPid = name;
  drawTimeChart($("sensor-chart"), health.samples, detailRange, chartColor(health.freshness.state));
}

function LIVE_GROUPSForUi(group) {
  return sensorsForGroup(group, { manual: false }).map((sensor) => sensor.name);
}

export function openSensorDetails(state, name) {
  detailPid = name;
  detailRange = "30";
  $("sensor-drawer").hidden = false;
  renderSensorDrawer(state);
  $("drawer-close").focus();
}

export function closeSensorDetails() {
  detailPid = null;
  $("sensor-drawer").hidden = true;
}

export function render(state) {
  latestState = state;
  const busy = state.phase !== "idle" || !!state.combined?.active;
  const linked = state.link === "ready";
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
  $("bench-value").textContent = state.bench.pass ? STR.benchPass : STR.benchNeeded;
  const rom = state.rom || activeSnap(state)?.rom;
  $("rom-value").textContent = rom ? `${hexByte(rom.low)} ${hexByte(rom.high)}` : STR.notKnown;
  const vbat = state.battery ?? activeSnap(state)?.pids?.VBAT?.samples?.at(-1)?.value;
  $("battery-value").textContent = vbat == null ? STR.notKnown : `${formatValue(vbat)} V`;
  $("status-raw").textContent = redactDiagnostic(state.status?.raw || state.identity.hello || "");

  const actions = ["read-codes-btn", "koeo-btn", "koer-btn", "live-start", "offline-btn", "bench-btn", "reboot-btn", "clear-btn", "mem-btn"];
  for (const id of actions) $(id).disabled = !linked || busy || !!state.recovering;
  $("stored-code-mode").disabled = busy;
  for (const id of ["live-set", "live-group"]) $(id).disabled = busy;

  const banner = (node) => {
    if (state.trust === "progress") { node.hidden = false; node.textContent = STR.inProgress; node.className = "banner"; }
    else if (state.trust === "untrusted") { node.hidden = false; node.textContent = STR.untrusted; node.className = "banner warn"; }
    else { node.hidden = true; node.textContent = ""; }
  };
  banner($("codes-banner"));
  banner($("live-banner"));
  const pct = progressValue(state);
  const variant = state.op?.variant || state.lastSession?.variant;
  $("codes-progress").value = ["KOEO", "KOER", "0E", "A4"].includes(variant) ? pct : 0;
  $("live-progress").value = ["ALL", "LIVE", "LIVE2", "LIVE3"].includes(variant) ? pct : 0;
  const prompt = activeCodes(state).find((entry) => ["010", "020", "030"].includes(entry.code));
  const promptBox = $("koer-prompt");
  promptBox.hidden = !(prompt && state.trust === "progress");
  promptBox.textContent = promptBox.hidden ? "" : `Follow the ECU prompt now: ${lookupCode(prompt.code).description}`;

  const snap = activeSnap(state);
  const result = state.lastSession;
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

  const manual = $("manual-gearbox").checked;
  const idleCheck = $("idle-check").checked;
  $("manual-gearbox-settings").checked = manual;
  $("idle-check-settings").checked = idleCheck;
  renderHero(state, manual, idleCheck);
  renderMetric("ECT", "metric-ect", "state-ect", state, manual, idleCheck);
  renderMetric("VBAT", "metric-vbat", "state-vbat", state, manual, idleCheck);
  renderMetric("ITP", "metric-itp", "state-itp", state, manual, idleCheck);
  renderMetric("LOAD", "metric-load", "state-load", state, manual, idleCheck);
  const pins = pinnedSensors();
  renderPinned(state, manual, idleCheck, pins);

  const group = $("live-group").value;
  setText($("group-title"), LIVE_GROUP_TITLES[group] || LIVE_GROUP_TITLES.overview);
  const groupHelp = LIVE_GROUP_HELP[group] || LIVE_GROUP_HELP.overview;
  setText($("group-help"), manual && group !== "advanced"
    ? `${groupHelp} Automatic-only channels are hidden here; Advanced and raw exports retain them.`
    : groupHelp);
  const setHelp = {
    LIVE: "15 engine, temperature and fuel channels.",
    LIVE2: "15 idle-control, switch and failure-memory channels.",
    LIVE3: "15 extra channels, including equipment-dependent and automatic-transmission signals.",
    ALL: "All 39 channels in one map. Requires bridge firmware v21 or later; the ECU update rate is measured, not assumed.",
  }[ $("live-set").value ] || "";
  setText($("live-set-help"), setHelp);
  const cards = $("live-cards");
  cards.hidden = group === "overview";
  const sensors = group === "overview" ? [] : sensorsForGroup(group, { manual });
  const nodes = sensors.map((sensor) => {
    let card = cardNodes.get(sensor.name);
    if (!card) { card = makeSensorCard(sensor.name); cardNodes.set(sensor.name, card); }
    updateCard(card, sensor, state, manual, idleCheck, pins);
    return card;
  });
  syncChildren(cards, nodes);

  const live = state.combined ? combinedSnapshot(state.combined) : (snap || result);
  const rows = live?.rows || [];
  $("csv-btn").disabled = rows.length === 0;
  $("live-meta").textContent = state.combined
    ? `Multi-set survey · ${state.combined.active ? "running" : "stopped"} · ${rows.length.toLocaleString()} readings · ${state.combined.segments.length} completed groups.${state.combined.error ? ` ${state.combined.error}` : ""}`
    : variant === "ALL" || $("live-set").value === "ALL"
      ? `All 39 channels · ${(live?.totalRows || rows.length).toLocaleString()} readings · one map; samples are sequential.`
      : rows.length ? `${(live?.totalRows || rows.length).toLocaleString()} readings${state.archive ? " · saved on this device" : " received"}` : "";
  $("recording-status").textContent = state.archive
    ? `Full bridge evidence and sensor rows are saved during this capture. ${state.archive.persistent ? "Persistent device storage was granted." : "Export the capture before clearing app storage."}${state.archive.error ? ` Storage error: ${state.archive.error}` : ""}`
    : "Recordings remain on this device. Interrupted sessions remain incomplete; saving does not certify diagnostic validity.";

  const mem = snap?.mem || result?.mem || {};
  const memLines = Object.keys(mem).sort((a, b) => a - b).map((key) => `byte ${key}: ${mem[key].toString(16).toUpperCase().padStart(2, "0")}`);
  $("identity-out").textContent = [
    rom ? `ECU software ID: ${hexByte(rom.low)} ${hexByte(rom.high)}` : "ECU software ID: no reading yet",
    memLines.length ? `Memory bytes (addresses 1–15):\n${memLines.join("\n")}` : "Memory bytes: no reading yet",
  ].join("\n");

  if (activeView === "log") {
    const verdict = result?.verdict;
    const summary = [];
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
  const heroSeries = sensorSeries(latestState, "N");
  const status = sensorHealth("N", heroSeries, latestState, $("manual-gearbox").checked, $("idle-check").checked);
  drawTimeChart($("rpm-trend"), heroSeries?.samples || [], "30", chartColor(status.freshness.state));
  renderSensorDrawer(latestState);
}

export function setSensorChartRange(range) {
  if (!["30", "120", "full"].includes(range)) return;
  detailRange = range;
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
    const reason = document.createElement("p"); reason.textContent = warning.reason;
    const evidence = document.createElement("small");
    evidence.textContent = `${warning.triggeredAt} · ${warning.active ? "active" : `resolved ${warning.resolvedAt}`} · ${warning.source || "Source unavailable"}`;
    row.append(title, reason, evidence); list.append(row);
  }
}

export function renderEventHistory(events) {
  const list = $("event-history");
  list.replaceChildren();
  for (const item of events) {
    const row = document.createElement("article"); row.className = "event-row";
    const title = document.createElement("strong"); title.textContent = `${item.category} · ${item.type}`;
    const detail = document.createElement("span"); detail.textContent = redactDiagnostic(JSON.stringify(item.detail));
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
