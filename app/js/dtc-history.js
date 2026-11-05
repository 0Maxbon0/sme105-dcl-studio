import { lookupCode } from "./codes-db.js";
/** Warnings are observations, keyed by originating dataset; never a current-health list. */
export function warningsForDiagnosticSession(session) {
  return (session.codes || []).filter(code => code.code !== "111").map(code => ({
    key: `dtc-${session.variant}-${session.startedAt}-${code.mode}-${code.code}`,
    warning: { severity: "amber", sensor: `DTC ${code.code}`, ruleId: `DTC-${code.code}`,
      reason: `${lookupCode(code.code).description} Historical observation in this dataset; not a present operator instruction or confirmed component failure.`,
      source: `${session.variant} · requested ${code.requestedMode?.toString(16).toUpperCase() || "?"}H · observed ${code.mode?.toString(16).toUpperCase() || "?"}H`,
      evidence: { ...code, channel: "DCL", variant: session.variant, startedAt: session.startedAt, completedAt: session.completedAt,
        verdict: session.verdict, dtcVerified: session.dtcVerified, memoryEffects: "UNPROVEN; no automatic clear" } },
  }));
}
