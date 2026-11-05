/** No validated SME105 operator-cue signature exists in the preserved evidence.
 * Result bits and numeric trouble codes deliberately cannot enter a prompt state.
 */
export const KOER_CUE_UNAVAILABLE = "Real-time ECU cue unavailable / unverified. لا توجد إشارة لحظية موثقة من وحدة التحكم.";
export function createKoerGuide({ journal = () => {}, now = Date.now } = {}) {
  const state = { phase: "PREPARATION", sessionId: null, prompt: null, verifiedSuccess: false, operatorEvents: [], evidence: [] };
  const emit = (type, detail) => journal(type, { channel: "DCL", sessionId: state.sessionId, utc: new Date(now()).toISOString(), ...detail });
  return {
    state,
    start(sessionId) {
      Object.assign(state, { phase: "AWAITING_ECU", sessionId, prompt: null, verifiedSuccess: false, operatorEvents: [], evidence: [] });
      emit("KOER_STARTED", { source: "operator", cueStatus: "UNAVAILABLE" });
    },
    evidence(event) {
      if (!["AWAITING_ECU", "RESULT_PHASE"].includes(state.phase)) return;
      state.evidence.push(event);
      if (event.type === "RESULT_PHASE") state.phase = "RESULT_PHASE";
      emit("KOER_ECU_EVIDENCE", { source: "bridge", ...event, authenticatedOperatorCue: false });
    },
    confirm(action) {
      if (!["AWAITING_ECU", "RESULT_PHASE"].includes(state.phase)) throw new Error("No active KOER recording");
      if (!["external-cue", "throttle-reported", "steering-reported", "brake-reported"].includes(action)) throw new Error("Unsupported operator marker");
      const event = { action, at: now(), source: "human", ecuConfirmed: false };
      state.operatorEvents.push(event); emit("KOER_OPERATOR_EVENT", event);
      return event;
    },
    finish({ disconnected = false, aborted = false, timedOut = false, captureIntegrity = "UNKNOWN" } = {}) {
      state.phase = disconnected ? "DISCONNECTED" : aborted ? "ABORTED" : timedOut ? "TIMED_OUT" : "ENDED_UNVERIFIED";
      state.prompt = null;
      emit("KOER_ENDED", { source: "app", phase: state.phase, captureIntegrity, verifiedSuccess: false, operatorCompleteness: "UNVERIFIED" });
    },
  };
}
