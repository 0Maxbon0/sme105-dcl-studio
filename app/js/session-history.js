/** Reconcile durable operator decisions after interruption, without rewriting raw events. */
import { diagnosticHistory, recordDiagnosticEvent, recordDiagnosticWarning } from "./diagnostics.js";
import { sessionWarning } from "./session-outcome.js";

export async function reconcileOutcome(item) {
  if (!item.operatorConfirmation || !item.session) return;
  const detail = { recordingId: item.id, outcome: item.outcome, operatorConfirmation: item.operatorConfirmation,
    confirmedAt: item.operatorConfirmation.confirmedAt, session: item.session };
  const events = await diagnosticHistory();
  if (!events.some(event => event.type === "SESSION_OUTCOME_RESOLVED" && event.detail?.recordingId === item.id)) {
    if (!await recordDiagnosticEvent("SESSION_OUTCOME_RESOLVED", detail, "session")) throw new Error("Diagnostic journal write failed");
  }
  const key = `session-${item.session.variant}-${item.session.completedAt}`;
  const active = (await diagnosticHistory("warnings")).find(w => w.key === key && w.active);
  const warning = sessionWarning({ ...item.session, variant: item.variant, verdict: item.verdict, outcome: item.outcome });
  if (active && (!warning || active.ruleId !== warning.ruleId)) await recordDiagnosticWarning(key, false, {});
  if (warning && active?.ruleId !== warning.ruleId) await recordDiagnosticWarning(key, true, { ...warning, evidence: { ...detail, verdict: item.verdict } });
}
