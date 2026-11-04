/** Per-capture validity. A session is valid only when every check passes. */

export function createSession() {
  return {
    started: false,
    kind: "",
    rx: 0,
    pads: [],
    problems: [],
    end: null,
    offlineQuietUs: null,
    bridgeBlocks: null,
    pidMap: null,
  };
}

export function noteSessionLine(session, parsed) {
  if (!session || session.end) return session;
  if (parsed.type === "session_start") {
    session.started = true;
    session.kind = parsed.kind || "";
    session.rx = 0;
    session.pads = [];
    session.problems = [];
    return session;
  }
  if (!session.started) return session;
  if (parsed.type === "rx") session.rx += 1;
  else if (parsed.type === "pad") session.pads.push(parsed);
  else if (parsed.type === "fault") session.problems.push(`FAULT reason=${parsed.reason}`);
  else if (parsed.type === "denied") session.problems.push(`DENIED ${parsed.reason}`.trim());
  else if (parsed.type === "uart_errors") session.problems.push("EVENT uart_errors");
  else if (parsed.type === "rx_lost") session.problems.push("EVENT rx_lost");
  else if (parsed.type === "offline") session.offlineQuietUs = parsed.quiet_us;
  else if (parsed.type === "dps") session.bridgeBlocks = parsed.blocks;
  else if (parsed.type === "pid_map") session.pidMap = parsed;
  else if (parsed.type === "end") session.end = parsed;
  return session;
}

export function sessionVerdict(session, flags = {}) {
  const reasons = [];
  if (flags.disconnect) reasons.push("link lost");
  if (flags.timeout) reasons.push("timed out");
  if (!session || !session.started) reasons.push("session did not start");
  if (session) reasons.push(...session.problems);
  if (!session?.end) reasons.push("no END line");
  else {
    if (session.end.ro_lost !== 0) reasons.push(`ro_lost=${session.end.ro_lost}`);
    if (session.end.uart_errors !== 0) reasons.push(`uart_errors=${session.end.uart_errors}`);
    if (session.rx !== session.end.ro_bytes) {
      reasons.push(`RX lines ${session.rx} != ro_bytes ${session.end.ro_bytes}`);
    }
    for (const pad of session.pads) {
      if (pad.match !== 1 || pad.observed !== pad.expected) {
        reasons.push(`TX_PAD slot ${pad.slot} expected ${pad.expected} observed ${pad.observed} match ${pad.match}`);
      }
    }
  }
  const forced = flags.disconnect || flags.timeout;
  const valid = reasons.length === 0 && !forced;
  let status = "INCOMPLETE";
  if (valid) status = "VALID";
  else if (flags.disconnect) status = "FAILED";
  return {
    valid,
    status,
    reasons,
    end: session?.end || null,
  };
}
