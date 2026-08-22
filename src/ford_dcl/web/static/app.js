(() => {
  "use strict";

  const token = new URLSearchParams(location.search).get("token") || "";
  const state = {
    bootstrap: null,
    settings: {},
    ports: [],
    events: [],
    wizardStep: 0,
    latestSequence: 0,
    socket: null,
    captureTimer: null,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  async function api(path, options = {}) {
    const headers = { "X-Ford-DCL-Token": token, ...(options.headers || {}) };
    if (options.body && !(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
    const response = await fetch(path, { ...options, headers });
    const payload = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
    if (!response.ok) {
      const detail = payload && payload.detail;
      const message = Array.isArray(detail)
        ? detail.map((item) => item.msg || JSON.stringify(item)).join("; ")
        : (detail || payload || `HTTP ${response.status}`);
      throw new Error(message);
    }
    return payload;
  }

  function toast(message, kind = "") {
    const node = document.createElement("div");
    node.className = `toast ${kind}`;
    node.textContent = message;
    $("#toast-container").append(node);
    setTimeout(() => node.remove(), 5000);
  }

  function value(id) { return $(id).value.trim(); }
  function numberOrNull(id) {
    const raw = value(id);
    return raw === "" ? null : Number(raw);
  }

  const pageTitles = {
    dashboard: "System Overview",
    setup: "Guided Setup",
    capture: "Live Capture",
    analysis: "Sessions & Analysis",
    dtc: "DTC Lookup",
    diagnosis: "High-Idle Diagnosis",
    firmware: "Firmware Management",
    logs: "Live Application Logs",
    reference: "Reference Library",
    settings: "Application Settings",
  };

  function navigate(page) {
    $$(".page").forEach((node) => node.classList.toggle("active", node.id === `page-${page}`));
    $$("#nav button").forEach((node) => node.classList.toggle("active", node.dataset.page === page));
    $("#page-title").textContent = pageTitles[page] || "Diagnostic Studio";
    if (page === "analysis") loadSessions();
    if (page === "logs") scrollLogs();
  }

  function renderPorts() {
    const selects = ["#wizard-port", "#capture-port", "#firmware-port"];
    for (const selector of selects) {
      const select = $(selector);
      const previous = select.value || state.settings.port;
      select.replaceChildren();
      const empty = new Option("Select serial port", "");
      select.add(empty);
      state.ports.forEach((port) => {
        const label = `${port.device} — ${port.description || "Serial device"}${port.permission ? "" : " (permission denied)"}`;
        select.add(new Option(label, port.device));
      });
      select.value = previous || "";
    }
    const selected = state.ports.find((item) => item.device === state.settings.port);
    $("#connection-pill").textContent = selected ? selected.device : "No serial port";
    $("#connection-pill").className = `pill ${selected ? "live" : "neutral"}`;
    $("#metric-port").textContent = selected?.device || "Not selected";
    $("#metric-port-detail").textContent = selected?.description || "Scan required";
  }

  function applySettings() {
    const s = state.settings;
    $("#capture-port").value = s.port || "";
    $("#wizard-port").value = s.port || "";
    $("#firmware-port").value = s.port || "";
    $("#capture-format").value = s.capture_format;
    $("#capture-baud").value = s.usb_baudrate;
    $("#capture-duration").value = s.duration_seconds;
    $("#capture-label").value = s.session_label;
    $("#capture-dcl-baud").value = String(s.dcl_baud);
    $("#capture-ignition").value = s.ignition_state;
    $("#capture-engine").value = s.engine_state;
    $("#metric-firmware").textContent = s.firmware;
    $$("[data-setting]").forEach((input) => {
      const setting = input.dataset.setting;
      if (input.type === "checkbox") input.checked = Boolean(s[setting]);
      else input.value = s[setting] ?? "";
    });
    const completed = Boolean(s.wizard_progress?.completed);
    updateReadiness(completed ? 100 : 20);
  }

  function updateReadiness(percent) {
    $("#progress-value").textContent = `${percent}%`;
    $("#progress-circle").style.strokeDashoffset = String(302 - (302 * percent / 100));
  }

  async function refreshPorts() {
    state.ports = await api("/api/ports");
    renderPorts();
    const selected = state.ports.find((item) => item.device === $("#wizard-port").value);
    const access = state.bootstrap?.serial_access;
    $("#port-diagnostic").textContent = selected
      ? `${selected.description}. Identity: ${selected.stable_identity || selected.hwid}. ${selected.permission ? "Read/write permission available." : selected.access_hint || access?.hint || "Permission denied."}`
      : "No device selected. USB-only setup does not require the K485 or ECU.";
  }

  function updateWizard() {
    $$(".wizard-step").forEach((node, index) => node.classList.toggle("active", index === state.wizardStep));
    $("#wizard-back").disabled = state.wizardStep === 0;
    $("#wizard-next").textContent = state.wizardStep === 5 ? "Finish setup" : "Continue";
    $("#wizard-step-label").textContent = `Step ${state.wizardStep + 1} of 6`;
    $("#wizard-progress").style.width = `${((state.wizardStep + 1) / 6) * 100}%`;
    updateReadiness(Math.round(((state.wizardStep + 1) / 6) * 100));
  }

  function wizardStepValid() {
    const active = $(`.wizard-step[data-step="${state.wizardStep}"]`);
    const gates = $$("[data-gate]", active);
    if (gates.length && gates.some((box) => !box.checked)) {
      toast("Complete every safety gate before continuing.", "error");
      return false;
    }
    if (state.wizardStep === 2 && !$("#wizard-port").value) {
      toast("Select the connected ESP32 serial port.", "error");
      return false;
    }
    return true;
  }

  async function finishWizard() {
    if (!$("#save-wizard").checked) {
      toast("Confirm that the guided setup should be saved.", "error");
      return;
    }
    const firmwareMode = $('input[name="firmware-mode"]:checked').value;
    const changes = {
      port: $("#wizard-port").value,
      capture_format: firmwareMode === "passive_binary" ? "binary" : "ascii",
      usb_baudrate: firmwareMode === "passive_binary" ? 460800 : 115200,
      firmware: `${firmwareMode}-guided`,
      wizard_progress: { completed: true, completed_utc: new Date().toISOString() },
    };
    state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ values: changes }) });
    applySettings();
    toast("Guided setup saved.");
    navigate("capture");
  }

  function eventSeverity(event) {
    if (/failed|error|abort|overflow|break/.test(event.event)) return "error";
    if (/concern|warning|disconnect/.test(event.event)) return "warning";
    return "";
  }

  function eventMessage(event) {
    if (event.message) return event.message;
    const omitted = new Set(["sequence", "event", "utc", "monotonic_ns"]);
    const details = Object.entries(event).filter(([key]) => !omitted.has(key));
    return details.map(([key, val]) => `${key}=${typeof val === "object" ? JSON.stringify(val) : val}`).join(" ") || "event";
  }

  function appendConsole(consoleNode, event) {
    const line = document.createElement("div");
    line.className = `console-line ${eventSeverity(event)}`;
    const time = document.createElement("time");
    time.textContent = (event.utc || new Date().toISOString()).slice(11, 23);
    const name = document.createElement("strong");
    name.textContent = event.event || "log";
    const message = document.createElement("span");
    message.textContent = eventMessage(event);
    line.append(time, name, message);
    consoleNode.append(line);
    while (consoleNode.children.length > 1000) consoleNode.firstElementChild.remove();
  }

  function receiveEvent(event) {
    state.latestSequence = Math.max(state.latestSequence, Number(event.sequence || 0));
    state.events.push(event);
    if (state.events.length > 1000) state.events.shift();
    appendConsole($("#global-console"), event);
    appendConsole($("#capture-console"), event);
    if (event.event?.startsWith("firmware_")) appendConsole($("#firmware-console"), event);
    $("#log-count").textContent = String(state.events.length);
    if ($("#log-autoscroll").checked) scrollLogs();
    if (event.event === "capture_throughput") {
      const counts = event.counts || {};
      $("#capture-throughput").textContent = `Live stream: raw=${counts.raw_usb || 0} transport=${counts.transport_record || 0} hex=${counts.hex_bytes || 0}`;
    }
    if (event.event === "application_capture_finished") {
      $("#metric-session").textContent = event.session ? event.session.split(/[\\/]/).pop() : "Stopped";
      loadSessions();
    }
  }

  function scrollLogs() {
    $$(".console").forEach((node) => { node.scrollTop = node.scrollHeight; });
  }

  function connectEvents() {
    if (!token) {
      toast("Missing application token. Launch with ford-dcl-gui.", "error");
      return;
    }
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${location.host}/ws/events?token=${encodeURIComponent(token)}&sequence=${state.latestSequence}`;
    state.socket = new WebSocket(url);
    state.socket.onmessage = (message) => receiveEvent(JSON.parse(message.data));
    state.socket.onclose = () => setTimeout(connectEvents, 1200);
  }

  async function saveCaptureSettings() {
    const changes = {
      port: $("#capture-port").value,
      capture_format: $("#capture-format").value,
      usb_baudrate: Number($("#capture-baud").value),
      duration_seconds: Number($("#capture-duration").value),
      session_label: value("#capture-label"),
      dcl_baud: Number($("#capture-dcl-baud").value),
      ignition_state: $("#capture-ignition").value,
      engine_state: value("#capture-engine"),
    };
    state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ values: changes }) });
  }

  async function startCapture() {
    try {
      await saveCaptureSettings();
      const status = await api("/api/capture/start", { method: "POST", body: JSON.stringify({ overrides: {} }) });
      updateCaptureStatus(status);
      toast("Bounded receive-only capture started.");
    } catch (error) { toast(error.message, "error"); }
  }

  async function stopCapture() {
    try {
      const status = await api("/api/capture/stop", { method: "POST" });
      updateCaptureStatus(status);
      toast("Capture stop requested.");
    } catch (error) { toast(error.message, "error"); }
  }

  function updateCaptureStatus(status) {
    const running = Boolean(status.running);
    $("#capture-start").disabled = running;
    $("#capture-stop").disabled = !running;
    $("#capture-pill").textContent = running ? "Capture running" : "Capture idle";
    $("#capture-pill").className = `pill ${running ? "live" : "neutral"}`;
    const elapsed = Number(status.elapsed_seconds || 0);
    const duration = Number($("#capture-duration").value || state.settings.duration_seconds || 1);
    $("#capture-progress-bar").style.width = `${Math.min(100, (elapsed / duration) * 100)}%`;
    $("#capture-time").textContent = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(Math.floor(elapsed % 60)).padStart(2, "0")}`;
    $("#capture-state-text").textContent = status.last_error || (running ? "Preserving raw USB stream" : "Waiting to start");
    if (status.session) $("#metric-session").textContent = status.session.split(/[\\/]/).pop();
  }

  async function pollStatus() {
    try {
      const status = await api("/api/capture/status");
      updateCaptureStatus(status);
      const firmware = await api("/api/firmware/status");
      $("#platformio-status").textContent = firmware.platformio
        ? `PlatformIO ready: ${firmware.platformio}${firmware.running ? " — task running" : ""}`
        : "PlatformIO is not on PATH. Install PlatformIO Core to build or upload firmware.";
      $("#firmware-build").disabled = firmware.running;
      $("#firmware-upload").disabled = firmware.running;
    } catch (_) { /* launcher shutdown or transient refresh */ }
  }

  function renderJson(target, data) {
    const root = $(target);
    root.replaceChildren();
    const pre = document.createElement("pre");
    pre.textContent = JSON.stringify(data, null, 2);
    root.append(pre);
  }

  function appendList(root, title, items) {
    if (!items || !items.length) return;
    const heading = document.createElement("h4");
    heading.textContent = title;
    const list = document.createElement("ul");
    list.className = "list-block";
    items.forEach((item) => {
      const node = document.createElement("li");
      node.textContent = item;
      list.append(node);
    });
    root.append(heading, list);
  }

  function renderDiagnosis(data) {
    const root = $("#diagnosis-result");
    root.replaceChildren();
    const card = document.createElement("div");
    card.className = "result-card";
    const badge = document.createElement("span");
    badge.className = `evidence ${data.definitive ? "observed" : "inferred"}`;
    badge.textContent = data.branch || "decision";
    const conclusion = document.createElement("p");
    conclusion.textContent = data.conclusion || "";
    const definitive = document.createElement("p");
    definitive.textContent = `Definitive: ${Boolean(data.definitive)}`;
    card.append(badge, conclusion, definitive);
    root.append(card);
    appendList(root, "Missing evidence", data.missing_evidence);
    appendList(root, "Next checks", data.next_checks);
    appendList(root, "Supporting evidence", data.supporting_evidence);
  }

  function renderDtc(data) {
    const root = $("#dtc-result");
    root.replaceChildren();
    (data.codes || []).forEach((item) => {
      const card = document.createElement("div");
      card.className = "result-card";
      const badge = document.createElement("span");
      badge.className = `evidence ${item.known ? "reference" : "unknown"}`;
      badge.textContent = item.kind || "dtc";
      const title = document.createElement("strong");
      title.textContent = `${item.display_code || item.raw_hex} · ${item.source}`;
      const summary = document.createElement("p");
      summary.textContent = item.summary || "Unknown catalog entry.";
      card.append(badge, title, summary);
      root.append(card);
    });
    if (data.confidence_notice) {
      const note = document.createElement("p");
      note.textContent = data.confidence_notice;
      root.append(note);
    }
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function renderMarkdown(text) {
    const escaped = escapeHtml(text);
    const withCode = escaped.replace(/```([\s\S]*?)```/g, (_match, code) => `<pre>${code}</pre>`);
    return withCode
      .replace(/^### (.*)$/gm, "<h4>$1</h4>")
      .replace(/^## (.*)$/gm, "<h3>$1</h3>")
      .replace(/^# (.*)$/gm, "<h2>$1</h2>")
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/^\- (.*)$/gm, "<li>$1</li>")
      .replace(/(<li>.*<\/li>\n?)+/g, (block) => `<ul>${block}</ul>`)
      .replace(/\n{2,}/g, "<br><br>");
  }

  async function loadSessions() {
    try {
      const sessions = await api("/api/sessions");
      const list = $("#session-list");
      list.replaceChildren();
      if (!sessions.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No capture sessions in the configured directory.";
        list.append(empty);
        return;
      }
      sessions.forEach((session) => {
        const button = document.createElement("button");
        button.className = "session-item";
        const strong = document.createElement("strong");
        strong.textContent = session.session?.label || session.id;
        const small = document.createElement("small");
        small.textContent = `${session.created_utc || "unknown time"} · ${session.format || "unknown"} · ${session.id}`;
        button.append(strong, small);
        button.addEventListener("click", () => inspectSession(session.id));
        list.append(button);
      });
    } catch (error) { toast(error.message, "error"); }
  }

  async function inspectSession(id) {
    $("#inspection-result").innerHTML = '<div class="empty"><div class="loader-ring"></div></div>';
    try { renderJson("#inspection-result", await api(`/api/sessions/${encodeURIComponent(id)}/inspect`)); }
    catch (error) { toast(error.message, "error"); }
  }

  async function analyzePayload(kind) {
    try {
      const result = await api(`/api/analyze/${kind}`, { method: "POST", body: JSON.stringify({ payload_hex: value("#payload-hex") }) });
      renderJson("#payload-result", result);
    } catch (error) { toast(error.message, "error"); }
  }

  async function lookupDTC() {
    const codes = value("#dtc-codes").split(/[\s,]+/).filter(Boolean);
    try {
      renderDtc(await api("/api/analyze/dtc", { method: "POST", body: JSON.stringify({ codes, source: $("#dtc-source").value }) }));
    } catch (error) { toast(error.message, "error"); }
  }

  async function diagnose() {
    const tps = $("#diag-tps").value;
    const request = {
      rpm: numberOrNull("#diag-rpm"),
      ect_deg_c: numberOrNull("#diag-ect"),
      tps_closed: tps === "" ? null : tps === "true",
      iac_percent: numberOrNull("#diag-iac"),
      airflow_isolation: $("#diag-airflow").value,
      mixture: $("#diag-mixture").value,
      repeated_sessions: Number($("#diag-repeats").value || 0),
      source_capture_ids: value("#diag-captures").split(",").map((item) => item.trim()).filter(Boolean),
    };
    try { renderDiagnosis(await api("/api/diagnose", { method: "POST", body: JSON.stringify(request) })); }
    catch (error) { toast(error.message, "error"); }
  }

  async function runFirmware(action) {
    const sketch = $("#firmware-sketch").value;
    const request = {
      sketch,
      action,
      port: $("#firmware-port").value || null,
      confirmation: action === "upload" && $("#firmware-confirm").checked ? "FLASH_RECEIVE_ONLY_FIRMWARE" : null,
    };
    try {
      await api("/api/firmware/run", { method: "POST", body: JSON.stringify(request) });
      toast(`Firmware ${action} started.`);
    } catch (error) { toast(error.message, "error"); }
  }

  async function loadGuide(id, button) {
    try {
      const guide = await api(`/api/guides/${encodeURIComponent(id)}`);
      $("#guide-title").textContent = guide.title;
      $("#guide-content").innerHTML = renderMarkdown(guide.markdown);
      $$("#guide-list button").forEach((node) => node.classList.toggle("active", node === button));
    } catch (error) { toast(error.message, "error"); }
  }

  function buildGuideList(guides) {
    const list = $("#guide-list");
    list.replaceChildren();
    guides.forEach((guide) => {
      const button = document.createElement("button");
      button.textContent = guide.title;
      button.addEventListener("click", () => loadGuide(guide.id, button));
      list.append(button);
    });
  }

  async function saveSettings() {
    const values = {};
    $$("[data-setting]").forEach((input) => {
      const key = input.dataset.setting;
      if (input.type === "checkbox") values[key] = input.checked;
      else if (input.type === "number") values[key] = Number(input.value);
      else values[key] = input.value;
    });
    try {
      state.settings = await api("/api/settings", { method: "PUT", body: JSON.stringify({ values }) });
      applySettings();
      toast("Settings saved.");
    } catch (error) { toast(error.message, "error"); }
  }

  function bindEvents() {
    $("#nav").addEventListener("click", (event) => {
      const button = event.target.closest("[data-page]");
      if (button) navigate(button.dataset.page);
    });
    $$("[data-open-page]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.openPage)));
    $("#refresh-ports").addEventListener("click", () => refreshPorts().catch((error) => toast(error.message, "error")));
    $("#wizard-port").addEventListener("change", refreshPorts);
    $("#wizard-back").addEventListener("click", () => { state.wizardStep--; updateWizard(); });
    $("#wizard-next").addEventListener("click", () => {
      if (!wizardStepValid()) return;
      if (state.wizardStep === 5) finishWizard();
      else { state.wizardStep++; updateWizard(); }
    });
    $("#capture-format").addEventListener("change", () => {
      const binary = $("#capture-format").value === "binary";
      $("#capture-baud").value = binary ? "460800" : "115200";
    });
    $("#capture-start").addEventListener("click", startCapture);
    $("#capture-stop").addEventListener("click", stopCapture);
    $("#abort-button").addEventListener("click", async () => {
      await Promise.allSettled([api("/api/capture/stop", { method: "POST" }), api("/api/firmware/cancel", { method: "POST" })]);
      try { await api("/api/capture/marker", { method: "POST", body: JSON.stringify({ label: "ABORT", detail: "Operator pressed global STOP / ABORT" }) }); } catch (_) {}
      toast("Stop requested. Restore wiring and vehicle state.", "error");
    });
    $$("[data-marker]").forEach((button) => button.addEventListener("click", async () => {
      try {
        await api("/api/capture/marker", { method: "POST", body: JSON.stringify({ label: button.dataset.marker }) });
        toast(`Marker: ${button.dataset.marker}`);
      } catch (error) { toast(error.message, "error"); }
    }));
    $$("[data-clear-log]").forEach((button) => button.addEventListener("click", () => {
      state.events = [];
      $$(".console").forEach((node) => node.replaceChildren());
      $("#log-count").textContent = "0";
    }));
    $("#refresh-sessions").addEventListener("click", loadSessions);
    $("#decode-payload").addEventListener("click", () => analyzePayload("decode"));
    $("#frame-payload").addEventListener("click", () => analyzePayload("frame"));
    $("#lookup-dtc").addEventListener("click", lookupDTC);
    $("#run-diagnosis").addEventListener("click", diagnose);
    $("#firmware-build").addEventListener("click", () => runFirmware("build"));
    $("#firmware-upload").addEventListener("click", () => runFirmware("upload"));
    $("#firmware-cancel").addEventListener("click", () => api("/api/firmware/cancel", { method: "POST" }).catch((error) => toast(error.message, "error")));
    $("#save-settings").addEventListener("click", saveSettings);
  }

  async function initialize() {
    bindEvents();
    try {
      state.bootstrap = await api("/api/bootstrap");
      state.settings = state.bootstrap.settings;
      state.ports = state.bootstrap.ports;
      renderPorts();
      applySettings();
      buildGuideList(state.bootstrap.guides);
      updateWizard();
      updateCaptureStatus(state.bootstrap.capture);
      connectEvents();
      await loadSessions();
      state.captureTimer = setInterval(pollStatus, 700);
      if (state.bootstrap.serial_access && !state.bootstrap.serial_access.ok) {
        toast(state.bootstrap.serial_access.hint, "error");
      }
    } catch (error) {
      toast(error.message, "error");
      $("#loading strong").textContent = "Application initialization failed";
      $("#loading span").textContent = error.message;
      return;
    }
    setTimeout(() => $("#loading").classList.add("hidden"), 250);
  }

  initialize();
})();
