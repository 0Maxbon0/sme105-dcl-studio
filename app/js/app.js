import { BleTransport, bluetoothAvailable } from "./ble.js";
import { createController } from "./controller.js";
import { APP_VERSION, createLineBuffer } from "./protocol.js";
import { createMockTransport, createReplay } from "./mock-transport.js";
import { STR } from "./strings.js";
import { createRecording, listRecordings, recordingBlob } from "./recording.js";
import { applyStaticStrings, confirmDialog, exportCsv, exportLog, render, showView } from "./ui.js";

const DEMO_FILES = {
  "0E": "./demo/read-0e.txt",
  KOEO: "./demo/koeo.txt",
  LIVE: "./demo/live-engine-off.txt",
};

const buffer = createLineBuffer();
let transport = null;

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
  onError(error) { controller.state.message = error?.message || String(error); },
});

function demoEnabled() {
  return document.getElementById("demo-toggle").checked;
}

function demoKey() {
  return document.getElementById("demo-capture").value;
}

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

async function connect() {
  const button = document.getElementById("connect-btn");
  button.disabled = true;
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
      controller.onConnected("SME105-DCL demo");
      return;
    }
    if (!window.isSecureContext) throw new Error(STR.secureWarning);
    transport = ble;
    const device = await ble.connect();
    controller.onConnected(device.name || "SME105");
  } catch (error) {
    controller.state.message = error?.message || String(error);
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
  if (controller.state.phase !== "idle") return;
  const result = await action();
  if (result && result.ok === false) controller.state.message = result.error;
  render(controller.state);
}

function selectedLive() {
  if (document.getElementById("set-all-live").checked) return "ALL";
  if (document.getElementById("set-live3").checked) return "LIVE3";
  if (document.getElementById("set-live2").checked) return "LIVE2";
  return "LIVE";
}

async function startLive() {
  const variant = selectedLive();
  try {
    const archive = await createRecording(variant, error => controller.failRecording(`Recording stopped: ${error.message}`));
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
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `eec-iv-${id.slice(0,19).replaceAll(":", "-")}.${kind === "csv" ? "csv" : "txt"}`;
    link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  } catch (error) {
    document.getElementById("recording-status").textContent = `Export failed: ${error.message}`;
  }
}

function wire() {
  applyStaticStrings();
  document.getElementById("about-version").textContent = APP_VERSION;
  document.getElementById("secure-warning").hidden = window.isSecureContext;
  document.getElementById("bt-warning").hidden = bluetoothAvailable() || demoEnabled();
  const storedDemo = readStorage("eeciv-demo") === "1";
  const storedCapture = readStorage("eeciv-demo-capture");
  document.getElementById("manual-gearbox").checked = readStorage("eeciv-manual-gearbox") !== "0";
  const storedMode = readStorage("eeciv-stored-code-mode");
  if (storedMode === "0E" || storedMode === "A4") document.getElementById("stored-code-mode").value = storedMode;
  document.getElementById("stored-code-mode").addEventListener("change", (event) => {
    writeStorage("eeciv-stored-code-mode", event.target.value);
  });
  document.getElementById("manual-gearbox").addEventListener("change", (event) => {
    writeStorage("eeciv-manual-gearbox", event.target.checked ? "1" : "0");
    render(controller.state);
  });
  document.getElementById("idle-check").addEventListener("change", () => render(controller.state));
  if (storedDemo) document.getElementById("demo-toggle").checked = true;
  if (storedCapture) document.getElementById("demo-capture").value = storedCapture;
  document.getElementById("bt-warning").hidden = bluetoothAvailable() || demoEnabled();

  document.querySelectorAll("nav button").forEach((button) => {
    button.addEventListener("click", () => {
      showView(button.dataset.view);
      render(controller.state);
    });
  });
  document.getElementById("connect-btn").addEventListener("click", () => { connect(); });
  document.getElementById("stop-btn").addEventListener("click", () => controller.requestStop());
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
  let dirty = true;
  let lastPaint = 0;
  controller.subscribe(() => { dirty = true; });
  const paint = (timestamp) => {
    if (dirty && timestamp - lastPaint >= 100) {
      lastPaint = timestamp;
      dirty = false;
      render(controller.state);
    }
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
  setInterval(() => controller.tick(), 250);
  setInterval(() => { if (controller.state.combined || controller.state.op?.kind === "live") dirty = true; }, 1000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  showView("connect");
  render(controller.state);
}

wire();
