/** Offline, deterministic comparison of two DCL captures. */

import { parseRawTranscript, analyzeMemCycles, classifyCycles } from "./frame-inspector.js";

const LABEL = input => String(input?.label || input?.name || input?.variant || input?.id || "capture");

function sortedObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value ?? null;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
}

function asWords(value) {
  if (value == null) return null;
  const list = Array.isArray(value) ? value : [value];
  return list.map(item => {
    if (item && typeof item === "object") return String(item.word ?? item.hex ?? item.value ?? "").toUpperCase();
    return String(item).toUpperCase();
  }).filter(Boolean);
}

function numeric(value) {
  if (value == null || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function cadencePeriod(value) {
  if (typeof value === "number") return numeric(value);
  if (value && typeof value === "object") return numeric(value.framePeriodMs ?? value.periodMs);
  if (typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*(?:ms)?\s*$/i.test(value)) return Number.parseFloat(value);
  return null;
}

function witnessMatch(witness) {
  if (typeof witness === "boolean") return witness;
  if (!witness || typeof witness !== "object") return null;
  if (typeof witness.match === "boolean") return witness.match;
  if (witness.match === 1 || witness.match === "1") return true;
  if (witness.match === 0 || witness.match === "0") return false;
  if (witness.expected == null || witness.observed == null) return null;
  return String(witness.expected).toUpperCase() === String(witness.observed).toUpperCase();
}

function rawLinesOf(source) {
  const raw = source.rawText ?? source.rawTranscript ?? source.transcript ?? source.rawLines ?? source.lines;
  if (typeof raw === "string") return raw.split(/\r?\n/).filter(Boolean);
  if (Array.isArray(raw)) return raw.map(line => typeof line === "string" ? line : line?.line ?? line?.raw).filter(Boolean).map(String);
  return [];
}

function hasRawDclLines(lines) {
  return lines.some(line => /^(?:RX |RXB |TX_PAD )/.test(String(line).trim()));
}

function parseTranscript(source, lines) {
  const parsed = {};
  for (const line of lines) {
    const command = /\b(?:commandWord|command|cmd)=([0-9a-f]{4})\b/i.exec(line);
    if (command) (parsed.sentCommandWords ||= []).push(command[1].toUpperCase());
    const period = /\b(?:framePeriodMs|periodMs|cadenceMs)=([0-9.]+)\b/i.exec(line);
    if (period && parsed.framePeriodMs == null) parsed.framePeriodMs = Number(period[1]);
    const frameCount = /\bframeCount=(\d+)\b/i.exec(line);
    if (frameCount && parsed.frameCount == null) parsed.frameCount = Number(frameCount[1]);
    const duration = /\bdurationMs=([0-9.]+)\b/i.exec(line);
    if (duration && parsed.durationMs == null) parsed.durationMs = Number(duration[1]);
    const parity = /\bparity=(valid|invalid)\b/i.exec(line);
    if (parity) parsed.parityValid = parity[1].toLowerCase() === "valid";
    const parityErrors = /\bparityErrors=(\d+)\b/i.exec(line);
    if (parityErrors) parsed.parityErrors = Number(parityErrors[1]);
    const witness = /^TX_PAD\s+.*?expected=([0-9a-f]+)\s+observed=([0-9a-f]+)\s+match=(0|1)\b/i.exec(line);
    if (witness) (parsed.txWitnesses ||= []).push({
      expected: witness[1].toUpperCase(), observed: witness[2].toUpperCase(), match: witness[3] === "1",
    });
    const word = /\b(F(?:0[0-9]|1[0-5]))=([0-9a-f]{4})\b/i.exec(line);
    if (word) {
      const address = word[1].toUpperCase();
      const section = Number(address.slice(1)) < 4 ? "F00_F03" : "F04_F15";
      (parsed.initialResponseBlock ||= { F00_F03: {}, F04_F15: {} })[section][address] = word[2].toUpperCase();
    }
  }
  return parsed;
}

function roundPeriod(periodUs) {
  return Number((periodUs / 1000).toFixed(1));
}

function isVerifiedWitness(witness) {
  return witness?.verified === true && witness?.match === true &&
    String(witness.expected ?? "").toUpperCase() === String(witness.observed ?? "").toUpperCase();
}

function witnessWord(witness) {
  return String(witness?.expected ?? witness?.observed ?? "").toUpperCase();
}

function hasClassifiableCycle(cycles) {
  return (cycles || []).some(cycle => cycle.complete && (cycle.frames || [])
    .map(frame => Number(frame?.periodUs ?? frame?.dt))
    .filter(periodUs => Number.isFinite(periodUs) && periodUs > 0).length >= 14);
}

function cycleClassificationFor(rawParsed, source) {
  const hasExplicitClassification = source.sustainedResponseCycles != null || source.responseEntryCycles != null;
  if (hasExplicitClassification) {
    const sustainedResponseCycles = source.sustainedResponseCycles == null ? 0 : numeric(source.sustainedResponseCycles);
    const responseEntryCycles = source.responseEntryCycles == null ? 0 : numeric(source.responseEntryCycles);
    const explicitValuesValid = (source.sustainedResponseCycles == null || sustainedResponseCycles != null) &&
      (source.responseEntryCycles == null || responseEntryCycles != null);
    return {
      sustainedResponseCycles,
      responseEntryCycles,
      memResponseCycles: sustainedResponseCycles == null || responseEntryCycles == null
        ? null : sustainedResponseCycles + responseEntryCycles,
      evidenceAvailable: explicitValuesValid,
    };
  }

  if (Array.isArray(source.cycles)) {
    const classification = classifyCycles(source.cycles);
    return { ...classification, evidenceAvailable: hasClassifiableCycle(source.cycles) };
  }

  if (rawParsed?.frames?.length) {
    const cycles = analyzeMemCycles(rawParsed.frames).cycles;
    const classification = classifyCycles(cycles);
    return { ...classification, evidenceAvailable: hasClassifiableCycle(cycles) };
  }

  if (source.cycleCount != null || source.cycles != null) {
    const cycleCount = numeric(source.cycleCount) ?? numeric(source.cycles);
    if (cycleCount == null) return null;
    return {
      sustainedResponseCycles: cycleCount,
      responseEntryCycles: 0,
      memResponseCycles: cycleCount,
      evidenceAvailable: true,
    };
  }

  return null;
}

function requestEvidence(rawParsed, declaredCommands = [], source = {}) {
  const witnesses = rawParsed?.txWitnesses || [];
  const verifiedIndexes = new Set(witnesses.flatMap((witness, index) => isVerifiedWitness(witness) ? [index] : []));
  const envelopes = [];
  const envelopeIndexes = new Set();
  for (let index = 0; index + 3 < witnesses.length; index += 1) {
    if (witnessWord(witnesses[index]) !== "01B0") continue;
    const candidate = witnesses.slice(index, index + 4);
    const words = candidate.map(witnessWord);
    if (words[1] !== "FF5F" || words[3] !== "00A0" || !candidate.every(isVerifiedWitness)) continue;
    const candidateIndexes = [index, index + 1, index + 2, index + 3];
    envelopes.push({ words, command: words[2], indexes: candidateIndexes });
    candidateIndexes.forEach(item => envelopeIndexes.add(item));
    index += 3;
  }

  const requestEnvelope = envelopes[0]?.words ?? null;
  const declared = declaredCommands.map(word => String(word).toUpperCase()).filter(word => /^[0-9A-F]{4}$/.test(word));
  const primaryCommandWord = envelopes[0]?.command ??
    (String(source.primaryCommandWord ?? source.commandWord ?? declared[0] ?? "").toUpperCase() || null);
  const continuationWords = [];
  for (const envelope of envelopes.slice(1)) {
    if (envelope.command !== primaryCommandWord && !continuationWords.includes(envelope.command)) continuationWords.push(envelope.command);
  }
  for (const [index, witness] of witnesses.entries()) {
    if (!verifiedIndexes.has(index) || envelopeIndexes.has(index)) continue;
    const word = witnessWord(witness);
    if (/^[0-9A-F]{4}$/.test(word) && !["01B0", "FF5F", "00A0", primaryCommandWord].includes(word) && !continuationWords.includes(word)) {
      continuationWords.push(word);
    }
  }

  const identity = [source.variant, source.id, source.label, source.name]
    .filter(Boolean).map(value => String(value).toUpperCase()).join(" ");
  const profileContinuation = identity.includes("MEM_PARITY") ? "2293"
    : identity.includes("MEM_OFF0") || identity.includes("MEM_SINGLE") || /\bMEM\b/.test(identity) ? "22D3" : null;
  const evidence = identity.includes("MEM_OFF0")
    ? "Historical MEM_OFF0 recording is not proof offset 0 was transmitted; offset 0 remains an unresolved hypothesis."
    : null;
  const endFields = rawParsed?.stats?.endEvents?.at(-1)?.fields ?? {};
  const witnessVerifiedCount = numeric(endFields.witness_verified ?? endFields.pad_verified) ??
    (rawParsed?.txWitnesses ? verifiedIndexes.size : null);
  const cycleClassification = cycleClassificationFor(rawParsed, source);
  const classifiedContinuation = Number(cycleClassification?.sustainedResponseCycles) > 0 ||
    Number(cycleClassification?.memResponseCycles) > 0;
  const wordsStarted = numeric(endFields.words_started);
  const sentCommandWords = primaryCommandWord ? [primaryCommandWord, ...continuationWords] : [...continuationWords];
  if (profileContinuation && (witnessVerifiedCount > 4 || (profileContinuation === "2293" && classifiedContinuation)) &&
      !sentCommandWords.includes(profileContinuation)) {
    sentCommandWords.push(profileContinuation);
  }

  let continuationBlocks = null;
  if (primaryCommandWord || sentCommandWords.length) {
    if (continuationWords.length) {
      continuationBlocks = `continuation request observed (${continuationWords.join(", ")})`;
    } else if (profileContinuation === "22D3" && witnessVerifiedCount > 4) {
      continuationBlocks = `continuation activity observed (profile candidate 22D3, witness count ${witnessVerifiedCount}); individual continuation words not independently PAD-verified`;
    } else if (profileContinuation === "2293" && (witnessVerifiedCount > 4 || classifiedContinuation)) {
      const sustained = numeric(cycleClassification?.sustainedResponseCycles);
      const entry = numeric(cycleClassification?.responseEntryCycles);
      const responseCount = sustained > 0 ? `~${sustained}`
        : entry > 0 ? `${entry} entry`
          : cycleClassification?.evidenceAvailable ? "0" : "unknown";
      const responseCycles = responseCount;
      continuationBlocks = `sustained continuation activity observed (profile candidate 2293, ${responseCycles} response cycles, witness count ${witnessVerifiedCount})`;
    } else {
      continuationBlocks = "initial request only; no continuation request observed";
    }
  }
  const verifiedTxWitnesses = verifiedIndexes.size;
  const txEchoWords = (rawParsed?.frames || []).flatMap(frame => (frame.words || [])
    .filter(word => Number(word.slot) >= 1 && Number(word.slot) <= 3 && word.classification === "ECHO")
    .map(word => ({
      frameId: Number(frame.frameId ?? frame.id), slot: Number(word.slot),
      hex: String(word.hex).toUpperCase(), t_us: word.t_us ?? frame.t_us ?? null,
      echoOf: word.echoOf ?? null,
    })));
  const txWitnessDetails = witnesses.map(witness => {
    const frame = (rawParsed?.frames || []).find(item => item.index === witness.frameIndex);
    return {
      frameId: frame ? Number(frame.frameId ?? frame.id) : null,
      frameIndex: witness.frameIndex ?? null,
      slot: witness.slot ?? null,
      expected: witness.expected ?? null,
      observed: witness.observed ?? null,
      match: typeof witness.match === "boolean" ? witness.match : null,
      verified: typeof witness.verified === "boolean" ? witness.verified : null,
      t_us: witness.t_us ?? null,
    };
  });

  return {
    requestEnvelope,
    primaryCommandWord,
    continuationWords,
    sentCommandWords: sentCommandWords.length ? sentCommandWords : null,
    verifiedTxWitnesses,
    witnessVerifiedCount,
    wordsStarted,
    cycleClassification,
    txEchoWords,
    txWitnessDetails,
    continuationBlocks,
    evidence,
  };
}

function bodyWordObservations(frames) {
  return (frames || []).flatMap(frame => (frame.words || [])
    .filter(word => Number(word.slot) >= 1 && Number(word.slot) <= 3 && word.hex)
    .map(word => ({
      frameId: Number(frame.frameId ?? frame.id),
      slot: Number(word.slot),
      hex: String(word.hex).toUpperCase(),
      t_us: word.t_us ?? frame.t_us ?? null,
      classification: word.classification ?? "UNRESOLVED",
      parityValid: typeof word.parityValid === "boolean" ? word.parityValid : null,
      echoOf: word.echoOf ?? null,
    }))
    .filter(item => Number.isInteger(item.frameId) && item.frameId >= 0 && item.frameId <= 15));
}

function hasContemporaneousTxWitness(observation, txWitnesses) {
  if (!Number.isFinite(observation.t_us)) return false;
  return txWitnesses.some(witness => isVerifiedWitness(witness) &&
    witnessWord(witness) === observation.hex && Number.isFinite(witness.t_us) &&
    Math.abs(observation.t_us - witness.t_us) <= 2600);
}

function detectPhaseTransitions(observations, firstTimeUs) {
  const byPosition = new Map();
  const transitions = [];
  for (const observation of observations) {
    const key = `${observation.frameId}:${observation.slot}`;
    const previous = byPosition.get(key);
    if (previous?.hex === "ACC0" && observation.hex === "EC80") {
      transitions.push({
        frameId: observation.frameId,
        slot: observation.slot,
        from: previous.hex,
        to: observation.hex,
        t_us: observation.t_us,
        delayMs: observation.t_us == null || firstTimeUs == null ? null : Number(((observation.t_us - firstTimeUs) / 1000).toFixed(1)),
      });
    }
    byPosition.set(key, observation);
  }
  return transitions;
}

function deriveRawEvidence(rawParsed, source = {}, declaredCommands = []) {
  if (!rawParsed) return {};
  const frames = rawParsed.frames || [];
  const bodyObservations = bodyWordObservations(frames);
  const requests = requestEvidence(rawParsed, declaredCommands, source);
  const cycleClassification = requests.cycleClassification;
  const padWitnesses = rawParsed.txWitnesses || [];
  const txEchoObservations = bodyObservations.filter(item => item.classification === "ECHO");
  const txWitnessWordObservations = bodyObservations.filter(item => item.classification === "TX_WITNESS");
  const repeatedEnvelopeWords = bodyObservations.filter(item => {
    if (item.slot !== 1 || item.frameId > 3 || item.classification === "ECHO") return false;
    const envelopeWord = requests.requestEnvelope?.[item.frameId];
    return envelopeWord === item.hex && !hasContemporaneousTxWitness(item, padWitnesses);
  }).map(item => ({
    frameId: item.frameId,
    slot: item.slot,
    hex: item.hex,
    t_us: item.t_us,
    reason: "UNATTRIBUTED_ENVELOPE_REPETITION",
  }));
  const repeatedKeys = new Set(repeatedEnvelopeWords.map(item => `${item.frameId}:${item.slot}:${item.t_us}:${item.hex}`));
  const unresolvedObservations = bodyObservations.filter(item =>
    item.classification === "UNRESOLVED" || !["RESPONSE_CANDIDATE", "ECHO", "TX_WITNESS"].includes(item.classification));
  const unresolvedKeys = new Set(unresolvedObservations.map(item => `${item.frameId}:${item.slot}:${item.t_us}:${item.hex}`));
  const echoKeys = new Set(txEchoObservations.map(item => `${item.frameId}:${item.slot}:${item.t_us}:${item.hex}`));
  const txWitnessKeys = new Set(txWitnessWordObservations.map(item => `${item.frameId}:${item.slot}:${item.t_us}:${item.hex}`));
  const independentResponseCandidates = bodyObservations.filter(item => {
    const key = `${item.frameId}:${item.slot}:${item.t_us}:${item.hex}`;
    return item.classification === "RESPONSE_CANDIDATE" && !echoKeys.has(key) &&
      !txWitnessKeys.has(key) && !repeatedKeys.has(key) && !unresolvedKeys.has(key);
  });
  const observations = independentResponseCandidates;
  const periods = frames.map(frame => Number(frame.periodUs)).filter(value => Number.isFinite(value) && value > 0).map(roundPeriod);
  const counts = new Map();
  for (const period of periods) counts.set(period, (counts.get(period) || 0) + 1);
  const periodDistributionMs = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([periodMs, count]) => ({ periodMs, count }));
  const ordinaryPeriods = periodDistributionMs.filter(item => item.periodMs <= 20);
  const baselinePeriodMs = ordinaryPeriods.length
    ? (ordinaryPeriods.find(item => item.periodMs === 10)?.periodMs ?? [...ordinaryPeriods].sort((a, b) => b.count - a.count || a.periodMs - b.periodMs)[0].periodMs)
    : null;
  const responsePeriods = baselinePeriodMs == null ? [] : periodDistributionMs.filter(item => item.periodMs > baselinePeriodMs + 0.1);
  const responseCadenceMs = responsePeriods.length
    ? [...responsePeriods].sort((a, b) => b.count - a.count || a.periodMs - b.periodMs)[0].periodMs
    : null;
  const nonBaselineResponseFrameCount = baselinePeriodMs == null ? null : responsePeriods.reduce((sum, item) => sum + item.count, 0);
  const responseFrames = baselinePeriodMs == null ? [] : frames.filter(frame => Number(frame.periodUs) > (baselinePeriodMs + 0.1) * 1000);
  const cycleCount = responseFrames.reduce((total, frame, index) => {
    if (Number(frame.frameId ?? frame.id) !== 15) return total;
    const from = responseFrames.slice(Math.max(0, index - 15), index + 1);
    return from.length === 16 && from.every((item, offset) => Number(item.frameId ?? item.id) === offset) ? total + 1 : total;
  }, 0);
  const responseDurationMs = responseCadenceMs == null || nonBaselineResponseFrameCount == null
    ? null : Number((responseCadenceMs * nonBaselineResponseFrameCount).toFixed(1));

  const initialByFrame = {};
  const initialResponseObservations = [];
  for (const item of observations) {
    const address = `F${String(item.frameId).padStart(2, "0")}`;
    initialByFrame[address] ||= {};
    if (initialByFrame[address][item.slot] == null) {
      initialByFrame[address][item.slot] = item.hex;
      initialResponseObservations.push({ frameId: item.frameId, slot: item.slot, hex: item.hex, t_us: item.t_us });
    }
  }
  const initialResponseBlock = Object.keys(initialByFrame).length ? { F00_F03: {}, F04_F15: {} } : null;
  for (const [address, slots] of Object.entries(initialByFrame)) {
    const section = Number(address.slice(1)) < 4 ? "F00_F03" : "F04_F15";
    const orderedSlots = Object.fromEntries(Object.entries(slots).sort(([left], [right]) => Number(left) - Number(right)).map(([slot, word]) => [`IW${slot}`, word]));
    const values = Object.values(orderedSlots);
    initialResponseBlock[section][address] = values.length === 1 ? values[0] : orderedSlots;
  }

  const valuesByPosition = new Map();
  for (const item of observations) {
    const key = `F${String(item.frameId).padStart(2, "0")}/IW${item.slot}`;
    const values = valuesByPosition.get(key) || new Set();
    values.add(item.hex);
    valuesByPosition.set(key, values);
  }
  const changingWords = [...valuesByPosition].filter(([, values]) => values.size > 1).map(([key]) => key).sort();
  const constantWords = [...valuesByPosition].filter(([, values]) => values.size === 1).map(([key]) => key).sort();
  const startTimeUs = (rawParsed.txWitnesses || []).find(witness => Number.isFinite(witness.t_us))?.t_us ?? frames[0]?.t_us ?? null;
  const phaseTransitions = detectPhaseTransitions(observations, startTimeUs);
  const knownMarkers = new Set(["11B1", "16C1", "72E1", "3845", "21C5"]);
  const responseCodes = [];
  let firstMarkerTimeUs = null;
  for (const observation of observations) {
    if (!knownMarkers.has(observation.hex)) continue;
    if (!responseCodes.includes(observation.hex)) responseCodes.push(observation.hex);
    if (firstMarkerTimeUs == null) firstMarkerTimeUs = observation.t_us;
  }
  const responseDelayMs = firstMarkerTimeUs == null || startTimeUs == null ? null : Number(((firstMarkerTimeUs - startTimeUs) / 1000).toFixed(1));
  const durationMs = frames.length > 1 && frames[0].t_us != null && frames.at(-1).t_us != null
    ? Number(((frames.at(-1).t_us - frames[0].t_us) / 1000).toFixed(1)) : null;
  const witnesses = (rawParsed.txWitnesses || []).map(witness => ({
    expected: witness.expected || null,
    observed: witness.observed || null,
    match: typeof witness.match === "boolean" ? witness.match : null,
    verified: typeof witness.verified === "boolean" ? witness.verified : null,
  }));
  const parityFailureCount = rawParsed.stats?.parityFailureCount ?? null;

  return {
    requestEnvelope: requests.requestEnvelope,
    primaryCommandWord: requests.primaryCommandWord,
    sentCommandWords: requests.sentCommandWords,
    continuationWords: requests.continuationWords,
    verifiedTxWitnesses: requests.verifiedTxWitnesses,
    witnessVerifiedCount: requests.witnessVerifiedCount,
    wordsStarted: requests.wordsStarted,
    txEchoWords: requests.txEchoWords,
    txWitnessDetails: requests.txWitnessDetails,
    txWitnessWordObservations,
    repeatedEnvelopeWords,
    independentResponseCandidates,
    unresolvedObservations,
    txWitnesses: witnesses.length ? witnesses : null,
    txWitnessStatus: witnesses.length
      ? witnesses.some(witness => witness.verified === false || witness.match === false) ? false
        : witnesses.every(witness => witness.verified === true || witness.match === true) ? true : null
      : null,
    framePeriodMs: responseCadenceMs ?? baselinePeriodMs,
    baselinePeriodMs,
    responseCadenceMs,
    periodDistributionMs: periodDistributionMs.length ? periodDistributionMs : null,
    nonBaselineResponseFrameCount,
    responseFrameCount: nonBaselineResponseFrameCount,
    responseDurationMs,
    frameCount: frames.length || null,
    durationMs,
    initialResponseBlock,
    initialResponseObservations,
    cycleCount: cycleCount || (nonBaselineResponseFrameCount === 0 ? 0 : null),
    sustainedResponseCycles: cycleClassification?.sustainedResponseCycles ?? null,
    responseEntryCycles: cycleClassification?.responseEntryCycles ?? null,
    continuationBlocks: requests.continuationBlocks,
    evidence: requests.evidence,
    responseCodes: responseCodes.length ? responseCodes : null,
    responseDelayMs,
    phaseTransitions: phaseTransitions.length ? phaseTransitions : null,
    wordBehavior: observations.length ? {
      changing: changingWords,
      constant: constantWords,
      transitions: phaseTransitions.length ? Object.fromEntries(phaseTransitions.map(item => [`F${String(item.frameId).padStart(2, "0")}`, [item.from, item.to]])) : null,
    } : null,
    parityIntegrity: parityFailureCount == null ? null : {
      valid: parityFailureCount === 0,
      errors: parityFailureCount,
      kind: "observed DCL VPARITY",
    },
  };
}

function normalizeInitialBlock(source, parsed) {
  const input = source.initialResponseBlock ?? source.initialResponse ?? parsed.initialResponseBlock;
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) return { value: input };
  const early = input.F00_F03 ?? input["F00..F03"] ?? input.F00toF03 ?? input.early ?? {};
  const later = input.F04_F15 ?? input["F04..F15"] ?? input.F04toF15 ?? input.later ?? {};
  const result = { F00_F03: sortedObject(early), F04_F15: sortedObject(later) };
  for (const [key, value] of Object.entries(input)) {
    if (/^F(?:0[0-9]|1[0-5])$/i.test(key)) {
      const section = Number(key.slice(1)) < 4 ? "F00_F03" : "F04_F15";
      result[section] ||= {};
      result[section][key.toUpperCase()] = value;
    }
  }
  return result;
}

function normalizeParity(source, parsed) {
  const value = source.parityIntegrity ?? source.parity ?? {};
  const valid = value.valid ?? source.parityValid ?? parsed.parityValid ?? null;
  let errors = value.errors ?? source.parityErrors ?? parsed.parityErrors ?? null;
  if (Array.isArray(errors)) errors = errors.length;
  return {
    valid: typeof valid === "boolean" ? valid : null,
    errors: numeric(errors),
    kind: value.kind ?? source.parityKind ?? null,
  };
}

function normalizeWordBehavior(source, frameList, derived) {
  const behavior = source.wordBehavior ?? {};
  let changing = asWords(behavior.changing ?? source.changingWords);
  let constant = asWords(behavior.constant ?? source.constantWords);
  const transitions = behavior.transitions ?? source.wordTransitions ?? derived?.transitions ?? null;
  if (changing == null && derived?.changing != null) changing = derived.changing;
  if (constant == null && derived?.constant != null) constant = derived.constant;
  if (frameList?.length >= 2 && changing == null && constant == null) {
    const values = new Map();
    for (const frame of frameList) {
      const words = frame?.words ?? frame?.values ?? {};
      for (const [word, value] of Object.entries(words)) {
        const history = values.get(word) || new Set();
        history.add(String(value).toUpperCase());
        values.set(word, history);
      }
    }
    changing = [...values].filter(([, history]) => history.size > 1).map(([word]) => word).sort();
    constant = [...values].filter(([, history]) => history.size === 1).map(([word]) => word).sort();
  }
  return { changing, constant, transitions: transitions == null ? null : sortedObject(transitions) };
}

function normalizeCapture(input, side) {
  if (typeof input === "string") input = { rawText: input, label: `Capture ${side}` };
  if (!input || typeof input !== "object") throw new TypeError(`Capture ${side} must be an object or transcript string`);
  const source = input.capture && typeof input.capture === "object" ? { ...input.capture, ...input }
    : input.metadata && typeof input.metadata === "object" ? { ...input.metadata, ...input }
      : input;
  const lines = rawLinesOf(source);
  const parsed = parseTranscript(source, lines);
  const rawParsed = hasRawDclLines(lines) ? parseRawTranscript(lines) : null;
  const declaredCommands = source.sentCommandWords ?? source.commandWords ?? source.commands ?? source.commandWord ?? parsed.sentCommandWords ?? [];
  const derived = deriveRawEvidence(rawParsed, source, asWords(declaredCommands) ?? []);
  const frameList = Array.isArray(source.frames) ? source.frames : null;
  const commands = source.sentCommandWords ?? source.commandWords ?? source.commands ?? source.commandWord ?? parsed.sentCommandWords ?? derived.sentCommandWords;
  let witnesses = source.txWitnesses ?? source.txWitness ?? source.witnesses ?? parsed.txWitnesses ?? derived.txWitnesses ?? null;
  if (witnesses != null && !Array.isArray(witnesses)) witnesses = [witnesses];
  const witnessStates = witnesses?.map(witnessMatch) ?? [];
  const derivedWitnessStatus = witnessStates.includes(false) ? false
    : witnessStates.length && witnessStates.every(state => state === true) ? true : null;
  const witnessStatus = source.txWitnessStatus === "MATCH" ? true
    : source.txWitnessStatus === "MISMATCH" ? false
      : source.txWitnessStatus ?? derivedWitnessStatus ?? derived.txWitnessStatus;
  const cadence = source.cadence ?? source.cadenceMs ?? null;
  const framePeriod = numeric(source.framePeriodMs ?? source.periodMs ?? source.cadenceMs ?? cadencePeriod(cadence) ?? parsed.framePeriodMs ?? derived.framePeriodMs);
  const frameCount = numeric(source.frameCount ?? source.framesCount ?? (frameList ? frameList.length : parsed.frameCount ?? derived.frameCount));
  const durationMs = numeric(source.durationMs ?? source.duration ?? parsed.durationMs ?? derived.durationMs);
  const responseBlock = normalizeInitialBlock(source, { ...parsed, initialResponseBlock: parsed.initialResponseBlock ?? derived.initialResponseBlock });
  const parity = normalizeParity(source, parsed);
  if (parity.valid == null && derived.parityIntegrity) parity.valid = derived.parityIntegrity.valid;
  if (parity.errors == null && derived.parityIntegrity) parity.errors = derived.parityIntegrity.errors;
  const behavior = normalizeWordBehavior(source, frameList, derived.wordBehavior);
  const decodedPidMap = source.decodedPidMap ?? source.pidMap ?? source.decodedPids ?? null;

  return {
    id: source.id ?? source.recordingId ?? null,
    label: LABEL(source),
    variant: source.variant ?? null,
    sentCommandWords: asWords(commands),
    requestEnvelope: asWords(source.requestEnvelope ?? derived.requestEnvelope),
    primaryCommandWord: String(source.primaryCommandWord ?? derived.primaryCommandWord ?? asWords(commands)?.[0] ?? "").toUpperCase() || null,
    continuationWords: asWords(source.continuationWords ?? derived.continuationWords ?? []),
    verifiedTxWitnesses: numeric(source.verifiedTxWitnesses ?? derived.verifiedTxWitnesses),
    witnessVerifiedCount: numeric(source.witnessVerifiedCount ?? derived.witnessVerifiedCount),
    wordsStarted: numeric(source.wordsStarted ?? derived.wordsStarted),
    txEchoWords: source.txEchoWords ?? derived.txEchoWords ?? null,
    txWitnessStatus: typeof witnessStatus === "boolean" ? witnessStatus : null,
    txWitnesses: witnesses?.map(witness => ({
      expected: witness?.expected ?? null,
      observed: witness?.observed ?? null,
      match: typeof witness?.match === "boolean" ? witness.match : null,
      verified: typeof witness?.verified === "boolean" ? witness.verified : typeof witness?.match === "boolean" ? witness.match : null,
    })) ?? null,
    framePeriodMs: framePeriod,
    cadence: typeof cadence === "number" || typeof cadence === "string" ? cadence : cadence?.label ?? null,
    baselinePeriodMs: numeric(source.baselinePeriodMs ?? derived.baselinePeriodMs),
    responseCadenceMs: numeric(source.responseCadenceMs ?? derived.responseCadenceMs),
    periodDistributionMs: source.periodDistributionMs ?? derived.periodDistributionMs ?? null,
    nonBaselineResponseFrameCount: numeric(source.nonBaselineResponseFrameCount ?? derived.nonBaselineResponseFrameCount),
    responseFrameCount: numeric(source.responseFrameCount ?? derived.responseFrameCount),
    responseDurationMs: numeric(source.responseDurationMs ?? derived.responseDurationMs),
    frameCount,
    durationMs,
    initialResponseBlock: responseBlock,
    initialResponseObservations: source.initialResponseObservations ?? derived.initialResponseObservations ?? null,
    wordBehavior: behavior,
    parityIntegrity: parity,
    acceptance: source.acceptance ?? source.acceptanceStatus ?? null,
    decodedPidMap,
    cycleCount: numeric(source.cycleCount ?? source.cycles ?? derived.cycleCount),
    sustainedResponseCycles: numeric(source.sustainedResponseCycles ?? derived.sustainedResponseCycles),
    responseEntryCycles: numeric(source.responseEntryCycles ?? derived.responseEntryCycles),
    continuationBlocks: source.continuationBlocks ?? derived.continuationBlocks ?? null,
    offsetCoverage: source.offsetCoverage ?? null,
    responsePattern: source.responsePattern ?? null,
    responseDelayMs: numeric(source.responseDelayMs ?? source.responseDelay ?? derived.responseDelayMs),
    responseCodes: asWords(source.responseCodes ?? derived.responseCodes),
    phaseTransitions: source.phaseTransitions ?? derived.phaseTransitions ?? null,
    evidence: source.evidence ?? source.observation ?? derived.evidence ?? null,
    ...(rawParsed ? {
      txWitnessDetails: derived.txWitnessDetails,
      txWitnessWordObservations: derived.txWitnessWordObservations,
      repeatedEnvelopeWords: derived.repeatedEnvelopeWords,
      independentResponseCandidates: derived.independentResponseCandidates,
      unresolvedObservations: derived.unresolvedObservations,
    } : {}),
  };
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function printable(value) {
  if (value === null || value === undefined) return "unknown";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "valid" : "invalid";
  if (Array.isArray(value)) return value.length ? value.map(item => item && typeof item === "object" ? JSON.stringify(item) : item).join(", ") : "none recorded";
  return JSON.stringify(value);
}

function compareField(differences, similarities, field, label, a, b, { unit = "", format = printable } = {}) {
  if (a == null || b == null) return;
  const same = stable(a) === stable(b);
  const suffix = unit ? ` ${unit}` : "";
  if (same) {
    similarities.push({ field, label, captureA: a, captureB: b, message: `Both captures have ${label.toLowerCase()} ${format(a)}${suffix}.` });
  } else {
    differences.push({ field, label, captureA: a, captureB: b, message: `${label} differs: Capture A is ${format(a)}${suffix}; Capture B is ${format(b)}${suffix}.` });
  }
}

/** Compare two normalized capture summaries without changing either input. */
export function compareCaptures(captureA, captureB) {
  const a = normalizeCapture(captureA, "A");
  const b = normalizeCapture(captureB, "B");
  const differences = [];
  const similarities = [];
  const cmp = (field, label, options) => compareField(differences, similarities, field, label, a[field], b[field], options);

  cmp("sentCommandWords", "Sent command words");
  cmp("primaryCommandWord", "Primary command word");
  cmp("requestEnvelope", "Verified request envelope");
  cmp("continuationWords", "Independently witnessed continuation words");
  cmp("verifiedTxWitnesses", "Verified TX witnesses");
  cmp("witnessVerifiedCount", "Verified witness count");
  cmp("txWitnessStatus", "TX witness status");
  cmp("txWitnesses", "TX witness expected and observed words");
  cmp("responseCadenceMs", "Response cadence", { unit: "ms", format: value => Number(value).toFixed(1) });
  cmp("framePeriodMs", "Frame period", { unit: "ms", format: value => Number(value).toFixed(1) });
  cmp("baselinePeriodMs", "Baseline frame period", { unit: "ms", format: value => Number(value).toFixed(1) });
  cmp("periodDistributionMs", "Frame period distribution");
  cmp("nonBaselineResponseFrameCount", "Non-baseline response frame count");
  cmp("responseDurationMs", "Sustained response duration", { unit: "ms" });
  cmp("cadence", "Cadence");
  cmp("frameCount", "Frame count");
  cmp("durationMs", "Duration", { unit: "ms" });
  if (a.initialResponseBlock && b.initialResponseBlock) {
    compareField(differences, similarities, "initialResponseBlock.F00_F03", "Initial response words F00..F03", a.initialResponseBlock.F00_F03, b.initialResponseBlock.F00_F03);
    compareField(differences, similarities, "initialResponseBlock.F04_F15", "Initial response words F04..F15", a.initialResponseBlock.F04_F15, b.initialResponseBlock.F04_F15);
  }
  compareField(differences, similarities, "wordBehavior.changing", "Changing words", a.wordBehavior.changing, b.wordBehavior.changing);
  compareField(differences, similarities, "wordBehavior.constant", "Constant words", a.wordBehavior.constant, b.wordBehavior.constant);
  compareField(differences, similarities, "wordBehavior.transitions", "Word transitions", a.wordBehavior.transitions, b.wordBehavior.transitions);
  compareField(differences, similarities, "phaseTransitions", "Phase transitions", a.phaseTransitions, b.phaseTransitions);
  compareField(differences, similarities, "parityIntegrity.valid", "Parity integrity", a.parityIntegrity.valid, b.parityIntegrity.valid);
  compareField(differences, similarities, "parityIntegrity.errors", "Parity error count", a.parityIntegrity.errors, b.parityIntegrity.errors);
  compareField(differences, similarities, "parityIntegrity.kind", "Parity method", a.parityIntegrity.kind, b.parityIntegrity.kind);
  for (const [field, label] of [
    ["acceptance", "Acceptance result"], ["decodedPidMap", "Decoded PID map"], ["cycleCount", "Cycle count"],
    ["continuationBlocks", "Continuation blocks"], ["offsetCoverage", "Offset coverage"],
    ["responsePattern", "Response pattern"], ["responseDelayMs", "Response delay"], ["responseCodes", "Response codes"],
  ]) compareField(differences, similarities, field, label, a[field], b[field], field === "responseDelayMs" ? { unit: "ms" } : {});

  const testedFields = differences.length + similarities.length;
  const verdict = differences.length ? "DIFFERENT" : testedFields ? "SIMILAR_ON_MEASURED_FIELDS" : "INSUFFICIENT_DATA";
  const differencePriority = field => {
    if (["responseCadenceMs", "framePeriodMs", "nonBaselineResponseFrameCount", "responseDurationMs", "cycleCount"].includes(field)) return 0;
    if (["responseCodes", "responseDelayMs", "phaseTransitions", "initialResponseBlock.F00_F03", "initialResponseBlock.F04_F15"].includes(field)) return 1;
    if (field === "sentCommandWords" || field === "txWitnessStatus" || field === "txWitnesses") return 2;
    return 3;
  };
  const keyDifferences = [...differences].sort((left, right) => differencePriority(left.field) - differencePriority(right.field)).slice(0, 3).map(item => item.message);
  const extraDifferenceCount = differences.length - keyDifferences.length;
  const evidence = [a.evidence, b.evidence].filter(Boolean);
  const parts = [`${a.label} vs ${b.label}:`];
  if (keyDifferences.length) parts.push(keyDifferences.join(" "));
  if (extraDifferenceCount > 0) parts.push(`${extraDifferenceCount} additional measured difference(s) are listed in the result.`);
  const prioritySimilarities = [...similarities].sort((left, right) => {
    const priority = field => field.startsWith("initialResponseBlock.") ? 0 : field === "sentCommandWords" ? 1 : 2;
    return priority(left.field) - priority(right.field);
  }).slice(0, 2).map(item => item.message);
  if (prioritySimilarities.length) parts.push(prioritySimilarities.join(" "));
  if (!differences.length && !similarities.length) parts.push("There is not enough comparable capture data to determine equivalence.");
  if (evidence.length) parts.push([...new Set(evidence)].join(" "));
  if ([...(a.sentCommandWords || []), ...(b.sentCommandWords || [])].includes("42F3") && a.offsetCoverage == null && b.offsetCoverage == null) {
    parts.push("The raw TX witnesses do not independently verify offset 0.");
  }

  return {
    captureA: a,
    captureB: b,
    differences,
    similarities,
    summaryText: parts.join(" "),
    verdict,
  };
}

const fixture = (id, values) => ({ id, label: id, ...values });

/** November 8 field-evidence fixtures. Unknown measurements remain null instead of being inferred. */
export const REFERENCE_CAPTURE_FIXTURES = Object.freeze({
  "260E": fixture("260E", {
    sentCommandWords: ["260E"], primaryCommandWord: "260E", framePeriodMs: 42.5, cadence: "42.5 ms",
    baselinePeriodMs: 10.0, responseCadenceMs: 42.5, nonBaselineResponseFrameCount: 16, responseDurationMs: 680,
    continuationBlocks: "initial request only; no continuation request observed",
    initialResponseBlock: { F00_F03: { F00: "72E1" }, F04_F15: {
      F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90", F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
    } },
    evidence: "Its first-cycle payload matches 26A4, but the slower cadence is a real distinction.",
  }),
  "26A4": fixture("26A4", {
    sentCommandWords: ["26A4"], primaryCommandWord: "26A4", framePeriodMs: 17.5, cadence: "17.5 ms",
    baselinePeriodMs: 10.0, responseCadenceMs: 17.5, nonBaselineResponseFrameCount: 16, responseDurationMs: 280,
    continuationBlocks: "initial request only; no continuation request observed",
    initialResponseBlock: { F00_F03: { F00: "72E1" }, F04_F15: {
      F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90", F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
    } },
    evidence: "Its first-cycle payload matches 260E while its frame cadence remains faster.",
  }),
  "005E": fixture("005E", {
    sentCommandWords: ["005E"], primaryCommandWord: "005E", framePeriodMs: 10.0, cadence: "10.0 ms",
    baselinePeriodMs: 10.0, nonBaselineResponseFrameCount: 0,
    continuationBlocks: "initial request only; no continuation request observed",
    parityIntegrity: { valid: false, errors: 1, kind: "invalid" }, acceptance: "no acceptance; timing unchanged",
    decodedPidMap: {}, evidence: "Invalid parity did not cause acceptance; no decoded PID map was returned.",
  }),
  "004E": fixture("004E", {
    sentCommandWords: ["004E"], primaryCommandWord: "004E", framePeriodMs: 42.5, cadence: "42.5 ms", frameCount: 16, cycleCount: 1,
    baselinePeriodMs: 10.0, responseCadenceMs: 42.5, nonBaselineResponseFrameCount: 16, responseDurationMs: 680,
    continuationBlocks: "initial request only; no continuation request observed",
    parityIntegrity: { valid: true, errors: 0, kind: "generic parity" }, acceptance: "structural acceptance for 1 cycle",
    decodedPidMap: {}, evidence: "Valid generic parity switched timing for one 16-frame cycle; no decoded PID map was returned.",
  }),
  MEM: fixture("MEM", {
    sentCommandWords: ["42F3", "22D3"], primaryCommandWord: "42F3", continuationWords: [],
    verifiedTxWitnesses: 4, witnessVerifiedCount: 244, wordsStarted: 4, offsetCoverage: "offsets 1..15",
    continuationBlocks: "continuation activity observed (profile candidate 22D3, witness count 244); individual continuation words not independently PAD-verified",
    framePeriodMs: 15.0, cadence: "15.0 ms", baselinePeriodMs: 10.0, responseCadenceMs: 15.0,
    nonBaselineResponseFrameCount: 16, responseFrameCount: 16, responseDurationMs: 240, cycleCount: 1,
    initialResponseBlock: { F00_F03: { F00: "72E1" }, F04_F15: {
      F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90", F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
    } },
    parityIntegrity: { valid: false, errors: 1, kind: "invalid continuation parity" },
    evidence: "MEM reverted to 10.0 ms after one response cycle; 22D3 remains a profile candidate without an individual PAD witness.",
  }),
  MEM_OFF0: fixture("MEM_OFF0", {
    sentCommandWords: ["42F3", "22D3"], primaryCommandWord: "42F3", continuationWords: [],
    verifiedTxWitnesses: 4, witnessVerifiedCount: 244, wordsStarted: 4,
    continuationBlocks: "continuation activity observed (profile candidate 22D3, witness count 244); individual continuation words not independently PAD-verified",
    framePeriodMs: 15.0, cadence: "15.0 ms", baselinePeriodMs: 10.0, responseCadenceMs: 15.0,
    nonBaselineResponseFrameCount: 16, responseFrameCount: 16, responseDurationMs: 240, cycleCount: 1,
    initialResponseBlock: { F00_F03: { F00: "72E1" }, F04_F15: {
      F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90", F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
    } },
    evidence: "Historical MEM_OFF0 recording is not proof offset 0 was transmitted; offset 0 remains an unresolved hypothesis.",
  }),
  MEM_SINGLE: fixture("MEM_SINGLE", {
    sentCommandWords: ["42F3"], primaryCommandWord: "42F3", continuationWords: [],
    verifiedTxWitnesses: 4, witnessVerifiedCount: 4, wordsStarted: 4, offsetCoverage: "offsets 1..15",
    framePeriodMs: 15.0, cadence: "15.0 ms", baselinePeriodMs: 10.0, responseCadenceMs: 15.0,
    nonBaselineResponseFrameCount: 16, responseFrameCount: 16, responseDurationMs: 240, cycleCount: 1,
    continuationBlocks: "initial request only; no continuation request observed",
    initialResponseBlock: { F00_F03: { F00: "72E1" }, F04_F15: {
      F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90", F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
    } },
    evidence: "MEM_SINGLE sends only the initial 42F3 request.",
  }),
  MEM_PARITY: fixture("MEM_PARITY", {
    sentCommandWords: ["42F3", "2293"], primaryCommandWord: "42F3", continuationWords: [],
    verifiedTxWitnesses: 4, witnessVerifiedCount: 164, wordsStarted: 4,
    framePeriodMs: 15.0, cadence: "15.0 ms", baselinePeriodMs: 10.0, responseCadenceMs: 15.0,
    nonBaselineResponseFrameCount: 608, responseFrameCount: 608, responseDurationMs: 9120, cycleCount: 38,
    parityIntegrity: { valid: true, errors: 0, kind: "generic VPARITY" }, wordBehavior: { changing: ["counter"], constant: null },
    initialResponseBlock: { F00_F03: { F00: "72E1" }, F04_F15: {
      F04: "26E0", F05: "FFA0", F06: "1F40", F07: "FC90", F08: "00A0", F09: "00A0", F10: "ADD0", F11: "3810",
    } },
    continuationBlocks: "sustained continuation activity observed (profile candidate 2293, ~38 response cycles, witness count 164)",
    evidence: "15 ms timing persisted for about 38 cycles with structured changing data.",
  }),
  KOEO: fixture("KOEO", {
    sentCommandWords: ["253E"], primaryCommandWord: "253E", continuationBlocks: "initial request only; no continuation request observed",
    framePeriodMs: 42.5, cadence: "42.5 ms", responsePattern: "static single code",
    responseDelayMs: 9000, responseCodes: ["11B1"], wordBehavior: {
      changing: ["F07"], constant: ["11B1"], transitions: { F07: ["ACC0", "EC80"] },
    },
    evidence: "After about 9 seconds it showed the static code 11B1; F07 changed ACC0 to EC80.",
  }),
  KOER: fixture("KOER", {
    sentCommandWords: ["253E"], primaryCommandWord: "253E", continuationBlocks: "initial request only; no continuation request observed",
    framePeriodMs: 42.5, cadence: "42.5 ms", responsePattern: "dynamic multi-code burst",
    responseDelayMs: 58600, cycleCount: 267, responseCodes: ["16C1", "72E1", "3845", "21C5"],
    wordBehavior: { changing: ["response-code-burst"], constant: null },
    evidence: "After about 58.6 seconds it emitted a dynamic four-code burst that persisted for 267 cycles.",
  }),
});

export const REFERENCE_COMPARISON_PAIRS = Object.freeze([
  Object.freeze({ id: "260E-vs-26A4", captureA: "260E", captureB: "26A4" }),
  Object.freeze({ id: "005E-vs-004E", captureA: "005E", captureB: "004E" }),
  Object.freeze({ id: "MEM-vs-MEM_OFF0", captureA: "MEM", captureB: "MEM_OFF0" }),
  Object.freeze({ id: "MEM-vs-MEM_SINGLE", captureA: "MEM", captureB: "MEM_SINGLE" }),
  Object.freeze({ id: "MEM-vs-MEM_PARITY", captureA: "MEM", captureB: "MEM_PARITY" }),
  Object.freeze({ id: "KOEO-vs-KOER", captureA: "KOEO", captureB: "KOER" }),
]);

export function compareReferencePair(pairId) {
  const pair = REFERENCE_COMPARISON_PAIRS.find(item => item.id === pairId);
  if (!pair) throw new RangeError(`Unknown reference comparison pair: ${pairId}`);
  return compareCaptures(REFERENCE_CAPTURE_FIXTURES[pair.captureA], REFERENCE_CAPTURE_FIXTURES[pair.captureB]);
}

export function exportComparisonJson(comparisonResult) {
  return JSON.stringify(comparisonResult, null, 2);
}

function csvCell(value) {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/** CSV rows describe the summary, each measured difference, and each measured similarity. */
export function exportComparisonCsv(comparisonResult) {
  const columns = ["record_type", "field", "capture_a", "capture_b", "description", "verdict", "summary_text"];
  const captureA = comparisonResult?.captureA?.label ?? "";
  const captureB = comparisonResult?.captureB?.label ?? "";
  const rows = [["summary", "", captureA, captureB, comparisonResult?.summaryText ?? "", comparisonResult?.verdict ?? "", comparisonResult?.summaryText ?? ""]];
  for (const item of comparisonResult?.differences || []) rows.push(["difference", item.field, item.captureA, item.captureB, item.message, comparisonResult.verdict, ""]);
  for (const item of comparisonResult?.similarities || []) rows.push(["similarity", item.field, item.captureA, item.captureB, item.message, comparisonResult.verdict, ""]);
  return [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
