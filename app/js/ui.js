/** DOM updates. Imported only from the browser entry point. */

import { lookupCode } from "./codes-db.js";
import { ALL_LIVE_PIDS, AUTOMATIC_PIDS, bitRows, displayReading, formatValue, judgeReading, LIVE2_PIDS, LIVE3_PIDS, LIVE_PIDS, PID_TEXT, PIDS, readingLabel, rowsToCsv, summarizeSeries } from "./pids.js";
import { combinedSnapshot, LIVE_GROUPS } from "./combined.js";
import { reasonText, stageText, VARIANTS } from "./protocol.js";
import { STR } from "./strings.js";
import { readingReference, VEHICLE_PROFILE } from "./reference.js";

const $ = (id) => document.getElementById(id);
const expandedReadings = new Set();

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
  document.querySelectorAll(".view").forEach((view) => {
    view.hidden = view.id !== `view-${name}`;
  });
  document.querySelectorAll("nav button").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.view === name ? "page" : "false");
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
      code: entry.code,
      source: entry.mode === 0x25
        ? (state.op?.variant || state.lastSession?.variant || "self-test")
        : `stored request ${state.op?.variant || state.lastSession?.variant || "unknown"}`,
    }));
  }
  return state.lastSession?.codes || [];
}

function lastSample(snap, result, name) {
  const samples = snap?.pids?.[name]?.samples || result?.pids?.[name]?.samples;
  return samples?.length ? samples[samples.length - 1].value : null;
}

function activeSnap(state) {
  if (state.cart) return state.cart.snapshot();
  return null;
}

function progressValue(state) {
  if (state.phase !== "read" || !state.op || state.deadline == null) return 0;
  const spec = VARIANTS[state.op.variant];
  if (!spec) return 0;
  const elapsed = spec.timeoutMs - (state.deadline - Date.now());
  return Math.max(0, Math.min(100, (elapsed / spec.expectMs) * 100));
}

function drawSpark(canvas, samples) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width = canvas.clientWidth * devicePixelRatio || 300;
  const height = canvas.height = 52 * devicePixelRatio;
  ctx.clearRect(0, 0, width, height);
  if (!samples.length) return;
  let min = samples[0].value;
  let max = samples[0].value;
  for (const sample of samples) {
    if (sample.value < min) min = sample.value;
    if (sample.value > max) max = sample.value;
  }
  const span = max - min || 1;
  ctx.strokeStyle = "#f5b942";
  ctx.lineWidth = 2 * devicePixelRatio;
  ctx.beginPath();
  samples.forEach((sample, index) => {
    const x = samples.length === 1 ? width / 2 : (index / (samples.length - 1)) * (width - 4) + 2;
    const y = height - 4 - ((sample.value - min) / span) * (height - 8);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function banner(node, state) {
  if (state.trust === "progress") {
    node.hidden = false;
    node.textContent = STR.inProgress;
    node.className = "banner";
  } else if (state.trust === "untrusted") {
    node.hidden = false;
    node.textContent = STR.untrusted;
    node.className = "banner warn";
  } else {
    node.hidden = true;
    node.textContent = "";
  }
}

export function render(state) {
  const busy = state.phase !== "idle" || !!state.combined?.active;
  const linked = state.link === "ready";
  $("link-pill").textContent = state.link === "ready"
    ? (state.deviceName || STR.link)
    : state.link === "denied" ? "DENIED" : STR.disconnected;
  $("link-pill").classList.toggle("on", linked);
  $("stop-btn").disabled = !busy;
  $("connect-btn").textContent = linked || state.link === "denied" ? STR.disconnectAction : STR.connectAction;
  $("message").textContent = state.message || "";

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
  $("status-raw").textContent = state.status?.raw || state.identity.hello || "";

  const actions = ["read-codes-btn", "koeo-btn", "koer-btn", "live-start", "offline-btn", "bench-btn", "reboot-btn", "clear-btn", "mem-btn"];
  for (const id of actions) $(id).disabled = !linked || busy;
  $("stored-code-mode").disabled = busy;
  $("set-live").disabled = busy;
  $("set-live2").disabled = busy;
  $("set-live3").disabled = busy;
  $("set-all-live").disabled = busy;

  banner($("codes-banner"), state);
  banner($("live-banner"), state);
  const pct = progressValue(state);
  const variant = state.op?.variant || state.lastSession?.variant;
  $("codes-progress").value = variant === "KOEO" || variant === "KOER" || variant === "0E" || variant === "A4" ? pct : 0;
  const prompt = (activeCodes(state).find((entry) => entry.code === "010" || entry.code === "020" || entry.code === "030"));
  const promptBox = $("koer-prompt");
  if (prompt && state.trust === "progress") {
    promptBox.hidden = false;
    promptBox.textContent = `Do this now: ${lookupCode(prompt.code).description}`;
  } else {
    promptBox.hidden = true;
    promptBox.textContent = "";
  }
  $("live-progress").value = variant === "ALL" || variant === "LIVE" || variant === "LIVE2" || variant === "LIVE3" ? pct : 0;

  const snap = activeSnap(state);
  const result = state.lastSession;
  const diagnosticVariant = state.op?.variant || result?.variant || "";
  const expectedMode = diagnosticVariant === "0E" || diagnosticVariant === "A4" ? 0x26
    : diagnosticVariant === "KOEO" || diagnosticVariant === "KOER" ? 0x25 : null;
  const observedModes = result?.observedModes || [
    ...((snap?.blocks25 || 0) > 0 ? [0x25] : []),
    ...((snap?.blocks26 || 0) > 0 ? [0x26] : []),
  ];
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
    empty.textContent = state.trust === "progress"
      ? "Waiting for response words."
      : state.trust === "valid"
        ? "No code words decoded in this complete capture; this does not certify ECU code status."
        : result?.verdict ? "No code words decoded; capture incomplete or failed. Review the validity details above."
          : STR.noCodes;
    list.append(empty);
  } else {
    for (const entry of codes) {
      const info = lookupCode(entry.code);
      const item = document.createElement("li");
      item.innerHTML = `<div class="code"></div><div></div><div class="tag"></div><div class="tag"></div><p class="help"></p><p class="help raw-provenance"></p>`;
      item.children[0].textContent = info.code;
      item.children[1].textContent = info.description;
      item.children[2].textContent = info.category || STR.category;
      item.children[3].textContent = `${STR.source}: ${entry.source}`;
      item.children[4].textContent = info.note;
      item.children[4].hidden = !info.note;
      const raw = entry.rawBytes ? entry.rawBytes.map(hexByte).join(" ") : "not retained";
      const mode = entry.mode == null ? "unknown" : `${entry.mode.toString(16).toUpperCase()}H`;
      item.children[5].textContent = `Observed mode ${mode} · raw bytes ${raw} · frame ${entry.frame ?? "?"}, slot ${entry.slot ?? "?"} · RX time ${entry.rxTimeUs ?? "?"} µs`;
      list.append(item);
    }
  }

  const setId = state.combined ? "ALL" : variant === "ALL" || variant === "LIVE2" || variant === "LIVE3" || variant === "LIVE"
    ? variant
    : ($("set-all-live").checked ? "ALL" : $("set-live3").checked ? "LIVE3" : $("set-live2").checked ? "LIVE2" : "LIVE");
  const pidList = setId === "ALL" ? ALL_LIVE_PIDS : setId === "LIVE3" ? LIVE3_PIDS : setId === "LIVE2" ? LIVE2_PIDS : LIVE_PIDS;
  const live = state.combined ? combinedSnapshot(state.combined) : (snap || result);
  const cards = $("live-cards");
  cards.classList.toggle("untrusted", state.trust === "untrusted" || !!state.combined?.failed);
  const rows = live?.rows || [];
  $("csv-btn").disabled = rows.length === 0;
  cards.replaceChildren();
  const hasSamples = rows.length > 0 || state.trust === "progress" || !!state.combined?.active;
  if (!hasSamples) {
    const note = document.createElement("p");
    note.className = "help";
    note.textContent = STR.liveEmpty;
    cards.append(note);
  }
  const context = {
    rpm: lastSample(snap, result, "N"),
    ect: lastSample(snap, result, "ECT"),
    iact: lastSample(snap, result, "IACT"),
    itp: lastSample(snap, result, "ITP"),
    idleCheck: $("idle-check").checked,
  };
  const manual = $("manual-gearbox").checked;
  for (const pid of hasSamples ? pidList.slice(1) : []) {
    const spec = PIDS[pid];
    if (!spec) continue;
    const [name, unit] = spec;
    const text = PID_TEXT[name] || [name, unit, ""];
    const series = live?.pids?.[name];
    const samples = series?.samples || [];
    const summary = series?.summary || (samples.length ? summarizeSeries(samples) : null);
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("strong");
    title.textContent = text[0];
    const value = document.createElement("div");
    value.className = "value";
    value.textContent = readingLabel(name, summary, { manual });
    const freshness = document.createElement("p");
    freshness.className = "meta";
    if (state.combined || setId === "ALL") {
      const latest = samples.at(-1);
      const age = latest?.receivedAt != null ? Math.max(0, (Date.now() - latest.receivedAt) / 1000) : null;
      freshness.textContent = latest
        ? `Last received ${age == null ? "—" : age.toFixed(1)} s ago${state.combined ? ` · ${latest.variant} · ${latest.validity}` : " · continuous map"}`
        : "No sample received yet";
    }
    const verdict = summary && !(manual && AUTOMATIC_PIDS.has(name))
      ? judgeReading(name, summary, { ...context, samples }) : null;
    if (verdict) value.classList.add(verdict.level);
    const judgement = document.createElement("p");
    judgement.className = `judge ${verdict ? verdict.level : ""}`;
    judgement.textContent = verdict ? verdict.text : "";
    const range = document.createElement("div");
    range.className = "meta";
    const displayUnit = summary ? displayReading(name, summary.last).unit : "";
    range.textContent = summary
      ? `${STR.min} ${formatValue(displayReading(name, summary.min).value)} · ${STR.max} ${formatValue(displayReading(name, summary.max).value)} ${displayUnit} · ${summary.n} samples received`
      : "";
    const canvas = document.createElement("canvas");
    const explain = document.createElement("p");
    explain.className = "help";
    explain.textContent = text[2];
    const reference = readingReference(name, { manual });
    const normal = document.createElement("p");
    normal.className = "help";
    normal.textContent = `Range / reference: ${reference.normal}`;
    const meaning = document.createElement("p");
    meaning.className = "help";
    meaning.textContent = reference.meaning;
    if (reference.source) {
      const source = document.createElement("a");
      source.href = reference.source;
      source.target = "_blank";
      source.rel = "noopener noreferrer";
      source.textContent = " Ford workshop specification";
      normal.append(source);
    }
    const details = document.createElement("details");
    const detailsTitle = document.createElement("summary");
    detailsTitle.textContent = `Technical values · ${name}`;
    // Preserve the user's expanded detail cards across live repainting.
    details.open = expandedReadings.has(name);
    details.addEventListener("toggle", () => {
      if (!details.isConnected) return;
      if (details.open) expandedReadings.add(name);
      else expandedReadings.delete(name);
      if (details.open) drawSpark(canvas, samples);
    });
    const raw = document.createElement("p");
    raw.className = "meta";
    raw.textContent = summary ? `ECU raw word: ${summary.rawLast} · decoded: ${formatValue(summary.last)} ${unit}` : "No reading yet";
    const activity = document.createElement("p");
    activity.className = "help";
    activity.textContent = summary && summary.min === 0 && summary.max === 0
      ? "Zero values were received. Zero alone cannot distinguish an inactive signal from an unsupported parameter."
      : "";
    details.append(detailsTitle, raw, range, activity, canvas);
    card.append(title, explain, value, freshness, judgement, normal, meaning, details);
    if (unit === "bits" && samples.length) {
      const bits = document.createElement("ul");
      bits.className = "bits";
      for (const bit of bitRows(name, samples[samples.length - 1].raw)) {
        const li = document.createElement("li");
        li.className = bit.on ? "on" : "";
        li.textContent = `${bit.on ? STR.yes : STR.no} · ${bit.label}`;
        bits.append(li);
      }
      card.append(bits);
    }
    cards.append(card);
    // The sparkline normalizes min/max. Positive linear unit conversions
    // preserve its shape; retain original samples without copying the series.
    if (details.open) drawSpark(canvas, samples);
  }
  $("live-meta").textContent = state.combined
    ? `Slow survey · ${state.combined.active ? `cycling ${LIVE_GROUPS[state.combined.groupIndex]}` : "stopped"} · ${rows.length} samples · ${state.combined.segments.length} completed groups. Groups are sampled in turn, not simultaneously.${state.combined.error ? ` ${state.combined.error}` : ""}`
    : setId === "ALL" ? `Continuous all-data stream · ${live?.totalRows || rows.length} samples · one map, no group switching. Designed for all channels each 0.36 s; actual vehicle delivery must be measured.`
    : rows.length ? `${live?.totalRows || rows.length} samples` : "";
  if (state.archive) $("live-meta").textContent += ` Full data is saved on this phone; graphs show recent readings. ${state.archive.persistent ? "Persistent storage granted." : "Export before clearing browser data; storage persistence was not granted."}${state.archive.error ? ` Storage error: ${state.archive.error}` : ""}`;
  const romNow = snap?.rom || state.rom;
  const mem = snap?.mem || result?.mem || {};
  const memLines = Object.keys(mem).sort((a, b) => a - b).map((key) => `byte ${key}: ${mem[key].toString(16).toUpperCase().padStart(2, "0")}`);
  $("identity-out").textContent = [
    romNow ? `ECU software ID: ${hexByte(romNow.low)} ${hexByte(romNow.high)}` : "ECU software ID: no reading yet",
    memLines.length ? `Memory bytes (addresses 1–15):\n${memLines.join("\n")}` : "Memory bytes: no reading yet",
  ].join("\n");

  const verdict = result?.verdict;
  const summary = [];
  if (!verdict) summary.push(STR.notKnown);
  else {
    const label = verdict.valid ? STR.valid : verdict.status === "FAILED" ? STR.failed : STR.incomplete;
    const why = verdict.end ? reasonText(verdict.end.reason) : STR.unknownEnd;
    summary.push(`${label}${verdict.valid ? ` — ${why}` : ""}`);
    if (!verdict.valid && verdict.reasons.length) summary.push(verdict.reasons.join("\n"));
    if (result.offlineQuietUs != null) summary.push(`${STR.quiet}: ${result.offlineQuietUs} µs`);
    if (verdict.end) {
      summary.push(`ro_bytes=${verdict.end.ro_bytes} ro_lost=${verdict.end.ro_lost} uart_errors=${verdict.end.uart_errors} pad_verified=${verdict.end.pad_verified}`);
    }
  }
  $("log-summary").textContent = summary.join("\n");
  const tail = state.log.slice(-400);
  $("log-pre").textContent = tail.join("\n");
}

export async function exportLog(state) {
  const blob = state.archive ? await state.archive.export("raw") : new Blob([`${state.log.join("\n")}\n`], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "eec-iv-session.txt";
  link.click();
  URL.revokeObjectURL(link.href);
}

export async function exportCsv(state) {
  const rows = state.combined?.rows || state.cart?.snapshot().rows || state.lastSession?.rows || [];
  const blob = state.archive ? await state.archive.export("csv") : new Blob([rowsToCsv(rows)], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "eec-iv-live.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}
