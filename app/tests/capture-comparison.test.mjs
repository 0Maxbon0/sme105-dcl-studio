import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { dclVParityByte } from "../js/protocol.js";
import {
  compareCaptures,
  compareReferencePair,
  exportComparisonCsv,
  exportComparisonJson,
  REFERENCE_COMPARISON_PAIRS,
} from "../js/capture-comparison.js";

const initialWords = Object.freeze({
  0: ["72E1"], 4: ["26E0"], 5: ["FFA0"], 6: ["1F40"], 7: ["FC90"],
  8: ["00A0"], 9: ["00A0"], 10: ["ADD0"], 11: ["3810"],
});
const REAL_MEM_PARITY_PATH = "/home/maxim/maximizotech/sme105-field-evidence/phone-2026-11-08-readonly-audit/reconstructed-captures/32-152217-MEM_PARITY/raw.txt";

function rxBatch(tUs, frameId, words = []) {
  const bytes = [0x00, 0x00, 0x00, dclVParityByte(0, frameId)];
  const dt = [0, 1040, 2500, 3540];
  words.slice(0, 3).forEach((word, index) => {
    const normalized = String(word).toUpperCase().padStart(4, "0");
    bytes.push(Number.parseInt(normalized.slice(0, 2), 16), Number.parseInt(normalized.slice(2, 4), 16));
    const offset = 4500 + index * 2000;
    dt.push(offset, offset + 1040);
  });
  return `RXB t_us=${tUs} data=${bytes.map(byte => byte.toString(16).padStart(2, "0")).join("")} dt=${dt.join(",")}`;
}

function rawCapture(label, commands, frames) {
  const envelope = ["01B0", "FF5F", commands[0], "00A0"];
  const echoTimesUs = [1_004_500, 1_006_500, 1_008_500, 1_014_500];
  const lines = envelope.map((word, index) => `TX_PAD slot=${index} expected=${word} observed=${word} tx_us=${echoTimesUs[index] - 2000} done_us=${echoTimesUs[index]} match=1`);
  const witnessCount = label === "MEM" || label === "MEM_OFF0" ? 244 : label === "MEM_PARITY" ? 164 : 4;
  let tUs = 1_000_000;
  frames.forEach((frame, index) => {
    if (index > 0) tUs += Math.round(frame.periodMs * 1000);
    const echoes = index === 0 ? envelope.slice(0, 3) : index === 1 ? [envelope[3]] : [];
    lines.push(rxBatch(tUs, frame.frameId, [...echoes, ...(frame.words || [])].slice(0, 3)));
  });
  lines.push(`END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 witness_verified=${witnessCount} pad_verified=4 words_started=4 DE=LOW`);
  return { id: label, label, rawText: lines.join("\n") };
}

function prelude() {
  return [{ frameId: 14, words: [] }, { frameId: 15, periodMs: 10, words: [] }];
}

function cadenceFrames(count, periodMs, startFrameId = 0, wordsAt = () => []) {
  return Array.from({ length: count }, (_, index) => ({
    frameId: (startFrameId + index) & 0x0f,
    periodMs,
    words: wordsAt(index, (startFrameId + index) & 0x0f),
  }));
}

function rawFixtures() {
  const storedWords = frameId => initialWords[frameId] || [];
  const stored260E = rawCapture("260E", ["260E"], [
    ...prelude(), ...cadenceFrames(16, 42.5, 0, (_, id) => storedWords(id)),
  ]);
  const stored26A4 = rawCapture("26A4", ["26A4"], [
    ...prelude(), ...cadenceFrames(16, 17.5, 0, (_, id) => storedWords(id)),
  ]);
  const noAcceptance = rawCapture("005E", ["005E"], [
    ...prelude(), ...cadenceFrames(16, 10, 0, () => ["00A0"]),
  ]);
  const oneCycle = rawCapture("004E", ["004E"], [
    ...prelude(), ...cadenceFrames(16, 42.5, 0, () => ["00A0"]),
  ]);

  const memWords = frameId => initialWords[frameId] || ["00A0"];
  const memFrames = [
    ...prelude(), ...cadenceFrames(16, 15, 0, (_, id) => memWords(id)),
    ...cadenceFrames(2, 10, 0, () => ["00A0"]),
  ];
  const mem = rawCapture("MEM", ["42F3", "22D3"], memFrames);
  const memOff0 = rawCapture("MEM_OFF0", ["42F3", "22D3"], structuredClone(memFrames));
  const memSingle = rawCapture("MEM_SINGLE", ["42F3"], [
    ...prelude(), ...cadenceFrames(16, 15, 0, (_, id) => memWords(id)),
  ]);
  const memParity = rawCapture("MEM_PARITY", ["42F3", "2293"], [
    ...prelude(), ...cadenceFrames(608, 15, 0, (index, id) => {
      if (id === 14) {
        const value = (0x19 - Math.floor(index / 16) * 5) & 0xff;
        return [`${value.toString(16).padStart(2, "0")}${dclVParityByte(value, id).toString(16).padStart(2, "0")}`];
      }
      return memWords(id);
    }),
  ]);

  const koeoEnvelope = ["01B0", "FF5F", "253E", "00A0"];
  const koeoFrames = cadenceFrames(232, 42.5, 8, (index, id) => {
    const words = [id <= 3 ? koeoEnvelope[id] : "00A0"];
    if (index === 211 || index === 216) words.push("11B1");
    if (id === 7 && index === 207) words[0] = "ACC0";
    if (id === 7 && index === 223) words[0] = "EC80";
    return words;
  });
  const koeo = rawCapture("KOEO", ["253E"], [...prelude(), ...koeoFrames]);

  const koerEnvelope = ["01B0", "FF5F", "253E", "00A0"];
  const koerFrames = cadenceFrames(1400, 42.5, 14, (index, id) => {
    const words = [id <= 3 ? koerEnvelope[id] : "00A0"];
    if (index >= 1378 && index <= 1381) words.push(["16C1", "72E1", "3845", "21C5"][index - 1378]);
    if (id === 7 && index === 1369) words[0] = "ACC0";
    if (id === 7 && index === 1385) words[0] = "EC80";
    return words;
  });
  // The 59.1 s phase marker lands on FID 7 after a slightly longer real-world interval.
  koerFrames[1385].periodMs += 185;
  const koer = rawCapture("KOER", ["253E"], [...prelude(), ...koerFrames]);
  return { stored260E, stored26A4, noAcceptance, oneCycle, mem, memOff0, memSingle, memParity, koeo, koer };
}

test("reference pairs preserve the 260E/26A4 timing distinction despite matching first-cycle words", () => {
  const result = compareReferencePair("260E-vs-26A4");
  assert.equal(result.verdict, "DIFFERENT");
  assert.equal(result.captureA.framePeriodMs, 42.5);
  assert.equal(result.captureB.framePeriodMs, 17.5);
  assert.ok(result.differences.some(item => item.field === "framePeriodMs"));
  assert.ok(result.similarities.some(item => item.field === "initialResponseBlock.F00_F03"));
  assert.ok(result.similarities.some(item => item.field === "initialResponseBlock.F04_F15"));
  assert.deepEqual(result.captureA.initialResponseBlock, result.captureB.initialResponseBlock);
  assert.deepEqual(result.captureA.initialResponseBlock.F04_F15, {
    F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90", F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
  });
  assert.match(result.summaryText, /real distinction|slower cadence/i);
});

test("reference 005E/004E pair distinguishes invalid parity from one-cycle structural acceptance", () => {
  const result = compareReferencePair("005E-vs-004E");
  assert.equal(result.captureA.framePeriodMs, 10.0);
  assert.equal(result.captureA.baselinePeriodMs, 10.0);
  assert.equal(result.captureA.parityIntegrity.valid, false);
  assert.equal(result.captureA.nonBaselineResponseFrameCount, 0);
  assert.equal(result.captureA.acceptance, "no acceptance; timing unchanged");
  assert.equal(result.captureB.framePeriodMs, 42.5);
  assert.equal(result.captureB.responseCadenceMs, 42.5);
  assert.equal(result.captureB.nonBaselineResponseFrameCount, 16);
  assert.equal(result.captureB.frameCount, 16);
  assert.equal(result.captureB.cycleCount, 1);
  assert.equal(result.captureB.parityIntegrity.valid, true);
  assert.deepEqual(result.captureA.decodedPidMap, {});
  assert.deepEqual(result.captureB.decodedPidMap, {});
  assert.match(result.summaryText, /no decoded PID map/i);
});

test("reference MEM pairs retain offset-hypothesis and continuation-request distinctions", () => {
  const off0 = compareReferencePair("MEM-vs-MEM_OFF0");
  assert.equal(off0.verdict, "SIMILAR_ON_MEASURED_FIELDS");
  assert.deepEqual(off0.captureA.sentCommandWords, ["42F3", "22D3"]);
  assert.deepEqual(off0.captureB.sentCommandWords, ["42F3", "22D3"]);
  assert.equal(off0.captureB.offsetCoverage, null);
  assert.match(off0.summaryText, /historical.*recording.*offset 0.*unresolved/i);
  assert.deepEqual(off0.captureA.initialResponseBlock, off0.captureB.initialResponseBlock);
  assert.equal(off0.captureA.responseDurationMs, 240);
  assert.equal(off0.captureB.responseDurationMs, 240);

  const single = compareReferencePair("MEM-vs-MEM_SINGLE");
  assert.deepEqual(single.captureA.sentCommandWords, ["42F3", "22D3"]);
  assert.deepEqual(single.captureB.sentCommandWords, ["42F3"]);
  assert.equal(single.captureA.nonBaselineResponseFrameCount, 16);
  assert.equal(single.captureB.nonBaselineResponseFrameCount, 16);
  assert.equal(single.captureA.responseCadenceMs, 15.0);
  assert.equal(single.captureB.responseCadenceMs, 15.0);
  assert.ok(single.differences.some(item => item.field === "continuationBlocks"));
  assert.match(single.summaryText, /only the initial 42F3 request/i);
});

test("reference MEM parity pair compares parity, sustained cadence, cycles, and changing words", () => {
  const result = compareReferencePair("MEM-vs-MEM_PARITY");
  assert.equal(result.captureA.sentCommandWords[1], "22D3");
  assert.equal(result.captureB.sentCommandWords[1], "2293");
  assert.equal(result.captureA.framePeriodMs, 15.0);
  assert.equal(result.captureB.framePeriodMs, 15.0);
  assert.ok(result.similarities.some(item => item.field === "framePeriodMs"));
  assert.equal(result.captureA.parityIntegrity.valid, false);
  assert.equal(result.captureB.parityIntegrity.valid, true);
  assert.equal(result.captureB.cycleCount, 38);
  assert.equal(result.captureB.responseCadenceMs, 15.0);
  assert.equal(result.captureB.nonBaselineResponseFrameCount, 608);
  assert.deepEqual(result.captureB.wordBehavior.changing, ["COUNTER"]);
  assert.match(result.captureB.continuationBlocks, /sustained continuation activity observed \(profile candidate 2293, ~38 response cycles, witness count 164\)/i);
});

test("MEM_PARITY continuation cycle counts follow full and partial transcript evidence", {
  skip: fs.existsSync(REAL_MEM_PARITY_PATH) ? false : `Real MEM_PARITY field capture not found at ${REAL_MEM_PARITY_PATH}`,
}, () => {
  const rawText = fs.readFileSync(REAL_MEM_PARITY_PATH, "utf8");
  const capture = { id: "32-152217-MEM_PARITY", variant: "MEM_PARITY", rawText };
  const full = compareCaptures(capture, capture).captureA;
  assert.equal(full.sustainedResponseCycles, 38);
  assert.equal(full.responseEntryCycles, 1);
  assert.match(full.continuationBlocks, /sustained continuation activity observed \(profile candidate 2293, ~38 response cycles, witness count 164\)/i);

  const lines = rawText.trim().split(/\r?\n/);
  const metadata = lines.filter(line => /^(?:TX_PAD|END)\s/.test(line));
  const partialText = [
    ...lines.slice(0, 2500).filter(line => !/^(?:TX_PAD|END)\s/.test(line)),
    ...metadata,
  ].join("\n");
  const partialCapture = { ...capture, rawText: partialText };
  const partial = compareCaptures(partialCapture, partialCapture).captureA;
  assert.equal(partial.sustainedResponseCycles, 18);
  assert.equal(partial.responseEntryCycles, 1);
  assert.match(partial.continuationBlocks, /sustained continuation activity observed \(profile candidate 2293, ~18 response cycles, witness count 164\)/i);
  assert.doesNotMatch(partial.continuationBlocks, /~38 response cycles/i);
});

test("MEM_PARITY entry-only and unavailable cycle evidence never use a fixed fallback", () => {
  const mixedCycle = rawCapture("MEM_PARITY", ["42F3", "2293"], [
    ...prelude(),
    { frameId: 0, periodMs: 10, words: [] },
    ...cadenceFrames(15, 15, 1, () => ["00A0"]),
  ]);
  const entryResult = compareCaptures(mixedCycle, mixedCycle).captureA;
  assert.equal(entryResult.sustainedResponseCycles, 0);
  assert.equal(entryResult.responseEntryCycles, 1);
  assert.match(entryResult.continuationBlocks, /profile candidate 2293, 1 entry response cycles, witness count 164/i);
  assert.doesNotMatch(entryResult.continuationBlocks, /~(?:38|39|41) response cycles/i);

  const noFrames = {
    id: "MEM_PARITY-no-frames",
    variant: "MEM_PARITY",
    rawText: [
      "TX_PAD slot=0 expected=01B0 observed=01B0 tx_us=1000 done_us=2000 match=1",
      "TX_PAD slot=1 expected=FF5F observed=FF5F tx_us=3000 done_us=4000 match=1",
      "TX_PAD slot=2 expected=42F3 observed=42F3 tx_us=5000 done_us=6000 match=1",
      "TX_PAD slot=3 expected=00A0 observed=00A0 tx_us=7000 done_us=8000 match=1",
      "END reason=16 witness_verified=9 pad_verified=4 words_started=4",
    ].join("\n"),
  };
  const unknown = compareCaptures(noFrames, noFrames).captureA;
  assert.equal(unknown.sustainedResponseCycles, null);
  assert.equal(unknown.responseEntryCycles, null);
  assert.match(unknown.continuationBlocks, /profile candidate 2293, unknown response cycles, witness count 9/i);
  assert.doesNotMatch(unknown.continuationBlocks, /~(?:38|39|41) response cycles/i);
});

test("reference KOEO/KOER pair separates static and dynamic results at the same command and cadence", () => {
  const result = compareReferencePair("KOEO-vs-KOER");
  assert.deepEqual(result.captureA.sentCommandWords, ["253E"]);
  assert.deepEqual(result.captureB.sentCommandWords, ["253E"]);
  assert.equal(result.captureA.framePeriodMs, 42.5);
  assert.equal(result.captureB.framePeriodMs, 42.5);
  assert.equal(result.captureA.responseDelayMs, 9000);
  assert.equal(result.captureB.responseDelayMs, 58600);
  assert.deepEqual(result.captureA.responseCodes, ["11B1"]);
  assert.deepEqual(result.captureB.responseCodes, ["16C1", "72E1", "3845", "21C5"]);
  assert.deepEqual(result.captureA.wordBehavior.transitions, { F07: ["ACC0", "EC80"] });
  assert.equal(result.captureB.cycleCount, 267);
  assert.match(result.summaryText, /ACC0 to EC80/i);
  assert.match(result.summaryText, /267 cycles/i);
});

test("comparison accepts parsed structures and transcript lines without mutating inputs", () => {
  const captureA = {
    id: "a", sentCommandWords: ["1234"], frames: [
      { words: { F00: "AAAA", F04: "0001" } },
      { words: { F00: "AAAA", F04: "0002" } },
    ],
    txWitnesses: [{ expected: "1234", observed: "1234", match: true }],
    parity: { valid: true, errors: 0 }, framePeriodMs: 10, durationMs: 20,
  };
  const captureB = {
    id: "b", commandWord: "1234", rawText: "TX_PAD expected=1234 observed=1234 match=1\nparity=valid parityErrors=0 framePeriodMs=10 frameCount=2 durationMs=20\n",
    initialResponseBlock: { F00: "AAAA", F04: "0002" },
  };
  const before = structuredClone([captureA, captureB]);
  const result = compareCaptures(captureA, captureB);
  assert.equal(result.captureA.txWitnessStatus, true);
  assert.equal(result.captureB.txWitnessStatus, true);
  assert.deepEqual(result.captureA.wordBehavior.changing, ["F04"]);
  assert.equal(result.captureB.framePeriodMs, 10);
  assert.deepEqual([captureA, captureB], before);
});

test("real RX/RXB transcript pairs reconstruct cadence, response blocks, continuation, and delayed markers", () => {
  const raw = rawFixtures();

  const stored = compareCaptures(raw.stored260E, raw.stored26A4);
  assert.equal(stored.verdict, "DIFFERENT");
  assert.deepEqual(stored.captureA.sentCommandWords, ["260E"]);
  assert.deepEqual(stored.captureB.sentCommandWords, ["26A4"]);
  assert.equal(stored.captureA.txWitnessStatus, true);
  assert.deepEqual(stored.captureA.requestEnvelope, ["01B0", "FF5F", "260E", "00A0"]);
  assert.equal(stored.captureA.primaryCommandWord, "260E");
  assert.equal(stored.captureA.verifiedTxWitnesses, 4);
  assert.equal(stored.captureA.wordsStarted, 4);
  assert.deepEqual(stored.captureA.continuationWords, []);
  assert.match(stored.captureA.continuationBlocks, /initial request only; no continuation request observed/i);
  assert.deepEqual(stored.captureB.requestEnvelope, ["01B0", "FF5F", "26A4", "00A0"]);
  assert.match(stored.captureB.continuationBlocks, /initial request only; no continuation request observed/i);
  assert.deepEqual(stored.captureA.txWitnesses[2], { expected: "260E", observed: "260E", match: true, verified: true });
  assert.equal(stored.captureA.txWitnessDetails.length, 4);
  assert.deepEqual(stored.captureA.txWitnessDetails[2], {
    frameId: 14, frameIndex: 0, slot: 2, expected: "260E", observed: "260E",
    match: true, verified: true, t_us: 1_006_500,
  });
  assert.equal(stored.captureA.baselinePeriodMs, 10);
  assert.equal(stored.captureA.responseCadenceMs, 42.5);
  assert.equal(stored.captureB.responseCadenceMs, 17.5);
  assert.equal(stored.captureA.nonBaselineResponseFrameCount, 16);
  assert.deepEqual(stored.captureA.initialResponseBlock, stored.captureB.initialResponseBlock);
  assert.deepEqual(stored.captureA.initialResponseBlock.F00_F03, { F00: "72E1" });
  assert.deepEqual(stored.captureA.initialResponseBlock.F04_F15, {
    F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90", F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
  });
  assert.ok(stored.captureA.independentResponseCandidates.some(word => word.frameId === 8 && word.slot === 1 && word.hex === "00A0"));
  assert.ok(stored.captureA.independentResponseCandidates.some(word => word.frameId === 9 && word.slot === 1 && word.hex === "00A0"));
  assert.deepEqual(stored.captureA.repeatedEnvelopeWords, []);
  assert.ok(stored.captureA.initialResponseObservations.some(word => word.frameId === 0 && word.slot === 1 && word.hex === "72E1" && Number.isFinite(word.t_us)));
  assert.equal(stored.captureA.initialResponseObservations.some(word => ["01B0", "FF5F", "260E"].includes(word.hex)), false);
  assert.ok(stored.differences.some(item => item.field === "responseCadenceMs"));
  assert.ok(stored.similarities.some(item => item.field === "initialResponseBlock.F00_F03"));
  assert.ok(stored.similarities.some(item => item.field === "initialResponseBlock.F04_F15"));
  assert.match(stored.summaryText, /response cadence differs/i);
  assert.match(stored.summaryText, /Initial response words F00\.\.F03/i);

  const acceptance = compareCaptures(raw.noAcceptance.rawText, raw.oneCycle.rawText);
  assert.equal(acceptance.verdict, "DIFFERENT");
  assert.equal(acceptance.captureA.baselinePeriodMs, 10);
  assert.equal(acceptance.captureA.responseCadenceMs, null);
  assert.equal(acceptance.captureA.nonBaselineResponseFrameCount, 0);
  assert.equal(acceptance.captureB.responseCadenceMs, 42.5);
  assert.equal(acceptance.captureB.cycleCount, 1);
  assert.equal(acceptance.captureA.decodedPidMap, null);
  assert.equal(acceptance.captureB.decodedPidMap, null);
  assert.ok(acceptance.differences.some(item => item.field === "nonBaselineResponseFrameCount"));
  assert.match(acceptance.summaryText, /non-baseline response frame count differs/i);

  const off0 = compareCaptures(raw.mem, raw.memOff0);
  assert.equal(off0.verdict, "SIMILAR_ON_MEASURED_FIELDS");
  assert.deepEqual(off0.captureA.initialResponseBlock, off0.captureB.initialResponseBlock);
  assert.equal(off0.captureA.responseCadenceMs, 15);
  assert.equal(off0.captureA.nonBaselineResponseFrameCount, 16);
  assert.equal(off0.captureA.cycleCount, 1);
  assert.equal(off0.captureA.witnessVerifiedCount, 244);
  assert.equal(off0.captureA.verifiedTxWitnesses, 4);
  assert.deepEqual(off0.captureA.requestEnvelope, ["01B0", "FF5F", "42F3", "00A0"]);
  assert.deepEqual(off0.captureA.sentCommandWords, ["42F3", "22D3"]);
  assert.deepEqual(off0.captureA.continuationWords, []);
  assert.match(off0.captureA.continuationBlocks, /continuation activity observed \(profile candidate 22D3, witness count 244\); individual continuation words not independently PAD-verified/i);
  assert.match(off0.captureB.evidence, /historical.*recording.*offset 0.*unresolved/i);
  assert.ok(off0.similarities.some(item => item.field === "initialResponseBlock.F04_F15"));
  assert.equal(off0.captureB.offsetCoverage, null);

  const single = compareCaptures(raw.mem, raw.memSingle);
  assert.equal(single.verdict, "DIFFERENT");
  assert.equal(single.captureA.responseFrameCount, 16);
  assert.equal(single.captureB.responseFrameCount, 16);
  assert.equal(single.captureA.cycleCount, 1);
  assert.equal(single.captureB.cycleCount, 1);
  assert.match(single.captureA.continuationBlocks, /continuation activity observed \(profile candidate 22D3, witness count 244\); individual continuation words not independently PAD-verified/i);
  assert.match(single.captureB.continuationBlocks, /initial request only; no continuation request observed/i);
  assert.deepEqual(single.captureB.requestEnvelope, ["01B0", "FF5F", "42F3", "00A0"]);
  assert.deepEqual(single.captureB.sentCommandWords, ["42F3"]);
  assert.deepEqual(single.captureB.continuationWords, []);
  assert.equal(single.captureB.witnessVerifiedCount, 4);
  assert.ok(single.differences.some(item => item.field === "sentCommandWords"));

  const parity = compareCaptures(raw.mem, raw.memParity);
  assert.equal(parity.verdict, "DIFFERENT");
  assert.equal(parity.captureA.responseCadenceMs, 15);
  assert.equal(parity.captureB.responseCadenceMs, 15);
  assert.equal(parity.captureA.nonBaselineResponseFrameCount, 16);
  assert.equal(parity.captureB.nonBaselineResponseFrameCount, 608);
  assert.equal(parity.captureB.cycleCount, 38);
  assert.equal(parity.captureB.witnessVerifiedCount, 164);
  assert.match(parity.captureB.continuationBlocks, /sustained continuation activity observed \(profile candidate 2293, ~38 response cycles, witness count 164\)/i);
  assert.ok(parity.captureB.wordBehavior.changing.some(word => /F14\/IW1/.test(word)));
  assert.ok(parity.differences.some(item => item.field === "nonBaselineResponseFrameCount"));

  const selfTest = compareCaptures(raw.koeo, raw.koer);
  assert.equal(selfTest.verdict, "DIFFERENT");
  assert.deepEqual(selfTest.captureA.sentCommandWords, ["253E"]);
  assert.deepEqual(selfTest.captureB.sentCommandWords, ["253E"]);
  assert.match(selfTest.captureA.continuationBlocks, /initial request only; no continuation request observed/i);
  assert.match(selfTest.captureB.continuationBlocks, /initial request only; no continuation request observed/i);
  assert.deepEqual(selfTest.captureA.responseCodes, ["11B1"]);
  assert.deepEqual(selfTest.captureB.responseCodes, ["16C1", "72E1", "3845", "21C5"]);
  assert.equal(selfTest.captureA.initialResponseBlock.F00_F03.F00, "11B1");
  assert.equal(selfTest.captureB.initialResponseBlock.F00_F03.F00, "16C1");
  assert.equal(selfTest.captureB.initialResponseBlock.F00_F03.F01, "72E1");
  assert.equal(selfTest.captureB.initialResponseBlock.F00_F03.F02, "3845");
  assert.equal(selfTest.captureB.initialResponseBlock.F00_F03.F03, "21C5");
  assert.ok(selfTest.captureA.independentResponseCandidates.some(word => word.frameId === 0 && word.slot === 2 && word.hex === "11B1"));
  assert.deepEqual(selfTest.captureB.independentResponseCandidates
    .filter(word => word.frameId <= 3 && word.slot === 2 && ["16C1", "72E1", "3845", "21C5"].includes(word.hex))
    .map(({ frameId, slot, hex }) => [frameId, slot, hex]), [
    [0, 2, "16C1"], [1, 2, "72E1"], [2, 2, "3845"], [3, 2, "21C5"],
  ]);
  assert.ok(selfTest.captureB.repeatedEnvelopeWords.length > 0);
  assert.deepEqual(selfTest.captureB.repeatedEnvelopeWords[0], {
    frameId: 0, slot: 1, hex: "01B0", t_us: selfTest.captureB.repeatedEnvelopeWords[0].t_us,
    reason: "UNATTRIBUTED_ENVELOPE_REPETITION",
  });
  assert.ok(Number.isFinite(selfTest.captureB.repeatedEnvelopeWords[0].t_us));
  assert.ok(selfTest.captureB.repeatedEnvelopeWords.every(word => word.slot === 1 && word.frameId <= 3));
  assert.equal(selfTest.captureB.initialResponseObservations.some(word =>
    word.frameId <= 3 && word.slot === 1 && ["01B0", "FF5F", "253E", "00A0"].includes(word.hex)), false);
  assert.ok(Math.abs(selfTest.captureA.responseDelayMs - 9000) < 100);
  assert.ok(Math.abs(selfTest.captureB.responseDelayMs - 58600) < 100);
  assert.ok(selfTest.captureA.phaseTransitions.some(item => item.frameId === 7 && item.slot === 1 && item.from === "ACC0" && item.to === "EC80" && Math.abs(item.delayMs - 9500) < 100));
  assert.ok(selfTest.captureB.phaseTransitions.some(item => item.frameId === 7 && item.slot === 1 && item.from === "ACC0" && item.to === "EC80" && Math.abs(item.delayMs - 59100) < 100));
  assert.ok(selfTest.differences.some(item => item.field === "responseCodes"));
  assert.ok(selfTest.differences.some(item => item.field === "responseDelayMs"));

  assert.deepEqual(JSON.parse(exportComparisonJson(stored)), stored);
  assert.equal(exportComparisonJson(stored), exportComparisonJson(compareCaptures(raw.stored260E, raw.stored26A4)));
  assert.equal(exportComparisonCsv(stored), exportComparisonCsv(compareCaptures(raw.stored260E, raw.stored26A4)));

  const multiSlot = rawCapture("MULTI_SLOT", ["1234"], [
    ...prelude(), ...cadenceFrames(1, 42.5, 0, () => ["72E1", "00A0"]),
  ]);
  const multiSlotResult = compareCaptures(multiSlot, multiSlot);
  assert.deepEqual(multiSlotResult.captureA.initialResponseBlock.F00_F03.F00, { IW1: "72E1", IW2: "00A0" });

  const echoOnly = rawCapture("ECHO_ONLY", ["260E"], [
    ...prelude(), ...cadenceFrames(1, 42.5, 0, () => []),
  ]);
  const echoResult = compareCaptures(echoOnly, echoOnly);
  assert.equal(echoResult.captureA.initialResponseBlock, null);
  assert.deepEqual(echoResult.captureA.initialResponseObservations, []);
  assert.deepEqual(echoResult.captureA.txEchoWords.map(word => word.hex), ["01B0", "FF5F", "260E", "00A0"]);
  assert.deepEqual(echoResult.captureA.txEchoWords.map(({ frameId, slot }) => [frameId, slot]), [[14, 1], [14, 2], [14, 3], [15, 1]]);
  assert.ok(echoResult.captureA.txEchoWords.every(word => Number.isFinite(word.t_us)));

  const independentlyWitnessed = raw.mem.rawText.replace(
    "END reason=16",
    "TX_PAD slot=4 expected=22D3 observed=22D3 tx_us=1016000 done_us=1018000 match=1\nEND reason=16",
  );
  const independentResult = compareCaptures({ id: "MEM", label: "MEM", rawText: independentlyWitnessed }, raw.memSingle);
  assert.deepEqual(independentResult.captureA.continuationWords, ["22D3"]);
  assert.deepEqual(independentResult.captureA.sentCommandWords, ["42F3", "22D3"]);
  assert.match(independentResult.captureA.continuationBlocks, /continuation request observed \(22D3\)/i);

  const unknown = compareCaptures("RX t_us=1 byte=AA", "RX t_us=2 byte=AA");
  assert.equal(unknown.captureA.baselinePeriodMs, null);
  assert.equal(unknown.captureA.responseCadenceMs, null);
  assert.equal(unknown.captureA.nonBaselineResponseFrameCount, null);
});

test("all six built-in reference comparisons return stable structured results", () => {
  for (const pair of REFERENCE_COMPARISON_PAIRS) {
    const first = compareReferencePair(pair.id);
    const second = compareReferencePair(pair.id);
    assert.equal(first.verdict, pair.id === "MEM-vs-MEM_OFF0" ? "SIMILAR_ON_MEASURED_FIELDS" : "DIFFERENT", pair.id);
    assert.deepEqual(first, second, pair.id);
    assert.ok(Array.isArray(first.differences));
    assert.ok(Array.isArray(first.similarities));
    assert.ok(first.summaryText.length > 0);
  }
  assert.throws(() => compareReferencePair("missing"), /Unknown reference comparison pair/);
});

test("JSON and CSV exports include comparison data with escaped cells", () => {
  const result = compareReferencePair("260E-vs-26A4");
  const json = exportComparisonJson(result);
  assert.deepEqual(JSON.parse(json), result);
  const csv = exportComparisonCsv(result);
  assert.match(csv, /^"record_type","field","capture_a","capture_b","description","verdict","summary_text"\r\n/);
  assert.match(csv, /"difference","framePeriodMs"/);
  assert.match(csv, /"similarity","initialResponseBlock\.F00_F03"/);
  assert.match(csv, /slower cadence is a real distinction/);
});
