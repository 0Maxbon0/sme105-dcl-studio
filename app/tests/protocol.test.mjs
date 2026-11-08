import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EXPECTED_HELLO,
  EXPECTED_PINS,
  EVIDENCE_LEVELS,
  EVIDENCE_LEVEL_NAMES,
  DCL_PROBE_VARIANTS,
  DCL_BLOCKED_CANDIDATES,
  EXPERIMENT_CATALOGUE,
  PROTOCOL_FRAMING_REFERENCE,
  VARIANTS,
  dclVParityByte,
  evidenceLevelName,
  chunkBytes,
  createLineBuffer,
  encodeCommand,
  firmwareCompatibility,
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

test("generic DCL VPARITY calculates command bytes and exposes source-literal mismatches", () => {
  assert.equal(dclVParityByte(0x00, 0x0e), 0x4e);
  assert.equal(dclVParityByte(0x22, 0x03), 0x93);
  assert.equal(dclVParityByte(0x03, 0x01), 0x81);
  assert.equal(dclVParityByte(0x42, 0x03), 0xf3);
});

test("evidence classification defines all five canonical levels and catalogue metadata", () => {
  assert.deepEqual(EVIDENCE_LEVELS, {
    LEVEL_1_NOT_TESTED: 1,
    LEVEL_2_TX_VERIFIED: 2,
    LEVEL_3_STRUCTURAL_RESPONSE: 3,
    LEVEL_4_RESPONSE_CANDIDATE: 4,
    LEVEL_5_MEANING_VERIFIED: 5,
  });
  assert.deepEqual(EVIDENCE_LEVEL_NAMES, {
    1: "1: Not Tested",
    2: "2: TX Verified",
    3: "3: Structural Response Observed",
    4: "4: Response Candidate Captured",
    5: "5: Meaning Verified",
  });
  for (let level = 1; level <= 5; level += 1) assert.equal(evidenceLevelName(level), EVIDENCE_LEVEL_NAMES[level]);
  assert.equal(evidenceLevelName(0), EVIDENCE_LEVEL_NAMES[1]);
  assert.equal(evidenceLevelName(6), EVIDENCE_LEVEL_NAMES[1]);

  const catalogue = Object.values(EXPERIMENT_CATALOGUE);
  assert.equal(catalogue.length, 26);
  assert.equal(new Set(catalogue.map(item => item.id)).size, 26);
  const expectedLevels = {
    ECU_STATUS: 2, STORED_0E: 4, STORED_A4: 4, CLEAR_DTC: 1, KOEO_253E: 4, KOER_253E: 4,
    KOEO_ALT: 1, PIDMAP_TX: 1, PIDMAP: 2, PIDMAP_ALT: 3, PID_VALUES: 1, CLEAR_A1: 1,
    CLEAR_F4: 1, DMRMAP_TX: 1, DMRMAP: 3, DMR_VALUES: 3, PID_DMR_BOTH: 3, CHANGE_BAUD: 1,
    STOP_PID_FLOW: 1, MEMORY_READ: 3, MEM_OFF0: 2, MEM_SINGLE: 3, MEM_PARITY: 4, GO_OFFLINE: 1,
    OUTPUT_SWITCH_TEST: 1, CYLINDER_BALANCE_TEST: 1,
  };
  assert.deepEqual(Object.fromEntries(catalogue.map(item => [item.id, item.evidenceNumericLevel])), expectedLevels);
  const clearDtc = catalogue.find(item => item.id === "CLEAR_DTC");
  assert.equal(clearDtc.evidenceLevel, evidenceLevelName(EVIDENCE_LEVELS.LEVEL_1_NOT_TESTED));
  assert.match(clearDtc.description, /November 8.*HSK_ACK.*words_started=0.*physical bus transmission remains unverified on the vehicle/i);
  for (const item of catalogue) {
    assert.ok(Number.isInteger(item.evidenceNumericLevel) && item.evidenceNumericLevel >= 1 && item.evidenceNumericLevel <= 5, item.id);
    assert.equal(item.evidenceLevel, evidenceLevelName(item.evidenceNumericLevel), item.id);
  }
  assert.deepEqual([...new Set(catalogue.map(item => item.evidenceNumericLevel))].sort(), [1, 2, 3, 4]);
});


test("DCL catalogue variants expose fixed command words and their sendability", () => {
  assert.match(DCL_PROBE_VARIANTS.PIDMAP.parityNote, /published 005E.*generic VPARITY.*004E/i);
  assert.deepEqual(Object.fromEntries(Object.entries(DCL_PROBE_VARIANTS).map(([key, value]) => [key, value.word])), {
    ECU_STATUS: "0381", PIDMAP: "005E", PIDMAP_ALT: "004E", DMRMAP: "242E", DMR: "22C6", BOTH: "271E",
    KOEO_ALT: "2594", CLEAR_A1: "01A1", CLEAR_F4: "01F4", DMRMAP_TX: "42A6",
    CHANGE_BAUD: "8174", STOP_PID_FLOW: "411E", MEM: "42F3 / 22D3",
    MEM_OFF0: "42F3 / 22D3", MEM_SINGLE: "42F3", MEM_PARITY: "42F3 / 2293", PID_VALUES: "21F6",
  });
  for (const key of Object.keys(DCL_PROBE_VARIANTS)) {
    assert.equal(VARIANTS[key].kind, key.startsWith("MEM") ? "memory" : "probe", key);
    assert.ok(VARIANTS[key].timeoutMs > 0, key);
    if (DCL_PROBE_VARIANTS[key].sourceUrl) assert.match(DCL_PROBE_VARIANTS[key].sourceUrl, /^https:\/\/github\.com\//, key);
    assert.match(DCL_PROBE_VARIANTS[key].evidence, /not validated on 97AB-12A650-KA/, key);
    assert.ok(Number.isInteger(DCL_PROBE_VARIANTS[key].evidenceNumericLevel), key);
    assert.equal(DCL_PROBE_VARIANTS[key].evidenceLevel, evidenceLevelName(DCL_PROBE_VARIANTS[key].evidenceNumericLevel), key);
    assert.equal(typeof DCL_PROBE_VARIANTS[key].sendable, "boolean", key);
  }
  for (const word of ["01B0", "FF5F", "00A0"]) {
    assert.ok(DCL_BLOCKED_CANDIDATES.some(item => item.word === word), word);
  }
  assert.equal(DCL_BLOCKED_CANDIDATES.some(item => item.word === "procedure"), false);
  assert.equal(DCL_BLOCKED_CANDIDATES.some(item => item.word === "22C6" || item.word === "271E" || item.word === "42F3 / 22D3"), false);
  assert.equal(DCL_BLOCKED_CANDIDATES.some(item => item.word === "81FF"), false);
});

test("protocol framing reference separates envelope control words from executable catalogue", () => {
  assert.equal(Object.keys(EXPERIMENT_CATALOGUE).length, 26);
  assert.equal(Object.values(EXPERIMENT_CATALOGUE).every(entry => entry.sendable), true);
  assert.equal(PROTOCOL_FRAMING_REFERENCE.length, 3);
  assert.deepEqual(PROTOCOL_FRAMING_REFERENCE.map(entry => entry.word), ["01B0", "FF5F", "00A0"]);
  assert.deepEqual(PROTOCOL_FRAMING_REFERENCE.map(entry => entry.role), ["ENVELOPE_START", "IDLE_SYNC", "ENVELOPE_END"]);
  for (const entry of PROTOCOL_FRAMING_REFERENCE) {
    assert.equal(entry.sendable, false, entry.word);
    assert.equal(entry.classification, "CONTROL", entry.word);
    assert.ok(entry.blockedReason, entry.word);
    assert.equal(Object.values(EXPERIMENT_CATALOGUE).some(item => item.id === entry.id), false, entry.id);
    assert.equal(Object.values(EXPERIMENT_CATALOGUE).some(item => item.commandWord === entry.word), false, entry.word);
  }
  assert.deepEqual(DCL_BLOCKED_CANDIDATES.map(item => item.word), ["01B0", "FF5F", "00A0"]);
});

test("firmware compatibility rejects unverified or malformed versions for physical operations", () => {
  const byId = id => Object.values(EXPERIMENT_CATALOGUE).find(entry => entry.id === id);
  const require21 = byId("STORED_0E");
  const require24 = byId("ECU_STATUS");
  const require27 = byId("MEMORY_READ");
  assert.equal(require21.requiredFirmwareVersion, 21);
  assert.equal(require24.requiredFirmwareVersion, 24);
  assert.equal(require27.requiredFirmwareVersion, 27);

  const matrix = [
    [21, true, false, false],
    [24, true, true, false],
    [26, true, true, false],
    [27, true, true, true],
  ];
  for (const [version, ok21, ok24, ok27] of matrix) {
    for (const [candidate, expected] of [[require21, ok21], [require24, ok24], [require27, ok27]]) {
      const result = firmwareCompatibility(candidate, String(version));
      assert.equal(result.required, candidate.requiredFirmwareVersion, `${candidate.id} v${version}`);
      assert.equal(result.connected, version, `${candidate.id} v${version}`);
      assert.equal(result.supported, expected, `${candidate.id} v${version}`);
      assert.equal(result.message, expected ? "" : `Requires Firmware v${candidate.requiredFirmwareVersion}+ (Connected bridge: v${version}). Please flash firmware v${candidate.requiredFirmwareVersion} to execute.`);
    }
  }

  const unverified = [
    null,
    undefined,
    {},
    { fields: {} },
    { raw: "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1" },
    "",
    "   ",
    "fw=unknown",
    "fw=abc",
    { fields: { fw: "not-a-number" } },
  ];
  for (const status of unverified) {
    const result = firmwareCompatibility(require27, status);
    assert.equal(result.connected, null, String(status));
    assert.equal(result.supported, false, String(status));
    assert.equal(result.message, "Bridge firmware version unverified. Connect an authenticated bridge in safe IDLE to verify compatibility.", String(status));
  }
});

test("firmware compatibility parses numeric and status-form versions", () => {
  const candidate = EXPERIMENT_CATALOGUE.MEM_READ;
  assert.equal(firmwareCompatibility(candidate, 27).connected, 27);
  assert.equal(firmwareCompatibility(candidate, { fields: { fw: "27" } }).connected, 27);
  assert.equal(firmwareCompatibility(candidate, { raw: "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW fw=27" }).connected, 27);
});

test("MEM_OFF0 requires firmware v28 after the frame 0 transition fix", () => {
  const candidate = EXPERIMENT_CATALOGUE.MEM_OFF0;
  assert.equal(candidate.requiredFirmwareVersion, 28);
  const v27 = firmwareCompatibility(candidate, 27);
  assert.equal(v27.required, 28);
  assert.equal(v27.connected, 27);
  assert.equal(v27.supported, false);
  assert.match(v27.message, /Requires Firmware v28\+ \(Connected bridge: v27\)/);
  const v28 = firmwareCompatibility(candidate, 28);
  assert.equal(v28.required, 28);
  assert.equal(v28.connected, 28);
  assert.equal(v28.supported, true);
  assert.equal(v28.message, "");
});

test("authoritative experiment catalogue covers all A-Q entries, parity states and blocking reasons", () => {
  const letters = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "Q"];
  for (const letter of letters) {
    const entry = Object.values(EXPERIMENT_CATALOGUE).find(e => e.letter === letter);
    assert.ok(entry, `Entry for letter ${letter} must exist in catalogue`);
    assert.ok(entry.name, `Entry ${letter} must have display name`);
    assert.ok(entry.commandWord, `Entry ${letter} must have commandWord`);
    assert.ok(entry.description, `Entry ${letter} must have description`);
    assert.ok(entry.source, `Entry ${letter} must have source provenance`);
    assert.ok(["GENERIC_MATCH", "UNRESOLVED_MISMATCH", "NOT_APPLICABLE"].includes(entry.parityStatus), `Entry ${letter} parityStatus`);
    assert.ok(["READ_ONLY", "STATE_CHANGING", "SELF_TEST", "CONFIG_CHANGE", "SEQUENCE_DEPENDENT", "FACTORY_PROCEDURE", "CONTROL"].includes(entry.classification), `Entry ${letter} classification`);
    assert.ok(["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(entry.risk), `Entry ${letter} risk`);
    assert.equal(typeof entry.sendable, "boolean", `Entry ${letter} sendable`);
  }
  // The former letter R idle-sync word is framing reference data, not a command.
  assert.equal(PROTOCOL_FRAMING_REFERENCE.find(entry => entry.word === "FF5F")?.name, "Idle synchronization control word");

  // Mandatory 005E literal vs 004E parity mismatch separation:
  const fLiteral = EXPERIMENT_CATALOGUE.F_READ_PIDMAP;
  assert.equal(fLiteral.commandWord, "005E");
  assert.equal(fLiteral.parityStatus, "UNRESOLVED_MISMATCH");

  const fParity = EXPERIMENT_CATALOGUE.F_PIDMAP_PARITY_HYPOTHESIS;
  assert.equal(fParity.commandWord, "004E");
  assert.equal(fParity.sendable, true);
  assert.equal(fParity.variantKey, "PIDMAP_ALT");
  assert.equal(fParity.armCommand, "ARM_PIDMAP_ALT");
  assert.equal(fParity.readCommand, "READ_PIDMAP_ALT");

  // DMR K and L have fixed raw-capture profiles; semantics remain unverified:
  const kEntry = EXPERIMENT_CATALOGUE.K_READ_DMR_VALUES;
  assert.equal(kEntry.commandWord, "22C6");
  assert.equal(kEntry.sendable, true);
  assert.equal(kEntry.variantKey, "DMR");

  const lEntry = EXPERIMENT_CATALOGUE.L_READ_COMBINED;
  assert.equal(lEntry.commandWord, "271E");
  assert.equal(lEntry.sendable, true);

  // MEM sequence remains experimental while the named bridge profile is available:
  const memEntry = EXPERIMENT_CATALOGUE.MEM_READ;
  assert.equal(memEntry.commandWord, "42F3 / 22D3");
  assert.equal(memEntry.sendable, true);
  assert.equal(memEntry.evidenceNumericLevel, 3);
  assert.equal(memEntry.evidenceLevel, "3: Structural Response Observed");
  assert.equal(memEntry.variantKey, "MEM");
  assert.equal(memEntry.armCommand, "ARM_MEM");
  assert.equal(memEntry.readCommand, "READ_MEM");

  // All catalogue variants expose the firmware's exact fixed arm/read names.
  for (const variant of Object.values(DCL_PROBE_VARIANTS)) {
    assert.equal(variant.sendable, true, variant.word);
    assert.equal(variant.blockedReason, null, variant.word);
  }
});
