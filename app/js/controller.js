/** Operation controller. Timers stay outside; call tick() with the injected clock. */

import { createCartDecoder } from "./cart.js";
import { ALL_LIVE_PIDS, PIDS, pidSetForVariant, summarizeSeries } from "./pids.js";
import {
  TIMEOUTS,
  VARIANTS,
  COMMAND_CATALOGUE,
  DISCOVERY_PASS_ORDER,
  DCL_PROBE_VARIANTS,
  FACTORY_PROCEDURES,
  MEM_EXPERIMENTS,
  firmwareCompatibility,
  parseLine,
  reasonText,
} from "./protocol.js";
import { createSession, noteSessionLine, sessionVerdict } from "./session.js";
import { appendCombined, createCombined, finishCombinedSegment, GROUP_WINDOW_MS, LIVE_GROUPS, startCombinedSegment } from "./combined.js";
import { recordBridgeRaw, recordDiagnosticSample } from "./diagnostics.js";
import { noResponseFromStart, ignitionConfirmationNeeded, ECU_NO_RESPONSE_MESSAGE } from "./session-outcome.js";

function unique(list) {
  const out = [];
  for (const item of list) if (item && !out.includes(item)) out.push(item);
  return out;
}

const LIVE_RECOVERY_MS = 30_000;

function isLiveVariant(variant) {
  return VARIANTS[variant]?.kind === "live";
}

function parseResumeLine(raw) {
  const match = /^RESUME (OK|DENIED)(?:\s+(.*))?$/.exec(String(raw));
  if (!match) return null;
  const fields = {};
  for (const field of (match[2] || "").split(/\s+/).filter(Boolean)) {
    const item = /^([A-Za-z_][A-Za-z0-9_]*)=(\S+)$/.exec(field);
    if (item) fields[item[1]] = item[2];
  }
  return { ok: match[1] === "OK", fields };
}

const CATALOGUE_ENTRIES = Object.values(COMMAND_CATALOGUE);

export function discoveryPassCandidates() {
  const orderedIds = [...DISCOVERY_PASS_ORDER];
  return orderedIds.map(id => CATALOGUE_ENTRIES.find(item => item.id === id)).filter(item =>
    item?.sendable && item.classification === "READ_ONLY" && item.variantKey && VARIANTS[item.variantKey]);
}

const ECU_STATE_TRANSITIONS = Object.freeze({
  ANY_POWERED: "ignition ON so the ECU is powered, transmission in neutral, parking brake applied",
  KEY_ON_ENGINE_OFF: "ignition ON, engine OFF, transmission in neutral, parking brake applied",
  KEY_ON_ENGINE_RUNNING: "engine running at operating temperature, vehicle stationary in neutral, parking brake applied",
  ACTIVE_PID_FLOW: "an active PID data stream that this command is allowed to stop",
});

/** State-changing, self-test, configuration, and experimental memory reads need a fresh operator check. */
export function candidateRequiresOperatorConfirmation(candidate) {
  if (!candidate) return true;
  return candidate.classification !== "READ_ONLY" ||
    candidate.id === "MEMORY_READ" || String(candidate.id).startsWith("MEM_");
}

export function candidateRequiredStateText(candidate) {
  const state = candidate?.requiredEcuState || "ANY_POWERED";
  return ECU_STATE_TRANSITIONS[state] || `the ECU state recorded as ${state}`;
}

export function candidateConfirmationRequiredMessage(candidate) {
  return `${candidate?.name || "This command"} was not transmitted because the operator confirmation or required vehicle state was not provided. Required transition: ${candidateRequiredStateText(candidate)}.`;
}


function catalogueCandidateForVariant(variant) {
  return CATALOGUE_ENTRIES.find(candidate => candidate.variantKey === variant) || null;
}

function verifiedBridgeStatus(parsed) {
  const statusKeys = [...parsed.raw.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map(match => match[1]);
  return parsed.identity === "SME105_USB_BRIDGE_V1" && new Set(statusKeys).size === statusKeys.length &&
    ["out_overflow", "transport_lost", "usb_skipped"].every(key => parsed.fields[key] === "0" ||
      (parsed.fields[key] == null && !(Number(parsed.fields.fw) >= 24 || parsed.fields.pad_evidence === "2"))) &&
    ["0", "3", "4", "15", "16", "19"].includes(parsed.fields.fault);
}

function statusCanRearm(parsed) {
  return verifiedBridgeStatus(parsed) && parsed.safe && parsed.fields.stage === "0" &&
    parsed.fields.read_used === "0" && parsed.fields.fault === "0";
}

export function createController({ now = () => Date.now(), send = () => {} } = {}) {
  const listeners = new Set();
  const state = {
    link: "disconnected",
    phase: "idle",
    deviceName: "",
    transport: "",
    identity: { auth: "", hello: "", helloOk: null, pins: "", pinsOk: null },
    status: null,
    bench: { result: "", pass: false },
    rom: null,
    battery: null,
    log: [],
    op: null,
    lastSession: null,
    lastDclProbe: null,
    cart: null,
    trust: "none",
    message: "Disconnected",
    deadline: null,
    combined: null,
    archive: null,
    recoveryDeadline: null,
    resuming: false,
    discoveryPass: null,
    memMatrix: { status: "idle", activeId: "", stopRequested: false, results: [] },
    factoryProcedure: null,
    experimentResults: [],
    candidateBatch: null,
  };

  function touch() {
    for (const fn of listeners) fn(state);
  }

  function arm(ms) {
    state.deadline = now() + ms;
  }

  function buildResult(verdict) {
    const snap = state.cart ? state.cart.snapshot() : null;
    if (snap) {
      for (let i = snap.rows.length - 1; i >= 0 && snap.rows[i].receivedAt == null; --i) snap.rows[i].receivedAt = now();
    }
    const variant = state.op?.variant || state.lastSession?.variant || "";
    const requestedMode = variant === "0E" || variant === "A4" ? 0x26
      : variant === "KOEO" || variant === "KOER" || variant === "KOEO_ALT" ? 0x25 : null;
    const probeSpec = DCL_PROBE_VARIANTS[variant] || null;
    const dclProbe = probeSpec ? {
      variant, ...probeSpec,
      responseBytes: state.op?.session?.rx ?? 0,
      responseObserved: (state.op?.session?.rx ?? 0) > 0,
      ecuOriginVerified: false,
      bridgeCaptureStatus: verdict.status,
    } : null;
    const factoryProcedure = state.factoryProcedure ? {
      ...state.factoryProcedure,
      prompts: [...state.factoryProcedure.prompts],
      codes: [...(state.factoryProcedure.codes || [])],
      verdict: state.factoryProcedure.verdict ? { ...state.factoryProcedure.verdict } : null,
    } : null;
    const codes = (snap?.codes || []).map((entry) => ({
      code: entry.code,
      mode: entry.mode,
      requestedMode,
      requestedVariant: variant,
      source: entry.mode === 0x25 ? variant : probeSpec ? `DCL probe ${variant}` : `stored request ${variant}`,
      frame: entry.frame,
      slot: entry.slot,
      rawBytes: entry.rawBytes,
      rawData: entry.rawData,
      rxTimeUs: entry.rxTimeUs,
      receivedAt: entry.receivedAt,
      frameTimeUs: entry.frameTimeUs,
      frameReceivedAt: entry.frameReceivedAt,
    }));
    const pids = {};
    if (snap) {
      for (const [name, series] of Object.entries(snap.pids)) {
        pids[name] = { ...series, summary: series.summary || summarizeSeries(series.samples) };
      }
    }
    return {
      variant,
      kind: state.op?.kind || "",
      dclProbe,
      factoryProcedure,
      source: state.op?.source || "bridge",
      startedAt: state.op?.startedAt || null,
      completedAt: now(),
      verdict,
      bridgeStatus: state.status,
      denial: state.op?.denial || null,
      requestedMode,
      observedModes: [
        ...((snap?.blocks25 || 0) > 0 ? [0x25] : []),
        ...((snap?.blocks26 || 0) > 0 ? [0x26] : []),
      ],
      dtcVerified: state.op?.session?.end?.fields?.dtc_verified === "1",
      codes,
      pids,
      rows: snap?.rows || [],
      totalRows: snap?.totalRows || 0,
      mem: snap?.mem ? { ...snap.mem } : {},
      rom: snap?.rom || null,
      selfTestComplete: !!snap?.selfTestComplete,
      ecuEvidence: snap?.evidence || [],
      integrity: { rawCapture: verdict.status, witness: verdict.witnessStatus || "LEGACY_UNVERIFIED",
        mode: requestedMode == null ? "NOT_DIAGNOSTIC" : ((requestedMode === 0x25 ? snap?.blocks25 > 0 && !snap?.blocks26 : snap?.blocks26 > 0 && !snap?.blocks25) && (snap?.codes || []).every(c => c.mode === requestedMode) ? "CONSISTENT" : "MISSING_OR_MISMATCHED"),
        resultPhaseObserved: !!snap?.selfTestComplete, operatorCompleteness: "UNVERIFIED", verifiedKoerSuccess: false },
      frame7First: snap?.frame7First ?? null,
      frame7Last: snap?.frame7Last ?? null,
      completeBlocks25: snap?.completeBlocks25 || 0,
      completeBlocks26: snap?.completeBlocks26 || 0,
      blocks25: snap?.blocks25 || 0,
      blocks26: snap?.blocks26 || 0,
      bridgeBlocks: state.op?.session?.bridgeBlocks ?? null,
      bridgeFaults: [...(state.op?.session?.faults || [])],
      bridgeProblems: [...(state.op?.session?.problems || [])],
      sequenceGaps: [...(state.op?.session?.sequenceGaps || [])],
      sequenceGapCount: (state.op?.session?.sequenceGaps || []).reduce((sum, gap) => sum + gap.lost, 0),
      operatorStop: !!state.op?.operatorStop,
      recordingError: state.archive?.error || "",
      offlineQuietUs: state.op?.session?.offlineQuietUs ?? null,
      parityRejects: snap?.parityRejects || 0,
      codeParityRejects: snap?.codeParityRejects || 0,
    };
  }

  function latestDclCaptureLines(log) {
    let start = -1;
    for (let index = log.length - 1; index >= 0; --index) {
      if (String(log[index]).startsWith("EVENT session=READ_CANDIDATE")) { start = index; break; }
    }
    if (start < 0) return [];
    let first = start;
    for (let index = start - 1; index >= 0; --index) {
      if (String(log[index]).startsWith("EVENT read_armed ")) { first = index; break; }
      if (String(log[index]).startsWith("END ") || String(log[index]).startsWith("EVENT session=")) break;
    }
    let end = log.findIndex((line, index) => index > start && String(line).startsWith("END "));
    if (end < 0) end = log.length - 1;
    return log.slice(first, end + 1).map(String);
  }

  function finalize(override) {
    if (!state.op) return;
    if (state.cart && !state.cart.snapshot().closed) state.cart.finish();
    const session = state.op?.session || null;
    let verdict = session ? sessionVerdict(session, {
      variant: state.op?.variant,
      requireVersioned: Number(state.status?.fields?.fw) >= 24 || state.status?.fields?.pad_evidence === "2",
      cart: state.cart?.snapshot() || null,
    }) : null;
    if (override) {
      verdict = {
        ...verdict,
        valid: false,
        status: override.status,
        reasons: unique([override.reason, ...(verdict?.reasons || [])]),
        end: verdict?.end || session?.end || null,
      };
    } else if (!verdict) {
      verdict = { valid: false, status: "INCOMPLETE", reasons: ["session did not start"], end: null };
    }
    if (state.factoryProcedure?.status === "running" || state.factoryProcedure?.status === "stopping") {
      const procedure = state.factoryProcedure;
      procedure.status = state.op?.operatorStop ? "stopped"
        : procedure.stepIndex >= procedure.prompts.length ? "complete" : "incomplete";
      procedure.completedAt = now();
      procedure.responseBytes = session?.rx ?? 0;
      procedure.codes = [...(state.cart?.snapshot()?.codes || [])];
      procedure.verdict = verdict;
      procedure.error = procedure.status === "stopped" ? "Stopped by operator."
        : procedure.status === "incomplete" ? "Capture ended before all procedure prompts were completed." : "";
    }
    state.lastSession = buildResult(verdict);
    state.lastSession.recordingId = state.archive?.id || null;
    if (state.lastSession.dclProbe) {
      state.lastDclProbe = {
        ...state.lastSession.dclProbe,
        startedAt: state.lastSession.startedAt,
        completedAt: state.lastSession.completedAt,
        verdict: state.lastSession.verdict,
        rawLines: latestDclCaptureLines(state.log),
        recordingId: state.archive?.id || null,
        result: {
          variant: state.lastSession.variant,
          verdict: state.lastSession.verdict,
          responseBytes: state.lastSession.dclProbe.responseBytes,
          completedAt: state.lastSession.completedAt,
        },
      };
    }
    if (noResponseFromStart(session, state.lastSession, state.op?.operatorStop, override)) {
      state.lastSession.outcome = "NOT_STARTED_ECU_NO_RESPONSE";
      verdict.outcome = state.lastSession.outcome;
    }
    if (ignitionConfirmationNeeded(session, state.lastSession, state.op, override)) {
      state.lastSession.outcome = "OPERATOR_CONFIRMATION_PENDING";
      verdict.outcome = state.lastSession.outcome;
    }
    if (state.op?.variant === "ALL" && verdict.valid) {
      const map = state.op.session?.pidMap;
      const complete = [15, 16].includes(verdict.end?.reason) && verdict.end?.de === "LOW"
        && map?.set === "ALL" && map.sent === 45 && map.verified === 45
        && state.lastSession.parityRejects === 0
        && ALL_LIVE_PIDS.slice(1).every((pid) => state.lastSession.pids[PIDS[pid][0]]?.samples.length > 0);
      if (!complete) {
        verdict = { ...verdict, valid: false, status: "INCOMPLETE", reasons: ["All-data map or sample verification incomplete"] };
        state.lastSession.verdict = verdict;
      }
    }
    const combined = state.combined;
    if (combined && state.op && LIVE_GROUPS.includes(state.op.variant)) {
      const expected = pidSetForVariant(state.op.variant).slice(1);
      const map = state.op.session?.pidMap;
      const complete = verdict.valid && [15, 16].includes(verdict.end?.reason)
        && state.lastSession.parityRejects === 0
        && map?.sent === expected.length && map?.verified === expected.length
        && expected.every((pid) => state.lastSession.pids[PIDS[pid][0]]?.samples.length > 0);
      finishCombinedSegment(combined, state.lastSession, now(), complete);
      if (!complete) {
        combined.active = false;
        combined.error = "All-data recording stopped: a group failed its capture, PID-map or sample checks.";
      } else if (combined.active && combined.rotateRequested) {
        combined.groupIndex = (combined.groupIndex + 1) % LIVE_GROUPS.length;
        combined.nextPending = true;
      } else {
        combined.active = false;
      }
    }
    state.trust = verdict.valid && !combined?.failed ? "valid" : "untrusted";
    if (state.archive) state.archive.finished = state.archive.finish(verdict, { outcome: state.lastSession.outcome || null, session: { variant: state.lastSession.variant, startedAt: state.lastSession.startedAt, completedAt: state.lastSession.completedAt } }).catch(error => { state.message = `Recording storage: ${error.message}`; touch(); return null; });
    if (verdict.valid && state.lastSession.rom) state.rom = state.lastSession.rom;
    const vbat = state.lastSession.pids.VBAT?.summary?.last;
    if (verdict.valid && vbat != null) state.battery = vbat;
    state.phase = "idle";
    state.deadline = null;
    state.recoveryDeadline = null;
    state.resuming = false;
    state.op = null;
    const diagnosticRead = ["codes", "koeo", "koer"].includes(state.lastSession.kind);
    state.message = state.lastSession.dclProbe
      ? verdict.valid
        ? `Bridge capture integrity passed — ${state.lastSession.dclProbe.responseBytes} raw RO byte(s) observed; ECU ownership and command support remain unverified.`
        : `${verdict.status}: ${verdict.reasons.join("; ")}`
      : verdict.valid
        ? diagnosticRead
          ? `Capture integrity checks passed — ECU DTC verification ${state.lastSession.dtcVerified ? "reported" : "not reported"}.`
          : `Valid — ${verdict.end ? reasonText(verdict.end.reason) : "complete"}`
        : `${verdict.status}: ${verdict.reasons.join("; ")}`;
    if (combined?.error) state.message = combined.error;
    if (state.lastSession.outcome === "OPERATOR_CONFIRMATION_PENDING") state.message = "Live data stopped. Operator confirmation is pending.";
    if (state.lastSession.outcome === "NOT_STARTED_ECU_NO_RESPONSE") state.message = ECU_NO_RESPONSE_MESSAGE;
    if (state.lastSession.sequenceGapCount > 0) {
      state.message += ` · ${state.lastSession.sequenceGapCount} missing telemetry sample(s) recorded`;
    }
    touch();
  }

  function beginArm() {
    if (state.transport === "ble" && state.identity.auth !== "OK") {
      finalize({ status: "FAILED", reason: "bridge authentication pending" });
      return;
    }
    state.phase = "arm";
    state.message = `Arming ${state.op.variant}`;
    arm(TIMEOUTS.arm);
    send(`ARM_${state.op.variant}`);
  }

  function checkReadLatch(parsed) {
    if (!state.op?.variant) return false;
    if (parsed.fields.read_used !== "1") {
      if (parsed.fields.read_used !== "0") {
        finalize({ status: "INCOMPLETE", reason: "Bridge read lock status is unknown." });
        return true;
      }
      return false;
    }
    const counters = ["out_overflow", "transport_lost", "usb_skipped"];
    const keys = [...parsed.raw.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map(match => match[1]);
    const clean = parsed.safe && now() - (parsed.receivedAt ?? now()) <= TIMEOUTS.status && parsed.identity === "SME105_USB_BRIDGE_V1" && new Set(keys).size === keys.length &&
      counters.every(key => parsed.fields[key] === "0") && ["0", "3", "4", "15", "16", "19"].includes(parsed.fields.fault);
    finalize(clean
      ? { status: "BRIDGE_READ_ALREADY_USED", reason: "The bridge is locked after a previous read. Restart the bridge safely before starting another read." }
      : { status: "INCOMPLETE", reason: "Bridge read latch is used; transport status is missing or reports a problem." });
    return true;
  }

  function onStatus(parsed) {
    state.status = {
      identity: parsed.identity,
      fields: parsed.fields,
      raw: parsed.raw,
      safe: parsed.safe,
      receivedAt: now(),
    };
    state.bench.pass = parsed.fields.tx2_bench_pass === "1";
    if (state.phase === "discovery_status") {
      const ok = state.link === "ready" &&
        (state.transport !== "ble" || state.identity.auth === "OK") && statusCanRearm(parsed);
      const result = {
        ok,
        status: state.status,
        error: ok ? "" : state.link !== "ready"
          ? "Bridge connection was lost during the safety check."
          : !parsed.safe ? "Bridge is not in a safe IDLE state."
          : parsed.fields.read_used !== "0" ? "Bridge read latch is used; it cannot be re-armed."
          : parsed.fields.fault !== "0" ? `Bridge reports fault ${parsed.fields.fault}; discovery stopped.`
          : "Bridge status is incomplete or reports transport errors.",
      };
      state.phase = "idle";
      state.deadline = null;
      state.message = ok ? "Bridge safe and re-armable" : result.error;
      const resolve = state.discoveryPass?.statusResolver;
      if (state.discoveryPass) state.discoveryPass.statusResolver = null;
      touch();
      resolve?.(result);
      return;
    }
    if (state.phase === "identify_status") {
      state.phase = "idle";
      state.deadline = null;
      state.message = parsed.safe ? "Bridge idle" : "Bridge is not in a safe idle state";
      return;
    }
    const verifiedStatus = verifiedBridgeStatus(parsed);
    if (state.phase === "reboot_status") {
      if (!parsed.safe || !verifiedStatus || state.link !== "ready" ||
          (state.transport === "ble" && state.identity.auth !== "OK") ||
          !["out_overflow", "transport_lost", "usb_skipped"].every(key => parsed.fields[key] === "0")) {
        state.phase = "idle";
        state.deadline = null;
        state.message = "Bridge restart blocked: safe idle and healthy transport could not be verified.";
        return;
      }
      state.phase = "reboot";
      state.message = "Rebooting bridge";
      arm(TIMEOUTS.identify);
      send("REBOOT");
      return;
    }
    if (state.phase === "pre_status") {
      if (!parsed.safe || !verifiedStatus) {
        finalize({ status: "INCOMPLETE", reason: "bridge not idle/safe" });
        return;
      }
      if (checkReadLatch(parsed)) return;
      const runBench = state.op?.manualBench || parsed.fields.tx2_bench_pass !== "1";
      if (runBench) {
        state.phase = "bench";
        state.message = "Running local pad self-test";
        arm(TIMEOUTS.bench);
        send("TX2_BENCH");
        return;
      }
      beginArm();
      return;
    }
    if (state.phase === "post_status") {
      if (!parsed.safe || !verifiedStatus || parsed.fields.tx2_bench_pass !== "1") {
        finalize({ status: "INCOMPLETE", reason: "bench did not leave the bridge safe" });
        return;
      }
      if (state.op?.manualBench && !state.op.variant) {
        state.phase = "idle";
        state.deadline = null;
        state.op = null;
        state.message = "Bridge self-test passed";
        return;
      }
      if (checkReadLatch(parsed)) return;
      beginArm();
    }
  }

  function ingestRead(parsed) {
    if (!state.op) return;
    if (!state.op.session) state.op.session = createSession();
    const session = state.op.session;
    if (parsed.type === "session_start" && session.started) {
      const sameBoot = parsed.fields?.boot_id == null || parsed.fields.boot_id === session.bootId;
      const sameSession = (parsed.fields?.session_id ?? parsed.fields?.epoch ?? null) == null ||
        String(parsed.fields.session_id ?? parsed.fields.epoch) === String(session.sessionId ?? session.epoch);
      if (sameBoot && sameSession) return;
    }
    if (parsed.type === "session_start" && !state.op.session.started) {
      state.cart = createCartDecoder(pidSetForVariant(state.op.variant), state.archive ? {
        historyLimit: 512,
        onSample(sample) {
          sample.receivedAt = now();
          state.archive.sample(sample);
          recordDiagnosticSample(sample, { variant: state.op?.variant || "", source: state.op?.source || "bridge" });
        },
      } : {});
    }
    if (parsed.type === "session_start" && !session.started) {
      session.sessionId = parsed.fields?.session_id ?? parsed.fields?.epoch ?? null;
      session.sequenceGaps ||= [];
      session.lastSeq = null;
    }
    let receivedEvents = null;
    if ((parsed.type === "rx" || parsed.type === "rx_batch") && session.started) {
      const events = parsed.type === "rx" ? [parsed] : parsed.events;
      receivedEvents = [];
      for (const event of events) {
        const sequence = event.seq;
        if (sequence != null && session.lastSeq != null && sequence <= session.lastSeq) continue;
        if (sequence != null && session.lastSeq != null && sequence > session.lastSeq + 1) {
          recordSequenceGap(sequence - session.lastSeq - 1, session.lastSeq + 1, sequence - 1, "sequence");
        }
        if (sequence != null) session.lastSeq = sequence;
        receivedEvents.push(event);
      }
      if (!receivedEvents.length) return;
    }
    if (parsed.type === "event" && parsed.raw.startsWith("EVENT telemetry_gap ")) {
      const lost = Number(parsed.fields?.lost);
      const from = Number(parsed.fields?.from);
      const to = Number(parsed.fields?.to);
      if (Number.isSafeInteger(lost) && lost > 0 && Number.isSafeInteger(from) && Number.isSafeInteger(to)) {
        recordSequenceGap(lost, from, to, "telemetry_gap");
        if (session.lastSeq == null || to > session.lastSeq) session.lastSeq = to;
      }
    }
    const ingested = receivedEvents == null || parsed.type === "rx"
      ? parsed
      : { ...parsed, events: receivedEvents };
    noteSessionLine(state.op.session, ingested);
    if (state.factoryProcedure?.status === "running") state.factoryProcedure.responseBytes = state.op.session.rx;
    try {
      if (parsed.type === "rx" && state.cart) state.cart.pushRx(parsed.t_us, parsed.byte, now());
      if (parsed.type === "rx_batch" && state.cart) {
        for (const event of receivedEvents ?? parsed.events) state.cart.pushRx(event.t_us, event.byte, now());
      }
    } catch (error) {
      state.op.forceStatus = "INCOMPLETE";
      state.op.forceReason = error.message;
      stop();
      return;
    }
    if (state.cart && (parsed.type === "rx" || parsed.type === "rx_batch")) {
      const rows = state.cart.snapshot().rows;
      // Timestamp newly decoded values for visible age without changing ECU time.
      for (let i = rows.length - 1; i >= 0 && rows[i].receivedAt == null; --i) rows[i].receivedAt = now();
    }
    if (state.combined && state.cart) appendCombined(state.combined, state.cart.snapshot(), now());
    if (parsed.type === "end") {
      const override = state.op.forceStatus
        ? { status: state.op.forceStatus, reason: state.op.forceReason }
        : null;
      finalize(override);
    }
  }

  function recordSequenceGap(lost, from, to, source = "resume") {
    const count = Number(lost);
    if (!Number.isSafeInteger(count) || count <= 0) return null;
    const gap = {
      lost: count,
      from: Number.isSafeInteger(Number(from)) ? Number(from) : null,
      to: Number.isSafeInteger(Number(to)) ? Number(to) : null,
      source,
    };
    const session = state.op?.session;
    if (session) {
      session.sequenceGaps ||= [];
      if (session.sequenceGaps.some(item => item.lost === gap.lost && item.from === gap.from && item.to === gap.to)) return gap;
      session.sequenceGaps.push(gap);
    }
    state.archive?.recordGap?.(gap.lost, gap.from, gap.to);
    return gap;
  }

  function handleResumeResult(resume) {
    if (!state.resuming || !state.op?.session) return;
    const session = state.op.session;
    if (!resume.ok) {
      state.resuming = false;
      state.recoveryDeadline = null;
      state.transportStatus = "connected";
      state.archive?.line?.("EVENT recovery_denied reason=Wi-Fi_session_expired_or_bridge_reset");
      finalize({ status: "INCOMPLETE", reason: "Wi-Fi session expired or bridge reset" });
      return;
    }
    const bootId = resume.fields.boot_id ?? resume.fields.boot;
    const sessionId = resume.fields.session_id ?? resume.fields.session;
    if ((bootId != null && String(bootId).toUpperCase() !== String(session.bootId).toUpperCase()) ||
        (sessionId != null && String(sessionId).toUpperCase() !== String(session.sessionId ?? session.epoch).toUpperCase())) {
      state.resuming = false;
      state.recoveryDeadline = null;
      state.transportStatus = "connected";
      finalize({ status: "INCOMPLETE", reason: "Wi-Fi session expired or bridge reset" });
      return;
    }
    const lost = Number(resume.fields.gap || 0);
    if (Number.isSafeInteger(lost) && lost > 0) {
      let from = resume.fields.from != null ? Number(resume.fields.from) : null;
      let to = resume.fields.to != null ? Number(resume.fields.to) : null;
      if (from == null && session.lastSeq != null) from = session.lastSeq + 1;
      if (to == null && from != null) to = Number(from) + lost - 1;
      const gap = recordSequenceGap(lost, from, to, "resume");
      if (gap?.to != null) session.lastSeq = gap.to;
    }
    state.resuming = false;
    state.recoveryDeadline = null;
    state.transportStatus = "connected";
    state.phase = "read";
    state.message = lost > 0
      ? `Live data resumed; ${lost} telemetry sample(s) were not retained by the bridge.`
      : "Live data resumed";
    touch();
  }

  function handleLine(line) {
    const parsed = parseLine(line);
    recordBridgeRaw(parsed.raw, { source: state.op?.source || (state.transport === "demo" ? "simulation" : "bridge") });
    state.archive?.line(parsed.raw);
    state.log.push(parsed.raw);
    if (state.archive && state.log.length > 2100) state.log.splice(0, state.log.length - 2000);
    const resume = parseResumeLine(parsed.raw);
    if (resume) {
      handleResumeResult(resume);
      return;
    }
    if (parsed.type === "auth") {
      state.identity.auth = parsed.ok ? "OK" : "DENIED";
      if (!parsed.ok) {
        if (state.combined) { state.combined.active = false; state.combined.nextPending = false; }
        state.link = "denied";
        if (state.op) finalize({ status: "FAILED", reason: "authentication denied" });
        state.phase = "idle";
        state.deadline = null;
        state.message = parsed.raw;
      }
      touch();
      return;
    }
    if (parsed.type === "status") {
      onStatus(parsed);
      touch();
      return;
    }
    if (state.phase === "identify_hello" && parsed.type === "hello") {
      state.identity.hello = parsed.raw;
      state.identity.helloOk = parsed.ok;
      state.phase = "identify_pins";
      state.message = parsed.ok ? "HELLO matched" : "HELLO did not match";
      arm(TIMEOUTS.identify);
      send("PINS");
      touch();
      return;
    }
    if (state.phase === "identify_pins" && parsed.type === "pins") {
      state.identity.pins = parsed.raw;
      state.identity.pinsOk = parsed.ok;
      state.phase = "identify_status";
      state.message = parsed.ok ? "PINS matched" : "PINS did not match";
      arm(TIMEOUTS.identify);
      send("STATUS");
      touch();
      return;
    }
    if (state.phase === "bench" && (parsed.type === "bench_end" || parsed.type === "denied")) {
      if (parsed.type === "denied" || !parsed.pass) {
        state.bench.result = parsed.result || parsed.raw;
        state.bench.pass = false;
        finalize({ status: "INCOMPLETE", reason: parsed.raw });
        return;
      }
      state.bench.result = parsed.result;
      state.bench.pass = true;
      state.phase = "post_status";
      state.message = "Bench passed — checking STATUS";
      arm(TIMEOUTS.status);
      send("STATUS");
      touch();
      return;
    }
    if (state.phase === "arm" && parsed.type === "armed") {
      if (parsed.variant !== state.op?.variant) {
        finalize({ status: "INCOMPLETE", reason: `armed ${parsed.variant}` });
        return;
      }
      state.phase = "read";
      if (state.factoryProcedure?.status === "preflight") {
        state.factoryProcedure.status = "running";
        state.factoryProcedure.stepIndex = 0;
        state.factoryProcedure.startedAt = now();
      }
      if (state.combined?.active) state.combined.rotateAt = now() + GROUP_WINDOW_MS;
      state.op.session = createSession();
      state.cart = createCartDecoder(pidSetForVariant(state.op.variant));
      state.message = `Reading ${state.op.variant}`;
      arm(VARIANTS[state.op.variant].timeoutMs);
      send(`READ_${state.op.variant}`);
      touch();
      return;
    }
    if ((state.phase === "arm" || state.phase === "read" || state.phase === "bench") && parsed.type === "denied") {
      if (state.op) state.op.denial = parsed.raw;
      if (state.op?.session) noteSessionLine(state.op.session, parsed);
      if (parsed.reason === "read_used_or_busy" && state.status?.fields.read_used === "1" &&
          now() - state.status.receivedAt <= TIMEOUTS.status && checkReadLatch(state.status)) return;
      finalize({ status: "INCOMPLETE", reason: parsed.reason === "read_used_or_busy"
        ? "Bridge refused the read. Current safe idle and read-lock status could not be verified." : parsed.raw });
      return;
    }
    if (parsed.type === "fault" && (state.phase === "read" || state.phase === "stopping")) {
      const alreadyStopping = state.phase === "stopping";
      if (state.op) {
        if (!state.op.session) state.op.session = createSession();
        noteSessionLine(state.op.session, parsed);
        if (!state.op.forceStatus) { state.op.forceStatus = "INCOMPLETE"; state.op.forceReason = parsed.raw; }
      }
      state.phase = "stopping";
      state.message = parsed.raw;
      if (!alreadyStopping) { arm(TIMEOUTS.stop); send("STOP"); }
      touch();
      return;
    }
    if (state.phase === "read" || state.phase === "stopping") {
      ingestRead(parsed);
      if (state.phase === "idle") return;
    }
    if (parsed.type === "stop" && state.phase === "stopping") {
      // STOP acknowledgement precedes drained RX and END in the real bridge.
      // Keep receiving an established capture until its END or stop timeout.
      if (state.op?.session?.started) return;
      const override = state.op?.forceStatus
        ? { status: state.op.forceStatus, reason: state.op.forceReason }
        : { status: "INCOMPLETE", reason: "stopped" };
      if (!state.op?.session?.end) finalize(override);
      return;
    }
    if (state.phase === "reboot" && parsed.type === "reboot") {
      state.phase = "idle";
      state.deadline = null;
      state.message = "Reboot accepted — the link will drop";
      touch();
      return;
    }
    touch();
  }

  function beginPrecheck(op) {
    if (state.review?.active) return "Exit offline review before a vehicle operation";
    if (state.link !== "ready") return "not connected";
    if (state.transport === "ble" && state.identity.auth !== "OK") return "bridge authentication pending";
    if (state.phase !== "idle") return "busy";
    if (state.identity.helloOk !== true || state.identity.pinsOk !== true) return "bridge identity not verified";
    if (op.kind !== "live" && (!state.archive || state.archive.variant !== op.variant || state.archive.closed)) state.archive = null;
    op.startedAt = now();
    op.source = state.transport === "demo" ? "simulation" : "bridge";
    state.op = op;
    if (!op.manualBench || op.variant) {
      state.lastSession = null;
      state.cart = null;
      state.trust = "progress";
    }
    state.phase = "pre_status";
    state.message = "Checking bridge status";
    arm(TIMEOUTS.status);
    send("STATUS");
    touch();
    return "";
  }

  function beginVehicle(variant) {
    return beginPrecheck({ variant, kind: VARIANTS[variant].kind, manualBench: false,
      forceStatus: null, forceReason: "", session: null });
  }

  function stop() {
    if (state.combined) { state.combined.active = false; state.combined.nextPending = false; }
    if (state.phase === "idle" || state.phase === "stopping") { touch(); return; }
    state.phase = "stopping";
    state.message = "Stopping";
    arm(TIMEOUTS.stop);
    send("STOP");
    touch();
  }

  function waitForCapture(variant, previousSession) {
    return new Promise(resolve => {
      let observed = !!state.op;
      let settled = false;
      let timer;
      const done = value => {
        if (settled) return;
        settled = true;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        if (state.op?.variant === variant) observed = true;
        if (observed && !state.op && state.phase === "idle" && state.lastSession && state.lastSession !== previousSession) {
          done({ ok: true, session: state.lastSession });
        } else if (state.link !== "ready" && !state.op) {
          done({ ok: false, error: "Bridge connection was lost before the capture completed." });
        }
      };
      listeners.add(check);
      timer = setTimeout(() => {
        if (state.op && state.phase !== "stopping") {
          state.op.operatorStop = true;
          stop();
          timer = setTimeout(() => done({ ok: false, error: "Capture did not finalize after STOP." }), TIMEOUTS.stop + 1000);
        } else done({ ok: false, error: "Capture did not reach a finalized END." });
      }, (VARIANTS[variant]?.timeoutMs || TIMEOUTS.DCL_PROBE) + TIMEOUTS.status + TIMEOUTS.arm + TIMEOUTS.stop + 5000);
      check();
    });
  }

  return {
    state,
    setArchive(archive) {
      if (state.phase !== "idle") throw new Error("Cannot replace an active recording");
      state.archive = archive;
    },
    failRecording(message) {
      if (state.op) { state.op.forceStatus = "INCOMPLETE"; state.op.forceReason = message; }
      else if (state.lastSession) {
        state.lastSession.outcome = "STORAGE_FAILURE";
        state.lastSession.verdict = { ...state.lastSession.verdict, valid: false, status: "INCOMPLETE", reasons: [message] };
        state.trust = "untrusted";
      }
      stop();
      state.message = message;
      touch();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    handleLine,
    onConnected(name = "", transport = "ble", connection = {}) {
      const connectionRecovered = state.link === "reconnecting" || connection.reconnected === true;
      if (connectionRecovered && (state.op?.operatorStop || state.phase === "stopping")) {
        state.link = "ready";
        state.deviceName = name || state.deviceName;
        state.transport = transport;
        state.resuming = false;
        state.recoveryDeadline = null;
        state.phase = "stopping";
        state.message = "Stopping retained session";
        arm(TIMEOUTS.stop);
        send("STOP");
        touch();
        return { stopped: true };
      }
      if (state.link === "ready" && state.transport === transport && !connection.reconnected) {
        return { reattached: true };
      }
      if (connectionRecovered && isLiveVariant(state.op?.variant) && state.op?.session?.started) {
        state.link = "ready";
        state.deviceName = name || state.deviceName;
        state.transport = transport;
        state.recoveryDeadline = now() + LIVE_RECOVERY_MS;
        state.resuming = true;
        state.phase = "read";
        const session = state.op.session;
        const bootId = session.bootId;
        const sessionId = session.sessionId ?? session.epoch;
        if (bootId == null || sessionId == null) {
          state.resuming = false;
          finalize({ status: "INCOMPLETE", reason: "Wi-Fi session expired or bridge reset" });
          return { resumed: false };
        }
        state.message = "Rejoining the active live data session";
        send(`RESUME ${bootId} ${sessionId} ${session.lastSeq ?? 0}`);
        touch();
        return { resumed: true };
      }
      if (connectionRecovered && state.op) {
        finalize({ status: isLiveVariant(state.op.variant) ? "INCOMPLETE" : "FAILED",
          reason: isLiveVariant(state.op.variant) ? "Wi-Fi session expired or bridge reset" : "link lost" });
      }
      state.link = "ready";
      state.deviceName = name;
      state.transport = transport;
      state.log = [];
      state.archive = null;
      state.status = null;
      state.lastSession = null;
      state.combined = null;
      state.cart = null;
      state.rom = null;
      state.battery = null;
      state.trust = "none";
      state.identity = { auth: "", hello: "", helloOk: null, pins: "", pinsOk: null };
      state.recoveryDeadline = null;
      state.resuming = false;
      state.phase = "identify_hello";
      state.message = "Checking bridge identity";
      arm(TIMEOUTS.identify);
      send("HELLO");
      touch();
      return { reattached: false };
    },
    onDisconnected() {
      const phase = state.phase;
      if (state.link === "reconnecting") return;
      if (isLiveVariant(state.op?.variant) && ["pre_status", "bench", "arm", "read", "stopping"].includes(phase)) {
        state.link = "reconnecting";
        state.recoveryDeadline = now() + LIVE_RECOVERY_MS;
        state.resuming = false;
        state.message = "Live data link interrupted; reconnect within 30 seconds to resume the session.";
        touch();
        return;
      }
      if (state.combined) { state.combined.active = false; state.combined.nextPending = false; }
      if (state.link === "disconnected") return;
      state.link = "disconnected";
      state.recoveryDeadline = null;
      state.identity.auth = "";
      state.deviceName = "";
      state.transport = "";
      if (phase === "discovery_status") {
        state.phase = "idle";
        state.deadline = null;
        const resolve = state.discoveryPass?.statusResolver;
        if (state.discoveryPass) state.discoveryPass.statusResolver = null;
        resolve?.({ ok: false, error: "Bridge connection was lost during the safety check." });
        touch();
        return;
      }
      if (phase === "idle") {
        state.message = "Disconnected";
        touch();
        return;
      }
      if (phase === "reboot" || phase === "reboot_status") {
        state.phase = "idle";
        state.deadline = null;
        state.op = null;
        state.message = phase === "reboot" ? "Bridge rebooted and the link dropped" : "Bridge restart cancelled: link lost";
        touch();
        return;
      }
      finalize({ status: "FAILED", reason: "link lost" });
    },
    requestVehicle(variant) {
      if (state.combined?.active) return { ok: false, error: "all-data recording is running" };
      if (!VARIANTS[variant]) return { ok: false, error: "unknown variant" };
      const candidate = catalogueCandidateForVariant(variant);
      const compatibility = candidate ? firmwareCompatibility(candidate, state.status) : { supported: true, message: "" };
      const isDemo = state.transport === "demo" || state.deviceName === "demo" || state.deviceName?.includes?.("demo");
      if (state.link === "ready" && !isDemo && !compatibility.supported) {
        state.message = compatibility.message;
        touch();
        return { ok: false, error: compatibility.message };
      }
      if (variant === "ALL" && state.status?.fields?.live_all !== "1") {
        return { ok: false, error: "Continuous all-data capture requires bridge firmware v21 or newer." };
      }
      const previous = state.combined;
      state.combined = null;
      const error = beginVehicle(variant);
      if (error) state.combined = previous;
      if (error) return { ok: false, error };
      state.message = `Checking bridge before ${variant}`;
      return { ok: true };
    },
    requestAllLive() { return this.requestVehicle("ALL"); },
    requestSurvey() {
      if (state.phase !== "idle" || state.combined?.active) return { ok: false, error: "busy" };
      const previous = state.combined;
      state.combined = createCombined(now());
      startCombinedSegment(state.combined, now());
      const error = beginVehicle(LIVE_GROUPS[0]);
      if (error) { state.combined = previous; return { ok: false, error }; }
      return { ok: true };
    },
    requestBench() {
      if (state.combined?.active) return { ok: false, error: "busy" };
      const error = beginPrecheck({
        variant: null,
        kind: "bench",
        manualBench: true,
        forceStatus: null,
        forceReason: "",
        session: null,
      });
      if (error) return { ok: false, error };
      state.message = "Checking bridge before self-test";
      return { ok: true };
    },
    requestReboot() {
      if (state.review?.active) return { ok: false, error: "Exit offline review before a bridge operation" };
      if (state.combined?.active) return { ok: false, error: "busy" };
      if (state.link !== "ready") return { ok: false, error: "not connected" };
      if (state.transport === "ble" && state.identity.auth !== "OK") return { ok: false, error: "bridge authentication pending" };
      if (state.phase !== "idle") return { ok: false, error: "busy" };
      if (state.identity.helloOk !== true || state.identity.pinsOk !== true) return { ok: false, error: "bridge identity not verified" };
      state.phase = "reboot_status";
      state.message = "Checking bridge before restart";
      arm(TIMEOUTS.status);
      send("STATUS");
      touch();
      return { ok: true };
    },
    requestStop() {
      if (state.phase === "reboot_status") {
        state.phase = "idle"; state.deadline = null;
        state.message = "Bridge restart cancelled"; touch(); return;
      }
      if (state.op && state.phase !== "stopping") state.op.operatorStop = true;
      stop();
    },
    async runCandidateBatch({ candidateIds = [], createArchive = null, onProgress = () => {}, confirmCandidate = null } = {}) {
      if (state.candidateBatch?.status === "running") return { ok: false, error: "A candidate batch is already running." };
      if (typeof createArchive !== "function") return { ok: false, error: "A recording archive factory is required." };
      const candidates = candidateIds.map(id => CATALOGUE_ENTRIES.find(item => item.id === id)).filter(item => item?.sendable && item.variantKey && VARIANTS[item.variantKey]);
      if (!candidates.length) return { ok: false, error: "Select at least one executable command candidate." };
      if (state.link !== "ready" || state.phase !== "idle" ||
          (state.transport === "ble" && state.identity.auth !== "OK")) {
        return { ok: false, error: "Connect an authenticated idle bridge, or enable Demo mode, before running candidates." };
      }
      const batch = {
        status: "running", startedAt: now(), completedAt: null, candidateIds: candidates.map(item => item.id),
        currentId: "", stopRequested: false, results: [], error: "", skipped: [],
      };
      state.candidateBatch = batch;
      const publish = () => { try { onProgress(batch); } catch { /* Display callbacks cannot alter bridge state. */ } touch(); };
      publish();
      for (const candidate of candidates) {
        if (batch.stopRequested) break;
        batch.currentId = candidate.id;
        const compatibility = firmwareCompatibility(candidate, state.status);
        if (state.transport !== "demo" && !compatibility.supported) {
          batch.results.push({ candidateId: candidate.id, status: "FIRMWARE_TOO_OLD", responseBytes: 0, recordingId: null, error: compatibility.message, startedAt: now(), completedAt: now() });
          publish();
          continue;
        }
        if (candidateRequiresOperatorConfirmation(candidate)) {
          let approved = false;
          if (typeof confirmCandidate === "function") {
            try { approved = await confirmCandidate(candidate, { batch }); }
            catch { approved = false; }
          }
          if (!approved) {
            const error = candidateConfirmationRequiredMessage(candidate);
            batch.results.push({ candidateId: candidate.id, variant: candidate.variantKey, commandWord: candidate.commandWord, status: "CONFIRMATION_REQUIRED", responseBytes: 0, recordingId: null, error, startedAt: now(), completedAt: now() });
            batch.skipped.push(candidate.id);
            publish();
            continue;
          }
          if (batch.stopRequested) break;
        }
        const startedAt = now();
        let archive;
        try {
          archive = await createArchive(candidate.variantKey, candidate, { batchId: batch.startedAt, batchCandidateId: candidate.id });
          archive?.line?.(`EXPERIMENT_CANDIDATE id=${candidate.id} command=${candidate.commandWord} tx=${candidate.envelope?.join(" ") || "procedure"}`);
        } catch (error) {
          batch.error = `Could not create recording for ${candidate.name}: ${error.message}`;
          batch.results.push({ candidateId: candidate.id, status: "ARCHIVE_FAILED", responseBytes: 0, recordingId: null, error: error.message, startedAt, completedAt: now() });
          break;
        }
        if (batch.stopRequested) {
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: ["Stopped before transmission"] });
          break;
        }
        try { this.setArchive(archive); }
        catch (error) {
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: [error.message] });
          batch.error = error.message;
          break;
        }
        const previous = state.lastSession;
        const completion = waitForCapture(candidate.variantKey, previous);
        const startError = beginVehicle(candidate.variantKey);
        if (startError) {
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: [startError] });
          batch.error = startError;
          batch.results.push({ candidateId: candidate.id, status: "NOT_STARTED", responseBytes: 0, recordingId: archive?.id || null, error: startError, startedAt, completedAt: now() });
          break;
        }
        const capture = await completion;
        if (!capture.ok) {
          batch.error = capture.error;
          if (state.op && state.phase !== "stopping") { state.op.operatorStop = true; stop(); }
          break;
        }
        await state.archive?.finished;
        const session = capture.session;
        const end = session.verdict?.end || null;
        const responseBytes = end?.ro_bytes ?? session.dclProbe?.responseBytes ?? 0;
        const zeroResponse = !session.operatorStop && responseBytes === 0 && end && [15, 16].includes(end.reason) && end.de === "LOW" && end.ro_lost === 0 && end.uart_errors === 0 && !(session.bridgeFaults || []).length;
        const result = {
          candidateId: candidate.id, variant: candidate.variantKey, commandWord: candidate.commandWord,
          status: session.operatorStop ? "STOPPED" : zeroResponse ? "ZERO_RESPONSE" : session.verdict?.status || "FAILED",
          responseBytes, recordingId: session.recordingId || archive?.id || null, verdict: session.verdict || null,
          startedAt: session.startedAt || startedAt, completedAt: session.completedAt || now(), error: session.recordingError || "",
        };
        batch.results.push(result);
        state.experimentResults.push(result);
        publish();
        if (session.operatorStop || batch.stopRequested) break;
        if (state.link !== "ready" || session.recordingError || (end && ![15, 16].includes(end.reason))) {
          batch.error = session.recordingError || "Bridge capture fault; candidate batch stopped without retry.";
          break;
        }
      }
      if (batch.skipped.length && !batch.error) {
        batch.error = `${batch.skipped.length} command(s) were skipped because the operator confirmation or required vehicle state was not provided. No command was retried.`;
      }
      batch.status = batch.stopRequested ? "stopped" : batch.error ? "failed" : "complete";
      batch.currentId = "";
      batch.completedAt = now();
      publish();
      return { ok: batch.status === "complete", batch, error: batch.error };
    },
    stopCandidateBatch() {
      const batch = state.candidateBatch;
      if (!batch || batch.status !== "running") return;
      batch.stopRequested = true;
      if (state.op && state.phase !== "stopping") {
        state.op.operatorStop = true;
        stop();
      }
      state.message = "Stopping candidate batch safely";
      touch();
    },
    async runMemExperiment(experimentId, { createArchive = null } = {}) {
      if (state.memMatrix.status === "running") return { ok: false, error: "A MEM experiment run is already active." };
      return this.runAllMemExperiments({ createArchive, experimentIds: [experimentId] });
    },
    async runAllMemExperiments({ createArchive = null, experimentIds = MEM_EXPERIMENTS.map(item => item.id) } = {}) {
      if (state.memMatrix.status === "running") return { ok: false, error: "A MEM experiment run is already active." };
      if (typeof createArchive !== "function") return { ok: false, error: "A recording archive factory is required." };
      if (!experimentIds.length || experimentIds.some(id => !MEM_EXPERIMENTS.some(item => item.id === id))) {
        return { ok: false, error: "Unknown MEM experiment selection." };
      }
      if (state.link !== "ready" || state.phase !== "idle" ||
          (state.transport === "ble" && state.identity.auth !== "OK")) {
        return { ok: false, error: "Connect an authenticated idle bridge, or enable Demo mode, before running MEM experiments." };
      }
      state.memMatrix.status = "running";
      state.memMatrix.stopRequested = false;
      state.memMatrix.startedAt = now();
      state.memMatrix.completedAt = null;
      state.memMatrix.error = "";
      state.memMatrix.results = state.memMatrix.results.filter(result => !experimentIds.includes(result.experimentId));
      touch();
      for (const experimentId of experimentIds) {
        if (state.memMatrix.stopRequested) break;
        const spec = MEM_EXPERIMENTS.find(item => item.id === experimentId);
        const candidate = CATALOGUE_ENTRIES.find(item => item.variantKey === spec.firmwareVariant);
        const compatibility = firmwareCompatibility(candidate, state.status);
        if (state.transport !== "demo" && !compatibility.supported) {
          const blocked = {
            experimentId, variant: spec.firmwareVariant, title: spec.title, status: "FIRMWARE_TOO_OLD",
            responseBytes: 0, responseHex: "", txEnvelope: candidate?.envelope || [], verdict: null,
            recordingId: null, startedAt: now(), completedAt: now(), error: compatibility.message,
          };
          state.memMatrix.results.push(blocked);
          state.memMatrix.error = compatibility.message;
          touch();
          continue;
        }
        const startedAt = now();
        state.memMatrix.activeId = experimentId;
        touch();
        let archive;
        try {
          archive = await createArchive(spec.firmwareVariant, candidate, {
            experimentId, matrixId: "MEM", startedAt, specification: spec,
          });
          archive?.line?.(`MEM_EXPERIMENT id=${experimentId} initial=${spec.initialWord} continuation=${spec.continuationWord} offsets=${spec.offsetScope} parity=${spec.parityMethod}`);
        } catch (error) {
          state.memMatrix.results.push({
            experimentId, variant: spec.firmwareVariant, title: spec.title, status: "ARCHIVE_FAILED",
            responseBytes: 0, responseHex: "", txEnvelope: candidate?.envelope || [], verdict: null,
            recordingId: null, startedAt, completedAt: now(), error: error.message,
          });
          state.memMatrix.error = error.message;
          break;
        }
        if (state.memMatrix.stopRequested) {
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: ["Stopped before transmission"] });
          break;
        }
        try { this.setArchive(archive); }
        catch (error) {
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: [error.message] });
          state.memMatrix.error = error.message;
          break;
        }
        const previous = state.lastSession;
        const completion = waitForCapture(spec.firmwareVariant, previous);
        const startError = beginVehicle(spec.firmwareVariant);
        if (startError) {
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: [startError] });
          state.memMatrix.results.push({
            experimentId, variant: spec.firmwareVariant, title: spec.title, status: "NOT_STARTED",
            responseBytes: 0, responseHex: "", txEnvelope: candidate?.envelope || [], verdict: null,
            recordingId: archive?.id || null, startedAt, completedAt: now(), error: startError,
          });
          state.memMatrix.error = startError;
          break;
        }
        const capture = await completion;
        if (!capture.ok) {
          state.memMatrix.error = capture.error;
          if (state.op && state.phase !== "stopping") { state.op.operatorStop = true; stop(); }
          break;
        }
        await state.archive?.finished;
        const session = capture.session;
        const end = session.verdict?.end || null;
        const responseBytes = end?.ro_bytes ?? session.dclProbe?.responseBytes ?? 0;
        const responseHex = latestDclCaptureLines(state.log).flatMap(line => {
          const rx = /^RX\s+t_us=\d+\s+byte=([0-9A-F]{2})/.exec(line);
          const rxb = /^RXB\s+t_us=\d+\s+data=([0-9A-F]+)/.exec(line);
          return rx ? [rx[1]] : rxb ? rxb[1].match(/.{2}/g) || [] : [];
        }).join(" ");
        const zeroResponse = responseBytes === 0 && end && [15, 16].includes(end.reason) && end.de === "LOW" &&
          end.ro_lost === 0 && end.uart_errors === 0 && !(session.bridgeFaults || []).length;
        const result = {
          experimentId, variant: spec.firmwareVariant, title: spec.title,
          status: session.operatorStop ? "STOPPED" : zeroResponse ? "ZERO_RESPONSE" : session.verdict?.valid ? "VALID" : "FAILED",
          responseBytes, responseHex, txEnvelope: candidate?.envelope || [], verdict: session.verdict || null,
          recordingId: session.recordingId || archive?.id || null,
          startedAt: session.startedAt || startedAt, completedAt: session.completedAt || now(),
          firmwareVersion: state.status?.fields?.fw || null,
          error: session.recordingError || "",
        };
        state.memMatrix.results.push(result);
        touch();
        if (session.operatorStop || state.memMatrix.stopRequested) break;
        if (state.link !== "ready" || session.recordingError || (end && ![15, 16].includes(end.reason))) {
          state.memMatrix.error = session.recordingError || "Bridge ended the MEM capture with a fault.";
          break;
        }
      }
      state.memMatrix.status = state.memMatrix.stopRequested ? "stopped" : state.memMatrix.error ? "failed" : "complete";
      state.memMatrix.activeId = "";
      state.memMatrix.completedAt = now();
      touch();
      return { ok: state.memMatrix.status === "complete", matrix: state.memMatrix, error: state.memMatrix.error };
    },
    stopMemExperiments() {
      if (state.memMatrix.status !== "running") return;
      state.memMatrix.stopRequested = true;
      if (state.op && state.phase !== "stopping") {
        state.op.operatorStop = true;
        stop();
      }
      state.message = "Stopping MEM experiment safely";
      touch();
    },
    async startFactoryProcedure(procedureId, { createArchive = null } = {}) {
      const spec = FACTORY_PROCEDURES[procedureId];
      const candidate = CATALOGUE_ENTRIES.find(item => item.id === procedureId);
      if (!spec || !candidate?.sendable) return { ok: false, error: "Unknown factory procedure." };
      if (typeof createArchive !== "function") return { ok: false, error: "A recording archive factory is required." };
      if (state.factoryProcedure?.status === "preflight" || state.factoryProcedure?.status === "running" || state.factoryProcedure?.status === "stopping") {
        return { ok: false, error: "A guided factory procedure is already active." };
      }
      if (state.link !== "ready" || state.phase !== "idle" ||
          (state.transport === "ble" && state.identity.auth !== "OK")) return { ok: false, error: "Connect an authenticated idle bridge before starting the procedure." };
      const compatibility = firmwareCompatibility(candidate, state.status);
      if (state.transport !== "demo" && !compatibility.supported) return { ok: false, error: compatibility.message };
      const procedure = {
        id: procedureId, title: spec.title, variant: spec.variant, status: "preflight",
        ecuState: spec.ecuState, prompts: [...spec.prompts], completedPrompts: [], stepIndex: 0,
        protocol: "EEC-IV diagnostic self-test protocol (253E)",
        guidance: "Guided factory diagnostic session: initiates the EEC-IV self-test protocol and guides the technician through manual throttle/pedal inputs while logging raw DCL response.",
        evidenceScope: "Raw DCL response capture only. Actuator cycling, fuel-cut sequencing, and cylinder identification are not claimed as verified ECU operations without live evidence.",
        startedAt: now(), completedAt: null, responseBytes: 0, codes: [], verdict: null, error: "",
      };
      let archive;
      try {
        archive = await createArchive(spec.variant, candidate, { procedureId, procedureTitle: spec.title });
        archive?.line?.(`FACTORY_PROCEDURE id=${procedureId} variant=${spec.variant} required=${spec.ecuState}`);
        archive?.line?.(`FACTORY_SESSION protocol="${procedure.protocol}" guidance="${procedure.guidance}" evidence="${procedure.evidenceScope}"`);
      } catch (error) { return { ok: false, error: `Could not create procedure recording: ${error.message}` }; }
      try { this.setArchive(archive); }
      catch (error) {
        await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: [error.message] });
        return { ok: false, error: error.message };
      }
      procedure.recordingId = archive?.id || null;
      state.factoryProcedure = procedure;
      const startError = beginVehicle(spec.variant);
      if (startError) {
        state.factoryProcedure.status = "failed";
        state.factoryProcedure.error = startError;
        await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: [startError] });
        touch();
        return { ok: false, error: startError };
      }
      return { ok: true, procedure: state.factoryProcedure };
    },
    nextFactoryProcedureStep() {
      const procedure = state.factoryProcedure;
      if (!procedure || procedure.status !== "running" || state.phase !== "read") return { ok: false, error: "The procedure is not waiting for an operator step." };
      if (procedure.stepIndex < procedure.prompts.length) {
        procedure.completedPrompts.push(procedure.prompts[procedure.stepIndex]);
        procedure.stepIndex += 1;
      }
      if (procedure.stepIndex >= procedure.prompts.length) {
        procedure.status = "stopping";
        state.message = "Procedure steps complete — ending capture cleanly";
        stop();
      }
      touch();
      return { ok: true, procedure };
    },
    stopFactoryProcedure() {
      const procedure = state.factoryProcedure;
      if (!procedure || !["preflight", "running"].includes(procedure.status)) return;
      procedure.status = "stopping";
      if (state.op && state.phase !== "stopping") {
        state.op.operatorStop = true;
        stop();
      }
      state.message = "Stopping factory procedure and draining capture";
      touch();
    },
    async startDiscoveryPass({ createArchive = null, onProgress = () => {} } = {}) {
      if (state.discoveryPass?.status === "running") return { ok: false, error: "A discovery pass is already running." };
      const candidates = discoveryPassCandidates();
      if (!candidates.length) return { ok: false, error: "No supported read-only discovery candidates are available." };
      if (typeof createArchive !== "function") return { ok: false, error: "A recording archive factory is required." };
      if (state.link !== "ready" || state.phase !== "idle" || state.transport === "demo" ||
          state.identity.helloOk !== true || state.identity.pinsOk !== true ||
          (state.transport === "ble" && state.identity.auth !== "OK")) {
        return { ok: false, error: "Connect and verify an idle physical bridge before discovery." };
      }

      const pass = {
        id: `discovery-${now()}-${Math.random().toString(36).slice(2, 8)}`,
        status: "running", startedAt: now(), completedAt: null,
        candidates: candidates.map(item => item.id), currentIndex: -1, activeVariant: "",
        completed: [], failed: [], remaining: candidates.map(item => item.id), results: [],
        stopRequested: false, error: "", statusResolver: null,
      };
      state.discoveryPass = pass;
      const publish = () => {
        try { onProgress(pass); } catch { /* UI callbacks cannot interrupt bridge safety handling. */ }
        touch();
      };
      const finishPass = (status, reason = "") => {
        pass.status = status;
        pass.error = reason;
        pass.activeVariant = "";
        pass.remaining = candidates.slice(pass.results.length).map(item => item.id);
        pass.completedAt = now();
        publish();
        return { ok: status === "complete", pass, error: reason };
      };
      const safetyCheck = () => new Promise(resolve => {
        if (pass.stopRequested) { resolve({ ok: false, stopped: true, error: "Discovery stopped by operator." }); return; }
        if (state.link !== "ready" || state.phase !== "idle" ||
            (state.transport === "ble" && state.identity.auth !== "OK")) {
          resolve({ ok: false, error: "Bridge is disconnected or busy." }); return;
        }
        pass.statusResolver = resolve;
        state.phase = "discovery_status";
        state.message = `Verifying safe IDLE before ${pass.activeVariant}`;
        arm(TIMEOUTS.status);
        try { send("STATUS"); } catch (error) {
          state.phase = "idle";
          state.deadline = null;
          pass.statusResolver = null;
          resolve({ ok: false, error: `Could not request bridge status: ${error.message}` });
        }
        touch();
      });
      const waitForCapture = (variant, previous) => new Promise(resolve => {
        let observed = !!state.op;
        let settled = false;
        let timer = null;
        let unsubscribe = () => {};
        const done = value => {
          if (settled) return;
          settled = true;
          unsubscribe();
          if (timer != null) clearTimeout(timer);
          resolve(value);
        };
        const check = () => {
          if (state.op?.variant === variant) observed = true;
          if (observed && !state.op && state.phase === "idle" && state.lastSession && state.lastSession !== previous) {
            done({ ok: true, session: state.lastSession });
          } else if (state.link !== "ready" && !state.op) {
            done({ ok: false, error: "Bridge connection was lost before the capture completed." });
          }
        };
        listeners.add(check);
        unsubscribe = () => listeners.delete(check);
        timer = setTimeout(() => {
          if (state.op) {
            if (state.phase !== "stopping") this.requestStop();
            timer = setTimeout(() => done({ ok: false, error: "Discovery capture did not reach a finalized END after STOP." }), TIMEOUTS.stop + 1000);
          } else done({ ok: false, error: "Discovery capture did not reach a finalized END." });
        }, VARIANTS[variant].timeoutMs + TIMEOUTS.status + TIMEOUTS.arm + TIMEOUTS.stop + 5000);
        check();
      });

      publish();
      for (let index = 0; index < candidates.length; index += 1) {
        const candidate = candidates[index];
        const variant = candidate.variantKey;
        pass.currentIndex = index;
        pass.activeVariant = variant;
        pass.remaining = candidates.slice(index).map(item => item.id);
        publish();
        const safe = await safetyCheck();
        if (!safe.ok) {
          if (safe.stopped || pass.stopRequested) return finishPass("stopped", safe.error || "Discovery stopped by operator.");
          return finishPass("stopped", safe.error || "Bridge safety check failed; discovery stopped.");
        }

        let archive;
        try {
          archive = await createArchive(variant, candidate, pass);
        } catch (error) {
          const failed = { candidateId: candidate.id, variant, commandWord: candidate.commandWord, status: "ARCHIVE_FAILED", error: error.message, startedAt: now(), completedAt: now() };
          pass.failed.push(failed);
          pass.results.push(failed);
          pass.remaining = candidates.slice(index + 1).map(item => item.id);
          return finishPass("failed", `Could not create recording for ${candidate.name}: ${error.message}`);
        }
        if (pass.stopRequested) {
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: ["Discovery stopped before command start"] });
          return finishPass("stopped", "Discovery stopped by operator.");
        }

        try { this.setArchive(archive); }
        catch (error) {
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: [error.message] });
          return finishPass("stopped", error.message);
        }
        const previous = state.lastSession;
        const completion = waitForCapture(variant, previous);
        const request = this.requestVehicle(variant);
        if (!request.ok) {
          const failed = { candidateId: candidate.id, variant, commandWord: candidate.commandWord, status: "NOT_STARTED", error: request.error, recordingId: archive?.id || null, startedAt: now(), completedAt: now() };
          pass.failed.push(failed);
          pass.results.push(failed);
          await archive?.finish?.({ valid: false, status: "INCOMPLETE", reasons: [request.error] });
          return finishPass("stopped", request.error);
        }

        const capture = await completion;
        if (!capture.ok) {
          if (state.op && state.phase !== "stopping") this.requestStop();
          return finishPass("stopped", capture.error);
        }
        await state.archive?.finished;
        const session = capture.session;
        const end = session.verdict?.end || null;
        const responseBytes = end?.ro_bytes ?? session.dclProbe?.responseBytes ?? 0;
        const zeroResponse = responseBytes === 0;
        const cleanZeroResponse = !session.operatorStop && zeroResponse && end && [15, 16].includes(end.reason) && end.de === "LOW" &&
          end.ro_lost === 0 && end.uart_errors === 0 && !(session.bridgeFaults || []).length;
        const outcome = session.operatorStop ? "STOPPED" : cleanZeroResponse ? "ZERO_RESPONSE" : session.verdict?.valid ? "VALID" : "FAILED";
        const result = {
          candidateId: candidate.id, variant, commandWord: candidate.commandWord,
          recordingId: session.recordingId || archive?.id || null,
          status: outcome, verdict: session.verdict || null, responseBytes,
          startedAt: session.startedAt, completedAt: session.completedAt,
          bridgeFaults: session.bridgeFaults || [],
          error: session.recordingError || "",
        };
        pass.results.push(result);
        if (outcome === "VALID" || outcome === "ZERO_RESPONSE") pass.completed.push(result);
        else pass.failed.push(result);
        pass.remaining = candidates.slice(index + 1).map(item => item.id);
        publish();

        if (pass.stopRequested) return finishPass("stopped", "Discovery stopped by operator.");
        if (state.link !== "ready") return finishPass("stopped", "Bridge disconnected; discovery stopped.");
        if (session.recordingError) return finishPass("failed", `Recording archive failed: ${session.recordingError}`);
        if (!state.status || !statusCanRearm(state.status)) {
          return finishPass("stopped", "Bridge returned an unsafe or non-rearmable status; discovery stopped.");
        }
        const faulted = !!result.bridgeFaults.length || (end && ![15, 16].includes(end.reason));
        if (faulted) return finishPass("stopped", "Bridge fault detected; discovery stopped without retry.");
      }
      return finishPass("complete");
    },
    stopDiscoveryPass() {
      const pass = state.discoveryPass;
      if (!pass || pass.status !== "running") return;
      pass.stopRequested = true;
      if (state.phase === "discovery_status") {
        state.phase = "idle";
        state.deadline = null;
        const resolve = pass.statusResolver;
        pass.statusResolver = null;
        resolve?.({ ok: false, stopped: true, error: "Discovery stopped by operator." });
      } else if (state.op && state.phase !== "stopping") {
        state.op.operatorStop = true;
        stop();
      }
      state.message = "Stopping discovery pass safely";
      touch();
    },
    tick() {
      if (state.resuming && state.recoveryDeadline != null && now() >= state.recoveryDeadline) {
        state.resuming = false;
        state.recoveryDeadline = null;
        state.link = "disconnected";
        state.transportStatus = "disconnected";
        state.transport = "";
        state.deviceName = "";
        state.identity.auth = "";
        state.archive?.line?.("EVENT recovery_timeout reason=Wi-Fi_session_expired_or_bridge_reset");
        finalize({ status: "INCOMPLETE", reason: "Wi-Fi session expired or bridge reset" });
        return true;
      }
      if (state.resuming) return false;
      if (state.link === "reconnecting") {
        if (state.recoveryDeadline != null && now() >= state.recoveryDeadline) {
          state.recoveryDeadline = null;
          state.link = "disconnected";
          state.transportStatus = "disconnected";
          state.transport = "";
          state.deviceName = "";
          state.identity.auth = "";
          state.archive?.line?.("EVENT recovery_timeout reason=Wi-Fi_session_expired_or_bridge_reset");
          finalize({ status: "INCOMPLETE", reason: "Wi-Fi session expired or bridge reset" });
          return true;
        }
        return false;
      }
      const combined = state.combined;
      if (combined?.active) {
        if (now() >= combined.endAt) { stop(); return true; }
        if (combined.nextPending && state.phase === "idle") {
          startCombinedSegment(combined, now());
          const error = beginVehicle(LIVE_GROUPS[combined.groupIndex]);
          if (error) { combined.active = false; combined.error = error; touch(); }
          return true;
        }
        if (state.phase === "read" && combined.rotateAt != null && now() >= combined.rotateAt) {
          combined.rotateRequested = true;
          state.phase = "stopping";
          state.message = "All live data — finishing group before switching";
          arm(TIMEOUTS.stop);
          send("STOP");
          touch();
          return true;
        }
      }
      if (state.deadline == null || now() < state.deadline) return false;
      state.deadline = null;
      if (state.phase === "stopping") {
        finalize({
          status: state.op?.forceStatus || "INCOMPLETE",
          reason: state.op?.forceReason || "timed out",
        });
        return true;
      }
      if (state.phase === "discovery_status") {
        state.phase = "idle";
        state.message = "Bridge did not answer the discovery safety check";
        const resolve = state.discoveryPass?.statusResolver;
        if (state.discoveryPass) state.discoveryPass.statusResolver = null;
        resolve?.({ ok: false, error: state.message });
        touch();
        return true;
      }
      if (state.phase === "read" || state.phase === "arm" || state.phase === "bench"
        || state.phase === "pre_status" || state.phase === "post_status") {
        if (state.op) {
          state.op.forceStatus = "INCOMPLETE";
          state.op.forceReason = "timed out";
        }
        state.phase = "stopping";
        state.message = "Timed out — sending STOP";
        arm(TIMEOUTS.stop);
        send("STOP");
        touch();
        return true;
      }
      state.phase = "idle";
      state.message = "Bridge did not answer";
      touch();
      return true;
    },
  };
}
