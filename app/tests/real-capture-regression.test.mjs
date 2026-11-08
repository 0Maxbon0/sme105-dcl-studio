import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyCycles } from "../js/analysis-ui.js";
import { compareCaptures } from "../js/capture-comparison.js";
import { analyzeMemCycles, parseRawTranscript } from "../js/frame-inspector.js";

const CAPTURES_DIR = "/home/maxim/maximizotech/sme105-field-evidence/phone-2026-11-08-readonly-audit/reconstructed-captures";
const CAPTURES_AVAILABLE = fs.existsSync(CAPTURES_DIR);
const FIXTURE_SKIP_REASON = CAPTURES_AVAILABLE
  ? false
  : `External real field capture fixtures not found at ${CAPTURES_DIR}; run on host with vehicle recordings`;

function readCapture(captureId) {
  return fs.readFileSync(path.join(CAPTURES_DIR, captureId, "raw.txt"), "utf8");
}

function capture(captureId, variant, rawText = readCapture(captureId)) {
  return { id: captureId, variant, rawText };
}

function testWithRealCaptures(name, callback) {
  test(name, { skip: FIXTURE_SKIP_REASON }, callback);
}

testWithRealCaptures("real KOER and KOEO separate TX echoes, repeated envelopes, and response candidates", () => {
  const koerRaw = readCapture("34-152500-KOER");
  const koeoRaw = readCapture("33-152320-KOEO");
  const koerParsed = parseRawTranscript(koerRaw);
  const koeoParsed = parseRawTranscript(koeoRaw);
  const comparison = compareCaptures(
    capture("34-152500-KOER", "KOER", koerRaw),
    capture("33-152320-KOEO", "KOEO", koeoRaw),
  );
  const koer = comparison.captureA;
  const koeo = comparison.captureB;
  const envelope = ["01B0", "FF5F", "253E", "00A0"];

  assert.ok(koerParsed.frames.length > 0);
  assert.ok(koeoParsed.frames.length > 0);
  assert.equal(comparison.verdict, "DIFFERENT");
  assert.deepEqual(koer.requestEnvelope, envelope);
  assert.deepEqual(koeo.requestEnvelope, envelope);

  assert.equal(koerParsed.txWitnesses.length, 4);
  assert.deepEqual(koer.txEchoWords.map(({ frameId, slot, hex, echoOf }) => ({ frameId, slot, hex, echoOf })), [
    { frameId: 0, slot: 1, hex: "01B0", echoOf: 0 },
    { frameId: 1, slot: 1, hex: "FF5F", echoOf: 1 },
    { frameId: 2, slot: 1, hex: "253E", echoOf: 2 },
    { frameId: 3, slot: 1, hex: "00A0", echoOf: 3 },
  ]);
  assert.deepEqual(koer.txWitnessDetails.map(({ expected, observed, match, verified }) => ({ expected, observed, match, verified })),
    envelope.map(word => ({ expected: word, observed: word, match: true, verified: true })));

  for (const [frameId, word] of envelope.entries()) {
    assert.ok(koer.repeatedEnvelopeWords.some(observation =>
      observation.frameId === frameId && observation.slot === 1 && observation.hex === word &&
      observation.reason === "UNATTRIBUTED_ENVELOPE_REPETITION"));
    assert.ok(koeo.repeatedEnvelopeWords.some(observation =>
      observation.frameId === frameId && observation.slot === 1 && observation.hex === word &&
      observation.reason === "UNATTRIBUTED_ENVELOPE_REPETITION"));
  }

  assert.deepEqual(koer.initialResponseBlock, {
    F00_F03: { F00: "16C1", F01: "72E1", F02: "3845", F03: "21C5" },
    F04_F15: {
      F04: "25D0", F05: "25D0", F06: "1F40", F07: "ACC0",
      F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
    },
  });
  for (const [frameId, word] of ["16C1", "72E1", "3845", "21C5"].entries()) {
    assert.ok(koer.independentResponseCandidates.some(observation =>
      observation.frameId === frameId && observation.slot === 2 && observation.hex === word));
    assert.equal(koer.independentResponseCandidates.some(observation =>
      observation.frameId === frameId && observation.slot === 1 && observation.hex === envelope[frameId]), false);
  }

  assert.deepEqual(koeo.initialResponseBlock.F00_F03, { F00: "11B1" });
  assert.notEqual(koeo.initialResponseBlock.F00_F03.F00, "01B0");
  assert.ok(koeo.independentResponseCandidates.some(observation =>
    observation.frameId === 0 && observation.slot === 2 && observation.hex === "11B1"));
});

testWithRealCaptures("real MEM_PARITY cycles classify the 10-to-15 ms entry and sustained response", () => {
  const parsed = parseRawTranscript(readCapture("32-152217-MEM_PARITY"));
  const mem = analyzeMemCycles(parsed.frames);
  const classification = classifyCycles(mem.cycles);

  assert.deepEqual(classification, {
    genericCartCycles: 41,
    responseEntryCycles: 1,
    sustainedResponseCycles: 38,
    memResponseCycles: 39,
    incompleteCycles: 1,
  });

  const descendingPrefix = ["19", "14", "0F", "0A", "05", "FF"];
  for (const frameId of [14, 15]) {
    const counter = mem.candidateCounters.find(candidate => candidate.frameId === frameId);
    assert.ok(counter, `expected candidate counter for frame ${frameId}`);
    assert.equal(counter.type, "MEM_PARITY_COUNTER_CANDIDATE");
    assert.deepEqual(counter.sequence.slice(0, descendingPrefix.length), descendingPrefix);
    assert.deepEqual(counter.cycles.slice(0, descendingPrefix.length), [3, 4, 5, 6, 7, 8]);
  }
});

testWithRealCaptures("real MEM and MEM_SINGLE distinguish continuation activity from the initial request", () => {
  const memRaw = readCapture("29-152110-MEM");
  const singleRaw = readCapture("31-152200-MEM_SINGLE");
  const comparison = compareCaptures(
    capture("29-152110-MEM", "MEM", memRaw),
    capture("31-152200-MEM_SINGLE", "MEM_SINGLE", singleRaw),
  );
  const mem = comparison.captureA;
  const single = comparison.captureB;
  const memCycles = classifyCycles(analyzeMemCycles(parseRawTranscript(memRaw).frames).cycles);
  const singleCycles = classifyCycles(analyzeMemCycles(parseRawTranscript(singleRaw).frames).cycles);

  assert.deepEqual(mem.requestEnvelope, ["01B0", "FF5F", "42F3", "00A0"]);
  assert.deepEqual(single.requestEnvelope, ["01B0", "FF5F", "42F3", "00A0"]);
  assert.deepEqual(single.continuationWords, []);
  assert.equal(single.continuationBlocks, "initial request only; no continuation request observed");
  assert.equal(single.witnessVerifiedCount, 4);
  assert.match(mem.continuationBlocks, /continuation activity observed \(profile candidate 22D3, witness count 244\)/);
  assert.match(mem.continuationBlocks, /not independently PAD-verified/);
  assert.equal(mem.witnessVerifiedCount, 244);
  assert.equal(memCycles.responseEntryCycles, 1);
  assert.equal(singleCycles.responseEntryCycles, 1);
});

testWithRealCaptures("real stored-code captures preserve matching words while distinguishing cadence", () => {
  const comparison = compareCaptures(
    capture("21-151911-0E", "0E"),
    capture("22-151922-A4", "A4"),
  );
  const expectedInitialBlock = {
    F00_F03: { F00: "72E1" },
    F04_F15: {
      F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90",
      F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
    },
  };

  assert.equal(comparison.verdict, "DIFFERENT");
  assert.deepEqual(comparison.captureA.requestEnvelope, ["01B0", "FF5F", "260E", "00A0"]);
  assert.deepEqual(comparison.captureB.requestEnvelope, ["01B0", "FF5F", "26A4", "00A0"]);
  assert.equal(comparison.captureA.responseCadenceMs, 42.5);
  assert.equal(comparison.captureB.responseCadenceMs, 17.5);
  assert.deepEqual(comparison.captureA.initialResponseBlock, expectedInitialBlock);
  assert.deepEqual(comparison.captureB.initialResponseBlock, expectedInitialBlock);
  assert.deepEqual(comparison.captureA.initialResponseBlock, comparison.captureB.initialResponseBlock);
  for (const comparedCapture of [comparison.captureA, comparison.captureB]) {
    assert.equal(comparedCapture.initialResponseBlock.F04_F15.F08, "00A0");
    assert.equal(comparedCapture.initialResponseBlock.F04_F15.F09, "00A0");
    assert.ok(comparedCapture.independentResponseCandidates.some(observation =>
      observation.frameId === 8 && observation.slot === 1 && observation.hex === "00A0"));
    assert.ok(comparedCapture.independentResponseCandidates.some(observation =>
      observation.frameId === 9 && observation.slot === 1 && observation.hex === "00A0"));
  }
});

testWithRealCaptures("real 005E and 004E captures distinguish no acceptance from one response cycle", () => {
  const noAcceptanceRaw = readCapture("24-151944-PIDMAP");
  const oneCycleRaw = readCapture("25-151954-PIDMAP_ALT");
  const comparison = compareCaptures(
    capture("24-151944-PIDMAP", "PIDMAP", noAcceptanceRaw),
    capture("25-151954-PIDMAP_ALT", "PIDMAP_ALT", oneCycleRaw),
  );
  const noAcceptance = comparison.captureA;
  const oneCycle = comparison.captureB;
  const oneCycleParsed = parseRawTranscript(oneCycleRaw);
  const responseCadenceFrames = oneCycleParsed.frames.filter(frame => frame.periodUs > 10_100);

  assert.equal(comparison.verdict, "DIFFERENT");
  assert.deepEqual(noAcceptance.requestEnvelope, ["01B0", "FF5F", "005E", "00A0"]);
  assert.deepEqual(oneCycle.requestEnvelope, ["01B0", "FF5F", "004E", "00A0"]);
  assert.equal(noAcceptance.baselinePeriodMs, 10);
  assert.equal(noAcceptance.responseCadenceMs, null);
  assert.equal(noAcceptance.nonBaselineResponseFrameCount, 0);
  assert.equal(oneCycle.responseCadenceMs, 42.5);
  assert.equal(oneCycle.nonBaselineResponseFrameCount, 16);
  assert.equal(responseCadenceFrames.length, 16);
  assert.deepEqual(responseCadenceFrames.map(frame => frame.frameId).sort((a, b) => a - b),
    Array.from({ length: 16 }, (_, frameId) => frameId));
  assert.equal(noAcceptance.decodedPidMap, null);
  assert.equal(oneCycle.decodedPidMap, null);
});
