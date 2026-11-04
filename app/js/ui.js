/** DOM updates. Imported only from the browser entry point. */

import { lookupCode } from "./codes-db.js";
import { bitRows, formatValue, LIVE2_PIDS, LIVE_PIDS, PIDS, rowsToCsv, summarizeSeries } from "./pids.js";
import { reasonText, stageText, VARIANTS } from "./protocol.js";
import { STR } from "./strings.js";

const $ = (id) => document.getElementById(id);

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
  $("modal-cancel").focus();
  return new Promise((resolve) => {
    const finish = (value) => {
      modal.hidden = true;
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
      code: entry.code,
      source: entry.mode === 0x25 ? "KOEO" : "stored",
    }));
  }
  return state.lastSession?.codes || [];
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
  const busy = state.phase !== "idle";
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

  const actions = ["read-codes-btn", "koeo-btn", "live-start", "offline-btn", "bench-btn", "reboot-btn"];
  for (const id of actions) $(id).disabled = !linked || busy;
  $("set-live").disabled = busy;
  $("set-live2").disabled = busy;

  banner($("codes-banner"), state);
  banner($("live-banner"), state);
  const pct = progressValue(state);
  const variant = state.op?.variant || state.lastSession?.variant;
  $("codes-progress").value = variant === "KOEO" || variant === "0E" ? pct : 0;
  $("live-progress").value = variant === "LIVE" || variant === "LIVE2" ? pct : 0;

  const snap = activeSnap(state);
  const result = state.lastSession;
  const flag = snap?.selfTestComplete || result?.selfTestComplete;
  const frame7 = snap?.frame7Last ?? result?.frame7Last;
  const bridgeBlocks = state.op?.session?.bridgeBlocks ?? result?.bridgeBlocks;
  const decodedBlocks = (snap?.blocks25 || 0) + (snap?.blocks26 || 0)
    || ((result?.blocks25 || 0) + (result?.blocks26 || 0));
  const blocks = bridgeBlocks ?? decodedBlocks;
  $("codes-meta").textContent = [
    `${STR.blocks}: ${blocks || 0}`,
    `${STR.selfTestFlag}: ${flag ? STR.flagSet : STR.flagClear}`,
    `${STR.frame7}: ${frame7 == null ? STR.notKnown : hexByte(frame7)}`,
  ].join(" · ");

  const list = $("codes-list");
  const codes = activeCodes(state);
  list.classList.toggle("untrusted", state.trust === "untrusted");
  list.replaceChildren();
  if (!codes.length) {
    const empty = document.createElement("li");
    empty.textContent = STR.noCodes;
    list.append(empty);
  } else {
    for (const entry of codes) {
      const info = lookupCode(entry.code);
      const item = document.createElement("li");
      item.innerHTML = `<div class="code"></div><div></div><div class="tag"></div><div class="tag"></div><p class="help"></p>`;
      item.children[0].textContent = info.code;
      item.children[1].textContent = info.description;
      item.children[2].textContent = info.category || STR.category;
      item.children[3].textContent = `${STR.source}: ${entry.source}`;
      item.children[4].textContent = info.note;
      item.children[4].hidden = !info.note;
      list.append(item);
    }
  }

  const setId = variant === "LIVE2" || (!variant && $("set-live2").checked) ? "LIVE2" : "LIVE";
  const pidList = setId === "LIVE2" ? LIVE2_PIDS : LIVE_PIDS;
  const cards = $("live-cards");
  cards.classList.toggle("untrusted", state.trust === "untrusted");
  const rows = snap?.rows || result?.rows || [];
  $("csv-btn").disabled = rows.length === 0;
  cards.replaceChildren();
  for (const pid of pidList.slice(1)) {
    const spec = PIDS[pid];
    if (!spec) continue;
    const [name, unit] = spec;
    const samples = snap?.pids?.[name]?.samples || result?.pids?.[name]?.samples || [];
    const summary = samples.length ? summarizeSeries(samples) : null;
    const card = document.createElement("article");
    card.className = "card";
    const title = document.createElement("strong");
    title.textContent = unit ? `${name} (${unit})` : name;
    const value = document.createElement("div");
    value.className = "value";
    value.textContent = summary ? `${formatValue(summary.last)} ${unit}`.trim() : STR.notKnown;
    const range = document.createElement("div");
    range.className = "meta";
    range.textContent = summary
      ? `${STR.min} ${formatValue(summary.min)} · ${STR.max} ${formatValue(summary.max)} · n ${summary.n}`
      : "";
    const canvas = document.createElement("canvas");
    card.append(title, value, range, canvas);
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
    drawSpark(canvas, samples);
  }
  $("live-meta").textContent = rows.length ? `${rows.length} samples` : "";

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

export function exportLog(state) {
  const blob = new Blob([`${state.log.join("\n")}\n`], { type: "text/plain" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "eec-iv-session.txt";
  link.click();
  URL.revokeObjectURL(link.href);
}

export function exportCsv(state) {
  const rows = state.cart?.snapshot().rows || state.lastSession?.rows || [];
  const blob = new Blob([rowsToCsv(rows)], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "eec-iv-live.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}
