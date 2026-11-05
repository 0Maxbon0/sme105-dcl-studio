import { createKlineSession, importKline, klineCsv } from "./kline.js";
import { diagnosticHistory, recordDiagnosticEvent } from "./diagnostics.js";
import { saveOrShare } from "./exports.js";
export function wireKline() {
  const $ = id => document.getElementById(id);
  let selected, active = null, timer = null, counter = 0;
  async function refresh() {
    const events = await diagnosticHistory();
    const byId = new Map(events.filter(e => e.type === "KLINE_SESSION").map(e => [e.detail.id, e.detail]));
    const sessions = [...byId.values()].map(session => session.status !== "RECORDING" ? session : {
      ...session, status: active?.state.id === session.id ? "RECORDING_SIMULATION" : "INTERRUPTED",
      records: events.filter(e => e.type === "KLINE_RX" && e.detail.sessionId === session.id).map(e => e.detail),
    });
    $("kline-history").replaceChildren(...sessions.reverse().map(s => {
      const option = document.createElement("option"); option.value = s.id; option.textContent = `${s.startedAt} · ${s.source} · ${s.records.length} records · ${s.status}`; return option;
    }));
    function select() {
      selected = sessions.find(s => s.id === $("kline-history").value);
      $("kline-raw").textContent = selected ? selected.records.slice(-300).map(r => `${r.monotonic_us} µs · ${r.byte == null ? `edge ${r.edge}` : r.byte.toString(16).padStart(2, "0")} · ${r.framing} · ${r.source} · ${r.error || "no reported error"} · protocol UNKNOWN (claim ${r.protocolClaim || "none"})`).join("\n") : "No offline K-Line sessions saved.";
      $("kline-export").disabled = !selected;
      $("kline-session-status").textContent = selected ? `${selected.status} · ${selected.source} · hardwareVerified=false · ${selected.records.length} records · overflow ${selected.overflow} · errors: ${(selected.errors || []).join(", ") || "none reported"} · ${selected.startedAt} → ${selected.endedAt || "no END retained"}` : "Hardware absent; no physical K-Line session is possible.";
    }
    $("kline-history").onchange = select; select();
  }
  async function store(state) {
    if (!await recordDiagnosticEvent("KLINE_SESSION", state, "kline")) throw new Error("K-Line recording could not be saved");
    await refresh();
  }
  const fail = error => { $("kline-message").textContent = error.message; void recordDiagnosticEvent("KLINE_IMPORT_ERROR", { channel: "KLINE", source: "simulation", importKind: "import", hardwareVerified: false, reason: error.message }, "error"); };
  $("kline-import").onchange = async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("Import exceeds 2 MiB; split the offline file first");
      const binary = /\.(bin|raw)$/i.test(file.name);
      await store(importKline(binary ? await file.arrayBuffer() : await file.text(), { binary, source: "import" }));
      $("kline-message").textContent = "Imported locally. Unverified offline data; no vehicle communication.";
    } catch (error) { fail(error); }
  };
  async function stopSimulation(reason = "STOPPED") {
    clearInterval(timer); timer = null;
    const current = active; active = null;
    $("kline-stop").disabled = true; $("kline-simulate").disabled = false; $("kline-import").disabled = false;
    if (current) await store(current.end(reason));
    $("kline-message").textContent = "Simulation ended and saved. No vehicle data or commands were involved.";
  }
  $("kline-stop").onclick = () => stopSimulation().catch(fail);
  $("kline-simulate").onclick = async () => {
    if (active) return;
    active = createKlineSession({ capacity: 256 }); counter = 0;
    $("kline-stop").disabled = false; $("kline-simulate").disabled = true; $("kline-import").disabled = true;
    try {
      const current = active;
      await store(current.state);
      if (active !== current) return;
      $("kline-message").textContent = "SIMULATION RECORDING · synthetic bytes only; hardware remains absent. Stop saves the independent session.";
      timer = setInterval(async () => {
        if (active !== current) return;
        try {
          const record = active.receive({ channel: "KLINE", t_us: (counter * 1042) >>> 0, byte: counter & 255,
            frame: `synthetic-${Math.floor(counter / 4)}`, framing: "synthetic byte, not decoded UART", metadata: { synthetic: true } });
          ++counter;
          if (!await recordDiagnosticEvent("KLINE_RX", record, "kline")) throw new Error("Simulation RX journal write failed");
          if (counter >= 256) await stopSimulation("SIMULATION_LIMIT"); else await refresh();
        } catch (error) { clearInterval(timer); active = null; $("kline-stop").disabled = true; $("kline-simulate").disabled = false; $("kline-import").disabled = false; fail(error); }
      }, 500);
    } catch (error) { active = null; $("kline-stop").disabled = true; $("kline-simulate").disabled = false; $("kline-import").disabled = false; fail(error); }
  };
  $("kline-export").onclick = async () => {
    try { await saveOrShare(new Blob([klineCsv(selected)], { type: "text/csv" }), `sme105-kline-${selected.id}.csv`); } catch (error) { fail(error); }
  };
  return refresh().catch(fail);
}
