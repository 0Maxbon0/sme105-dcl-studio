/** Shared Android/WebView review path; all decisions are durable before UI success. */
import { listRecordings, resolveRecordingOutcome } from "./recording.js";
import { reconcileOutcome } from "./session-history.js";

export function createIgnitionReview({ controller, render, refreshWarnings, refreshRecordings = async () => {}, document: doc = globalThis.document }) {
  let pending = null;
  let saving = false;
  let refreshVersion = 0;
  const node = id => doc.getElementById(id);
  async function refresh(show = false) {
    const version = ++refreshVersion;
    const recordings = await listRecordings();
    if (version !== refreshVersion) return;
    pending = recordings.find(item => item.outcome === "OPERATOR_CONFIRMATION_PENDING") || null;
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
      if (controller.state.review?.metadata?.id === item.id) Object.assign(controller.state.review.metadata,
        { outcome, operatorConfirmation: item.operatorConfirmation });
      controller.state.message = outcome === "USER_CONFIRMED_IGNITION_OFF"
        ? "Session ended after operator-reported ignition off."
        : "The ECU stopped responding unexpectedly. Check the communication connection.";
      render(controller.state);
      await refreshWarnings();
      await refreshRecordings();
      await refresh(true);
    } catch (error) {
      controller.state.message = `Could not save confirmation: ${error.message}`;
      render(controller.state);
    } finally { saving = false; buttons.forEach(button => { button.disabled = false; }); }
  }
  function wire() {
    // Background DOM updates cannot be seen; re-read durable state on every resume.
    const resume = () => { if (!doc.hidden) void refresh(true).catch(error => {
      controller.state.message = `Could not load confirmation: ${error.message}`;
      render(controller.state);
    }); };
    doc.addEventListener?.('visibilitychange', resume);
    doc.defaultView?.addEventListener('sme105-native-resume', resume);
    node("ignition-review").addEventListener("click", () => refresh(true));
    node("ignition-later").addEventListener("click", () => { ++refreshVersion; node("ignition-confirmation").hidden = true; });
    node("ignition-yes").addEventListener("click", () => resolve("USER_CONFIRMED_IGNITION_OFF"));
    node("ignition-no").addEventListener("click", () => resolve("UNEXPECTED_ECU_SILENCE"));
  }
  return { refresh, resolve, wire };
}
