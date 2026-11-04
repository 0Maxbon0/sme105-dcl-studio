import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createCartDecoder, formatCode, parityOk, wordData } from "../js/cart.js";
import { parseLine } from "../js/protocol.js";
import { LIVE_PIDS, summarizeSeries } from "../js/pids.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function load(name) {
  return readFileSync(path.join(repo, "captures/SME105_97AB", name), "utf8");
}

function decodeSession(text, pidSet = null) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith("EVENT session="));
  const end = lines.findIndex((line, index) => index > start && line.startsWith("END "));
  const decoder = createCartDecoder(pidSet);
  for (const line of lines.slice(start, end)) {
    const parsed = parseLine(line);
    if (parsed.type === "rx") decoder.pushRx(parsed.t_us, parsed.byte);
  }
  return decoder.finish();
}

function codesOf(name) {
  return decodeSession(load(name)).codes.map((entry) => entry.code);
}

test("parity and 12-bit code packing", () => {
  assert.equal(parityOk(0x22, 0xb1), true);
  assert.equal(formatCode(wordData(0x22, 0xb1)), "122");
  assert.equal(parityOk(0x00, 0x00), false);
  assert.equal(parityOk(0x00, 0xa0), true);
  assert.equal(formatCode(wordData(0x00, 0xa0)), "000");
});

test("stored-code captures", () => {
  assert.deepEqual(codesOf("20261104T143804949449Z-usb-bridge.txt"), ["122", "113", "214", "157", "452"]);
  assert.deepEqual(codesOf("20261104T144256788073Z-usb-bridge.txt"), ["122", "113", "214", "157", "452"]);
  const rom = decodeSession(load("20261104T143804949449Z-usb-bridge.txt")).rom;
  assert.equal(rom.low, 0xad);
  assert.equal(rom.high, 0x38);
});

test("KOEO capture is mode 0x25 code 113 and the self-test flag sets", () => {
  const decoded = decodeSession(load("20261104T154903976737Z-usb-bridge.txt"));
  assert.deepEqual(decoded.codes.map((entry) => entry.code), ["113"]);
  assert.equal(decoded.codes[0].mode, 0x25);
  assert.equal(decoded.frame7First, 0xac);
  assert.equal(decoded.frame7Last, 0xec);
  assert.equal(decoded.selfTestComplete, true);
  assert.equal(decoded.blocks25, 88);
  assert.equal(decoded.rom.low, 0xad);
  assert.equal(decoded.rom.high, 0x38);
});

function expectSeries(decoded, expected) {
  assert.equal(decoded.rows.length, expected.rows);
  assert.equal(decoded.parityRejects, 0);
  for (const [name, want] of Object.entries(expected.pids)) {
    const summary = summarizeSeries(decoded.pids[name].samples);
    assert.equal(summary.n, want.n, name);
    assert.ok(Math.abs(summary.first - want.first) < 1e-9, `${name} first ${summary.first}`);
    assert.ok(Math.abs(summary.min - want.min) < 1e-9, `${name} min ${summary.min}`);
    assert.ok(Math.abs(summary.max - want.max) < 1e-9, `${name} max ${summary.max}`);
    assert.ok(Math.abs(summary.last - want.last) < 1e-9, `${name} last ${summary.last}`);
    assert.equal(summary.rawLast, want.raw);
  }
  assert.ok(LIVE_PIDS.includes(0x01));
}

test("LIVE engine-off capture matches decode_live_pids.py", () => {
  const decoded = decodeSession(load("20261104T160936508451Z-usb-bridge.txt"), LIVE_PIDS);
  expectSeries(decoded, {
    rows: 3717,
    pids: {
      N: { n: 247, first: 0, min: 0, max: 0, last: 0, raw: 0 },
      ACT: { n: 247, first: 34.4, min: 34.4, max: 34.4, last: 34.4, raw: 47 },
      ECT: { n: 247, first: 34.4, min: 34.4, max: 34.4, last: 34.4, raw: 47 },
      IACT: { n: 248, first: 948, min: 947, max: 949, last: 948, raw: 948 },
      IECT: { n: 248, first: 502, min: 501, max: 502, last: 502, raw: 502 },
      ITP: { n: 248, first: 159, min: 159, max: 873, last: 163, raw: 163 },
      VBAT: { n: 248, first: 11.6875, min: 11.6875, max: 11.6875, last: 11.6875, raw: 187 },
      BP: { n: 248, first: 29.875, min: 29.875, max: 29.875, last: 29.875, raw: 239 },
      SAFTOT: { n: 248, first: 10, min: 10, max: 10, last: 10, raw: 40 },
      FUELPW1: { n: 248, first: 0, min: 0, max: 0, last: 0, raw: 0 },
      LAMBSE1: { n: 248, first: 1, min: 1, max: 1, last: 1, raw: 2048 },
      IEGO1: { n: 248, first: 1020, min: 1015, max: 1020, last: 1015, raw: 1015 },
      VS: { n: 248, first: 0, min: 0, max: 0, last: 0, raw: 0 },
      LOAD: { n: 248, first: 0, min: 0, max: 76.23, last: 0, raw: 0 },
      KAMRF1: { n: 248, first: 1, min: 1, max: 1, last: 1, raw: 16 },
    },
  });
});

test("LIVE engine-running capture matches decode_live_pids.py", () => {
  const decoded = decodeSession(load("20261104T161814961794Z-usb-bridge.txt"), LIVE_PIDS);
  expectSeries(decoded, {
    rows: 3717,
    pids: {
      N: { n: 247, first: 1084, min: 968, max: 2640, last: 992, raw: 248 },
      ACT: { n: 247, first: 35.6, min: 35.6, max: 42.2, last: 37.8, raw: 50 },
      ECT: { n: 247, first: 35.6, min: 35.6, max: 44.4, last: 44.4, raw: 56 },
      IACT: { n: 248, first: 948, min: 947, max: 949, last: 948, raw: 948 },
      IECT: { n: 248, first: 494, min: 405, max: 494, last: 405, raw: 405 },
      ITP: { n: 248, first: 18, min: 11, max: 156, last: 94, raw: 94 },
      VBAT: { n: 248, first: 12.9375, min: 12.5625, max: 13.125, last: 12.9375, raw: 207 },
      BP: { n: 248, first: 29.875, min: 29.875, max: 29.875, last: 29.875, raw: 239 },
      SAFTOT: { n: 248, first: 9.5, min: 8.5, max: 31.5, last: 21.5, raw: 86 },
      FUELPW1: { n: 248, first: 1984, min: 960, max: 2848, last: 1664, raw: 52 },
      LAMBSE1: { n: 248, first: 0.921875, min: 0.921875, max: 0.96875, last: 0.96875, raw: 1984 },
      IEGO1: { n: 248, first: 1022, min: 955, max: 1023, last: 990, raw: 990 },
      VS: { n: 248, first: 0, min: 0, max: 0, last: 0, raw: 0 },
      LOAD: { n: 248, first: 22.64, min: 11.61, max: 32.31, last: 19.32, raw: 396 },
      KAMRF1: { n: 248, first: 1, min: 1, max: 1, last: 1, raw: 16 },
    },
  });
});
