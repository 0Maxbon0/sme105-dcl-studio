import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
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

function sliceSession(text, kind) {
  const lines = linesOf(text);
  const start = lines.findIndex((line) => line.startsWith("EVENT session=") && (!kind || line.includes(`session=${kind}`)));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("END "));
  return lines.slice(start, end + 1).join("\n");
}

test("READ_0E capture meets the validity rules", () => {
  const text = capture("20261104T143804949449Z-usb-bridge.txt");
  const session = feed(sliceSession(text, "READ_CANDIDATE"));
  const verdict = sessionVerdict(session);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.status, "VALID");
  assert.equal(session.rx, 3810);
  assert.equal(session.end.ro_lost, 0);
  assert.equal(session.pads.length, 4);
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
