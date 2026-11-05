/** Operation controller. Timers stay outside; call tick() with the injected clock. */

import { createCartDecoder } from "./cart.js";
import { ALL_LIVE_PIDS, PIDS, pidSetForVariant, summarizeSeries } from "./pids.js";
import {
  TIMEOUTS,
  VARIANTS,
  parseLine,
  reasonText,
} from "./protocol.js";
import { createSession, noteSessionLine, sessionVerdict } from "./session.js";
import { appendCombined, createCombined, finishCombinedSegment, GROUP_WINDOW_MS, LIVE_GROUPS, startCombinedSegment } from "./combined.js";
import { recordBridgeRaw, recordDiagnosticSample } from "./diagnostics.js";

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
    const codes = (snap?.codes || []).map((entry) => ({
      code: entry.code,
      mode: entry.mode,
      requestedMode,
      requestedVariant: variant,
      source: entry.mode === 0x25 ? variant : `stored request ${variant}`,
      frame: entry.frame,
      slot: entry.slot,
      rawBytes: entry.rawBytes,
      rawData: entry.rawData,
      rxTimeUs: entry.rxTimeUs,
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
      startedAt: state.op?.startedAt || null,
      completedAt: now(),
      verdict,
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
      frame7First: snap?.frame7First ?? null,
      frame7Last: snap?.frame7Last ?? null,
      blocks25: snap?.blocks25 || 0,
      blocks26: snap?.blocks26 || 0,
      bridgeBlocks: state.op?.session?.bridgeBlocks ?? null,
      offlineQuietUs: state.op?.session?.offlineQuietUs ?? null,
      parityRejects: snap?.parityRejects || 0,
    };
  }

  function finalize(override) {
    if (state.cart && !state.cart.snapshot().closed) state.cart.finish();
    const session = state.op?.session || null;
    let verdict = session ? sessionVerdict(session, {
      variant: state.op?.variant,
      cart: state.cart?.snapshot() || null,
    }) : null;
    if (override) {
      verdict = {
        valid: false,
        status: override.status,
        reasons: unique([override.reason, ...(verdict?.reasons || [])]),
        end: verdict?.end || session?.end || null,
      };
    } else if (!verdict) {
      verdict = { valid: false, status: "INCOMPLETE", reasons: ["session did not start"], end: null };
    }
    state.lastSession = buildResult(verdict);
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
    state.archive?.finish(verdict).catch(error => { state.message = `Recording storage: ${error.message}`; touch(); });
    if (verdict.valid && state.lastSession.rom) state.rom = state.lastSession.rom;
    const vbat = state.lastSession.pids.VBAT?.summary?.last;
    if (verdict.valid && vbat != null) state.battery = vbat;
    state.phase = "idle";
    state.deadline = null;
    state.op = null;
    const diagnosticRead = ["codes", "koeo", "koer"].includes(state.lastSession.kind);
    state.message = verdict.valid
      ? diagnosticRead
        ? `Capture integrity checks passed — ECU DTC verification ${state.lastSession.dtcVerified ? "reported" : "not reported"}.`
        : `Valid — ${verdict.end ? reasonText(verdict.end.reason) : "complete"}`
      : `${verdict.status}: ${verdict.reasons.join("; ")}`;
    if (combined?.error) state.message = combined.error;
    touch();
  }

  function beginArm() {
    state.phase = "arm";
    state.message = `Arming ${state.op.variant}`;
    arm(TIMEOUTS.arm);
    send(`ARM_${state.op.variant}`);
  }

  function onStatus(parsed) {
    state.status = {
      identity: parsed.identity,
      fields: parsed.fields,
      raw: parsed.raw,
      safe: parsed.safe,
    };
    state.bench.pass = parsed.fields.tx2_bench_pass === "1";
    if (state.phase === "identify_status") {
      state.phase = "idle";
      state.deadline = null;
      state.message = parsed.safe ? "Bridge idle" : "Bridge is not in a safe idle state";
      return;
    }
    if (state.phase === "pre_status") {
      if (!parsed.safe) {
        finalize({ status: "INCOMPLETE", reason: "bridge not idle/safe" });
        return;
      }
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
      if (!parsed.safe || parsed.fields.tx2_bench_pass !== "1") {
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
      beginArm();
    }
  }

  function ingestRead(parsed) {
    if (!state.op) return;
    if (!state.op.session) state.op.session = createSession();
    if (parsed.type === "session_start") {
      state.cart = createCartDecoder(pidSetForVariant(state.op.variant), state.archive ? {
        historyLimit: 512,
        onSample(sample) {
          sample.receivedAt = now();
          state.archive.sample(sample);
          recordDiagnosticSample(sample, { variant: state.op?.variant || "" });
        },
      } : {});
    }
    noteSessionLine(state.op.session, parsed);
    try {
      if (parsed.type === "rx" && state.cart) state.cart.pushRx(parsed.t_us, parsed.byte);
      if (parsed.type === "rx_batch" && state.cart) {
        for (const event of parsed.events) state.cart.pushRx(event.t_us, event.byte);
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
    recordBridgeRaw(parsed.raw);
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
      if (state.op?.session) noteSessionLine(state.op.session, parsed);
      finalize({ status: "INCOMPLETE", reason: parsed.raw });
      return;
    }
    if (parsed.type === "fault" && (state.phase === "read" || state.phase === "stopping")) {
      if (state.op) {
        if (!state.op.session) state.op.session = createSession();
        noteSessionLine(state.op.session, parsed);
        state.op.forceStatus = "INCOMPLETE";
        state.op.forceReason = parsed.raw;
      }
      state.phase = "stopping";
      state.message = parsed.raw;
      arm(TIMEOUTS.stop);
      send("STOP");
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
      if (state.op?.session?.started && !state.op.forceStatus) return;
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
    if (state.link !== "ready") return "not connected";
    if (state.phase !== "idle") return "busy";
    if (state.identity.helloOk !== true || state.identity.pinsOk !== true) return "bridge identity not verified";
    if (op.kind !== "live") state.archive = null;
    op.startedAt = now();
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
      const auth = state.identity.auth;
      state.link = "ready";
      state.deviceName = name;
      state.transport = transport;
      state.log = [];
      state.archive = null;
      state.lastSession = null;
      state.combined = null;
      state.cart = null;
      state.rom = null;
      state.battery = null;
      state.trust = "none";
      state.identity = { auth, hello: "", helloOk: null, pins: "", pinsOk: null };
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
      state.deviceName = "";
      state.transport = "";
      if (phase === "idle") {
        state.message = "Disconnected";
        touch();
        return;
      }
      if (phase === "reboot") {
        state.phase = "idle";
        state.deadline = null;
        state.op = null;
        state.message = "Bridge rebooted and the link dropped";
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
      if (state.combined?.active) return { ok: false, error: "busy" };
      if (state.link !== "ready") return { ok: false, error: "not connected" };
      if (state.phase !== "idle") return { ok: false, error: "busy" };
      state.phase = "reboot";
      state.message = "Rebooting bridge";
      arm(TIMEOUTS.identify);
      send("REBOOT");
      touch();
      return { ok: true };
    },
    requestStop: stop,
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
