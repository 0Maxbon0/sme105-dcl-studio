/** Offline, read-only DCL transcript inspection. No transport or vehicle I/O. */
import { dclVParityByte, parseFields, parseLine } from "./protocol.js";

const UINT32 = 0x100000000;
const REFLECTION_WINDOW_US = 2600;
const FRAME_PERIOD_EXPECTED_US = 42500;
const MEM_PATTERN = [0x19, 0x14, 0x0f, 0x0a, 0x05, 0xff, 0xfa, 0xf5, 0xf0];
const HYPOTHESIS_TAG = "[HYPOTHESIS - UNPROVEN FOR SME-105]";

function textLines(input) {
  if (Array.isArray(input)) return input.map((line) => typeof line === "string" ? line : String(line?.raw || ""));
  return String(input ?? "").split(/\r?\n/);
}

function hexByte(value) {
  return Number(value).toString(16).padStart(2, "0").toUpperCase();
}

function normalizeHex(value) {
  return String(value ?? "").replace(/^0x/i, "").replace(/[^0-9a-f]/gi, "").toUpperCase();
}

function isValidWord(firstByte, secondByte) {
  return dclVParityByte(firstByte, secondByte & 0x0f) === secondByte;
}

function unwrapNext(raw, state, errors, source = "RX") {
  const value = Number(raw) >>> 0;
  if (state.lastRaw === null) {
    state.lastRaw = value;
    state.lastExpanded = value;
    return value;
  }
  const delta = (value - state.lastRaw + UINT32) % UINT32;
  if (delta > 0x7fffffff) {
    errors.push({ type: "timestamp", source, raw: value, reason: "TIMESTAMP_REVERSED" });
    state.lastRaw = value;
    return state.lastExpanded;
  }
  state.lastRaw = value;
  state.lastExpanded += delta;
  return state.lastExpanded;
}

function nearestEpoch(raw, anchor) {
  if (raw === null || raw === undefined || !Number.isFinite(Number(raw))) return null;
  const value = Number(raw) >>> 0;
  if (!Number.isFinite(anchor)) return value;
  const base = Math.floor(anchor / UINT32) * UINT32 + value;
  const options = [base - UINT32, base, base + UINT32];
  return options.reduce((best, candidate) => Math.abs(candidate - anchor) < Math.abs(best - anchor) ? candidate : best);
}

function normalizedLine(raw) {
  let line = String(raw).trim();
  if (line.startsWith("RXB ")) {
    line = line.replace(/\bbytes=/, "data=").replace(/\bdata=([0-9a-f]+)/i, (_, hex) => `data=${hex.toUpperCase()}`);
  } else if (line.startsWith("RX ")) {
    line = line.replace(/\bbyte=([0-9a-f]{2})/i, (_, byte) => `byte=${byte.toUpperCase()}`);
  }
  return line;
}

function validHeaderAt(events, index) {
  if (events[index]?.byte !== 0 || events[index + 1]?.byte !== 0 || index + 3 >= events.length) return null;
  const quartet = events.slice(index, index + 4);
  const gaps = quartet.slice(1).map((event, offset) => event.t_us - quartet[offset].t_us);
  if (gaps.some((gap) => gap < 0 || gap > 3500)) return null;
  const data = quartet[2].byte;
  const parity = quartet[3].byte;
  return {
    start: index,
    end: index + 4,
    t_us: quartet[0].t_us,
    frameId: parity & 0x0f,
    data,
    parity,
    parityValid: isValidWord(data, parity),
    rawBytes: quartet.map((event) => event.byte),
  };
}

function selectHeaders(events) {
  const candidates = [];
  for (let index = 0; index < events.length - 3; index += 1) {
    const candidate = validHeaderAt(events, index);
    if (candidate) candidates.push(candidate);
  }
  const headers = [];
  for (const candidate of candidates) {
    const previous = headers.at(-1);
    if (!previous) {
      // A valid VPARITY header is the strongest synchronization point. If the
      // recording begins in a damaged header, retain its first sync quartet.
      if (candidate.parityValid || !candidates.some((item) => item !== candidate && item.parityValid && item.start < candidate.start)) {
        headers.push(candidate);
      }
      continue;
    }
    if (candidate.start < previous.end) continue;
    const elapsed = candidate.t_us - previous.t_us;
    if (elapsed < 4000) continue;
    const expectedId = (previous.frameId + 1) & 0x0f;
    if (candidate.parityValid || candidate.frameId === expectedId) headers.push(candidate);
  }
  return headers;
}

function decodedMeaning(hex) {
  const meanings = {
    "11B1": `Candidate Ford self-test code 11 (pass) ${HYPOTHESIS_TAG}`,
    "16C1": `Candidate Ford self-test code 16 ${HYPOTHESIS_TAG}`,
    "72E1": `Candidate Ford self-test code 72 ${HYPOTHESIS_TAG}`,
    "3845": `Candidate Ford self-test code 38 ${HYPOTHESIS_TAG}`,
    "21C5": `Candidate Ford self-test code 21 ${HYPOTHESIS_TAG}`,
    "ACC0": `Candidate self-test phase marker ${HYPOTHESIS_TAG}`,
    "EC80": `Candidate self-test result-phase marker ${HYPOTHESIS_TAG}`,
  };
  return meanings[hex] || null;
}

function createWord({ first, second, t_us, slot, frameId, source = "RX", rawBytes = null }) {
  const hex = `${hexByte(first)}${hexByte(second)}`;
  const parityValid = isValidWord(first, second);
  const meaning = decodedMeaning(hex);
  return {
    t_us,
    frameId,
    slot,
    slotName: `IW${slot}`,
    firstByte: first,
    secondByte: second,
    value: ((first << 8) | second) >>> 0,
    hex,
    rawBytes: rawBytes || [first, second],
    parityValid,
    expectedParity: dclVParityByte(first, second & 0x0f),
    classification: slot === 0 ? "FRAME_HEADER" : parityValid ? "RESPONSE_CANDIDATE" : "UNRESOLVED",
    decodedMeaning: meaning,
    meaningClassification: meaning ? "DECODED_MEANING" : null,
    source,
    echoOf: null,
    changed: false,
  };
}

function makeTxWitness(parsed, rawLine, anchor) {
  const fields = parsed?.fields || parseFields(rawLine);
  const expected = normalizeHex(fields.expected).slice(-4).padStart(normalizeHex(fields.expected).length ? 4 : 0, "0");
  const observed = normalizeHex(fields.observed).slice(-4).padStart(normalizeHex(fields.observed).length ? 4 : 0, "0");
  const match = fields.match === undefined ? expected !== "" && expected === observed : Number(fields.match) === 1;
  const verified = match && expected !== "" && expected === observed;
  const tRaw = fields.tx_us ?? fields.done_us ?? null;
  const t_us = tRaw === null ? null : nearestEpoch(tRaw, anchor);
  return {
    type: "tx_witness",
    classification: verified ? "TX_WITNESS" : "UNRESOLVED",
    slot: fields.slot === undefined ? null : Number(fields.slot),
    expected,
    observed,
    match,
    verified,
    t_us,
    raw: rawLine,
    fields,
    frameIndex: null,
  };
}

function assignEchoesAndWitnesses(frames, words, witnesses) {
  const allFrameWords = frames.flatMap((frame) => frame.words);
  for (const witness of witnesses) {
    if (witness.t_us !== null) {
      const frame = [...frames].reverse().find((item) => item.t_us <= witness.t_us) || frames[0];
      if (frame) {
        witness.frameIndex = frame.index;
        frame.txWitnesses.push(witness);
      }
    }
    if (!witness.verified || witness.t_us === null) continue;
    const matching = allFrameWords
      .filter((word) => word.slot >= 1 && word.hex === witness.expected && Math.abs(word.t_us - witness.t_us) <= REFLECTION_WINDOW_US)
      .sort((a, b) => Math.abs(a.t_us - witness.t_us) - Math.abs(b.t_us - witness.t_us))[0];
    if (matching) {
      matching.classification = "ECHO";
      matching.echoOf = witness.slot;
      matching.txWitness = witness;
      witness.echoWord = matching;
    }
  }

  const previous = new Map();
  for (const word of words) {
    const key = `${word.frameId}:${word.slot}`;
    const old = previous.get(key);
    word.changed = Boolean(old && old.hex !== word.hex);
    previous.set(key, word);
  }
}

/** Parse bridge RX/RXB, TX_PAD, STATUS and END transcript records offline. */
export function parseRawTranscript(transcriptTextOrLines) {
  const errors = [];
  const bytes = [];
  const txWitnesses = [];
  const statusEvents = [];
  const endEvents = [];
  const timestampState = { lastRaw: null, lastExpanded: null };

  for (const original of textLines(transcriptTextOrLines)) {
    if (!original) continue;
    const line = normalizedLine(original);
    if (/^RXB?\s/.test(line)) {
      const parsed = parseLine(line);
      if (parsed.type === "rx") {
        const expanded = unwrapNext(parsed.t_us, timestampState, errors);
        bytes.push({ ...parsed, t_us: expanded, rawT_us: parsed.t_us, rawLine: original });
      } else if (parsed.type === "rx_batch") {
        for (const event of parsed.events) {
          const expanded = unwrapNext(event.t_us, timestampState, errors);
          bytes.push({ ...event, t_us: expanded, rawT_us: event.t_us, rawLine: original });
        }
      } else {
        errors.push({ type: "parse", line: original, reason: parsed.reason || "RX_FORMAT" });
      }
    } else if (line.startsWith("TX_PAD ")) {
      const parsed = parseLine(line);
      txWitnesses.push(makeTxWitness(parsed, original, timestampState.lastExpanded));
    } else if (line.startsWith("STATUS ")) {
      const parsed = parseLine(line);
      statusEvents.push(parsed.type === "status" ? parsed : { raw: original, fields: parseFields(line) });
    } else if (line.startsWith("END ")) {
      const parsed = parseLine(line);
      endEvents.push(parsed.type === "end" ? parsed : { raw: original, fields: parseFields(line) });
    }
  }

  const headers = selectHeaders(bytes);
  const frames = [];
  const words = [];
  const used = new Set();
  for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
    const header = headers[headerIndex];
    const next = headers[headerIndex + 1];
    const frame = {
      index: frames.length,
      frameId: header.frameId,
      id: header.frameId,
      t_us: header.t_us,
      periodUs: frames.length ? header.t_us - frames.at(-1).t_us : null,
      dt: frames.length ? header.t_us - frames.at(-1).t_us : null,
      data: header.data,
      parity: header.parity,
      parityValid: header.parityValid,
      header: header.rawBytes.map(hexByte).join(" "),
      cycle: null,
      words: [],
      txWitnesses: [],
      errors: [],
    };
    const iw0 = createWord({
      first: header.data,
      second: header.parity,
      t_us: bytes[header.start + 2].t_us,
      slot: 0,
      frameId: frame.frameId,
      rawBytes: [header.data, header.parity],
    });
    frame.words.push(iw0);
    words.push(iw0);
    for (let byteIndex = header.start; byteIndex < header.end; byteIndex += 1) used.add(byteIndex);
    if (!header.parityValid) {
      const error = { type: "parity", frameIndex: frame.index, frameId: frame.frameId, t_us: frame.t_us, word: iw0.hex, reason: "HEADER_VPARITY_FAILURE" };
      frame.errors.push(error);
      errors.push(error);
    }

    const bodyEnd = next ? next.start : bytes.length;
    let cursor = header.end;
    let slot = 1;
    while (cursor + 1 < bodyEnd) {
      const first = bytes[cursor];
      const second = bytes[cursor + 1];
      const word = createWord({ first: first.byte, second: second.byte, t_us: first.t_us, slot, frameId: frame.frameId });
      frame.words.push(word);
      words.push(word);
      used.add(cursor);
      used.add(cursor + 1);
      if (!word.parityValid) {
        const error = { type: "parity", frameIndex: frame.index, frameId: frame.frameId, slot, t_us: word.t_us, word: word.hex, reason: "WORD_VPARITY_FAILURE" };
        frame.errors.push(error);
        errors.push(error);
      }
      cursor += 2;
      slot += 1;
    }
    if (cursor < bodyEnd) {
      const trailing = bytes[cursor];
      const malformed = {
        t_us: trailing.t_us,
        frameId: frame.frameId,
        slot,
        slotName: `IW${slot}`,
        firstByte: trailing.byte,
        secondByte: null,
        value: trailing.byte,
        hex: hexByte(trailing.byte),
        rawBytes: [trailing.byte],
        parityValid: false,
        expectedParity: null,
        classification: "UNRESOLVED",
        decodedMeaning: null,
        meaningClassification: null,
        source: "RX",
        echoOf: null,
        changed: false,
      };
      frame.words.push(malformed);
      words.push(malformed);
      used.add(cursor);
      const error = { type: "malformed", frameIndex: frame.index, frameId: frame.frameId, slot, t_us: trailing.t_us, byte: trailing.byte, reason: "ODD_FRAME_PAYLOAD_BYTE" };
      frame.errors.push(error);
      errors.push(error);
    }
    frames.push(frame);
  }

  if (!frames.length && bytes.length) {
    errors.push({ type: "frame", reason: "NO_DCL_HEADER", rxByteCount: bytes.length });
  }
  for (let i = 0; i < bytes.length; i += 1) {
    if (used.has(i)) continue;
    // Bytes preceding initial sync or between sync candidates are retained in
    // diagnostics rather than silently disappearing.
    if (i >= (headers[0]?.start ?? bytes.length) && headers.some((header) => header.start <= i && i < (headers[headers.indexOf(header) + 1]?.start ?? bytes.length))) continue;
    errors.push({ type: "unframed_byte", t_us: bytes[i].t_us, byte: bytes[i].byte, classification: "UNRESOLVED", reason: "BYTE_OUTSIDE_RECONSTRUCTED_FRAME" });
  }

  assignEchoesAndWitnesses(frames, words, txWitnesses);
  const periods = frames.map((frame) => frame.periodUs).filter((period) => Number.isFinite(period) && period > 0);
  const stats = {
    rxByteCount: bytes.length,
    frameCount: frames.length,
    headerCount: words.filter((word) => word.classification === "FRAME_HEADER").length,
    wordCount: words.length,
    txWitnessCount: txWitnesses.length,
    verifiedTxWitnessCount: txWitnesses.filter((witness) => witness.verified).length,
    echoCount: words.filter((word) => word.classification === "ECHO").length,
    responseCandidateCount: words.filter((word) => word.slot >= 1 && word.classification === "RESPONSE_CANDIDATE").length,
    parityFailureCount: words.filter((word) => word.parityValid === false && word.secondByte !== null).length,
    unresolvedCount: words.filter((word) => word.classification === "UNRESOLVED").length,
    errorCount: errors.length,
    meanFramePeriodUs: periods.length ? periods.reduce((sum, period) => sum + period, 0) / periods.length : null,
    minFramePeriodUs: periods.length ? Math.min(...periods) : null,
    maxFramePeriodUs: periods.length ? Math.max(...periods) : null,
    statusEvents,
    endEvents,
  };
  return { frames, words, txWitnesses, errors, stats };
}

function frameKey(frame) {
  return Number(frame.frameId ?? frame.id ?? frame.header?.frameId);
}

function wordHex(word) {
  return normalizeHex(word.hex ?? word.word ?? word.valueHex);
}

function wordGroups(frames) {
  const groups = new Map();
  for (const frame of frames || []) {
    const id = frameKey(frame);
    for (const word of frame.words || []) {
      if (word.slot === undefined) continue;
      const key = `${id}:${word.slot}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ cycle: frame.cycle, frameId: id, slot: word.slot, hex: wordHex(word), word, frame });
    }
  }
  return groups;
}

function detectMemCounters(cycles) {
  const counters = [];
  for (const frameId of [14, 15]) {
    const bySlot = new Map();
    for (const cycle of cycles) {
      const frame = (cycle.frames || []).find((item) => frameKey(item) === frameId);
      if (!frame) continue;
      for (const word of frame.words || []) {
        if (!word.slot || word.firstByte === undefined || word.secondByte === null) continue;
        if (!bySlot.has(word.slot)) bySlot.set(word.slot, []);
        bySlot.get(word.slot).push({ cycle: cycle.number, value: Number(word.firstByte) & 0xff, word });
      }
    }
    for (const [slot, observations] of bySlot) {
      for (let start = 0; start + MEM_PATTERN.length <= observations.length; start += 1) {
        const section = observations.slice(start, start + MEM_PATTERN.length);
        if (section.every((entry, index) => entry.value === MEM_PATTERN[index])) {
          counters.push({
            type: "MEM_PARITY_COUNTER_CANDIDATE",
            frameId,
            slot,
            stepSize: -5,
            rolloverAt: "FF",
            sequence: section.map((entry) => hexByte(entry.value)),
            cycles: section.map((entry) => entry.cycle),
            hypothesis: `Candidate MEM_PARITY descending counter pattern ${HYPOTHESIS_TAG}`,
          });
          break;
        }
      }
    }
  }
  return counters;
}

function detectRepeatingSequences(groups) {
  const sequences = [];
  for (const observations of groups.values()) {
    const byCycle = new Map();
    for (const observation of observations) {
      const cycle = observation.frame.cycle;
      if (cycle !== null && cycle !== undefined) byCycle.set(cycle, observation.hex);
    }
    const values = [...byCycle.entries()].sort((a, b) => a[0] - b[0]);
    if (new Set(values.map((entry) => entry[1])).size < 2) continue;
    for (let start = 0; start < values.length - 3; start += 1) {
      let found = null;
      for (let period = 2; period <= Math.floor((values.length - start) / 2); period += 1) {
        const first = values.slice(start, start + period).map((entry) => entry[1]);
        if (first.every((value, index) => value === values[start + period + index][1])) {
          found = { period, first };
          break;
        }
      }
      if (!found) continue;
      const { frameId, slot } = observations[0];
      const key = `${frameId}:${slot}:${start}:${found.period}:${found.first.join(",")}`;
      if (sequences.some((sequence) => sequence.key === key)) continue;
      let repetitions = 2;
      while (start + (repetitions + 1) * found.period <= values.length &&
          found.first.every((value, index) => value === values[start + repetitions * found.period + index][1])) repetitions += 1;
      sequences.push({
        frameId,
        slot,
        slotName: `IW${slot}`,
        startCycle: values[start][0],
        periodCycles: found.period,
        repetitions,
        values: found.first,
        key,
      });
      break;
    }
  }
  return sequences;
}

/** Group Frame 0..15 runs and compare same frame/word positions across cycles. */
export function analyzeMemCycles(frames) {
  const cycles = [];
  let current = null;
  const finish = () => {
    if (!current) return;
    current.complete = current.frameIds.length === 16 && current.frameIds.every((id, index) => id === index);
    current.frameCount = current.frames.length;
    cycles.push(current);
    current = null;
  };
  for (const frame of frames || []) {
    const id = frameKey(frame);
    if (id === 0) {
      finish();
      current = { number: cycles.length, startUs: frame.t_us ?? null, frames: [], frameIds: [], complete: false };
    }
    if (!current) continue;
    current.frames.push(frame);
    current.frameIds.push(id);
    frame.cycle = current.number;
    if (id === 15) finish();
  }
  finish();

  const grouped = wordGroups(frames || []);
  const constantWords = [];
  const variableWords = [];
  for (const [key, observations] of grouped) {
    const byCycle = new Map();
    for (const observation of observations) {
      const cycle = observation.frame.cycle;
      if (cycle === null || cycle === undefined) continue;
      byCycle.set(cycle, observation.hex);
    }
    if (byCycle.size < 2) continue;
    const frameId = observations[0].frameId;
    const slot = observations[0].slot;
    const values = [...byCycle.entries()].sort((a, b) => a[0] - b[0]).map(([cycle, hex]) => ({ cycle, hex }));
    const unique = [...new Set(values.map((item) => item.hex))];
    const item = { frameId, slot, slotName: `IW${slot}`, observations: values.length, values, key };
    if (unique.length === 1) constantWords.push({ ...item, hex: unique[0], value: parseInt(unique[0], 16) });
    else variableWords.push({ ...item, uniqueValues: unique });
  }
  return {
    cycles,
    constantWords,
    variableWords,
    repeatingSequences: detectRepeatingSequences(grouped),
    candidateCounters: detectMemCounters(cycles),
    cycleCount: cycles.filter((cycle) => cycle.complete).length,
  };
}

/** Classify complete MEM cycles by response cadence. */
export function classifyCycles(cycles) {
  const completeCycles = (cycles || []).filter(cycle => cycle.complete);
  let responseEntryCycles = 0;
  let sustainedResponseCycles = 0;

  for (const cycle of completeCycles) {
    const periods = (cycle.frames || [])
      .map(frame => Number(frame?.periodUs ?? frame?.dt))
      .filter(periodUs => Number.isFinite(periodUs) && periodUs > 0)
      .map(periodUs => periodUs / 1000);
    if (periods.length < 14) continue;

    if (periods.every(period => Math.abs(period - 15.0) <= 2.0)) {
      sustainedResponseCycles += 1;
      continue;
    }

    const baselineIndexes = [];
    let responsePeriods = 0;
    periods.forEach((period, index) => {
      if (Math.abs(period - 10.0) <= 2.0) baselineIndexes.push(index);
      if (Math.abs(period - 15.0) <= 2.0) responsePeriods += 1;
    });
    const transitionsToResponse = baselineIndexes.some(index =>
      periods.slice(index + 1).some(period => Math.abs(period - 15.0) <= 2.0));
    if (transitionsToResponse && responsePeriods >= Math.ceil(periods.length / 2)) {
      responseEntryCycles += 1;
    }
  }

  return {
    genericCartCycles: completeCycles.length,
    responseEntryCycles,
    sustainedResponseCycles,
    memResponseCycles: sustainedResponseCycles + responseEntryCycles,
    incompleteCycles: (cycles || []).length - completeCycles.length,
  };
}

function collectWords(frames) {
  return (frames || []).flatMap((frame) => (frame.words || []).map((word) => ({ frame, word })));
}

function cadenceMarker(frames) {
  const periods = (frames || []).map((frame) => Number(frame.periodUs ?? frame.dt)).filter((period) => Number.isFinite(period) && period > 0);
  if (!periods.length) return null;
  const average = periods.reduce((sum, value) => sum + value, 0) / periods.length;
  return {
    type: "FRAME_CADENCE",
    meanPeriodUs: average,
    expectedPeriodUs: FRAME_PERIOD_EXPECTED_US,
    approximately42_5ms: Math.abs(average - FRAME_PERIOD_EXPECTED_US) <= 7000,
    samples: periods.length,
  };
}

function transitionRows(frames, from, to) {
  const found = [];
  const previousByPosition = new Map();
  for (const frame of frames || []) {
    const frameId = frameKey(frame);
    for (const word of frame.words || []) {
      if (word.slot === undefined || word.slot === null) continue;
      const key = `${frameId}:${word.slot}`;
      const current = { frame, word, frameId, slot: word.slot, hex: wordHex(word) };
      const previous = previousByPosition.get(key);
      const successiveCycles = previous && (
        previous.frame.cycle === null || previous.frame.cycle === undefined ||
        frame.cycle === null || frame.cycle === undefined ||
        frame.cycle === previous.frame.cycle + 1
      );
      if (previous?.frame !== frame && successiveCycles && previous.hex === from && current.hex === to) {
        found.push({
          frameId: current.frameId,
          slot: current.slot,
          from,
          to,
          t_us: current.word.t_us ?? current.frame.t_us ?? null,
          fromT_us: previous.word.t_us ?? previous.frame.t_us ?? null,
          cycle: current.frame.cycle,
          hypothesis: `Candidate Ford self-test phase transition (${from} → ${to}); ${HYPOTHESIS_TAG}`,
        });
      }
      previousByPosition.set(key, current);
    }
  }
  return found;
}

/** Decode candidate KOEO/KOER self-test markers from already reconstructed frames. */
export function decodeSelfTestMarkers(frames, variant) {
  const normalizedVariant = String(variant ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const koeo = normalizedVariant.includes("KOEO");
  const koer = normalizedVariant.includes("KOER");
  const markers = [];
  const hypotheses = [];
  const cadence = cadenceMarker(frames);
  if (cadence) markers.push(cadence);
  const observedWords = collectWords(frames);
  const phaseTransitions = transitionRows(frames, "ACC0", "EC80");
  const firstTime = (frames || []).find((frame) => Number.isFinite(frame.t_us))?.t_us ?? 0;

  if (koeo) {
    const passHypothesis = `Candidate Ford code 11 (pass) ${HYPOTHESIS_TAG}`;
    for (const { frame, word } of observedWords) {
      if (wordHex(word) !== "11B1" || word.parityValid === false || frameKey(frame) !== 0) continue;
      const t_us = word.t_us ?? frame.t_us ?? null;
      markers.push({
        type: "KOEO_CODE_CANDIDATE",
        code: "11B1",
        frameId: 0,
        slot: word.slot,
        t_us,
        seconds: t_us === null ? null : (t_us - firstTime) / 1_000_000,
        parityValid: true,
        hypothesis: passHypothesis,
      });
    }
    if (markers.some((marker) => marker.type === "KOEO_CODE_CANDIDATE")) hypotheses.push(passHypothesis);
  }

  if (koer) {
    const codes = ["16C1", "72E1", "3845", "21C5"];
    for (const code of codes) {
      const matches = observedWords.filter(({ frame, word }) =>
        wordHex(word) === code && frameKey(frame) === codes.indexOf(code) && word.parityValid !== false);
      if (!matches.length) continue;
      const cycles = [...new Set(matches.map(({ frame }) => frame.cycle).filter((cycle) => cycle !== null && cycle !== undefined))];
      const first = matches[0];
      const t_us = first.word.t_us ?? first.frame.t_us ?? null;
      const hypothesis = `Candidate Ford KOER code ${code.slice(0, 2)} ${HYPOTHESIS_TAG}`;
      markers.push({
        type: "KOER_CODE_CANDIDATE",
        code,
        frameId: codes.indexOf(code),
        slot: first.word.slot,
        t_us,
        seconds: t_us === null ? null : (t_us - firstTime) / 1_000_000,
        persistenceCycles: cycles.length || new Set(matches.map(({ frame }) => frame.index)).size,
        occurrences: matches.length,
        hypothesis,
      });
      hypotheses.push(hypothesis);
    }
    const phaseMatches = observedWords.filter(({ frame, word }) => frameKey(frame) === 7 && wordHex(word) === "EC80" && word.parityValid !== false);
    if (phaseMatches.length) {
      const cycles = [...new Set(phaseMatches.map(({ frame }) => frame.cycle).filter((cycle) => cycle !== null && cycle !== undefined))];
      const first = phaseMatches[0];
      const t_us = first.word.t_us ?? first.frame.t_us ?? null;
      const hypothesis = `Candidate Ford KOER result phase EC80 ${HYPOTHESIS_TAG}`;
      markers.push({
        type: "KOER_PHASE_CANDIDATE",
        code: "EC80",
        frameId: 7,
        slot: first.word.slot,
        t_us,
        seconds: t_us === null ? null : (t_us - firstTime) / 1_000_000,
        persistenceCycles: cycles.length || new Set(phaseMatches.map(({ frame }) => frame.index)).size,
        occurrences: phaseMatches.length,
        hypothesis,
      });
      hypotheses.push(hypothesis);
    }
  }

  for (const transition of phaseTransitions) {
    const marker = { type: "PHASE_TRANSITION_CANDIDATE", code: `${transition.from}→${transition.to}`, ...transition };
    markers.push(marker);
    hypotheses.push(transition.hypothesis);
  }

  return {
    markers,
    hypotheses,
    phaseTransitions,
  };
}

/** Return frames containing words of the requested classification. */
export function filterFrames(frames, filterType = "ALL") {
  const type = String(filterType ?? "ALL").toUpperCase();
  if (type === "ALL") return [...(frames || [])];
  const supported = new Set(["TX", "ECHO", "RESPONSE_CANDIDATE", "CHANGED", "PARITY_FAILURE", "UNRESOLVED", "FRAME_HEADER", "HEADER"]);
  if (!supported.has(type)) return [];
  return (frames || []).filter((frame) => {
    const frameWords = frame.words || [];
    if (type === "HEADER" || type === "FRAME_HEADER") return frameWords.some((word) => word.classification === "FRAME_HEADER");
    if (type === "TX") return (frame.txWitnesses || []).some((witness) => witness.verified) || frameWords.some((word) => word.classification === "TX_WITNESS");
    if (type === "PARITY_FAILURE") return frameWords.some((word) => word.parityValid === false && word.secondByte !== null);
    if (type === "CHANGED") return frameWords.some((word) => word.changed);
    if (type === "RESPONSE_CANDIDATE") return frameWords.some((word) => word.slot >= 1 && word.classification === type);
    return frameWords.some((word) => word.classification === type);
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/** Format a compact plain-text row for logs, exports, or card summaries. */
export function formatFrameRow(frame) {
  const id = Number(frame?.frameId ?? frame?.id ?? 0).toString(16).toUpperCase().padStart(2, "0");
  const words = (frame?.words || []).map((word) => `${word.slotName || `IW${word.slot}`}:${wordHex(word)} ${word.classification || ""}`.trim()).join(" · ");
  const dt = Number.isFinite(frame?.periodUs) ? ` Δ${Math.round(frame.periodUs / 1000)}ms` : "";
  return `F${id}${dt}  ${words}`.trim();
}

function frameIndexLabel(frame, fallbackIndex) {
  const index = Number(frame?.index);
  return Number.isInteger(index) && index >= 0 ? index : fallbackIndex;
}

function findFrameJumpTargets(frames) {
  const targets = [];
  const seen = new Set();
  const add = (key, label, index) => {
    if (index < 0 || seen.has(key)) return;
    seen.add(key);
    targets.push({ key, label, index });
  };
  const firstWordIndex = (hex) => (frames || []).findIndex((frame) => (frame.words || []).some((word) => wordHex(word) === hex));

  const koeoIndex = firstWordIndex("11B1");
  if (koeoIndex >= 0) add("KOEO_11B1", `11B1 · frame ${frameIndexLabel(frames[koeoIndex], koeoIndex)}`, koeoIndex);

  const previousByPosition = new Map();
  let transitionIndex = -1;
  for (let index = 0; index < (frames || []).length; index += 1) {
    const frame = frames[index];
    const id = frameKey(frame);
    for (const word of frame.words || []) {
      if (word.slot === undefined || word.slot === null) continue;
      const key = `${id}:${word.slot}`;
      const previous = previousByPosition.get(key);
      const successiveCycles = previous && (
        previous.frame.cycle === null || previous.frame.cycle === undefined ||
        frame.cycle === null || frame.cycle === undefined ||
        frame.cycle === previous.frame.cycle + 1
      );
      if (transitionIndex < 0 && previous?.frame !== frame && successiveCycles && previous.hex === "ACC0" && wordHex(word) === "EC80") {
        transitionIndex = index;
      }
      previousByPosition.set(key, { frame, hex: wordHex(word) });
    }
  }
  if (transitionIndex >= 0) {
    const frameId = frameKey(frames[transitionIndex]);
    add("PHASE_ACC0_EC80", `ACC0 → EC80 · F${frameId.toString(16).toUpperCase().padStart(2, "0")}`, transitionIndex);
  }

  for (const code of ["16C1", "72E1", "3845", "21C5"]) {
    const index = firstWordIndex(code);
    if (index >= 0) add(`KOER_${code}`, `${code} · frame ${frameIndexLabel(frames[index], index)}`, index);
  }

  const previousMemWords = new Map();
  const memChangeIndex = (frames || []).findIndex((frame) => {
    const id = frameKey(frame);
    if (id !== 14 && id !== 15) return false;
    for (const word of frame.words || []) {
      if (!word.slot) continue;
      const key = `${id}:${word.slot}`;
      const hex = wordHex(word);
      const changed = word.changed || (previousMemWords.has(key) && previousMemWords.get(key) !== hex);
      previousMemWords.set(key, hex);
      if (changed) return true;
    }
    return false;
  });
  if (memChangeIndex >= 0) {
    const frame = frames[memChangeIndex];
    const cycle = frame.cycle;
    const detail = cycle === null || cycle === undefined ? `frame ${frameIndexLabel(frame, memChangeIndex)}` : `cycle ${Number(cycle) + 1}`;
    add("MEM_PARITY_CHANGE", `MEM_PARITY change · ${detail}`, memChangeIndex);
  }
  return targets;
}

function installFrameInspectorNavigation(containerElement) {
  if (containerElement._frameInspectorNavigationWired || typeof containerElement.addEventListener !== "function") return;
  containerElement._frameInspectorNavigationWired = true;
  containerElement.addEventListener("click", (event) => {
    const target = event.target?.closest?.(".frame-page-btn, .frame-jump-btn") || event.target?.parentElement?.closest?.(".frame-page-btn, .frame-jump-btn");
    if (!target || target.disabled || (typeof containerElement.contains === "function" && !containerElement.contains(target))) return;
    const frames = containerElement._frameInspectorFrames;
    const pageSize = containerElement._frameInspectorPageSize || 100;
    if (!Array.isArray(frames)) return;

    let page;
    if (target.classList.contains("frame-jump-btn")) {
      const targetIndex = Number(target.dataset.targetIndex ?? target.getAttribute("data-target-index"));
      if (!Number.isFinite(targetIndex) || targetIndex < 0) return;
      page = Math.floor(targetIndex / pageSize) + 1;
    } else {
      page = Number(target.dataset.page ?? target.getAttribute("data-page"));
    }
    if (!Number.isFinite(page)) return;
    renderFrameInspectorCards(frames, containerElement, { page, pageSize });
  });
}

/** Render responsive, expandable mobile cards into a supplied container. */
export function renderFrameInspectorCards(frames, containerElement, options = {}) {
  if (!containerElement || typeof containerElement !== "object") return "";
  const allFrames = Array.isArray(frames) ? [...frames] : [];
  const rawPageSize = Number(options?.pageSize);
  const pageSize = Number.isFinite(rawPageSize) && rawPageSize > 0 ? Math.min(999, Math.max(1, Math.floor(rawPageSize))) : 100;
  const totalPages = Math.max(1, Math.ceil(allFrames.length / pageSize));
  const requestedPage = Number(options?.page || 1);
  const page = Number.isFinite(requestedPage) ? Math.min(totalPages, Math.max(1, Math.floor(requestedPage))) : 1;
  const startIndex = (page - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, allFrames.length);
  const visibleFrames = allFrames.slice(startIndex, page * pageSize);
  const rangeStart = allFrames.length ? startIndex + 1 : 0;
  const rangeEnd = allFrames.length ? endIndex : 0;
  const jumpTargets = findFrameJumpTargets(allFrames);
  const buttonStyle = "max-width:100%;min-width:0;padding:6px 9px;border:1px solid #aab4c0;border-radius:6px;background:#fff;color:inherit;font:inherit;white-space:normal;overflow-wrap:anywhere;cursor:pointer";
  const pageControls = `<nav class="frame-inspector-navigation" aria-label="Frame inspector pagination" style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;max-width:100%;min-width:0;margin:0 0 8px"><button type="button" class="frame-page-btn" data-page="${page - 1}" aria-label="Previous page"${page <= 1 ? " disabled" : ""} style="${buttonStyle}">« Prev</button><span class="frame-page-info" aria-live="polite" style="flex:1 1 180px;min-width:0;text-align:center;overflow-wrap:anywhere">Page ${page} of ${totalPages} (Frames ${rangeStart}–${rangeEnd} of ${allFrames.length})</span><button type="button" class="frame-page-btn" data-page="${page + 1}" aria-label="Next page"${page >= totalPages ? " disabled" : ""} style="${buttonStyle}">Next »</button>${jumpTargets.length ? `<div class="frame-inspector-jumps" aria-label="Jump to important frames" style="display:flex;flex:1 1 100%;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;max-width:100%;min-width:0"><span class="frame-inspector-jump-label" style="flex:0 1 auto">Jump to:</span>${jumpTargets.map((target) => `<button type="button" class="frame-jump-btn" data-target-index="${target.index}" aria-label="Jump to ${escapeHtml(target.label)}" style="${buttonStyle}">${escapeHtml(target.label)}</button>`).join("")}</div>` : ""}</nav>`;
  const cards = `<div class="frame-inspector-cards" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:8px;min-width:0">${visibleFrames.map((frame, visibleIndex) => {
    const summary = escapeHtml(formatFrameRow(frame));
    const details = (frame.words || []).map((word) => `<li><strong>${escapeHtml(word.slotName || `IW${word.slot}`)} ${escapeHtml(wordHex(word))}</strong><span> ${escapeHtml(word.classification || "UNRESOLVED")}${word.parityValid === false ? " · parity failure" : ""}</span>${word.decodedMeaning ? `<small style="display:block;overflow-wrap:anywhere">${escapeHtml(word.decodedMeaning)}</small>` : ""}</li>`).join("");
    const witnesses = (frame.txWitnesses || []).map((witness) => `<li><strong>TX ${escapeHtml(witness.expected)}</strong><span> ${witness.verified ? "TX_WITNESS" : "UNRESOLVED"} · slot ${escapeHtml(witness.slot)}</span></li>`).join("");
    return `<details class="frame-inspector-card" data-frame-index="${frameIndexLabel(frame, startIndex + visibleIndex)}" style="min-width:0;border:1px solid #ccd3dc;border-radius:8px;padding:8px"><summary style="overflow-wrap:anywhere;cursor:pointer">${summary}</summary><ul style="margin:8px 0 0;padding-left:20px;overflow-wrap:anywhere">${details}${witnesses}</ul></details>`;
  }).join("")}</div>`;
  const html = `${pageControls}${cards}`;
  containerElement._frameInspectorFrames = allFrames;
  containerElement._frameInspectorPage = page;
  containerElement._frameInspectorPageSize = pageSize;
  installFrameInspectorNavigation(containerElement);
  containerElement.innerHTML = html;
  return html;
}
