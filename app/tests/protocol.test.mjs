import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_HELLO,
  EXPECTED_PINS,
  chunkBytes,
  createLineBuffer,
  encodeCommand,
  parseLine,
  reasonText,
  statusSafe,
} from "../js/protocol.js";

test("line buffer reassembles fragments and CR LF", () => {
  const buffer = createLineBuffer();
  assert.deepEqual(buffer.push("HEL"), []);
  assert.deepEqual(buffer.push("LO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1\r\nPIN"), [
    EXPECTED_HELLO,
  ]);
  assert.deepEqual(buffer.push("S ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1\n"), [
    EXPECTED_PINS,
  ]);
  assert.equal(buffer.remainder(), "");
});

test("writes are newline-terminated and chunked at 180 bytes", () => {
  const bytes = encodeCommand("HELLO");
  assert.equal(bytes.at(-1), 0x0a);
  const chunks = chunkBytes(bytes, 180);
  assert.equal(chunks.length, 1);
  const long = encodeCommand(`X${"A".repeat(400)}`);
  const parts = chunkBytes(long, 180);
  assert.ok(parts.length >= 3);
  assert.ok(parts.every((part) => part.length <= 180));
  const joined = new Uint8Array(long.length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  assert.deepEqual(joined, long);
});

test("status safety and reason 16 text", () => {
  const ok = parseLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=0 DE=LOW auto_tx=0 gate4=1 fw=17 tx2_bench_pass=1 fault=0");
  assert.equal(ok.type, "status");
  assert.equal(ok.fields.fw, "17");
  assert.equal(statusSafe(ok), true);
  const bad = parseLine("STATUS SME105_USB_BRIDGE_V1 read_used=0 stage=6 DE=HIGH auto_tx=1 gate4=0 fault=8");
  assert.equal(statusSafe(bad), false);
  assert.match(reasonText(16), /CAPTURE_TIMEOUT/);
  assert.equal(parseLine(EXPECTED_HELLO).ok, true);
  assert.equal(parseLine(`${EXPECTED_HELLO} extra=1`).ok, false);
});

test("RX, pad, end and denial lines", () => {
  const rx = parseLine("RX t_us=2210867 byte=00");
  assert.equal(rx.type, "rx");
  assert.equal(rx.t_us, 2210867);
  assert.equal(rx.byte, 0);
  const pad = parseLine("TX_PAD slot=2 expected=260E observed=260E tx_us=1 done_us=2 match=1");
  assert.equal(pad.match, 1);
  assert.equal(pad.expected, "260E");
  const end = parseLine("END reason=16 ro_bytes=3810 ro_lost=0 uart_errors=0 pad_verified=4 words_started=4 ecu_verified=0 dtc_verified=0 DE=LOW");
  assert.equal(end.ro_bytes, 3810);
  assert.equal(end.reasonName, "CAPTURE_TIMEOUT");
  assert.equal(parseLine("DENIED remote_busy").type, "denied");
  assert.equal(parseLine("AUTH OK transport=BLE").ok, true);
});

test("malformed RX cannot enter the decoder as a valid byte", () => {
  for (const line of ["RX t_us=-1 byte=AA", "RX t_us=1.5 byte=AA", "RX t_us=4294967296 byte=AA", "RX t_us=1 byte=100", "RX t_us=1 byte=1G", "RX t_us=1 byte=aa"]) {
    const result = parseLine(line);
    assert.equal(result.type, "fault", line);
    assert.equal(result.raw, line);
  }
  assert.equal(parseLine("RX t_us=4294967295 byte=FF").byte, 255);
});
