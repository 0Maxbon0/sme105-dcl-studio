/** Operation controller. Timers stay outside; call tick() with the injected clock. */

import { createCartDecoder } from "./cart.js";
import { pidSetForVariant, summarizeSeries } from "./pids.js";
import {
  TIMEOUTS,
  VARIANTS,
  parseLine,
  reasonText,
} from "./protocol.js";
import { createSession, noteSessionLine, sessionVerdict } from "./session.js";

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
  };

  function touch() {
    for (const fn of listeners) fn(state);
  }

  function arm(ms) {
    state.deadline = now() + ms;
  }

  function buildResult(verdict) {
    const snap = state.cart ? state.cart.snapshot() : null;
    const variant = state.op?.variant || state.lastSession?.variant || "";
    const codes = (snap?.codes || []).map((entry) => ({
      code: entry.code,
      mode: entry.mode,
      source: entry.mode === 0x25 ? "KOEO" : "stored",
      frame: entry.frame,
      slot: entry.slot,
    }));
    const pids = {};
    if (snap) {
      for (const [name, series] of Object.entries(snap.pids)) {
        pids[name] = { ...series, summary: summarizeSeries(series.samples) };
      }
    }
    return {
      variant,
      kind: state.op?.kind || "",
      verdict,
      codes,
      pids,
      rows: snap?.rows || [],
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
    let verdict = session ? sessionVerdict(session, {}) : null;
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
    state.trust = verdict.valid ? "valid" : "untrusted";
    if (verdict.valid && state.lastSession.rom) state.rom = state.lastSession.rom;
    const vbat = state.lastSession.pids.VBAT?.summary?.last;
    if (verdict.valid && vbat != null) state.battery = vbat;
    state.phase = "idle";
    state.deadline = null;
    state.op = null;
    state.message = verdict.valid
      ? `Valid — ${verdict.end ? reasonText(verdict.end.reason) : "complete"}`
      : `${verdict.status}: ${verdict.reasons.join("; ")}`;
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
      state.cart = createCartDecoder(pidSetForVariant(state.op.variant));
    }
    noteSessionLine(state.op.session, parsed);
    if (parsed.type === "rx" && state.cart) state.cart.pushRx(parsed.t_us, parsed.byte);
    if (parsed.type === "end") {
      const override = state.op.forceStatus
        ? { status: state.op.forceStatus, reason: state.op.forceReason }
        : null;
      finalize(override);
    }
  }

  function handleLine(line) {
    const parsed = parseLine(line);
    state.log.push(parsed.raw);
    if (parsed.type === "auth") {
      state.identity.auth = parsed.ok ? "OK" : "DENIED";
      if (!parsed.ok) {
        state.link = "denied";
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

  return {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    handleLine,
    onConnected(name = "") {
      const auth = state.identity.auth;
      state.link = "ready";
      state.deviceName = name;
      state.log = [];
      state.lastSession = null;
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
      if (state.link === "disconnected") return;
      const phase = state.phase;
      state.link = "disconnected";
      state.deviceName = "";
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
      if (!VARIANTS[variant]) return { ok: false, error: "unknown variant" };
      const error = beginPrecheck({
        variant,
        kind: VARIANTS[variant].kind,
        manualBench: false,
        forceStatus: null,
        forceReason: "",
        session: null,
      });
      if (error) return { ok: false, error };
      state.message = `Checking bridge before ${variant}`;
      return { ok: true };
    },
    requestBench() {
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
      if (state.link !== "ready") return { ok: false, error: "not connected" };
      if (state.phase !== "idle") return { ok: false, error: "busy" };
      state.phase = "reboot";
      state.message = "Rebooting bridge";
      arm(TIMEOUTS.identify);
      send("REBOOT");
      touch();
      return { ok: true };
    },
    requestStop() {
      if (state.phase === "idle" || state.phase === "stopping") return;
      state.phase = "stopping";
      state.message = "Stopping";
      arm(TIMEOUTS.stop);
      send("STOP");
      touch();
    },
    tick() {
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
