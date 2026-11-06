/** Shared Android/WebView review path; all decisions are durable before UI success. */
import { listRecordings, resolveRecordingOutcome } from "./recording.js";
import { reconcileOutcome } from "./session-history.js";

export function createIgnitionReview({ controller, render, refreshWarnings, document: doc = globalThis.document }) {
  let pending = null;
  let saving = false;
  const node = id => doc.getElementById(id);
  async function refresh(show = false) {
    pending = (await listRecordings()).find(item => item.outcome === "OPERATOR_CONFIRMATION_PENDING") || null;
    node("ignition-review").hidden = !pending;
    if (!pending) node("ignition-confirmation").hidden = true;
    else if (show) {
      node("ignition-session").textContent = `${pending.variant} · ${new Date(pending.started).toLocaleString()}`;
      node("ignition-confirmation").hidden = false;
    }
  }
  async function resolve(outcome) {
    if (!pending || saving) return;
    saving = true;
    const buttons = ["ignition-yes", "ignition-no", "ignition-later"].map(node);
    buttons.forEach(button => { button.disabled = true; });
    try {
      const item = await resolveRecordingOutcome(pending.id, outcome);
      if (!item) { await refresh(true); return; }
      await reconcileOutcome(item);
      if (controller.state.lastSession?.recordingId === item.id) Object.assign(controller.state.lastSession,
        { outcome, operatorConfirmation: item.operatorConfirmation });
      controller.state.message = outcome === "USER_CONFIRMED_IGNITION_OFF"
        ? "Session ended after operator-reported ignition off."
        : "The ECU stopped responding unexpectedly. Check the communication connection.";
      render(controller.state);
      await refreshWarnings();
      await refresh(true);
    } catch (error) {
      controller.state.message = `Could not save confirmation: ${error.message}`;
      render(controller.state);
    } finally { saving = false; buttons.forEach(button => { button.disabled = false; }); }
  }
  function wire() {
    node("ignition-review").addEventListener("click", () => refresh(true));
    node("ignition-later").addEventListener("click", () => { node("ignition-confirmation").hidden = true; });
    node("ignition-yes").addEventListener("click", () => resolve("USER_CONFIRMED_IGNITION_OFF"));
    node("ignition-no").addEventListener("click", () => resolve("UNEXPECTED_ECU_SILENCE"));
  }
  return { refresh, resolve, wire };
}
