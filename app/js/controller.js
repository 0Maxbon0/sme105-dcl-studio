/** Operation controller. Timers stay outside; call tick() with the injected clock. */

import { createCartDecoder } from "./cart.js";
import { ALL_LIVE_PIDS, PIDS, pidSetForVariant, summarizeSeries } from "./pids.js";
import {
  TIMEOUTS,
  VARIANTS,
  DCL_PROBE_VARIANTS,
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
      : variant === "KOEO" || variant === "KOER" ? 0x25 : null;
    const probeSpec = DCL_PROBE_VARIANTS[variant] || null;
    const dclProbe = probeSpec ? {
      variant, ...probeSpec,
      responseBytes: state.op?.session?.rx ?? 0,
      responseObserved: (state.op?.session?.rx ?? 0) > 0,
      ecuOriginVerified: false,
      bridgeCaptureStatus: verdict.status,
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
    state.lastSession = buildResult(verdict);
    state.lastSession.recordingId = state.archive?.id || null;
    if (state.lastSession.dclProbe) {
      state.lastDclProbe = {
        ...state.lastSession.dclProbe,
        startedAt: state.lastSession.startedAt,
        completedAt: state.lastSession.completedAt,
        verdict: state.lastSession.verdict,
        rawLines: latestDclCaptureLines(state.log),
        recordingId: state.lastSession.recordingId || state.archive?.id || null,
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
    if (state.phase === "identify_status") {
      state.phase = "idle";
      state.deadline = null;
      state.message = parsed.safe ? "Bridge idle" : "Bridge is not in a safe idle state";
      return;
    }
    const statusKeys = [...parsed.raw.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g)].map(match => match[1]);
    const verifiedStatus = parsed.identity === "SME105_USB_BRIDGE_V1" && new Set(statusKeys).size === statusKeys.length &&
      ["out_overflow", "transport_lost", "usb_skipped"].every(key => parsed.fields[key] === "0" ||
        (parsed.fields[key] == null && !(Number(parsed.fields.fw) >= 24 || parsed.fields.pad_evidence === "2"))) &&
      ["0", "3", "4", "15", "16", "19"].includes(parsed.fields.fault);
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
    noteSessionLine(state.op.session, parsed);
    try {
      if (parsed.type === "rx" && state.cart) state.cart.pushRx(parsed.t_us, parsed.byte, now());
      if (parsed.type === "rx_batch" && state.cart) {
        for (const event of parsed.events) state.cart.pushRx(event.t_us, event.byte, now());
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

  function handleLine(line) {
    const parsed = parseLine(line);
    recordBridgeRaw(parsed.raw, { source: state.op?.source || (state.transport === "demo" ? "simulation" : "bridge") });
    state.archive?.line(parsed.raw);
    state.log.push(parsed.raw);
    if (state.archive && state.log.length > 2100) state.log.splice(0, state.log.length - 2000);
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
    onConnected(name = "", transport = "ble") {
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
      state.phase = "identify_hello";
      state.message = "Checking bridge identity";
      arm(TIMEOUTS.identify);
      send("HELLO");
      touch();
    },
    onDisconnected() {
      if (state.combined) { state.combined.active = false; state.combined.nextPending = false; }
      if (state.link === "disconnected") return;
      const phase = state.phase;
      state.link = "disconnected";
      state.identity.auth = "";
      state.deviceName = "";
      state.transport = "";
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
    tick() {
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
