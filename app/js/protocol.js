/** ASCII line protocol for the SME105 bridge. No DOM, no Bluetooth. */

export const APP_VERSION = "1.6.1";

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const DEVICE_NAME_PREFIX = "SME105";
export const MAX_WRITE_BYTES = 180;

export const EXPECTED_HELLO =
  "HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1";
export const EXPECTED_PINS =
  "PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1";

export const STAGES = {
  0: "IDLE",
  1: "QUIET",
  2: "ECHO_TX",
  3: "ACK_WAIT",
  4: "GO_TX",
  5: "CART_PASSIVE",
  6: "CART_READ",
  7: "FINISHING",
  8: "FAULTED",
};

export const END_REASONS = {
  0: "NO_FAULT",
  1: "BAD_IDLE",
  2: "HSK_TX",
  3: "HSK_TIMEOUT",
  4: "HSK_ACK",
  5: "CART_INIT",
  6: "CART_ERR",
  7: "CART_HEADER",
  8: "CART_PHASE",
  9: "CART_CADENCE",
  10: "CART_TIMER",
  11: "PAD_MISMATCH",
  12: "PAD_FRAMING",
  13: "DE_TIMEOUT",
  14: "RX_OVERFLOW",
  15: "HOST_STOP",
  16: "CAPTURE_TIMEOUT",
  17: "TRANSPORT_BACKPRESSURE",
  18: "DE_MISSING",
  19: "RX_SILENCE (no UART1 bytes for five seconds)",
};

/** Timeouts in milliseconds. Session timeouts start when READ is sent. */
export const TIMEOUTS = {
  identify: 8000,
  status: 8000,
  arm: 8000,
  stop: 8000,
  bench: 15000,
  codes: 20000,
  KOEO: 75000,
  KOER: 5 * 60 * 1000,
  LIVE: 181 * 60 * 1000,
  LIVE2: 181 * 60 * 1000,
  LIVE3: 181 * 60 * 1000,
  ALL: 181 * 60 * 1000,
  CLR: 12000,
  MEM: 20000,
  OFF: 15000,
};

export const VARIANTS = {
  "0E": { command: "0E", kind: "codes", label: "stored", timeoutMs: TIMEOUTS.codes, expectMs: 20000 },
  A4: { command: "A4", kind: "codes", label: "stored-alt", timeoutMs: TIMEOUTS.codes, expectMs: 20000 },
  KOEO: { command: "KOEO", kind: "koeo", label: "KOEO", timeoutMs: TIMEOUTS.KOEO, expectMs: 60000 },
  KOER: { command: "KOER", kind: "koer", label: "KOER", timeoutMs: TIMEOUTS.KOER, expectMs: 4 * 60 * 1000 },
  LIVE: { command: "LIVE", kind: "live", label: "LIVE", timeoutMs: TIMEOUTS.LIVE, expectMs: 180 * 60 * 1000 },
  LIVE2: { command: "LIVE2", kind: "live", label: "LIVE2", timeoutMs: TIMEOUTS.LIVE2, expectMs: 180 * 60 * 1000 },
  LIVE3: { command: "LIVE3", kind: "live", label: "LIVE3", timeoutMs: TIMEOUTS.LIVE3, expectMs: 180 * 60 * 1000 },
  ALL: { command: "ALL", kind: "live", label: "ALL", timeoutMs: TIMEOUTS.ALL, expectMs: 180 * 60 * 1000 },
  CLR: { command: "CLR", kind: "clear", label: "CLR", timeoutMs: TIMEOUTS.CLR, expectMs: 4000 },
  MEM: { command: "MEM", kind: "memory", label: "MEM", timeoutMs: TIMEOUTS.MEM, expectMs: 10000 },
  OFF: { command: "OFF", kind: "offline", label: "OFF", timeoutMs: TIMEOUTS.OFF, expectMs: 15000 },
};

export function reasonText(code) {
  const n = Number(code);
  const name = END_REASONS[n];
  if (name === undefined) return `reason ${code}`;
  if (n === 16) return `${name} (normal end of a bounded capture)`;
  return name;
}

const STAGE_PLAIN = {
  0: "Idle — waiting for a command",
  1: "Checking that the link is quiet",
  2: "Sending the wake-up message",
  3: "Waiting for the ECU to answer",
  4: "Asking the ECU to start diagnostic mode",
  5: "Listening only",
  6: "Talking to the ECU",
  7: "Finishing and saving the result",
  8: "Stopped because of a fault",
};

export function stageText(code) {
  const n = Number(code);
  return STAGE_PLAIN[n] || `Unknown state ${code}`;
}

export function parseFields(line) {
  const fields = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)/g;
  let match;
  while ((match = re.exec(line))) fields[match[1]] = match[2];
  return fields;
}

export function parseStatus(line) {
  const body = line.startsWith("STATUS ") ? line.slice(7) : line;
  const parts = body.trim().split(/\s+/);
  const identity = parts[0] || "";
  const fields = parseFields(body);
  return { identity, fields };
}

export function statusSafe(status) {
  if (!status || !status.fields) return false;
  const f = status.fields;
  return f.stage === "0" && f.DE === "LOW" && f.auto_tx === "0" && f.gate4 === "1";
}

export function createLineBuffer() {
  let buf = "";
  return {
    push(chunk) {
      buf += String(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const lines = [];
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        lines.push(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      return lines;
    },
    remainder() {
      return buf;
    },
  };
}

export function encodeCommand(command) {
  const text = command.endsWith("\n") ? command : `${command}\n`;
  return new TextEncoder().encode(text);
}

export function chunkBytes(bytes, max = MAX_WRITE_BYTES) {
  const chunks = [];
  for (let i = 0; i < bytes.length; i += max) chunks.push(bytes.subarray(i, Math.min(i + max, bytes.length)));
  return chunks;
}

function num(fields, key) {
  if (fields[key] === undefined) return null;
  const n = Number(fields[key]);
  return Number.isFinite(n) ? n : null;
}

export function parseLine(line) {
  const raw = String(line).replace(/\r$/, "");
  if (raw.startsWith("RXB ")) {
    const match = raw.match(/^RXB t_us=(\d{1,10}) data=([0-9A-F]{2,32}) dt=(\d+(?:,\d+)*)$/);
    if (match) {
      const base = Number(match[1]);
      const offsets = match[3].split(",").map(Number);
      if (base <= 0xffffffff && match[2].length % 2 === 0 &&
          offsets.length === match[2].length / 2 && offsets[0] === 0 &&
          offsets.every((n, i) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff && (!i || n >= offsets[i - 1]))) {
        return { type: "rx_batch", raw, events: offsets.map((dt, i) => ({
          type: "rx", t_us: (base + dt) >>> 0, byte: parseInt(match[2].slice(i * 2, i * 2 + 2), 16),
        })) };
      }
    }
    return { type: "fault", raw, reason: "RX_BATCH_FORMAT" };
  }
  if (raw.startsWith("AUTH OK")) return { type: "auth", ok: true, raw };
  if (raw.startsWith("DENIED") || raw.startsWith("TX2_BENCH_DENIED")) {
    return { type: "denied", raw, reason: raw.replace(/^(DENIED|TX2_BENCH_DENIED)\s*/, "") };
  }
  if (raw.startsWith("HELLO ")) return { type: "hello", raw, ok: raw === EXPECTED_HELLO };
  if (raw.startsWith("PINS ")) return { type: "pins", raw, ok: raw === EXPECTED_PINS };
  if (raw.startsWith("STATUS ")) {
    const status = parseStatus(raw);
    return { type: "status", raw, ...status, safe: statusSafe(status) };
  }
  if (raw.startsWith("TX2_BENCH_END")) {
    const fields = parseFields(raw);
    return { type: "bench_end", raw, fields, result: fields.result || "", pass: (fields.result || "").startsWith("PASS") };
  }
  if (raw.startsWith("TX2_BENCH")) return { type: "bench", raw };
  if (raw.startsWith("FAULT")) {
    const fields = parseFields(raw);
    return { type: "fault", raw, reason: num(fields, "reason"), fields };
  }
  if (raw.startsWith("END ")) {
    const fields = parseFields(raw);
    const reason = num(fields, "reason");
    return {
      type: "end",
      raw,
      fields,
      reason,
      reasonName: END_REASONS[reason] || "UNKNOWN",
      ro_bytes: num(fields, "ro_bytes"),
      ro_lost: num(fields, "ro_lost"),
      uart_errors: num(fields, "uart_errors"),
      pad_verified: num(fields, "pad_verified"),
      words_started: num(fields, "words_started"),
      de: fields.DE || "",
    };
  }
  if (raw.startsWith("TX_PAD ")) {
    const fields = parseFields(raw);
    return {
      type: "pad",
      raw,
      fields,
      slot: num(fields, "slot"),
      expected: (fields.expected || "").toUpperCase(),
      observed: (fields.observed || "").toUpperCase(),
      match: num(fields, "match"),
    };
  }
  if (raw.startsWith("RX ")) {
    const fields = parseFields(raw);
    const byte = fields.byte ? Number.parseInt(fields.byte, 16) : NaN;
    const t = fields.t_us !== undefined ? Number(fields.t_us) : NaN;
    if (!Number.isFinite(byte) || !Number.isFinite(t)) return { type: "other", raw };
    return { type: "rx", raw, t_us: t, byte };
  }
  if (raw.startsWith("EVENT read_armed")) {
    const fields = parseFields(raw);
    return { type: "armed", raw, variant: fields.variant || "", fields };
  }
  if (raw.startsWith("EVENT session=")) {
    const fields = parseFields(raw);
    return { type: "session_start", raw, kind: fields.session || "", fields };
  }
  if (raw.startsWith("EVENT stop=")) return { type: "stop", raw, fields: parseFields(raw) };
  if (raw.startsWith("EVENT reboot=")) return { type: "reboot", raw, fields: parseFields(raw) };
  if (raw.startsWith("EVENT uart_errors")) return { type: "uart_errors", raw, fields: parseFields(raw) };
  if (raw.startsWith("EVENT rx_lost")) return { type: "rx_lost", raw, fields: parseFields(raw) };
  if (raw.startsWith("EVENT dps_blocks_complete") || raw.includes(" dps_blocks_complete=")) {
    const fields = parseFields(raw);
    return { type: "dps", raw, blocks: num(fields, "dps_blocks_complete"), fields };
  }
  if (raw.startsWith("EVENT offline_quiet") || raw.includes("offline_quiet_us=")) {
    const fields = parseFields(raw);
    return { type: "offline", raw, quiet_us: num(fields, "offline_quiet_us"), fields };
  }
  if (raw.startsWith("EVENT live_pid_map")) {
    const fields = parseFields(raw);
    return { type: "pid_map", raw, set: fields.set || "", sent: num(fields, "sent"), verified: num(fields, "verified"), fields };
  }
  if (raw.startsWith("H2400 ") || raw.startsWith("EVENT ")) return { type: "event", raw, fields: parseFields(raw) };
  return { type: "other", raw };
}
