export const ECU_NO_RESPONSE_MESSAGE = "The ECU did not respond. The ignition may be off. Check that the ignition is on and the connection is secure, then try Start again.";

export function noResponseFromStart(session, result, operatorStop, override = null) {
  return !operatorStop && result.source === "bridge" && result.kind === "live" &&
    [3, 4, 19].includes(session?.end?.reason) && session.rx === 0 &&
    (!override || new RegExp(`^FAULT reason=${session.end.reason}\\b`).test(override.reason || "")) &&
    session.end.ro_lost === 0 && session.end.uart_errors === 0 && session.end.de === "LOW" &&
    !result.totalRows && !result.parityRejects &&
    session.problems.every(problem => /^FAULT reason=(3|4|19)$/.test(problem));
}

export const IGNITION_QUESTION = "Live data stopped because the ECU is no longer responding. Did you switch off the ignition yourself?";
export function ignitionConfirmationNeeded(session, result, op, override) {
  return result.source === "bridge" && result.kind === "live" &&
    ["LIVE", "LIVE2", "LIVE3", "ALL"].includes(result.variant) && !op?.operatorStop &&
    session?.end?.reason === 19 && session.rx > 0 && result.totalRows > 0 &&
    result.verdict?.witnessStatus === "SESSION_BOUND" && !result.parityRejects &&
    session.rx === session.end.ro_bytes && session.end.ro_lost === 0 &&
    session.end.uart_errors === 0 && session.end.de === "LOW" &&
    session.faults?.some(raw => /^FAULT\s+.*\breason=19\b.*\bcause=RX_SILENCE\b/.test(raw)) &&
    session.problems.every(problem => problem === "FAULT reason=19") &&
    (!override || /^FAULT\s+reason=19\b/.test(override.reason || ""));
}

// Operator disposition never changes the raw capture verdict.
export function independentIntegrityReasons(verdict) {
  return (verdict?.reasons || []).filter(reason =>
    !/^FAULT reason=19(?:$| cause=RX_SILENCE\b)/.test(reason) && !/^END reason=19 \(RX_SILENCE/.test(reason));
}
export function sessionWarning(session) {
  if (session.verdict?.valid) return null;
  const pending = session.outcome === "OPERATOR_CONFIRMATION_PENDING";
  const confirmed = session.outcome === "USER_CONFIRMED_IGNITION_OFF";
  const reasons = pending || confirmed ? independentIntegrityReasons(session.verdict) : session.verdict?.reasons || [];
  if ((pending || confirmed) && !reasons.length) return null;
  return { severity: session.verdict?.status === "FAILED" ? "red" : "amber", sensor: "Session",
    ruleId: `SESSION-${pending || confirmed ? "INTEGRITY" : session.outcome || session.verdict?.status || "INCOMPLETE"}`,
    reason: session.outcome === "NOT_STARTED_ECU_NO_RESPONSE" ? ECU_NO_RESPONSE_MESSAGE :
      session.outcome === "UNEXPECTED_ECU_SILENCE" ? "The ECU stopped responding unexpectedly. Check the communication connection." : reasons.join("; "),
    source: `${session.variant} session validity checks`, evidence: session };
}
