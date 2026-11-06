/** Per-capture validity. A session is valid only when every check passes. */
import { reasonText } from "./protocol.js";

export function createSession() {
  return {
    started: false,
    kind: "",
    rx: 0,
    pads: [],
    epoch: null,
    bootId: null,
    problems: [],
    faults: [],
    end: null,
    offlineQuietUs: null,
    bridgeBlocks: null,
    pidMap: null,
  };
}

export function noteSessionLine(session, parsed) {
  if (!session || session.end) return session;
  if (parsed.type === "session_start") {
    session.started = true;
    session.kind = parsed.kind || "";
    session.epoch = parsed.fields?.epoch ?? null;
    session.bootId = parsed.fields?.boot_id ?? null;
    session.startRaw = parsed.raw;
    session.rx = 0;
    session.pads = [];
    session.problems = [];
    session.faults = [];
    return session;
  }
  if (!session.started) return session;
  if (parsed.type === "rx") session.rx += 1;
  else if (parsed.type === "rx_batch") session.rx += parsed.events.length;
  else if (parsed.type === "pad") session.pads.push(parsed);
  else if (parsed.type === "fault") { session.problems.push(`FAULT reason=${parsed.reason}`); session.faults.push(parsed.raw); }
  else if (parsed.type === "denied") session.problems.push(`DENIED ${parsed.reason}`.trim());
  else if (parsed.type === "uart_errors") session.problems.push("EVENT uart_errors");
  else if (parsed.type === "rx_lost") session.problems.push("EVENT rx_lost");
  else if (parsed.type === "offline") session.offlineQuietUs = parsed.quiet_us;
  else if (parsed.type === "dps") session.bridgeBlocks = parsed.blocks;
  else if (parsed.type === "pid_map") session.pidMap = parsed;
  else if (parsed.type === "end") session.end = parsed;
  return session;
}

function diagnosticModeProblems(variant, cart) {
  const spec = {
    "0E": { expected: 0x26, expectedBlocks: "blocks26", otherBlocks: "blocks25" },
    A4: { expected: 0x26, expectedBlocks: "blocks26", otherBlocks: "blocks25" },
    KOEO: { expected: 0x25, expectedBlocks: "blocks25", otherBlocks: "blocks26", selfTest: true },
    KOER: { expected: 0x25, expectedBlocks: "blocks25", otherBlocks: "blocks26", selfTest: true },
  }[variant];
  if (!spec) return [];
  if (!cart) return [`missing decoded response for ${variant}`];

  const reasons = [];
  if (!(cart[spec.expectedBlocks] > 0)) {
    reasons.push(`missing mode ${spec.expected.toString(16).toUpperCase()}H response for ${variant}`);
  }
  if (cart[spec.otherBlocks] > 0) {
    const unexpected = spec.expected === 0x26 ? 0x25 : 0x26;
    reasons.push(`unexpected mode ${unexpected.toString(16).toUpperCase()}H response during ${variant}`);
  }
  if (cart.codes?.some((entry) => entry.mode !== spec.expected)) {
    reasons.push(`DTC code mode does not match ${variant}`);
  }
  if (cart.codeParityRejects > 0) {
    reasons.push(`${cart.codeParityRejects} DTC code word(s) failed parity verification`);
  }
  if (spec.selfTest && !cart.selfTestComplete) {
    reasons.push(`missing Frame 7 result-phase flag for ${variant}`);
  }
  return reasons;
}

export function sessionVerdict(session, flags = {}) {
  const reasons = [];
  if (flags.disconnect) reasons.push("link lost");
  if (flags.timeout) reasons.push("timed out");
  if (!session || !session.started) reasons.push("session did not start");
  if (session) reasons.push(...session.problems);
  reasons.push(...diagnosticModeProblems(flags.variant, flags.cart));
  if (!session?.end) reasons.push("no END line");
  else {
    // END means the bridge stopped, NOT necessarily that a read completed.
    // In v21 a five-second silence used END reason=7 (CART_HEADER) without
    // emitting FAULT, so old LIVE views could wrongly display "Valid".
    if (![15, 16].includes(session.end.reason)) {
      reasons.push(`END reason=${session.end.reason} (${reasonText(session.end.reason)})`);
    }
    if (session.end.de !== "LOW") reasons.push(`END DE=${session.end.de || "missing"}`);
    if (session.end.ro_lost !== 0) reasons.push(`ro_lost=${session.end.ro_lost}`);
    if (session.end.uart_errors !== 0) reasons.push(`uart_errors=${session.end.uart_errors}`);
    if (session.rx !== session.end.ro_bytes) {
      reasons.push(`RX lines ${session.rx} != ro_bytes ${session.end.ro_bytes}`);
    }
    for (const pad of session.pads) {
      if (pad.match !== 1 || pad.observed !== pad.expected) {
        reasons.push(`TX_PAD slot ${pad.slot} expected ${pad.expected} observed ${pad.observed} match ${pad.match}`);
      }
    }
  }
  const fields = session?.end?.fields || {};
  const uint = value => typeof value === "string" && /^\d{1,10}$/.test(value) && Number(value) <= 0xffffffff;
  const uniqueFields = raw => {
    const keys = [...String(raw || "").matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map(match => match[1]);
    return new Set(keys).size === keys.length;
  };
  const versioned = session?.kind === "READ_CANDIDATE" &&
    (session.epoch !== null || session.bootId !== null || fields.evidence === "2" || session.pads.some(p => p.evidence === 2));
  const counters = uint(fields.witness_started) && uint(fields.witness_verified) &&
    Number(fields.witness_started) >= 4 && fields.witness_started === fields.witness_verified;
  const provenance = versioned && uniqueFields(session.startRaw) && uniqueFields(session.end?.raw) && uint(session.epoch) && uint(session.bootId) &&
    fields.evidence === "2" && fields.epoch === session.epoch && fields.boot_id === session.bootId && counters &&
    session.pads.length === 4 && [0, 1, 2, 3].every(slot => {
      const matches = session.pads.filter(p => p.slot === slot);
      if (matches.length !== 1) return false;
      const p = matches[0];
      return uniqueFields(p.raw) && p.evidence === 2 && p.fields.boot_id === session.bootId && p.fields.epoch === session.epoch &&
        p.block === 0 && p.sequence === slot + 1 && p.completed === 1 && p.match === 1 &&
        /^[0-9A-F]{4}$/.test(p.fields.expected || "") && p.fields.expected === p.fields.observed &&
        uint(p.fields.tx_us) && uint(p.fields.done_us) &&
        ((Number(p.fields.done_us) - Number(p.fields.tx_us)) >>> 0) > 0 &&
        ((Number(p.fields.done_us) - Number(p.fields.tx_us)) >>> 0) < 1000000;
    });
  if (versioned && !provenance) reasons.push("TX_PAD session provenance missing or inconsistent");
  const forced = flags.disconnect || flags.timeout;
  const valid = reasons.length === 0 && !forced;
  let status = "INCOMPLETE";
  if (valid) status = "VALID";
  else if (flags.disconnect) status = "FAILED";
  return {
    valid,
    witnessStatus: provenance ? "SESSION_BOUND" : "LEGACY_UNVERIFIED",
    verifiedSuccess: false,
    status,
    reasons,
    end: session?.end || null,
  };
}
