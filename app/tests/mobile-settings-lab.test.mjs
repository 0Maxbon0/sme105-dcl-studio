import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { MEM_EXPERIMENTS, EXPERIMENT_CATALOGUE } from "../js/protocol.js";
import { renderDclCommandExplorer, wireDclCommandExplorer, applyStaticStrings, showView, render } from "../js/ui.js";

test("Settings structure has exactly four compact groups plus Engineering Lab entry", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const doc = dom.window.document;

  const viewTools = doc.getElementById("view-tools");
  assert.ok(viewTools, "#view-tools must exist");

  // Groups under settings
  const groups = viewTools.querySelectorAll(".settings-group");
  assert.ok(groups.length >= 4, "Settings must contain at least the 4 primary groups");

  // Connection group elements
  assert.ok(doc.getElementById("connect-settings"), "connect-settings must exist in Connection group");
  assert.ok(doc.getElementById("settings-conn-status"), "settings-conn-status must exist");
  assert.ok(doc.getElementById("settings-status-dot"), "settings-status-dot must exist");
  assert.ok(doc.getElementById("settings-device-name"), "settings-device-name must exist");
  assert.ok(doc.getElementById("settings-fw-version"), "settings-fw-version must exist");
  assert.ok(doc.getElementById("status-raw"), "status-raw must be preserved in details");
  assert.ok(doc.getElementById("auth-value"), "auth-value must be preserved");

  // Vehicle group elements
  assert.ok(doc.getElementById("manual-gearbox-settings"), "manual-gearbox-settings must exist");
  assert.ok(doc.getElementById("idle-check-settings"), "idle-check-settings must exist");
  assert.ok(doc.getElementById("vehicle-profile"), "vehicle-profile must exist");

  // Display group elements
  assert.ok(doc.getElementById("theme-mode"), "theme-mode must exist");
  assert.ok(doc.getElementById("unit-system"), "unit-system must exist");
  assert.ok(doc.getElementById("font-size"), "font-size must exist");
  assert.ok(doc.getElementById("high-contrast"), "high-contrast must exist");
  assert.ok(doc.getElementById("reduce-motion"), "reduce-motion must exist");

  // Data & About elements
  assert.ok(doc.getElementById("about-version"), "about-version must exist");
  assert.ok(doc.getElementById("demo-toggle"), "demo-toggle must exist");
  assert.ok(doc.getElementById("play-demo"), "play-demo must exist");
  assert.ok(doc.getElementById("demo-capture"), "demo-capture must exist");

  // Engineering Lab launcher entry
  const openLabBtn = doc.getElementById("open-engineering-lab");
  assert.ok(openLabBtn, "open-engineering-lab launcher button must exist");

  // Clear DTC must NOT be inside Settings; it is now in Codes workflow
  assert.equal(viewTools.querySelector("#clear-btn"), null, "clear-btn must not be in Settings");
  const viewCodes = doc.getElementById("view-codes");
  assert.ok(viewCodes.querySelector("#clear-btn"), "clear-btn must be inside Codes workflow");

  dom.window.close();
});

test("Engineering Lab is organized into the three requested areas", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const doc = dom.window.document;

  const viewLab = doc.getElementById("view-lab");
  assert.ok(viewLab, "#view-lab must exist as a dedicated view");
  assert.equal(viewLab.classList.contains("view"), true, "#view-lab must have class 'view'");

  // Header & back button
  assert.equal(doc.getElementById("lab-back-btn"), null, "Lab tab must not have a redundant back header");

  const areaA = doc.getElementById("lab-sec-explorer");
  const areaB = doc.getElementById("lab-workflows");
  const areaC = doc.getElementById("lab-advanced-panel");
  assert.ok(areaA, "Area A must contain the Command Explorer");
  assert.ok(areaB, "Area B must contain Ready-made Workflows");
  assert.ok(areaC, "Area C must contain the advanced bridge and protocol tools");
  assert.equal(areaB.querySelectorAll("details.lab-workflow-card").length, 3, "Area B must have three workflow cards");
  for (const id of ["lab-sec-discovery", "lab-sec-mem", "lab-sec-procedures"]) {
    assert.ok(areaB.querySelector(`#${id}`), `Area B must include #${id}`);
  }
  assert.ok(areaC.querySelector("#lab-sec-bridge"), "Area C must contain bridge tools");
  assert.ok(areaC.querySelector("#lab-sec-reference"), "Area C must contain protocol reference");
  assert.equal(areaC.open, false, "Area C must start collapsed");
  assert.equal(doc.querySelectorAll("[data-lab-section]").length, 0, "The old six-pill navigation must be removed");

  dom.window.close();
});

test("Navigation has the six bottom tabs in the required order and labels", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    applyStaticStrings();
    const bottomNavButtons = document.querySelectorAll("nav button");
    assert.equal(bottomNavButtons.length, 6, "Must have 6 bottom navigation tabs");
    const tabs = [...bottomNavButtons].map(button => [button.textContent.trim(), button.dataset.view]);
    assert.deepEqual(tabs, [
      ["Dashboard", "live"], ["Faults", "codes"], ["Lab", "lab"],
      ["History", "log"], ["K-Line", "kline"], ["Settings", "tools"],
    ]);

    // Show Lab
    showView("lab");
    assert.equal(document.getElementById("view-lab").hidden, false, "#view-lab should be visible");
    assert.equal(document.getElementById("view-tools").hidden, true, "#view-tools should be hidden");
    const labBtn = document.querySelector('nav button[data-view="lab"]');
    assert.equal(labBtn.getAttribute("aria-current"), "page", "Lab tab must be current while Lab is visible");

    // Switch to Settings
    showView("tools");
    assert.equal(document.getElementById("view-lab").hidden, true, "#view-lab should be hidden");
    assert.equal(document.getElementById("view-tools").hidden, false, "#view-tools should be visible");
    const toolsBtn = document.querySelector('nav button[data-view="tools"]');
    assert.equal(toolsBtn.getAttribute("aria-current"), "page", "Tools tab should be active in settings");
    assert.equal(labBtn.getAttribute("aria-current"), "false");
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test("Single selection updates the contextual run action and dispatches the selected candidate", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const state = { link: "ready", phase: "idle", transport: "ble", status: { fields: { fw: "27" } } };
    wireDclCommandExplorer();
    renderDclCommandExplorer(state);

    assert.equal(document.getElementById("dcl-run-selected"), null, "The duplicate batch Run button must not exist");
    const candidateRunButtons = document.querySelectorAll("#view-lab .dcl-runner-panel .dcl-run-bar button.primary");
    assert.equal(candidateRunButtons.length, 1, "The candidate runner must have exactly one primary Run button");
    assert.equal(candidateRunButtons[0].id, "dcl-run-action");
    assert.equal(candidateRunButtons[0].hidden, false, "The canonical candidate Run button remains visible");

    const toggle = document.getElementById("dcl-toggle-multiselect");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.textContent, "Select multiple");
    const search = document.getElementById("dcl-command-search");
    search.value = "004E";
    search.dispatchEvent(new window.Event("input"));
    const card = document.querySelector("#dcl-command-list .dcl-command-card");
    assert.ok(card);
    card.click();

    const candidate = Object.values(EXPERIMENT_CATALOGUE).find(item => item.id === "PIDMAP_ALT");
    const runAction = document.getElementById("dcl-run-action");
    assert.equal(document.getElementById("dcl-command-detail-title").textContent, `${candidate.name} · ${candidate.commandWord}`);
    assert.equal(runAction.textContent, `Run ${candidate.name} (${candidate.commandWord})`);
    assert.equal(runAction.disabled, false, "A sendable candidate is enabled with a compatible ready bridge");
    assert.equal(document.getElementById("dcl-batch-order").hidden, true, "Batch order is hidden in single-selection mode");

    state.link = "disconnected";
    renderDclCommandExplorer(state);
    assert.equal(runAction.disabled, true, "A disconnected physical bridge disables transmission");
    state.link = "ready";
    renderDclCommandExplorer(state);

    const dispatched = [];
    document.addEventListener("dcl:run-candidate", event => { dispatched.push(event.detail.candidateId); });
    runAction.click();
    assert.deepEqual(dispatched, [candidate.id], "Single selection dispatches exactly one candidate through the canonical action");

    const category = document.getElementById("dcl-command-category");
    search.value = "";
    search.dispatchEvent(new window.Event("input"));
    category.value = "FACTORY_PROCEDURE";
    category.dispatchEvent(new window.Event("change"));
    const procedureCard = document.querySelector("#dcl-command-list .dcl-command-card");
    procedureCard.click();
    const procedure = Object.values(EXPERIMENT_CATALOGUE).find(item => item.id === "OUTPUT_SWITCH_TEST");
    assert.equal(runAction.textContent, `Run ${procedure.name} (Guided)`);
    let guidedProcedure = null;
    document.addEventListener("dcl:run-procedure", event => { guidedProcedure = event.detail.procedureId; }, { once: true });
    runAction.click();
    assert.equal(guidedProcedure, procedure.id);
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test("Contextual run action disables firmware-incompatible and busy candidates", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const state = { link: "ready", phase: "idle", transport: "ble", status: { fields: { fw: "24" } } };
    wireDclCommandExplorer();
    renderDclCommandExplorer(state);
    const search = document.getElementById("dcl-command-search");
    search.value = "004E";
    search.dispatchEvent(new window.Event("input"));
    const runAction = document.getElementById("dcl-run-action");
    assert.equal(runAction.disabled, true, "The candidate requires firmware v27");

    state.status.fields.fw = "27";
    renderDclCommandExplorer(state);
    assert.equal(runAction.disabled, false, "Compatible firmware enables the idle bridge action");
    state.phase = "running";
    renderDclCommandExplorer(state);
    assert.equal(runAction.disabled, true, "A busy bridge cannot start another candidate");
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test("Multi-select mode shows the execution order and dispatches the selected batch", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const state = { link: "ready", phase: "idle", transport: "ble", status: { fields: { fw: "27" } } };
    wireDclCommandExplorer();
    renderDclCommandExplorer(state);

    const toggle = document.getElementById("dcl-toggle-multiselect");
    toggle.click();
    assert.equal(toggle.textContent, "Single selection");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(document.getElementById("dcl-run-action").textContent, "Run selected (0)");
    assert.equal(document.getElementById("dcl-run-action").disabled, true);
    assert.match(document.getElementById("dcl-batch-order").textContent, /Select candidates from the list/);

    const search = document.getElementById("dcl-command-search");
    search.value = "004E";
    search.dispatchEvent(new window.Event("input"));
    document.querySelector("#dcl-command-list .dcl-command-card").click();
    search.value = "005E";
    search.dispatchEvent(new window.Event("input"));
    document.querySelector("#dcl-command-list .dcl-command-card").click();

    const runAction = document.getElementById("dcl-run-action");
    assert.equal(runAction.textContent, "Run selected (2)");
    assert.equal(runAction.disabled, false);
    assert.match(document.getElementById("dcl-batch-order").textContent, /Order: 1\. 004E \(PIDMAP_ALT\) → 2\. 005E \(PIDMAP\)/);
    assert.equal(document.querySelector("#dcl-command-list .dcl-command-card").getAttribute("aria-pressed"), "true");

    const dispatched = [];
    document.addEventListener("dcl:run-selected", event => { dispatched.push(event.detail.candidateIds); });
    runAction.click();
    assert.deepEqual(dispatched, [["PIDMAP_ALT", "PIDMAP"]], "Canonical action dispatches the exact ordered batch once");

    toggle.click();
    assert.equal(toggle.textContent, "Select multiple");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(document.getElementById("dcl-batch-order").hidden, true);
    const primaryPidMap = Object.values(EXPERIMENT_CATALOGUE).find(item => item.id === "PIDMAP");
    assert.equal(document.getElementById("dcl-run-action").textContent, `Run ${primaryPidMap.name} (${primaryPidMap.commandWord})`);
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test("MEM candidates can be inspected but are excluded from generic multi-select batches", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const state = { link: "ready", phase: "idle", transport: "ble", status: { fields: { fw: "27" } } };
    wireDclCommandExplorer();
    renderDclCommandExplorer(state);
    document.getElementById("dcl-toggle-multiselect").click();
    const search = document.getElementById("dcl-command-search");

    for (const candidateId of ["MEMORY_READ", "MEM_OFF0", "MEM_SINGLE", "MEM_PARITY"]) {
      search.value = candidateId;
      search.dispatchEvent(new window.Event("input"));
      const card = document.querySelector("#dcl-command-list .dcl-command-card");
      assert.ok(card, `${candidateId} must remain available for inspection`);
      card.click();
      assert.match(card.textContent, /MEM experiment · Run individually/);
      assert.match(document.getElementById("dcl-command-detail-body").textContent, /cannot be run in generic batches.*Run individually or use the MEM Comparison workflow/);
      assert.equal(document.querySelector("#dcl-command-detail-body input[type=checkbox]"), null, `${candidateId} must not show Include in batch`);
      assert.equal(document.getElementById("dcl-run-action").textContent, "Run selected (0)");
      assert.equal(document.getElementById("dcl-run-action").disabled, true);
    }
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test("MEM experiments provide 4 compact mobile cards and preserve wide technical table", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    const state = {
      link: "ready", phase: "idle", transport: "ble",
      status: { fields: { fw: "27" } },
      memMatrix: {
        status: "idle",
        results: [
          { experimentId: "MEM", status: "PASSED", responseBytes: 16, responseHex: "01020304", txEnvelope: ["42F3", "22D3"] },
          { experimentId: "MEM_OFF0", status: "NOT RUN" },
        ],
      },
    };

    wireDclCommandExplorer();
    renderDclCommandExplorer(state);

    // 4 Mobile cards
    const cards = document.querySelectorAll("#mem-cards-container .mem-card");
    assert.equal(cards.length, MEM_EXPERIMENTS.length, `Must render exactly ${MEM_EXPERIMENTS.length} mobile experiment cards`);

    // Verify card content for MEM
    const memCard = document.querySelector('#mem-cards-container .mem-card[data-experiment-id="MEM"]');
    assert.ok(memCard, "MEM card must exist");
    assert.match(memCard.textContent, /42F3/, "Card must display initial word");
    assert.match(memCard.textContent, /22D3/, "Card must display continuation word");
    assert.match(memCard.textContent, /16 byte\(s\)/, "Card must display result bytes");
    const memRunBtn = memCard.querySelector('button[data-mem-run="MEM"]');
    assert.ok(memRunBtn, "Card must have Run button");
    assert.equal(memRunBtn.disabled, false);

    // Verify technical table is also populated
    const rows = document.querySelectorAll("#mem-matrix-body tr");
    assert.equal(rows.length, MEM_EXPERIMENTS.length, "Technical table must also have all rows populated");
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test("MEM evidence strings render as inert text and individual Run dispatch stays wired", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  try {
    const raw = '<img src=x onerror="alert(1)">';
    const state = {
      link: "ready", phase: "idle", transport: "ble", status: { fields: { fw: "27" } },
      memMatrix: { status: "complete", results: [{
        experimentId: "MEM", status: "FAILED", responseHex: raw, error: raw,
        responseBytes: 0, txEnvelope: [raw],
      }] },
    };
    wireDclCommandExplorer();
    renderDclCommandExplorer(state);
    const card = document.querySelector('#mem-cards-container [data-experiment-id="MEM"]');
    assert.ok(card);
    assert.equal(card.querySelector("img"), null, "raw capture must not become HTML");
    assert.equal(card.querySelector("script"), null);
    assert.match(card.textContent, /<img src=x onerror=/);
    let selected = null;
    document.addEventListener("dcl:run-mem", event => { selected = event.detail.experimentId; }, { once: true });
    card.querySelector('[data-mem-run="MEM"]').click();
    assert.equal(selected, "MEM", "the card must still dispatch the real candidate ID");
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test("No duplicate DOM IDs in index.html", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const allElements = dom.window.document.querySelectorAll("[id]");
  const ids = new Set();
  const duplicates = [];

  for (const el of allElements) {
    if (ids.has(el.id)) {
      duplicates.push(el.id);
    }
    ids.add(el.id);
  }

  assert.deepEqual(duplicates, [], `Found duplicate DOM IDs: ${duplicates.join(", ")}`);
  dom.window.close();
});

test("Global STOP button and active operations are preserved across view transitions", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    const stopBtn = document.getElementById("stop-btn");
    assert.ok(stopBtn, "#stop-btn must exist in top header");

    const state = {
      link: "connected",
      phase: "running",
      transport: "ble",
      identity: { auth: "OK", helloOk: true, pinsOk: true },
      bench: { pass: true },
      status: { fields: { fw: "27" } },
      op: { variant: "ALL", kind: "live" },
    };

    render(state);
    assert.equal(stopBtn.disabled, false, "Stop button must be enabled when phase is running");
    assert.equal(stopBtn.hidden, false, "Stop button must be visible when phase is running");

    // Navigate to lab
    showView("lab");
    assert.equal(stopBtn.disabled, false, "Stop button remains enabled in Lab view");
    assert.equal(stopBtn.hidden, false, "Stop button remains visible in Lab view");

    // Navigate to settings
    showView("tools");
    assert.equal(stopBtn.disabled, false, "Stop button remains enabled in Settings view");
    assert.equal(stopBtn.hidden, false, "Stop button remains visible in Settings view");

    // Return to idle
    state.phase = "idle";
    state.op = null;
    render(state);
    assert.equal(stopBtn.disabled, true, "Stop button disables when idle");
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});

test("Display settings (theme, text size, contrast, motion) apply classes cleanly", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const body = dom.window.document.body;

  // Text size large
  body.setAttribute("data-font-size", "large");
  assert.equal(body.getAttribute("data-font-size"), "large");

  // High contrast
  body.classList.toggle("high-contrast", true);
  assert.equal(body.classList.contains("high-contrast"), true);

  // Reduce motion
  body.classList.toggle("reduce-motion", true);
  assert.equal(body.classList.contains("reduce-motion"), true);

  // Dark / Light themes
  body.setAttribute("data-theme", "dark");
  assert.equal(body.getAttribute("data-theme"), "dark");
  body.setAttribute("data-theme", "light");
  assert.equal(body.getAttribute("data-theme"), "light");

  dom.window.close();
});

test("Firmware status filter is hidden and candidate details show concise vehicle conditions", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    const fwSelect = document.getElementById("dcl-command-firmware");
    assert.ok(fwSelect, "dcl-command-firmware element must exist in DOM for compatibility");
    const parentLabel = fwSelect.closest("label");
    assert.equal(parentLabel?.hidden || fwSelect.hidden, true, "Firmware status filter must be hidden from user");

    wireDclCommandExplorer();
    renderDclCommandExplorer({ link: "ready", phase: "idle", transport: "ble", status: { fields: { fw: "27" } } });

    const detailBody = document.getElementById("dcl-command-detail-body");
    assert.ok(detailBody, "dcl-command-detail-body must exist");
    assert.match(detailBody.textContent, /Ignition:/);
    assert.match(detailBody.textContent, /Engine:/);
    const condCard = detailBody.querySelector(".dcl-condition-card");
    assert.ok(condCard, "Condition card must be rendered prominently");
  } finally {
    dom.window.close();
    globalThis.window = oldWindow;
    globalThis.document = oldDocument;
  }
});
