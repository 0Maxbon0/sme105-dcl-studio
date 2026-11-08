import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { dclVParityByte } from "../js/protocol.js";
import {
  analyzeMemCycles,
  decodeSelfTestMarkers,
  filterFrames,
  formatFrameRow,
  parseRawTranscript,
  renderFrameInspectorCards,
} from "../js/frame-inspector.js";

function rx(t, byte) {
  return `RX t_us=${t >>> 0} byte=${byte.toString(16).padStart(2, "0").toUpperCase()}`;
}

function emitHeader(lines, t, id, data = 0) {
  const parity = dclVParityByte(data, id);
  lines.push(rx(t, 0), rx(t + 1040, 0), rx(t + 2500, data), rx(t + 3540, parity));
}

function emitWord(lines, t, first, second) {
  lines.push(rx(t, first), rx(t + 1040, second));
}

function makeWord(hex, frameId, slot, t_us) {
  const normalized = hex.toUpperCase();
  const firstByte = parseInt(normalized.slice(0, 2), 16);
  const secondByte = parseInt(normalized.slice(2, 4), 16);
  return {
    slot,
    slotName: `IW${slot}`,
    hex: normalized,
    firstByte,
    secondByte,
    value: parseInt(normalized, 16),
    t_us,
    frameId,
    parityValid: dclVParityByte(firstByte, secondByte & 0x0f) === secondByte,
    classification: "RESPONSE_CANDIDATE",
    changed: false,
  };
}

function makeSlot2Words(hex, frameId, t_us) {
  const fillerParity = dclVParityByte(0, frameId);
  return [
    makeWord(`00${fillerParity.toString(16).padStart(2, "0")}`, frameId, 1, t_us + 12000),
    makeWord(hex, frameId, 2, t_us + 14400),
  ];
}

function makeCycles(cycleCount, wordAt) {
  const frames = [];
  for (let cycle = 0; cycle < cycleCount; cycle += 1) {
    for (let frameId = 0; frameId < 16; frameId += 1) {
      const t_us = cycle * 16 * 42500 + frameId * 42500;
      const frame = {
        index: frames.length,
        frameId,
        id: frameId,
        t_us,
        periodUs: frames.length ? 42500 : null,
        words: [],
        txWitnesses: [],
        cycle: null,
      };
      const words = wordAt?.(cycle, frameId, t_us) || [];
      frame.words.push(...words.map((word, index) => typeof word === "string"
        ? makeWord(word, frameId, index + 1, t_us + 12000 + index * 2200)
        : word));
      frames.push(frame);
    }
  }
  return frames;
}

test("parser accepts RX and RXB bytes, and keeps STATUS/END metadata", () => {
  const result = parseRawTranscript([
    "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0",
    "RXB t_us=100 bytes=000000a0 dt=0,1040,2500,3540",
    "END reason=16 ro_bytes=4 ro_lost=0 uart_errors=0 DE=LOW",
  ]);
  assert.equal(result.stats.rxByteCount, 4);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].frameId, 0);
  assert.equal(result.frames[0].parityValid, true);
  assert.equal(result.stats.statusEvents[0].fields.DE, "LOW");
  assert.equal(result.stats.endEvents[0].reason, 16);
  assert.deepEqual(result.errors, []);
});

test("real read-0e transcript slice reconstructs ordered, timed DCL headers", () => {
  const text = readFileSync(new URL("../demo/read-0e.txt", import.meta.url), "utf8");
  const rxSlice = text.split(/\r?\n/).filter((line) => line.startsWith("RX ")).slice(0, 24);
  const result = parseRawTranscript(rxSlice);
  assert.equal(result.frames.length, 6);
  assert.deepEqual(result.frames.map((frame) => frame.frameId), [0, 1, 2, 3, 4, 5]);
  assert.ok(Math.abs(result.stats.meanFramePeriodUs - 10000) < 100);
  assert.ok(result.frames.every((frame) => frame.parityValid));
});

test("PAD witnesses, reflected echoes, ECU response candidates, and malformed words stay distinct", () => {
  const lines = ["TX_PAD slot=1 expected=01B0 observed=01B0 tx_us=15000 done_us=17000 match=1"];
  emitHeader(lines, 10000, 0);
  emitWord(lines, 15000, 0x01, 0xb0);
  emitWord(lines, 18000, 0x11, 0xb1);
  emitWord(lines, 21000, 0x11, 0xb0);
  lines.push(rx(24000, 0xaa));
  emitHeader(lines, 52500, 1);

  const result = parseRawTranscript(lines);
  const frame0 = result.frames[0];
  assert.ok(result.words.filter((word) => word.slot === 0).every((word) => word.classification === "FRAME_HEADER"));
  assert.equal(result.words.find((word) => word.slot === 0).classification, "FRAME_HEADER");
  assert.equal(result.stats.headerCount, result.frames.length);
  assert.equal(result.stats.responseCandidateCount, 1);
  assert.equal(result.stats.echoCount, 1);
  assert.equal(result.stats.unresolvedCount, 2);
  assert.equal(result.stats.txWitnessCount, 1);
  assert.equal(result.stats.verifiedTxWitnessCount, 1);
  assert.equal(result.txWitnesses[0].classification, "TX_WITNESS");
  assert.equal(frame0.txWitnesses.length, 1);
  assert.equal(result.words.find((word) => word.hex === "01B0").classification, "ECHO");
  assert.equal(result.words.find((word) => word.hex === "11B1").classification, "RESPONSE_CANDIDATE");
  assert.equal(result.words.find((word) => word.hex === "11B0").classification, "UNRESOLVED");
  assert.equal(result.words.find((word) => word.hex === "AA").classification, "UNRESOLVED");
  assert.ok(result.errors.some((error) => error.reason === "ODD_FRAME_PAYLOAD_BYTE"));
  assert.equal(result.stats.parityFailureCount, 1);
  assert.equal(filterFrames(result.frames, "TX")[0], frame0);
  assert.equal(filterFrames(result.frames, "ECHO")[0], frame0);
  assert.equal(filterFrames(result.frames, "RESPONSE_CANDIDATE")[0], frame0);
  assert.equal(filterFrames(result.frames, "FRAME_HEADER").length, result.frames.length);
  assert.equal(filterFrames(result.frames, "HEADER").length, result.frames.length);
  assert.equal(filterFrames(result.frames, "PARITY_FAILURE")[0], frame0);
  assert.equal(filterFrames(result.frames, "UNRESOLVED")[0], frame0);
});

test("bytes outside reconstructed frames remain unresolved diagnostics", () => {
  const lines = [rx(100, 0x55)];
  emitHeader(lines, 1000, 0);
  const result = parseRawTranscript(lines);
  const unframed = result.errors.find((error) => error.reason === "BYTE_OUTSIDE_RECONSTRUCTED_FRAME");
  assert.equal(unframed.classification, "UNRESOLVED");
});

test("uint32 timestamp rollover is expanded before calculating frame cadence", () => {
  const lines = [];
  emitHeader(lines, 0xfffff000, 0);
  emitHeader(lines, (0xfffff000 + 42500) >>> 0, 1);
  const result = parseRawTranscript(lines);
  assert.equal(result.frames.length, 2);
  assert.equal(result.frames[1].periodUs, 42500);
  assert.equal(result.errors.length, 0);
});

test("MEM analyzer groups full 16-ID cycles and finds static, changing, and supplied counter pattern", () => {
  const pattern = ["19", "14", "0F", "0A", "05", "FF", "FA", "F5", "F0"];
  const frames = makeCycles(10, (cycle, frameId) => {
    const value = frameId === 14 && cycle < pattern.length
      ? parseInt(pattern[cycle], 16)
      : frameId === 15 && cycle < 9 ? 0x31 + cycle % 3 : 0x22;
    const word = `${value.toString(16).padStart(2, "0")}${dclVParityByte(value, frameId).toString(16).padStart(2, "0")}`;
    return [word];
  });
  const result = analyzeMemCycles(frames);
  assert.equal(result.cycleCount, 10);
  assert.ok(result.cycles.every((cycle) => cycle.complete && cycle.frameCount === 16));
  assert.ok(result.constantWords.some((word) => word.frameId === 1 && word.slot === 1));
  assert.ok(result.variableWords.some((word) => word.frameId === 14 && word.slot === 1));
  assert.ok(result.repeatingSequences.some((sequence) => sequence.frameId === 15 && sequence.periodCycles === 3));
  const counter = result.candidateCounters.find((item) => item.frameId === 14);
  assert.ok(counter);
  assert.equal(counter.stepSize, -5);
  assert.equal(counter.rolloverAt, "FF");
  assert.deepEqual(counter.sequence, pattern);
  assert.match(counter.hypothesis, /unproven/i);
});

test("KOEO decoder marks valid 11B1 near nine seconds and exposes phase transition hypothesis", () => {
  const frames = makeCycles(15, (cycle, frameId, t_us) => {
    if (frameId === 0 && cycle === 13) return makeSlot2Words("11B1", frameId, t_us);
    if (frameId === 7 && cycle === 12) return ["ACC0"];
    if (frameId === 7 && cycle === 13) return ["EC80"];
    return [];
  });
  analyzeMemCycles(frames);
  const result = decodeSelfTestMarkers(frames, "KOEO_253E");
  const marker = result.markers.find((item) => item.code === "11B1");
  assert.ok(marker);
  assert.equal(marker.frameId, 0);
  assert.equal(marker.slot, 2);
  assert.equal(marker.parityValid, true);
  assert.ok(marker.seconds >= 8.5 && marker.seconds <= 9.5);
  assert.equal(result.markers.find((item) => item.type === "FRAME_CADENCE").approximately42_5ms, true);
  assert.ok(result.hypotheses.some((hypothesis) => hypothesis.includes("Candidate Ford code 11 (pass)") && hypothesis.includes("[HYPOTHESIS - UNPROVEN FOR SME-105]")));
  const transition = result.phaseTransitions.find((item) => item.from === "ACC0" && item.to === "EC80");
  assert.equal(transition.frameId, 7);
  assert.equal(transition.slot, 1);
  assert.equal(transition.cycle, 13);
  const transitionMarker = result.markers.find((item) => item.type === "PHASE_TRANSITION_CANDIDATE");
  assert.equal(transitionMarker.frameId, 7);
  assert.equal(transitionMarker.slot, 1);
  assert.match(transitionMarker.hypothesis, /\[HYPOTHESIS - UNPROVEN FOR SME-105\]/);
});

test("KOER decoder finds four frame 0..3 codes, EC80, and repeated-cycle persistence", () => {
  const codes = ["16C1", "72E1", "3845", "21C5"];
  const frames = makeCycles(353, (cycle, frameId, t_us) => {
    if (cycle >= 86 && frameId < 4) return makeSlot2Words(codes[frameId], frameId, t_us);
    if (frameId === 7 && cycle === 85) return ["ACC0"];
    if (frameId === 7 && cycle >= 86) return ["EC80"];
    return [];
  });
  analyzeMemCycles(frames);
  const result = decodeSelfTestMarkers(frames, "KOER");
  for (const code of codes) {
    const marker = result.markers.find((item) => item.code === code);
    assert.ok(marker, code);
    assert.equal(marker.frameId, codes.indexOf(code));
    assert.equal(marker.slot, 2);
    assert.ok(marker.seconds >= 58 && marker.seconds < 60, `${code} appeared at ${marker.seconds}s`);
    assert.equal(marker.persistenceCycles, 267);
    assert.match(marker.hypothesis, /unproven/i);
  }
  const phase = result.markers.find((item) => item.code === "EC80");
  assert.equal(phase.frameId, 7);
  assert.equal(phase.slot, 1);
  assert.equal(phase.persistenceCycles, 267);
  assert.ok(result.phaseTransitions.length >= 1);
  assert.ok(result.hypotheses.some((hypothesis) => hypothesis.includes("72")));
  assert.ok(result.hypotheses.every((hypothesis) => hypothesis.includes("[HYPOTHESIS - UNPROVEN FOR SME-105]")));
  const transitionMarker = result.markers.find((item) => item.type === "PHASE_TRANSITION_CANDIDATE");
  assert.equal(transitionMarker.frameId, 7);
  assert.equal(transitionMarker.slot, 1);
});

test("phase transitions compare the same slot across successive cycles only", () => {
  const frames = makeCycles(2, (cycle, frameId) => {
    if (frameId !== 7) return [];
    if (cycle === 0) return ["ACC0", "EC80"];
    return ["ACC0", "EC80"];
  });
  analyzeMemCycles(frames);
  const result = decodeSelfTestMarkers(frames, "KOEO");
  assert.deepEqual(result.phaseTransitions, []);
  assert.equal(result.markers.some((marker) => marker.type === "PHASE_TRANSITION_CANDIDATE"), false);
});

test("filters include classification, parity, changed, and all-frame selections", () => {
  const good = makeWord("11B1", 0, 1, 10);
  good.classification = "ECHO";
  const candidate = makeWord("22D2", 0, 2, 20);
  candidate.classification = "RESPONSE_CANDIDATE";
  candidate.changed = true;
  const misclassifiedHeader = makeWord("00A0", 0, 0, 5);
  misclassifiedHeader.classification = "RESPONSE_CANDIDATE";
  const header = makeWord("00A0", 0, 0, 5);
  header.classification = "FRAME_HEADER";
  const bad = makeWord("11B0", 0, 3, 30);
  bad.classification = "UNRESOLVED";
  const frame = { frameId: 0, words: [header, misclassifiedHeader, good, candidate, bad], txWitnesses: [{ verified: true }] };
  const frames = [frame, { frameId: 1, words: [], txWitnesses: [] }];
  assert.deepEqual(filterFrames(frames, "ALL"), frames);
  for (const kind of ["TX", "ECHO", "RESPONSE_CANDIDATE", "CHANGED", "PARITY_FAILURE", "UNRESOLVED"]) {
    assert.deepEqual(filterFrames(frames, kind), [frame], kind);
  }
  assert.deepEqual(filterFrames(frames, "FRAME_HEADER"), [frame]);
  assert.deepEqual(filterFrames(frames, "HEADER"), [frame]);
  assert.deepEqual(filterFrames([{ frameId: 0, words: [misclassifiedHeader] }], "RESPONSE_CANDIDATE"), []);
});

test("card renderer emits expandable, compact and escaped HTML", () => {
  const frame = { frameId: 0, periodUs: 42500, words: [makeWord("11B1", 0, 1, 10)], txWitnesses: [] };
  const container = { innerHTML: "" };
  const html = renderFrameInspectorCards([frame], container);
  assert.equal(container.innerHTML, html);
  assert.match(html, /<details/);
  assert.match(html, /grid-template-columns/);
  assert.match(html, /IW1 11B1/);
  assert.match(formatFrameRow(frame), /F00/);
  const escaped = renderFrameInspectorCards([{ ...frame, frameId: 0, words: [{ ...frame.words[0], decodedMeaning: "<script>" }] }], container);
  assert.doesNotMatch(escaped, /<script>/);
  assert.match(escaped, /&lt;script&gt;/);

  const manyFrames = Array.from({ length: 105 }, (_, frameId) => ({ ...frame, frameId }));
  const boundedHtml = renderFrameInspectorCards(manyFrames, container);
  assert.equal((boundedHtml.match(/class="frame-inspector-card"/g) || []).length, 100);
  assert.match(boundedHtml, /Page 1 of 2 \(Frames 1–100 of 105\)/);
  assert.doesNotMatch(boundedHtml, /frame-inspector-truncation/);
});

function makeInspectorFrames(count) {
  return Array.from({ length: count }, (_, index) => ({
    index,
    frameId: index % 16,
    periodUs: 42500,
    cycle: Math.floor(index / 16),
    words: [],
    txWitnesses: [],
  }));
}

function makeInspectorContainer() {
  const dom = new JSDOM("<section></section>");
  return { dom, container: dom.window.document.querySelector("section") };
}

test("frame inspector paginates small and 5,681-frame recordings without rendering beyond one page", () => {
  const { dom: smallDom, container: smallContainer } = makeInspectorContainer();
  const smallHtml = renderFrameInspectorCards(makeInspectorFrames(50), smallContainer);
  assert.match(smallHtml, /Page 1 of 1 \(Frames 1–50 of 50\)/);
  assert.equal(smallContainer.querySelectorAll(".frame-inspector-card").length, 50);
  const customPageHtml = renderFrameInspectorCards(makeInspectorFrames(50), smallContainer, { pageSize: 25, page: 2 });
  assert.match(customPageHtml, /Page 2 of 2 \(Frames 26–50 of 50\)/);
  assert.equal(smallContainer.querySelectorAll(".frame-inspector-card").length, 25);
  smallDom.window.close();

  const frames = makeInspectorFrames(5681);
  const { dom, container } = makeInspectorContainer();
  const pageOneHtml = renderFrameInspectorCards(frames, container);
  assert.match(pageOneHtml, /Page 1 of 57 \(Frames 1–100 of 5681\)/);
  assert.equal(container.querySelectorAll(".frame-inspector-card").length, 100);
  assert.equal(container.querySelector(".frame-inspector-card").dataset.frameIndex, "0");
  assert.equal(container.querySelectorAll(".frame-inspector-card").item(99).dataset.frameIndex, "99");

  container.querySelector('.frame-page-btn[aria-label="Next page"]').click();
  assert.equal(container._frameInspectorPage, 2);
  assert.match(container.querySelector(".frame-page-info").textContent, /Page 2 of 57 \(Frames 101–200 of 5681\)/);
  assert.equal(container.querySelector(".frame-inspector-card").dataset.frameIndex, "100");
  assert.equal(container.querySelectorAll(".frame-inspector-card").item(99).dataset.frameIndex, "199");

  const pageTwoHtml = renderFrameInspectorCards(frames, container, { page: 2 });
  assert.match(pageTwoHtml, /Page 2 of 57 \(Frames 101–200 of 5681\)/);
  const finalHtml = renderFrameInspectorCards(frames, container, { page: 57 });
  assert.match(finalHtml, /Page 57 of 57 \(Frames 5601–5681 of 5681\)/);
  assert.equal(container.querySelectorAll(".frame-inspector-card").length, 81);
  assert.equal(container.querySelector(".frame-inspector-card").dataset.frameIndex, "5600");
  assert.equal(container.querySelectorAll(".frame-inspector-card").item(80).dataset.frameIndex, "5680");
  assert.equal(container.querySelector('.frame-page-btn[aria-label="Next page"]').disabled, true);

  const resetHtml = renderFrameInspectorCards(frames, container);
  assert.match(resetHtml, /Page 1 of 57/);
  assert.equal(container._frameInspectorPage, 1);
  dom.window.close();
});

test("frame inspector quick jumps open the page containing important transcript events", () => {
  const frames = makeInspectorFrames(1800);
  frames[211].words = [makeWord("11B1", 3, 2, 9000000)];
  frames[7].words = [makeWord("ACC0", 7, 1, 0)];
  frames[23].words = [makeWord("EC80", 7, 1, 680000)];
  for (const [index, code] of [[1378, "16C1"], [1380, "72E1"], [1382, "3845"], [1384, "21C5"]]) {
    frames[index].words = [makeWord(code, index % 16, 2, index * 42500)];
  }
  frames[1422].words = [{ ...makeWord("1914", 14, 1, 1422 * 42500), changed: true }];

  const { dom, container } = makeInspectorContainer();
  renderFrameInspectorCards(frames, container);
  assert.ok(container.querySelector('.frame-jump-btn[aria-label*="11B1"]'));
  assert.ok(container.querySelector('.frame-jump-btn[aria-label*="ACC0 → EC80"]'));
  assert.ok(container.querySelector('.frame-jump-btn[aria-label*="16C1"]'));
  assert.ok(container.querySelector('.frame-jump-btn[aria-label*="72E1"]'));
  assert.ok(container.querySelector('.frame-jump-btn[aria-label*="3845"]'));
  assert.ok(container.querySelector('.frame-jump-btn[aria-label*="21C5"]'));
  assert.ok(container.querySelector('.frame-jump-btn[aria-label*="MEM_PARITY"]'));

  container.querySelector('.frame-jump-btn[aria-label*="72E1"]').click();
  assert.equal(container._frameInspectorPage, Math.floor(1378 / 100) + 1);
  assert.match(container.querySelector(".frame-page-info").textContent, /Page 14 of 18/);
  assert.ok([...container.querySelectorAll(".frame-inspector-card")].some((card) => card.dataset.frameIndex === "1378"));
  dom.window.close();
});

test("frame filtering is applied before pagination and page counts use filtered frames", () => {
  const frames = makeInspectorFrames(350);
  for (const index of [5, 105, 205]) {
    frames[index].words = [{ ...makeWord("11B0", index % 16, 1, index * 42500), changed: true }];
  }
  const changedFrames = filterFrames(frames, "CHANGED");
  assert.deepEqual(changedFrames.map((frame) => frame.index), [5, 105, 205]);

  const { dom, container } = makeInspectorContainer();
  const html = renderFrameInspectorCards(changedFrames, container);
  assert.match(html, /Page 1 of 1 \(Frames 1–3 of 3\)/);
  assert.equal(container.querySelectorAll(".frame-inspector-card").length, 3);
  assert.equal(container.querySelector(".frame-inspector-card").dataset.frameIndex, "5");
  dom.window.close();
});
