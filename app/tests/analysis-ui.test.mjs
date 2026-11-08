import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { dclVParityByte } from "../js/protocol.js";
import { classifyCycles, initAnalysisUI } from "../js/analysis-ui.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function rx(t, byte) {
  return `RX t_us=${t >>> 0} byte=${byte.toString(16).padStart(2, "0").toUpperCase()}`;
}

function recordingTranscript({ counterOffset = 0, selfTest = false, framePeriodMs = 42, frameSpacingUs = 42500, counterValues = [0x10, 0x20, 0x30] } = {}) {
  const frameCount = counterValues.length * 16;
  const spacingAt = index => Array.isArray(frameSpacingUs)
    ? frameSpacingUs[index] ?? frameSpacingUs.at(-1)
    : frameSpacingUs;
  const durationMs = Math.round(Array.from({ length: frameCount }, (_, index) => spacingAt(index)).reduce((sum, spacing) => sum + spacing, 0) / 1000);
  const lines = [`framePeriodMs=${framePeriodMs} frameCount=${frameCount} durationMs=${durationMs} parity=valid parityErrors=0`];
  let time = 1000;
  for (let cycle = 0; cycle < counterValues.length; cycle += 1) {
    for (let frameId = 0; frameId < 16; frameId += 1) {
      const value = frameId === 0 && selfTest ? 0x11
        : frameId === 14 ? (counterValues[cycle] + counterOffset) & 0xff
          : 0x22;
      const parity = frameId === 0 && selfTest ? dclVParityByte(value, 1) : dclVParityByte(value, frameId);
      lines.push(rx(time, 0), rx(time + 1040, 0), rx(time + 2500, 0), rx(time + 3540, dclVParityByte(0, frameId)));
      lines.push(rx(time + 7000, value), rx(time + 8040, parity));
      time += spacingAt(cycle * 16 + frameId);
    }
  }
  return lines.join("\n");
}

function setupDom() {
  const dom = new JSDOM(html, { url: "https://dcl-studio.test/" });
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  const downloads = [];
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  return {
    dom,
    document: dom.window.document,
    downloads,
    restore() {
      dom.window.close();
      globalThis.window = priorWindow;
      globalThis.document = priorDocument;
    },
  };
}

function mockStore() {
  const recordings = [
    { id: "capture-a", variant: "KOEO", started: 1000, notes: { ignition: "ON", engine: "OFF", operatingConditions: "warm day", operatorObservations: "", comments: "" } },
    { id: "capture-b", variant: "DCL_EXPERIMENT", commandVariant: "MEM_OFF0", experimentCandidateId: "MEM_OFF0", started: 2000, notes: { ignition: "UNKNOWN", engine: "UNKNOWN", operatingConditions: "", operatorObservations: "", comments: "" } },
  ];
  const raw = new Map([
    ["capture-a", recordingTranscript({
      selfTest: true,
      counterValues: [0x19, 0x14, 0x0f, 0x0a, 0x05, 0xff, 0xfa, 0xf5, 0xf0],
    })],
    ["capture-b", recordingTranscript({
      counterOffset: 0,
      framePeriodMs: 15,
      frameSpacingUs: 15000,
      counterValues: [0x19, 0x14, 0x0f, 0x0a, 0x05, 0xff, 0xfa, 0xf5, 0xf0],
    })],
  ]);
  const savedNotes = [];
  const attached = [];
  return {
    recordings,
    raw,
    savedNotes,
    attached,
    list: async () => recordings,
    getNotes: async id => ({ ...recordings.find(item => item.id === id).notes }),
    async saveNotes(id, notes) {
      recordings.find(item => item.id === id).notes = { ...notes };
      savedNotes.push({ id, notes: { ...notes } });
    },
    async attachAnalysis(id, analysis) {
      recordings.find(item => item.id === id).analysis = analysis;
      attached.push({ id, analysis });
    },
    async getBlob(id, kind) {
      assert.equal(kind, "raw");
      return new Blob([raw.get(id)], { type: "text/plain" });
    },
  };
}

function initWithStore(document, store) {
  return initAnalysisUI({
    document,
    list: store.list,
    getNotes: store.getNotes,
    saveNotes: store.saveNotes,
    attachAnalysis: store.attachAnalysis,
    getBlob: store.getBlob,
  });
}

function cycle(complete, periodsMs) {
  const frames = periodsMs.map((periodMs, frameId) => ({ frameId, periodUs: periodMs * 1000 }));
  return { complete, frames, frameIds: frames.map(frame => frame.frameId) };
}

test("classifyCycles separates entry cadence, sustained cadence, generic and incomplete cycles", () => {
  const cycles = [
    cycle(true, Array(16).fill(10)),
    cycle(true, Array(16).fill(10)),
    cycle(true, [10, ...Array(15).fill(15)]),
    ...Array.from({ length: 38 }, () => cycle(true, Array(16).fill(15))),
    cycle(false, Array(8).fill(15)),
  ];

  assert.deepEqual(classifyCycles(cycles), {
    genericCartCycles: 41,
    responseEntryCycles: 1,
    sustainedResponseCycles: 38,
    memResponseCycles: 39,
    incompleteCycles: 1,
  });
});

test("classifyCycles counts a single mixed MEM response cycle as an entry cycle", () => {
  assert.deepEqual(classifyCycles([cycle(true, [10, ...Array(15).fill(15)])]), {
    genericCartCycles: 1,
    responseEntryCycles: 1,
    sustainedResponseCycles: 0,
    memResponseCycles: 1,
    incompleteCycles: 0,
  });
});

test("recording selectors populate from saved recordings and refresh keeps valid selections", async () => {
  const dom = setupDom();
  try {
    const store = mockStore();
    const ui = initWithStore(dom.document, store);
    await ui.ready;
    const primary = dom.document.getElementById("analysis-recording-select");
    const secondary = dom.document.getElementById("compare-second-recording");
    const referencePair = dom.document.getElementById("compare-reference-pair");
    assert.equal(primary.options.length, 3);
    assert.equal(primary.options[0].textContent, "Select a saved recording…");
    assert.deepEqual([...primary.options].slice(1).map(option => option.value), ["capture-a", "capture-b"]);
    assert.deepEqual([...secondary.options].slice(1).map(option => option.value), ["capture-a", "capture-b"]);
    assert.deepEqual([...referencePair.options].slice(1).map(option => option.value), [
      "260E-vs-26A4", "005E-vs-004E", "MEM-vs-MEM_OFF0", "MEM-vs-MEM_SINGLE", "MEM-vs-MEM_PARITY", "KOEO-vs-KOER",
    ]);
    primary.value = "capture-b";
    primary.dispatchEvent(new dom.dom.window.Event("change"));
    await ui.settled();
    await ui.refreshAnalysisRecordings();
    assert.equal(primary.value, "capture-b");
    assert.equal(dom.document.getElementById("note-ignition").value, "UNKNOWN");
  } finally {
    dom.restore();
  }
});

test("selecting a recording loads notes and saving notes leaves the raw transcript unchanged", async () => {
  const dom = setupDom();
  try {
    const store = mockStore();
    const originalRaw = store.raw.get("capture-a");
    const ui = initWithStore(dom.document, store);
    await ui.ready;
    const select = dom.document.getElementById("analysis-recording-select");
    select.value = "capture-a";
    select.dispatchEvent(new dom.dom.window.Event("change"));
    await ui.settled();
    assert.equal(dom.document.getElementById("note-ignition").value, "ON");
    assert.equal(dom.document.getElementById("note-engine").value, "OFF");
    assert.equal(dom.document.getElementById("btn-save-notes").disabled, false);
    assert.equal(dom.document.getElementById("btn-inspect-frames").disabled, false);

    dom.document.getElementById("note-ignition").value = "OFF";
    dom.document.getElementById("note-engine").value = "ON";
    dom.document.getElementById("note-conditions").value = "warm idle";
    dom.document.getElementById("note-observations").value = "Fan cycled once";
    dom.document.getElementById("note-comments").value = "Repeat after cool-down";
    dom.document.getElementById("btn-save-notes").click();
    await ui.settled();
    assert.deepEqual(store.savedNotes[0], {
      id: "capture-a",
      notes: {
        ignition: "OFF", engine: "ON", operatingConditions: "warm idle",
        operatorObservations: "Fan cycled once", comments: "Repeat after cool-down",
      },
    });
    assert.equal(dom.document.getElementById("note-status-msg").textContent, "Notes saved safely without modifying raw recording data.");
    assert.equal(store.raw.get("capture-a"), originalRaw);
  } finally {
    dom.restore();
  }
});

test("non-MEM inspection labels 16-frame cycles generically and filter updates cards", async () => {
  const dom = setupDom();
  try {
    const store = mockStore();
    const ui = initWithStore(dom.document, store);
    await ui.ready;
    const select = dom.document.getElementById("analysis-recording-select");
    select.value = "capture-a";
    select.dispatchEvent(new dom.dom.window.Event("change"));
    await ui.settled();
    dom.document.getElementById("btn-inspect-frames").click();
    await ui.settled();

    assert.equal(dom.document.getElementById("inspector-output-area").hidden, false);
    assert.match(dom.document.getElementById("inspector-stats").textContent, /144 frame\(s\)/);
    const hypotheses = dom.document.getElementById("inspector-self-test-box");
    assert.equal(hypotheses.hidden, false);
    assert.match(hypotheses.textContent, /\[HYPOTHESIS - UNPROVEN FOR SME-105\]/);
    assert.match(hypotheses.textContent, /code 11/i);
    const mem = dom.document.getElementById("inspector-mem-cycles-box");
    assert.equal(mem.hidden, false);
    assert.match(mem.textContent, /DCL \/ CART frame-cycle structure · 9 cycle\(s\)/);
    assert.match(mem.textContent, /16-frame group\(s\) detected/);
    assert.match(mem.textContent, /Cycle 1: 16 frame\(s\) · F00–F0F · complete/);
    assert.doesNotMatch(mem.textContent, /MEM cycle analysis|MEM_PARITY|memory-read result/i);
    assert.ok(dom.document.querySelectorAll("#inspector-cards-container .frame-inspector-card").length > 0);
    assert.equal(store.attached.at(-1).analysis.frameInspection.frameCycles.cycleCount, 9);
    assert.equal(store.attached.at(-1).analysis.frameInspection.frameCycles.genericCartCycles, 9);
    assert.equal(store.attached.at(-1).analysis.frameInspection.frameCycles.responseEntryCycles, 0);
    assert.equal(store.attached.at(-1).analysis.frameInspection.frameCycles.sustainedResponseCycles, 0);
    assert.equal(store.attached.at(-1).analysis.frameInspection.frameCycles.memResponseCycles, 0);
    assert.equal("memCycles" in store.attached.at(-1).analysis.frameInspection, false);

    const filter = dom.document.getElementById("inspector-filter");
    filter.value = "CHANGED";
    filter.dispatchEvent(new dom.dom.window.Event("change"));
    assert.match(dom.document.getElementById("inspector-stats").textContent, /showing 8 for CHANGED/);
    assert.equal(dom.document.querySelectorAll("#inspector-cards-container .frame-inspector-card").length, 8);
  } finally {
    dom.restore();
  }
});

test("MEM capture inspection renders candidate counters and persists specialized cycle analysis", async () => {
  const dom = setupDom();
  try {
    const store = mockStore();
    const ui = initWithStore(dom.document, store);
    await ui.ready;
    const select = dom.document.getElementById("analysis-recording-select");
    select.value = "capture-b";
    select.dispatchEvent(new dom.dom.window.Event("change"));
    await ui.settled();
    dom.document.getElementById("btn-inspect-frames").click();
    await ui.settled();

    const mem = dom.document.getElementById("inspector-mem-cycles-box");
    assert.equal(mem.hidden, false);
    assert.match(mem.textContent, /MEM response analysis · 9 response cycle\(s\) \(15ms cadence\) within 9 complete CART cycle\(s\)/);
    assert.match(mem.textContent, /constant word/i);
    assert.match(mem.textContent, /variable word/i);
    assert.match(mem.textContent, /candidate counter pattern/i);
    assert.match(mem.textContent, /MEM_PARITY descending counter pattern/);
    const frameInspection = store.attached.at(-1).analysis.frameInspection;
    assert.equal(frameInspection.memCycles.cycleCount, 9);
    assert.equal(frameInspection.memCycles.genericCartCycles, 9);
    assert.equal(frameInspection.memCycles.memResponseCycles, 9);
    assert.equal(frameInspection.frameCycles.genericCartCycles, 9);
    assert.equal(frameInspection.frameCycles.responseEntryCycles, 0);
    assert.equal(frameInspection.frameCycles.sustainedResponseCycles, 9);
    assert.equal(frameInspection.frameCycles.memResponseCycles, 9);
    assert.ok(Array.isArray(frameInspection.memCycles.candidateCounters));
    assert.equal(frameInspection.frameCycles.cycleCount, 9);
  } finally {
    dom.restore();
  }
});

test("MEM inspection labels a mixed transition cycle separately from sustained response cycles", async () => {
  const dom = setupDom();
  try {
    const store = mockStore();
    const frameSpacings = [...Array(16).fill(10000), ...Array(16).fill(15000)];
    store.raw.set("capture-b", recordingTranscript({
      framePeriodMs: 15,
      frameSpacingUs: frameSpacings,
      counterValues: [0x19, 0x14],
    }));
    const ui = initWithStore(dom.document, store);
    await ui.ready;
    const select = dom.document.getElementById("analysis-recording-select");
    select.value = "capture-b";
    select.dispatchEvent(new dom.dom.window.Event("change"));
    await ui.settled();
    dom.document.getElementById("btn-inspect-frames").click();
    await ui.settled();

    const mem = dom.document.getElementById("inspector-mem-cycles-box");
    assert.match(mem.textContent, /MEM response analysis · 0 sustained response cycle\(s\) \(15ms cadence\) \+ 1 entry cycle within 2 complete CART cycle\(s\)/);
    const frameCycles = store.attached.at(-1).analysis.frameInspection.frameCycles;
    assert.equal(frameCycles.genericCartCycles, 2);
    assert.equal(frameCycles.responseEntryCycles, 1);
    assert.equal(frameCycles.sustainedResponseCycles, 0);
    assert.equal(frameCycles.memResponseCycles, 1);
  } finally {
    dom.restore();
  }
});

test("reference and custom recording comparisons render results and enable JSON and CSV downloads", async () => {
  const dom = setupDom();
  try {
    const store = mockStore();
    const ui = initWithStore(dom.document, store);
    await ui.ready;
    const primary = dom.document.getElementById("analysis-recording-select");
    primary.value = "capture-a";
    primary.dispatchEvent(new dom.dom.window.Event("change"));
    await ui.settled();
    dom.document.getElementById("btn-toggle-comparison").click();
    assert.equal(dom.document.getElementById("comparison-section-area").hidden, false);

    const pair = dom.document.getElementById("compare-reference-pair");
    pair.value = "260E-vs-26A4";
    pair.dispatchEvent(new dom.dom.window.Event("change"));
    const run = dom.document.getElementById("btn-run-comparison");
    assert.equal(run.disabled, false);
    run.click();
    await ui.settled();
    const results = dom.document.getElementById("comparison-results-box");
    assert.equal(results.hidden, false);
    assert.match(results.textContent, /Verdict: DIFFERENT/);
    assert.match(results.textContent, /Differences/);
    assert.match(results.textContent, /Similarities/);
    assert.equal(dom.document.getElementById("btn-export-comparison-json").disabled, false);
    assert.equal(dom.document.getElementById("btn-export-comparison-csv").disabled, false);

    dom.document.getElementById("btn-export-comparison-json").click();
    dom.document.getElementById("btn-export-comparison-csv").click();
    await ui.settled();
    assert.equal(dom.downloads.length, 2);
    assert.ok(dom.downloads[0].endsWith(".json"));
    assert.ok(dom.downloads[1].endsWith(".csv"));

    pair.value = "";
    pair.dispatchEvent(new dom.dom.window.Event("change"));
    const second = dom.document.getElementById("compare-second-recording");
    second.value = "capture-b";
    second.dispatchEvent(new dom.dom.window.Event("change"));
    assert.equal(run.disabled, false);
    run.click();
    await ui.settled();
    assert.equal(results.hidden, false);
    assert.match(results.textContent, /frame period differs/i);
    assert.ok(store.raw.has("capture-a") && store.raw.has("capture-b"));
    assert.ok(store.attached.some(item => item.analysis.comparison?.secondRecordingId === "capture-b"));
  } finally {
    dom.restore();
  }
});

test("disposing with notes loading prevents async writes after DOM teardown", async () => {
  const dom = setupDom();
  let resolveNotes;
  const store = mockStore();
  const ui = initAnalysisUI({
    document: dom.document,
    list: store.list,
    getNotes: () => new Promise(resolve => { resolveNotes = resolve; }),
    saveNotes: store.saveNotes,
    attachAnalysis: store.attachAnalysis,
    getBlob: store.getBlob,
  });
  try {
    await ui.ready;
    const select = dom.document.getElementById("analysis-recording-select");
    select.value = "capture-a";
    select.dispatchEvent(new dom.dom.window.Event("change"));
    ui.dispose();
    dom.document.body.replaceChildren();
    dom.restore();
    resolveNotes({ ignition: "ON", engine: "OFF" });
    await ui.settled();
    assert.equal(dom.document.body.childElementCount, 0);
  } finally {
    ui.dispose();
    if (globalThis.document === dom.document) dom.restore();
  }
});

test("settled waits for stale note loads and only the latest selection updates the form", async () => {
  const dom = setupDom();
  let resolveA;
  let resolveB;
  const store = mockStore();
  const ui = initAnalysisUI({
    document: dom.document,
    list: store.list,
    getNotes: id => new Promise(resolve => {
      if (id === "capture-a") resolveA = resolve;
      else resolveB = resolve;
    }),
    saveNotes: store.saveNotes,
    attachAnalysis: store.attachAnalysis,
    getBlob: store.getBlob,
  });
  try {
    await ui.ready;
    const select = dom.document.getElementById("analysis-recording-select");
    select.value = "capture-a";
    select.dispatchEvent(new dom.dom.window.Event("change"));
    select.value = "capture-b";
    select.dispatchEvent(new dom.dom.window.Event("change"));
    resolveB({ ignition: "ON", engine: "ON" });
    resolveA({ ignition: "OFF", engine: "OFF" });
    await ui.settled();
    assert.equal(dom.document.getElementById("note-ignition").value, "ON");
    assert.equal(dom.document.getElementById("note-engine").value, "ON");
  } finally {
    ui.dispose();
    dom.restore();
  }
});
