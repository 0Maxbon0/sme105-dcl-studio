/** Replay a bridge transcript. No DOM. The browser wrapper adds timing. */

export function variantOf(line) {
  const match = String(line).match(/(?:^|\s)variant=([A-Z0-9]+)/);
  return match ? match[1] : null;
}

export function createReplay(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.replace(/\s+$/, "")).filter((line) => line.length > 0);
  const statuses = lines.filter((line) => line.startsWith("STATUS "));
  let statusIdx = 0;

  function respond(command) {
    const cmd = String(command).trim();
    if (cmd === "HELLO") return lines.filter((line) => line.startsWith("HELLO ")).slice(0, 1);
    if (cmd === "PINS") return lines.filter((line) => line.startsWith("PINS ")).slice(0, 1);
    if (cmd === "STATUS") {
      if (!statuses.length) return [];
      const line = statuses[Math.min(statusIdx, statuses.length - 1)];
      if (statusIdx < statuses.length - 1) statusIdx += 1;
      return [line];
    }
    if (cmd === "TX2_BENCH") {
      const start = lines.findIndex((line) => line.startsWith("TX2_BENCH"));
      const end = lines.findIndex((line) => line.startsWith("TX2_BENCH_END"));
      if (start < 0 || end < start) return ["TX2_BENCH_DENIED demo"];
      return lines.slice(start, end + 1);
    }
    if (cmd.startsWith("ARM_")) {
      const variant = cmd.slice(4);
      const hit = lines.find((line) => line.startsWith("EVENT read_armed") && variantOf(line) === variant);
      return hit ? [hit] : [`DENIED demo_no_${variant}`];
    }
    if (cmd.startsWith("READ_")) {
      const variant = cmd.slice(5);
      const arm = lines.findIndex((line) => line.startsWith("EVENT read_armed") && variantOf(line) === variant);
      if (arm < 0) return [`DENIED demo_no_${variant}`];
      let start = -1;
      for (let i = arm + 1; i < lines.length; i += 1) {
        if (lines[i].startsWith("EVENT session=")) {
          start = i;
          break;
        }
      }
      if (start < 0) return ["DENIED demo_no_session"];
      let end = start;
      for (let i = start; i < lines.length; i += 1) {
        if (lines[i].startsWith("END ")) {
          end = i;
          break;
        }
      }
      return lines.slice(start, end + 1);
    }
    if (cmd === "STOP") return ["EVENT stop=accepted DE=LOW"];
    if (cmd === "REBOOT") return ["EVENT reboot=accepted DE=LOW"];
    return [`DENIED unknown_command`];
  }

  return { lines, respond };
}

export function createMockTransport(replay, handlers) {
  let token = 0;
  return {
    name: "SME105-DCL",
    async connect() {
      handlers.onText("AUTH OK transport=BLE\n");
    },
    async disconnect() {
      token += 1;
      handlers.onDisconnect();
    },
    write(command) {
      token += 1;
      const mine = token;
      const lines = replay.respond(command);
      let index = 0;
      const pump = () => {
        if (mine !== token) return;
        const slice = lines.slice(index, index + 100);
        index += slice.length;
        if (slice.length) handlers.onText(`${slice.join("\n")}\n`);
        if (index < lines.length) setTimeout(pump, 0);
      };
      setTimeout(pump, 0);
      return Promise.resolve();
    },
  };
}
