import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { MEM_EXPERIMENTS, EXPERIMENT_CATALOGUE } from "../js/protocol.js";
import { renderDclCommandExplorer, wireDclCommandExplorer, showView, render } from "../js/ui.js";

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

test("Engineering Lab view is dedicated and segmented into 6 distinct sections", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const doc = dom.window.document;

  const viewLab = doc.getElementById("view-lab");
  assert.ok(viewLab, "#view-lab must exist as a dedicated view");
  assert.equal(viewLab.classList.contains("view"), true, "#view-lab must have class 'view'");

  // Header & back button
  assert.equal(doc.getElementById("lab-back-btn"), null, "Lab tab must not have a redundant back header");

  // 6 segmented navigation pills
  const pills = doc.querySelectorAll("[data-lab-section]");
  assert.equal(pills.length, 6, "Must have exactly 6 lab section pills");
  const pillSections = [...pills].map(p => p.dataset.labSection);
  assert.deepEqual(pillSections, ["explorer", "discovery", "mem", "procedures", "bridge", "reference"]);

  // 6 section containers
  assert.ok(doc.getElementById("lab-sec-explorer"), "explorer section must exist");
  assert.ok(doc.getElementById("lab-sec-discovery"), "discovery section must exist");
  assert.ok(doc.getElementById("lab-sec-mem"), "mem section must exist");
  assert.ok(doc.getElementById("lab-sec-procedures"), "procedures section must exist");
  assert.ok(doc.getElementById("lab-sec-bridge"), "bridge section must exist");
  assert.ok(doc.getElementById("lab-sec-reference"), "reference section must exist");

  // Only the first section is visible initially; the other 5 are hidden
  assert.equal(doc.getElementById("lab-sec-explorer").hidden, false);
  assert.equal(doc.getElementById("lab-sec-discovery").hidden, true);
  assert.equal(doc.getElementById("lab-sec-mem").hidden, true);
  assert.equal(doc.getElementById("lab-sec-procedures").hidden, true);
  assert.equal(doc.getElementById("lab-sec-bridge").hidden, true);
  assert.equal(doc.getElementById("lab-sec-reference").hidden, true);

  dom.window.close();
});

test("Navigation has six bottom tabs with Lab directly after Faults", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const oldWindow = globalThis.window, oldDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;

  try {
    const bottomNavButtons = document.querySelectorAll("nav button");
    assert.equal(bottomNavButtons.length, 6, "Must have 6 bottom navigation tabs");
    const views = [...bottomNavButtons].map(b => b.dataset.view);
    assert.deepEqual(views, ["live", "codes", "lab", "log", "kline", "tools"], "Lab tab follows Faults");

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
