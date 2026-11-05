import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createCartDecoder } from "../js/cart.js";
import { parseLine } from "../js/protocol.js";
import { createSession, noteSessionLine, sessionVerdict } from "../js/session.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const capture = (name) => readFileSync(path.join(repo, "captures/SME105_97AB", name), "utf8");

function linesOf(text) {
  return text.split(/\r?\n/).filter((line) => line.length);
}

function feed(text) {
  const session = createSession();
  for (const line of linesOf(text)) noteSessionLine(session, parseLine(line));
  return session;
}

function decode(text) {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => line.startsWith("EVENT session="));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("END "));
  const cart = createCartDecoder();
  const session = createSession();
  for (const line of lines.slice(start, end + 1)) {
    const parsed = parseLine(line);
    noteSessionLine(session, parsed);
    if (parsed.type === "rx") cart.pushRx(parsed.t_us, parsed.byte);
  }
  return { session, cart: cart.finish() };
}

function sliceSession(text, kind) {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => line.startsWith("EVENT session=") && (!kind || line.includes(`session=${kind}`)));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("END "));
  return lines.slice(start, end + 1).join("\n");
}

test("READ_0E capture meets the validity rules", () => {
  const text = capture("20261104T143804949449Z-usb-bridge.txt");
  const session = feed(sliceSession(text, "READ_CANDIDATE"));
  const { cart } = decode(text);
  const verdict = sessionVerdict(session, { variant: "0E", cart });
  assert.equal(verdict.valid, true);
  assert.equal(verdict.status, "VALID");
  assert.equal(session.rx, 3810);
  assert.equal(session.end.ro_lost, 0);
  assert.equal(session.pads.length, 4);
});

test("stored-code captures require mode 26H and keep raw code provenance", () => {
  for (const [name, variant] of [
    ["20261104T143804949449Z-usb-bridge.txt", "0E"],
    ["20261104T144256788073Z-usb-bridge.txt", "A4"],
  ]) {
    const { session, cart } = decode(capture(name));
    const verdict = sessionVerdict(session, { variant, cart });
    assert.equal(verdict.valid, true, variant);
    assert.equal(cart.blocks26 > 0, true, variant);
    assert.equal(cart.codes[0].mode, 0x26, variant);
    assert.equal(cart.codes[0].rawBytes.length, 2, variant);
    assert.ok(Number.isFinite(cart.codes[0].rxTimeUs), variant);
  }
});

test("a corrupt DTC code word is counted and makes the stored read incomplete", () => {
  const source = capture("20261104T143804949449Z-usb-bridge.txt");
  const corrupted = source.replace("RX t_us=2566892 byte=B1", "RX t_us=2566892 byte=B0");
  assert.notEqual(corrupted, source, "the fixture byte mutation must match exactly once");
  const { session, cart } = decode(corrupted);
  assert.equal(cart.codeParityRejects, 1);
  const verdict = sessionVerdict(session, { variant: "0E", cart });
  assert.equal(verdict.status, "INCOMPLETE");
  assert.ok(verdict.reasons.some((reason) => reason.includes("failed parity verification")));
});

test("DTC mode mismatch, absent target response, and incomplete self-test fail closed", () => {
  const start = feed("EVENT session=READ_CANDIDATE\nEND reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 pad_verified=0 words_started=0 ecu_verified=0 dtc_verified=0 DE=LOW");
  const storedWithMode25 = sessionVerdict(start, { variant: "0E", cart: {
    blocks25: 1, blocks26: 0, codes: [{ code: "113", mode: 0x25 }], selfTestComplete: true,
  } });
  assert.equal(storedWithMode25.status, "INCOMPLETE");
  assert.ok(storedWithMode25.reasons.some((reason) => reason.includes("mode 26H")));
  assert.ok(storedWithMode25.reasons.some((reason) => reason.includes("unexpected mode 25H")));

  const selfTestWithMode26 = sessionVerdict(start, { variant: "KOEO", cart: {
    blocks25: 0, blocks26: 1, codes: [{ code: "113", mode: 0x26 }], selfTestComplete: true,
  } });
  assert.equal(selfTestWithMode26.status, "INCOMPLETE");
  assert.ok(selfTestWithMode26.reasons.some((reason) => reason.includes("mode 25H")));
  assert.ok(selfTestWithMode26.reasons.some((reason) => reason.includes("unexpected mode 26H")));

  const missingMode = sessionVerdict(start, { variant: "A4", cart: { blocks25: 0, blocks26: 0, codes: [] } });
  assert.equal(missingMode.status, "INCOMPLETE");
  assert.ok(missingMode.reasons.some((reason) => reason.includes("missing mode 26H")));

  const noFlag = sessionVerdict(start, { variant: "KOER", cart: {
    blocks25: 1, blocks26: 0, codes: [], selfTestComplete: false,
  } });
  assert.equal(noFlag.status, "INCOMPLETE");
  assert.ok(noFlag.reasons.some((reason) => reason.includes("self-test complete flag")));
});

test("KOEO capture satisfies mode 25H and Frame 7 completion checks", () => {
  const { session, cart } = decode(capture("20261104T154903976737Z-usb-bridge.txt"));
  const verdict = sessionVerdict(session, { variant: "KOEO", cart });
  assert.equal(verdict.valid, true);
  assert.equal(cart.blocks25, 88);
  assert.equal(cart.selfTestComplete, true);
});

test("a dropped RX byte or a pad mismatch is incomplete", () => {
  const text = capture("20261104T143804949449Z-usb-bridge.txt");
  const lines = sliceSession(text, "READ_CANDIDATE").split("\n");
  const dropped = lines.filter((line, index) => !(line.startsWith("RX ") && index === lines.findIndex((item) => item.startsWith("RX "))));
  const badCount = feed(dropped.join("\n"));
  const countVerdict = sessionVerdict(badCount);
  assert.equal(countVerdict.valid, false);
  assert.ok(countVerdict.reasons.some((reason) => reason.includes("ro_bytes")));

  const flipped = lines.map((line) => line.replace("observed=260E", "observed=FFFF"));
  const badPad = sessionVerdict(feed(flipped.join("\n")));
  assert.equal(badPad.valid, false);
  assert.ok(badPad.reasons.some((reason) => reason.startsWith("TX_PAD")));
});

test("OFF capture reports the quiet time and the following listen is empty", () => {
  const text = capture("20261104T152920262127Z-usb-bridge.txt");
  const offline = feed(sliceSession(text, "OFFLINE_JOIN"));
  const verdict = sessionVerdict(offline);
  assert.equal(verdict.valid, true);
  assert.equal(offline.offlineQuietUs, 7613810);
  assert.equal(offline.rx, 164);
  const lines = linesOf(text);
  const end = lines.findIndex((line) => line.startsWith("END ") && line.includes("ro_bytes=0"));
  let start = end;
  while (start > 0 && !lines[start].startsWith("EVENT session=")) start -= 1;
  const listen = feed(lines.slice(start, end + 1).join("\n"));
  assert.equal(listen.kind, "LISTEN_9600");
  assert.equal(sessionVerdict(listen).valid, true);
  assert.equal(listen.rx, 0);
  assert.equal(listen.end.ro_bytes, 0);
});

test("disconnect and timeout override a clean end", () => {
  const session = createSession();
  noteSessionLine(session, parseLine("EVENT session=READ_CANDIDATE"));
  noteSessionLine(session, parseLine("END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 pad_verified=0 words_started=0 ecu_verified=0 dtc_verified=0 DE=LOW"));
  assert.equal(sessionVerdict(session).valid, true);
  assert.equal(sessionVerdict(session, { disconnect: true }).status, "FAILED");
  assert.equal(sessionVerdict(session, { timeout: true }).status, "INCOMPLETE");
  noteSessionLine(createSession(), parseLine("FAULT reason=8"));
  const faulted = createSession();
  noteSessionLine(faulted, parseLine("EVENT session=READ_CANDIDATE"));
  noteSessionLine(faulted, parseLine("FAULT reason=8"));
  noteSessionLine(faulted, parseLine("END reason=8 ro_bytes=0 ro_lost=0 uart_errors=0 pad_verified=0 words_started=0 ecu_verified=0 dtc_verified=0 DE=LOW"));
  const verdict = sessionVerdict(faulted);
  assert.equal(verdict.valid, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes("FAULT")));
});

test("v21 live RX silence cannot be misreported as a successful capture", () => {
  // The in-car ALL log had matching RX count and zero UART errors/loss,
  // but END reason=7 after the UART1 stream went silent. Older LIVE views
  // missed this because they validated counters but not END reason.
  for (const reason of [7, 19]) {
    const session = feed([
      "EVENT session=READ_CANDIDATE",
      `END reason=${reason} ro_bytes=0 ro_lost=0 uart_errors=0 pad_verified=1 words_started=2 ecu_verified=0 dtc_verified=0 DE=LOW`,
    ].join("\n"));
    const verdict = sessionVerdict(session);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.status, "INCOMPLETE");
    assert.match(verdict.reasons.join("; "), new RegExp(`END reason=${reason}`));
  }
  assert.equal(sessionVerdict(feed([
    "EVENT session=READ_CANDIDATE",
    "END reason=16 ro_bytes=0 ro_lost=0 uart_errors=0 pad_verified=0 words_started=0 ecu_verified=0 dtc_verified=0 DE=LOW",
  ].join("\n"))).valid, true);
});
