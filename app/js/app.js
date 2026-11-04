import { BleTransport, bluetoothAvailable } from "./ble.js";
import { createController } from "./controller.js";
import { APP_VERSION, createLineBuffer } from "./protocol.js";
import { createMockTransport, createReplay } from "./mock-transport.js";
import { STR } from "./strings.js";
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
  const result = action();
  if (result && result.ok === false) controller.state.message = result.error;
  render(controller.state);
}

function selectedLive() {
  if (document.getElementById("set-live3").checked) return "LIVE3";
  if (document.getElementById("set-live2").checked) return "LIVE2";
  return "LIVE";
}

function wire() {
  applyStaticStrings();
  document.getElementById("about-version").textContent = APP_VERSION;
  document.getElementById("secure-warning").hidden = window.isSecureContext;
  document.getElementById("bt-warning").hidden = bluetoothAvailable() || demoEnabled();
  const storedDemo = readStorage("eeciv-demo") === "1";
  const storedCapture = readStorage("eeciv-demo-capture");
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
  document.getElementById("read-codes-btn").addEventListener("click", () => ask(
    STR.confirmStoredTitle, STR.confirmStoredBody, () => controller.requestVehicle("0E"),
  ));
  document.getElementById("koeo-btn").addEventListener("click", () => ask(
    STR.confirmKoeoTitle, STR.confirmKoeoBody, () => controller.requestVehicle("KOEO"),
  ));
  document.getElementById("koer-btn").addEventListener("click", () => ask(
    STR.confirmKoerTitle, STR.confirmKoerBody, () => controller.requestVehicle("KOER"),
  ));
  document.getElementById("live-start").addEventListener("click", () => ask(
    STR.confirmLiveTitle, STR.confirmLiveBody, () => controller.requestVehicle(selectedLive()),
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
  document.getElementById("export-btn").addEventListener("click", () => exportLog(controller.state));
  document.getElementById("csv-btn").addEventListener("click", () => exportCsv(controller.state));
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
  controller.subscribe(() => { dirty = true; });
  const paint = () => {
    if (dirty) {
      dirty = false;
      render(controller.state);
    }
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
  setInterval(() => controller.tick(), 250);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  showView("connect");
  render(controller.state);
}

wire();
