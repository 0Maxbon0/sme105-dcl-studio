/** Isolated passive channel model. No transport, TX, OBD service or GPIO API. */
export const KLINE_CAPABILITY = Object.freeze({ hardwareEnabled: false, txEnabled: false, hardwareVerified: false, candidateRxGpio: 19, protocol: "UNKNOWN" });
export function createKlineSession({ id = crypto.randomUUID(), source = "simulation", capacity = 65536 } = {}) {
  if (!["simulation", "import"].includes(source)) throw new Error("Hardware input unavailable: transceiver and receiver not qualified");
  let last = null, clock = 0;
  const provenance = source; source = "simulation";
  const state = { id, channel: "KLINE", source, importKind: provenance, hardwareVerified: false, status: "RECORDING", startedAt: new Date().toISOString(), endedAt: null, records: [], errors: [], received: 0, overflow: 0, protocol: "UNKNOWN" };
  return {
    state,
    receive(event) {
      if (state.status !== "RECORDING") throw new Error("K-Line session is closed");
      if (event.channel !== "KLINE") throw new Error("Channel mismatch: DCL cannot enter K-Line");
      const t = event.t_us;
      if (!Number.isInteger(t) || t < 0 || t > 0xffffffff) throw new Error("Invalid uint32 timestamp");
      const delta = last === null ? 0 : (t - last) >>> 0;
      if (delta > 0x7fffffff) throw new Error("K-Line timestamp reversal");
      if (!Object.hasOwn(event, "byte") && !Object.hasOwn(event, "edge") && !event.error && !event.metadata) throw new Error("Missing K-Line payload");
      if (event.byte !== undefined && (!Number.isInteger(event.byte) || event.byte < 0 || event.byte > 255)) throw new Error("Invalid byte");
      if (event.edge !== undefined && ![0, 1].includes(event.edge)) throw new Error("Invalid edge");
      clock = last === null ? t : clock + delta; last = t; ++state.received;
      if (event.error) state.errors.push(String(event.error));
      if (state.records.length >= capacity) { ++state.overflow; state.status = "OVERFLOW"; return null; }
      const record = { channel: "KLINE", sessionId: id, source, hardwareVerified: false, t_us: t, monotonic_us: clock,
        byte: event.byte, edge: event.edge, frame: event.frame ?? null, framing: event.framing ?? "UNKNOWN", protocol: "UNKNOWN",
        protocolClaim: event.protocol ?? null, error: event.error ?? null, metadata: event.metadata ?? null };
      if (event.protocol && !["UNKNOWN", "ISO9141"].includes(event.protocol)) { state.errors.push("PROTOCOL_MISMATCH"); record.error = "PROTOCOL_MISMATCH"; }
      state.records.push(record); return record;
    },
    end(reason = "STOPPED") { state.status = reason; state.endedAt = new Date().toISOString(); return state; },
  };
}
export function importKline(input, { binary = false, ...options } = {}) {
  const session = createKlineSession(options);
  if (binary) {
    // Binary imports have no measured clock/framing. Synthetic ordering only.
    for (const [i, byte] of new Uint8Array(input).entries()) {
      session.receive({ channel: "KLINE", t_us: i, byte, metadata: { timeBasis: "synthetic-byte-index", framing: "UNKNOWN" } });
      if (session.state.status === "OVERFLOW") break;
    }
  } else {
    for (const line of String(input).split(/\r?\n/).filter(line => line.trim())) {
      let event;
      if (line.trim().startsWith("{")) event = JSON.parse(line);
      else {
        const match = /^KLINE\s+t_us=(\d+)\s+byte=([0-9a-f]{2})$/i.exec(line.trim());
        if (!match) throw new Error("Expected KLINE t_us=<uint32> byte=<hex>, or JSONL with channel KLINE");
        event = { channel: "KLINE", t_us: Number(match[1]), byte: parseInt(match[2], 16) };
      }
      session.receive(event);
      if (session.state.status === "OVERFLOW") break;
    }
  }
  session.end(session.state.status === "OVERFLOW" ? "OVERFLOW" : "IMPORTED");
  return session.state;
}
export function klineCsv(session) {
  const cell = v => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const keys = ["channel", "sessionId", "source", "hardwareVerified", "t_us", "monotonic_us", "byte", "edge", "frame", "framing", "protocol", "protocolClaim", "error", "metadata"];
  return keys.join(",") + "\n" + session.records.map(r => keys.map(k => cell(typeof r[k] === "object" && r[k] !== null ? JSON.stringify(r[k]) : r[k])).join(",")).join("\n") + "\n";
}
