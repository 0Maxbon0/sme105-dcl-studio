import { listRecordings, getRecordingNotes, saveRecordingNotes, attachRecordingAnalysis, recordingBlob } from "./recording.js";
import { parseRawTranscript, analyzeMemCycles, classifyCycles, decodeSelfTestMarkers, filterFrames, renderFrameInspectorCards } from "./frame-inspector.js";
import { compareCaptures, compareReferencePair, exportComparisonJson, exportComparisonCsv } from "./capture-comparison.js";
import { saveOrShare } from "./exports.js";

export { classifyCycles } from "./frame-inspector.js";

const EMPTY_NOTES = Object.freeze({
  ignition: "UNKNOWN",
  engine: "UNKNOWN",
  operatingConditions: "",
  operatorObservations: "",
  comments: "",
});

const HYPOTHESIS_LABEL = "[HYPOTHESIS - UNPROVEN FOR SME-105]";

function recordingLabel(recording) {
  const variant = recording?.variant || "Recording";
  const started = recording?.started ? new Date(recording.started).toLocaleString() : recording?.id || "Saved capture";
  return `${variant} · ${started}`;
}

function textNode(doc, tag, text, className = "") {
  const node = doc.createElement(tag);
  node.textContent = String(text ?? "");
  if (className) node.className = className;
  return node;
}

function isMemCapture(recording, parsed) {
  const name = String(recording?.commandVariant || recording?.candidateId || recording?.name || recording?.id || "").toUpperCase();
  const metadataName = [recording?.experimentCandidateId, recording?.experimentId, recording?.variant]
    .filter(Boolean).join(" ").toUpperCase();
  if (name.includes("MEM") || metadataName.includes("MEM")) return true;
  const recordedWords = String(recording?.commandWord || "").match(/\b[0-9A-F]{4}\b/gi) || [];
  const parsedWords = Array.isArray(parsed?.sentCommandWords) ? parsed.sentCommandWords : [];
  const cmds = [...parsedWords.map(word => String(word).toUpperCase()), ...recordedWords.map(word => word.toUpperCase())];
  return cmds.includes("42F3") || cmds.includes("22D3") || cmds.includes("2293");
}

function safeFilename(value) {
  return String(value || "capture").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "capture";
}

/** Offline History workflow for recording notes, frame inspection and capture comparison. */
export function initAnalysisUI({
  document = globalThis.document,
  list = listRecordings,
  getNotes = getRecordingNotes,
  saveNotes: saveRecordingNotesFn = saveRecordingNotes,
  attachAnalysis = attachRecordingAnalysis,
  getBlob = recordingBlob,
} = {}) {
  let disposed = false;
  let activeOperation = Promise.resolve();
  const activeOperations = new Set();
  const generations = new Map();

  function el(id) {
    if (disposed || !document) return null;
    return document.getElementById(id);
  }
  function setHidden(id, hidden) {
    const element = el(id);
    if (element) element.hidden = Boolean(hidden);
  }
  function setText(id, text) {
    const element = el(id);
    if (element) element.textContent = String(text ?? "");
  }
  function replaceContent(id, ...nodes) {
    const element = el(id);
    if (element) element.replaceChildren(...nodes);
  }
  function setDisabled(id, disabled) {
    const element = el(id);
    if (element) element.disabled = Boolean(disabled);
  }
  function setValue(id, value) {
    const element = el(id);
    if (element) element.value = String(value ?? "");
  }
  function valueOf(id) {
    return el(id)?.value || "";
  }

  const primarySelect = el("analysis-recording-select");
  if (!primarySelect) {
    return {
      refreshAnalysisRecordings: async () => [],
      ready: Promise.resolve([]),
      settled: async () => {},
      dispose: () => { disposed = true; },
    };
  }

  let recordings = [];
  let selectedRecordingId = "";
  let inspectedFrames = null;
  let comparisonResult = null;

  function runOperation(name, callback) {
    const token = (generations.get(name) || 0) + 1;
    generations.set(name, token);
    const isCurrent = () => !disposed && generations.get(name) === token;
    let operation;
    operation = activeOperation = (async () => {
      if (!isCurrent()) return;
      return callback(isCurrent);
    })();
    activeOperations.add(operation);
    const removeOperation = () => activeOperations.delete(operation);
    operation.then(removeOperation, removeOperation);
    return operation;
  }

  async function settled() {
    while (activeOperations.size) {
      await Promise.allSettled([...activeOperations]);
    }
    await activeOperation;
  }

  function invalidateSelectionOperations() {
    for (const name of ["inspectFrames", "runComparison", "saveNotes"]) {
      generations.set(name, (generations.get(name) || 0) + 1);
    }
  }

  function clearInspector() {
    if (disposed) return;
    inspectedFrames = null;
    setHidden("inspector-output-area", true);
    replaceContent("inspector-cards-container");
    replaceContent("inspector-self-test-box");
    setHidden("inspector-self-test-box", true);
    replaceContent("inspector-mem-cycles-box");
    setHidden("inspector-mem-cycles-box", true);
    setText("inspector-stats", "");
    setValue("inspector-filter", "ALL");
  }

  function clearComparison() {
    if (disposed) return;
    comparisonResult = null;
    replaceContent("comparison-results-box");
    setHidden("comparison-results-box", true);
    setDisabled("btn-export-comparison-json", true);
    setDisabled("btn-export-comparison-csv", true);
  }

  function updateComparisonAction() {
    if (disposed) return;
    const hasPair = !!valueOf("compare-reference-pair");
    const hasSecond = !!valueOf("compare-second-recording");
    setDisabled("btn-run-comparison", !(hasPair || (selectedRecordingId && hasSecond)));
  }

  function resetNotesForm() {
    if (disposed) return;
    const notes = EMPTY_NOTES;
    setValue("note-ignition", notes.ignition);
    setValue("note-engine", notes.engine);
    setValue("note-conditions", notes.operatingConditions);
    setValue("note-observations", notes.operatorObservations);
    setValue("note-comments", notes.comments);
    setDisabled("btn-save-notes", true);
    setDisabled("btn-inspect-frames", true);
  }

  function loadSelectedNotes(id) {
    return runOperation("loadSelectedNotes", async isCurrent => {
      selectedRecordingId = id || "";
      invalidateSelectionOperations();
      clearInspector();
      clearComparison();
      setText("note-status-msg", "");
      if (!selectedRecordingId) {
        resetNotesForm();
        updateComparisonAction();
        return;
      }
      const requestedId = selectedRecordingId;
      setDisabled("btn-save-notes", false);
      setDisabled("btn-inspect-frames", false);
      try {
        const notes = { ...EMPTY_NOTES, ...(await getNotes(requestedId) || {}) };
        if (!isCurrent() || requestedId !== selectedRecordingId) return;
        setValue("note-ignition", notes.ignition);
        setValue("note-engine", notes.engine);
        setValue("note-conditions", notes.operatingConditions);
        setValue("note-observations", notes.operatorObservations);
        setValue("note-comments", notes.comments);
      } catch (error) {
        if (isCurrent() && requestedId === selectedRecordingId) setText("note-status-msg", `Could not load notes: ${error.message}`);
      }
      if (isCurrent() && requestedId === selectedRecordingId) updateComparisonAction();
    });
  }

  function addOptions(select, placeholder, selectedValue = "") {
    if (disposed || !document || !select) return;
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    select.replaceChildren(empty, ...recordings.map(recording => {
      const option = document.createElement("option");
      option.value = recording.id;
      option.textContent = recordingLabel(recording);
      return option;
    }));
    if (recordings.some(recording => recording.id === selectedValue)) select.value = selectedValue;
  }

  function refreshAnalysisRecordings() {
    return runOperation("refreshAnalysisRecordings", async isCurrent => {
      const primary = el("analysis-recording-select");
      if (!primary) return [];
      const priorPrimary = primary.value || selectedRecordingId;
      const priorSecondary = valueOf("compare-second-recording");
      try {
        const nextRecordings = await list();
        if (!isCurrent()) return [];
        recordings = Array.isArray(nextRecordings) ? nextRecordings : [];
        addOptions(primary, "Select a saved recording…", priorPrimary);
        addOptions(el("compare-second-recording"), "Select a second recording…", priorSecondary);
        const nextPrimary = primary.value;
        if (nextPrimary !== selectedRecordingId) await loadSelectedNotes(nextPrimary);
        else updateComparisonAction();
        if (!isCurrent()) return [];
        return recordings;
      } catch (error) {
        if (isCurrent()) setText("note-status-msg", `Recording list unavailable: ${error.message}`);
        return [];
      }
    });
  }

  async function readRawText(id) {
    const raw = await getBlob(id, "raw");
    return typeof raw?.text === "function" ? raw.text() : String(raw ?? "");
  }

  async function persistAnalysis(id, key, value) {
    if (!id) return;
    const recording = recordings.find(item => item.id === id);
    const current = recording?.analysis && typeof recording.analysis === "object" ? recording.analysis : {};
    const updated = { ...current, [key]: value };
    await attachAnalysis(id, updated);
    if (recording) recording.analysis = updated;
  }

  function renderInspector(parsed, mem, selfTest, memCapture = false) {
    if (disposed || !document) return;
    const frames = parsed.frames;
    const filter = valueOf("inspector-filter") || "ALL";
    const filtered = filterFrames(frames, filter);
    const cards = el("inspector-cards-container");
    if (cards) renderFrameInspectorCards(filtered, cards);
    setText("inspector-stats", `${parsed.stats.frameCount} frame(s) · ${parsed.stats.wordCount} word(s) · ${parsed.stats.rxByteCount} raw byte(s) · ${parsed.stats.parityFailureCount} parity failure(s) · showing ${filtered.length} for ${filter}`);

    const hypotheses = [...new Set(selfTest.hypotheses || [])];
    const selfTestBox = el("inspector-self-test-box");
    if (selfTestBox) selfTestBox.replaceChildren();
    if (selfTestBox && hypotheses.length) {
      selfTestBox.hidden = false;
      selfTestBox.append(textNode(document, "strong", "Self-test hypotheses"));
      const list = document.createElement("ul");
      hypotheses.forEach(hypothesis => list.append(textNode(document, "li", `${HYPOTHESIS_LABEL} ${hypothesis}`)));
      selfTestBox.append(list);
    } else if (selfTestBox) selfTestBox.hidden = true;

    const memBox = el("inspector-mem-cycles-box");
    if (!memBox) return;
    memBox.replaceChildren();
    const metrics = classifyCycles(mem.cycles);
    if (memCapture) {
      memBox.hidden = false;
      const incomplete = metrics.incompleteCycles ? ` · ${metrics.incompleteCycles} incomplete` : "";
      const heading = metrics.responseEntryCycles > 0
        ? `MEM response analysis · ${metrics.sustainedResponseCycles} sustained response cycle(s) (15ms cadence) + ${metrics.responseEntryCycles} entry cycle within ${metrics.genericCartCycles} complete CART cycle(s)${incomplete}`
        : `MEM response analysis · ${metrics.sustainedResponseCycles} response cycle(s) (15ms cadence) within ${metrics.genericCartCycles} complete CART cycle(s)${incomplete}`;
      memBox.append(textNode(document, "strong", heading));
      memBox.append(textNode(document, "p", `${mem.constantWords.length} constant word(s) · ${mem.variableWords.length} variable word(s) · ${mem.candidateCounters.length} candidate counter pattern(s)`));
      const list = document.createElement("ul");
      const frameLabel = frameId => `F${Number(frameId).toString(16).toUpperCase().padStart(2, "0")}`;
      mem.constantWords.slice(0, 12).forEach(item => list.append(textNode(document, "li", `Constant ${frameLabel(item.frameId)} ${item.slotName}: ${item.hex}`)));
      mem.variableWords.slice(0, 12).forEach(item => list.append(textNode(document, "li", `Variable ${frameLabel(item.frameId)} ${item.slotName}: ${(item.uniqueValues || []).join(" → ")}`)));
      mem.candidateCounters.forEach(item => list.append(textNode(document, "li", `${item.hypothesis}: ${item.sequence.join(" → ")}`)));
      mem.repeatingSequences.slice(0, 8).forEach(item => list.append(textNode(document, "li", `Repeating ${frameLabel(item.frameId)} ${item.slotName}: ${item.values.join(" → ")} · period ${item.periodCycles} cycle(s)`)));
      memBox.append(list);
    } else {
      memBox.hidden = false;
      memBox.append(textNode(document, "strong", `DCL / CART frame-cycle structure · ${metrics.genericCartCycles} cycle(s)`));
      memBox.append(textNode(document, "p", `${mem.cycles.length} 16-frame group(s) detected · ${metrics.incompleteCycles} incomplete`));
      const list = document.createElement("ul");
      mem.cycles.slice(0, 12).forEach(cycle => {
        const first = cycle.frameIds?.[0];
        const last = cycle.frameIds?.at(-1);
        const span = first === undefined ? "frame IDs unavailable" : `F${Number(first).toString(16).toUpperCase().padStart(2, "0")}–F${Number(last).toString(16).toUpperCase().padStart(2, "0")}`;
        list.append(textNode(document, "li", `Cycle ${cycle.number + 1}: ${cycle.frameCount} frame(s) · ${span}${cycle.complete ? " · complete" : " · incomplete"}`));
      });
      memBox.append(list);
    }
  }

  function inspectFrames() {
    return runOperation("inspectFrames", async isCurrent => {
      const id = selectedRecordingId;
      if (!id) return;
      setDisabled("btn-inspect-frames", true);
      try {
        const recording = recordings.find(item => item.id === id);
        const rawText = await readRawText(id);
        if (!isCurrent() || id !== selectedRecordingId) return;
        const parsed = parseRawTranscript(rawText);
        const mem = analyzeMemCycles(parsed.frames);
        const metrics = classifyCycles(mem.cycles);
        const memCapture = isMemCapture(recording, parsed);
        const selfTest = decodeSelfTestMarkers(parsed.frames, recording?.variant);
        inspectedFrames = { parsed, mem, selfTest, memCapture };
        renderInspector(parsed, mem, selfTest, memCapture);
        setHidden("inspector-output-area", false);
        const frameCycles = {
          cycleCount: mem.cycleCount,
          genericCartCycles: metrics.genericCartCycles,
          responseEntryCycles: metrics.responseEntryCycles,
          sustainedResponseCycles: metrics.sustainedResponseCycles,
          memResponseCycles: metrics.memResponseCycles,
          incompleteCycles: metrics.incompleteCycles,
          cycles: mem.cycles.map(cycle => ({
            number: cycle.number,
            complete: cycle.complete,
            frameCount: cycle.frameCount,
            frameIds: cycle.frameIds,
          })),
          constantWords: mem.constantWords,
          variableWords: mem.variableWords,
          repeatingSequences: mem.repeatingSequences,
        };
        const frameInspection = {
          analyzedAt: new Date().toISOString(),
          stats: parsed.stats,
          frameCycles,
          selfTest,
        };
        if (memCapture) frameInspection.memCycles = { ...frameCycles, candidateCounters: mem.candidateCounters };
        try {
          await persistAnalysis(id, "frameInspection", frameInspection);
          if (!isCurrent() || id !== selectedRecordingId) return;
        } catch (error) {
          if (isCurrent() && id === selectedRecordingId) {
            setText("inspector-stats", `${valueOf("inspector-stats")} · Analysis annotation could not be saved: ${error.message}`);
          }
        }
      } catch (error) {
        if (!isCurrent() || id !== selectedRecordingId) return;
        setHidden("inspector-output-area", false);
        setText("inspector-stats", `Frame inspection failed: ${error.message}`);
      } finally {
        if (isCurrent() && id === selectedRecordingId) setDisabled("btn-inspect-frames", !selectedRecordingId);
      }
    });
  }

  function renderComparison(result) {
    if (disposed || !document) return;
    const box = el("comparison-results-box");
    if (!box) return;
    box.replaceChildren();
    box.append(textNode(document, "h4", `Verdict: ${result.verdict || "UNKNOWN"}`));
    box.append(textNode(document, "p", result.summaryText || "No comparison summary was returned."));
    for (const [title, items, emptyMessage] of [
      ["Differences", result.differences || [], "No measured differences."],
      ["Similarities", result.similarities || [], "No measured similarities."],
    ]) {
      box.append(textNode(document, "strong", title));
      const list = document.createElement("ul");
      if (items.length) items.forEach(item => list.append(textNode(document, "li", item.message || `${item.label || item.field}: ${item.captureA} / ${item.captureB}`)));
      else list.append(textNode(document, "li", emptyMessage));
      box.append(list);
    }
    box.hidden = false;
    setDisabled("btn-export-comparison-json", false);
    setDisabled("btn-export-comparison-csv", false);
  }

  function runComparison() {
    return runOperation("runComparison", async isCurrent => {
      clearComparison();
      const selectedId = selectedRecordingId;
      const pairId = valueOf("compare-reference-pair");
      try {
        let result;
        if (pairId) {
          result = compareReferencePair(pairId);
        } else {
          const secondId = valueOf("compare-second-recording");
          if (!selectedId || !secondId) throw new Error("Select two saved recordings or choose a reference regression pair.");
          if (selectedId === secondId) throw new Error("Choose two different recordings to compare.");
          const first = recordings.find(item => item.id === selectedId);
          const second = recordings.find(item => item.id === secondId);
          const [rawTextA, rawTextB] = await Promise.all([readRawText(selectedId), readRawText(secondId)]);
          if (!isCurrent() || selectedId !== selectedRecordingId) return;
          result = compareCaptures({ ...first, rawText: rawTextA }, { ...second, rawText: rawTextB });
        }
        if (!isCurrent() || selectedId !== selectedRecordingId) return;
        comparisonResult = result;
        renderComparison(result);
        if (selectedId) {
          try {
            await persistAnalysis(selectedId, "comparison", {
              comparedAt: new Date().toISOString(),
              pairId: pairId || null,
              secondRecordingId: pairId ? null : valueOf("compare-second-recording"),
              result,
            });
            if (!isCurrent() || selectedId !== selectedRecordingId) return;
          } catch (error) {
            if (isCurrent() && selectedId === selectedRecordingId) setText("note-status-msg", `Comparison is ready, but its annotation could not be saved: ${error.message}`);
          }
        }
      } catch (error) {
        if (!isCurrent() || selectedId !== selectedRecordingId) return;
        setHidden("comparison-results-box", false);
        setText("comparison-results-box", `Comparison failed: ${error.message}`);
      }
    });
  }

  function exportComparison(format) {
    return runOperation("exportComparison", async isCurrent => {
      if (!comparisonResult || !isCurrent()) return;
      const content = format === "json" ? exportComparisonJson(comparisonResult) : exportComparisonCsv(comparisonResult);
      const mime = format === "json" ? "application/json" : "text/csv";
      const first = safeFilename(comparisonResult.captureA?.label);
      const second = safeFilename(comparisonResult.captureB?.label);
      await saveOrShare(new Blob([content], { type: mime }), `sme105-comparison-${first}-vs-${second}.${format}`);
    });
  }

  function saveNotes() {
    return runOperation("saveNotes", async isCurrent => {
      const id = selectedRecordingId;
      if (!id) return;
      setDisabled("btn-save-notes", true);
      const notes = {
        ignition: valueOf("note-ignition"),
        engine: valueOf("note-engine"),
        operatingConditions: valueOf("note-conditions"),
        operatorObservations: valueOf("note-observations"),
        comments: valueOf("note-comments"),
      };
      try {
        await saveRecordingNotesFn(id, notes);
        if (!isCurrent() || id !== selectedRecordingId) return;
        setText("note-status-msg", "Notes saved safely without modifying raw recording data.");
      } catch (error) {
        if (isCurrent() && id === selectedRecordingId) setText("note-status-msg", `Notes could not be saved: ${error.message}`);
      } finally {
        if (isCurrent() && id === selectedRecordingId) setDisabled("btn-save-notes", !selectedRecordingId);
      }
    });
  }

  function listen(id, event, callback) {
    const element = el(id);
    if (element) element.addEventListener(event, (...args) => {
      if (!disposed) callback(...args);
    });
  }

  primarySelect.addEventListener("change", () => { if (!disposed) void loadSelectedNotes(primarySelect.value); });
  listen("btn-save-notes", "click", () => { void saveNotes(); });
  listen("btn-inspect-frames", "click", () => { void inspectFrames(); });
  listen("inspector-filter", "change", () => {
    if (inspectedFrames) renderInspector(inspectedFrames.parsed, inspectedFrames.mem, inspectedFrames.selfTest, inspectedFrames.memCapture);
  });
  listen("btn-toggle-comparison", "click", () => {
    const area = el("comparison-section-area");
    if (area) area.hidden = !area.hidden;
  });
  listen("compare-second-recording", "change", () => {
    generations.set("runComparison", (generations.get("runComparison") || 0) + 1);
    clearComparison();
    updateComparisonAction();
  });
  listen("compare-reference-pair", "change", () => {
    generations.set("runComparison", (generations.get("runComparison") || 0) + 1);
    clearComparison();
    updateComparisonAction();
  });
  listen("btn-run-comparison", "click", () => { void runComparison(); });
  listen("btn-export-comparison-json", "click", () => { void exportComparison("json"); });
  listen("btn-export-comparison-csv", "click", () => { void exportComparison("csv"); });

  resetNotesForm();
  updateComparisonAction();
  const ready = refreshAnalysisRecordings();
  return {
    refreshAnalysisRecordings,
    ready,
    settled: () => settled(),
    dispose: () => {
      disposed = true;
      for (const [name, token] of generations) generations.set(name, token + 1);
    },
  };
}
