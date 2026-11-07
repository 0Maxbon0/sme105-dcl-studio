/** Saved diagnostic results are read from the durable session-result journal. */
import { lookupCode } from "./codes-db.js";
import { DCL_PROBE_VARIANTS } from "./protocol.js";

export function savedDiagnosticTests(events) {
  const savedVariants = new Set(["0E", "A4", "KOEO", "KOER", ...Object.keys(DCL_PROBE_VARIANTS)]);
  return events.filter(event => event.type === "SESSION_RESULT" && savedVariants.has(event.detail?.variant))
    .sort((a, b) => (b.detail.completedAt || 0) - (a.detail.completedAt || 0));
}

export function diagnosticTestReport(event) {
  const result = event.detail;
  const date = value => value ? `${new Date(value).toLocaleString()} (${new Date(value).toISOString()})` : "Not retained";
  const probe = result.dclProbe || null;
  const lines = ["SME105 DCL Studio — saved diagnostic result", `Test: ${result.variant}`,
    ...(probe ? [`DCL command word: ${probe.word}`, `Purpose: ${probe.description}`,
      ...(probe.parityNote ? [`Parity note: ${probe.parityNote}`] : []), `Source: ${probe.source} (${probe.sourceUrl})`,
      `Raw RO bytes observed: ${probe.responseBytes ?? "unknown"}`, "ECU ownership / command support: unverified"] : []),
    `Started: ${date(result.startedAt)}`, `Completed: ${date(result.completedAt)}`,
    `Capture status: ${result.verdict?.status || "UNKNOWN"}`,
    `Capture notes: ${(result.verdict?.reasons || []).join("; ") || "None"}`,
    `ECU DTC verification: ${result.dtcVerified ? "reported" : "not reported"}`,
    `Decoded codes: ${(result.codes || []).length}`, ""];
  for (const code of result.codes || []) {
    const info = lookupCode(code.code);
    lines.push(`${code.code}: ${info.description}`);
    if (info.note) lines.push(info.note);
  }
  if (!result.codes?.length) lines.push(probe
    ? "No DTC code words were decoded by this probe. Review the raw RO transcript in the full diagnostic ZIP; this is not proof that the ECU lacks faults."
    : "No code words decoded. This alone does not certify that the ECU has no faults.");
  lines.push("", "Codes from incomplete captures remain unverified evidence; a code alone does not prove a failed component.",
    "", "Original saved evidence:", JSON.stringify(event, null, 2));
  return lines.join("\n") + "\n";
}
