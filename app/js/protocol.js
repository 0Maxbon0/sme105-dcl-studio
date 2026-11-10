/** ASCII line protocol for the SME105 bridge. No DOM, no Bluetooth. */

export const VERSION = "1.8.17";
export const APP_VERSION = VERSION;

export const NUS_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e";
export const DEVICE_NAME_PREFIX = "SME105";
export const MAX_WRITE_BYTES = 180;

export const EVIDENCE_LEVELS = Object.freeze({
  LEVEL_1_NOT_TESTED: 1,
  LEVEL_2_TX_VERIFIED: 2,
  LEVEL_3_STRUCTURAL_RESPONSE: 3,
  LEVEL_4_RESPONSE_CANDIDATE: 4,
  LEVEL_5_MEANING_VERIFIED: 5,
});

export const EVIDENCE_LEVEL_NAMES = Object.freeze({
  1: "1: Not Tested",
  2: "2: TX Verified",
  3: "3: Structural Response Observed",
  4: "4: Response Candidate Captured",
  5: "5: Meaning Verified",
});

export function evidenceLevelName(level) {
  return EVIDENCE_LEVEL_NAMES[level] || "1: Not Tested";
}

/** Generic Ford DCL VPARITY byte calculation for a data byte and low-nibble ID. */
export function dclVParityByte(firstByte, id) {
  const data = Number(firstByte) & 0xff;
  const nibble = Number(id) & 0x0f;
  return (((((data >> 4) ^ (data & 0x0f) ^ nibble ^ 0x0a) & 0x0f) << 4) | nibble) & 0xff;
}

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
  DCL_PROBE: 20000,
};

const EXPERIMENT_CATALOGUE_SOURCE = {
  A_ECU_STATUS: Object.freeze({
    id: "ECU_STATUS", letter: "A", name: "ECU status", commandWord: "0381",
    envelope: ["01B0", "FF5F", "0381", "00A0"],
    description: "Nov 8 captures 18 and 23: 0381 was pad-verified and returned F04=0390 while cadence remained 10.0 ms. Since ID 1 already maps to 10 ms, structural acceptance is not established.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 2, evidenceLevel: evidenceLevelName(2),
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 10000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_ECU_STATUS", readCommand: "READ_ECU_STATUS", variantKey: "ECU_STATUS",
    sendable: true, blockedReason: null,
  }),
  B_STORED_0E: Object.freeze({
    id: "STORED_0E", letter: "B", name: "Read stored DTCs (0E)", commandWord: "260E",
    envelope: ["01B0", "FF5F", "260E", "00A0"],
    description: "Stored continuous DTC read (0E). Nov 8 captures 19 and 21: 42.5 ms cadence, with 72E1 in F00 and 26E0 in F04; these remain response candidates, not decoded DTC meanings.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 4, evidenceLevel: evidenceLevelName(4),
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 20000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_0E", readCommand: "READ_0E", variantKey: "0E",
    sendable: true, blockedReason: null,
  }),
  B_STORED_A4: Object.freeze({
    id: "STORED_A4", letter: "B", name: "Read stored DTCs (A4)", commandWord: "26A4",
    envelope: ["01B0", "FF5F", "26A4", "00A0"],
    description: "Stored continuous DTC read (A4). Nov 8 captures 20 and 22: 17.5 ms cadence, with matching first-cycle response candidates 72E1 in F00 and 26E0 in F04. Retained separately from 260E because the timing differs.",
    source: "flxkrmr/eec-iv-reader-arduino", sourceUrl: "https://github.com/flxkrmr/eec-iv-reader-arduino",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 4, evidenceLevel: evidenceLevelName(4),
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 20000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_A4", readCommand: "READ_A4", variantKey: "A4",
    sendable: true, blockedReason: null,
  }),
  C_CLEAR_DTC: Object.freeze({
    id: "CLEAR_DTC", letter: "C", name: "Clear DTCs", commandWord: "0291",
    envelope: ["01B0", "FF5F", "0291", "00A0"],
    description: "November 8 field attempts aborted at HSK_ACK with words_started=0, so physical bus transmission remains unverified on the vehicle. The command is destructive and intended to clear continuous-memory DTCs.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: EVIDENCE_LEVELS.LEVEL_1_NOT_TESTED, evidenceLevel: evidenceLevelName(1),
    classification: "STATE_CHANGING", risk: "MEDIUM", timeoutMs: 12000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_CLR", readCommand: "READ_CLR", variantKey: "CLR",
    sendable: true, blockedReason: null,
  }),
  D_KOEO_253E: Object.freeze({
    id: "KOEO_253E", letter: "D", name: "KOEO on-demand self-test", commandWord: "253E",
    envelope: ["01B0", "FF5F", "253E", "00A0"],
    description: "Nov 8 capture 33: 253E sustained 42.5 ms cadence for 1,408 frames. 11B1 appeared in F00 at about 9 s and F07 changed from ACC0 to EC80. Ford code 11 is a hypothesis, not independently verified for SME-105.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 4, evidenceLevel: evidenceLevelName(4),
    classification: "SELF_TEST", risk: "MEDIUM", timeoutMs: 60000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: true, requiresMapOrQualifier: false,
    armCommand: "ARM_KOEO", readCommand: "READ_KOEO", variantKey: "KOEO",
    sendable: true, blockedReason: null,
  }),
  D_KOER_253E: Object.freeze({
    id: "KOER_253E", letter: "D", name: "KOER running self-test", commandWord: "253E",
    envelope: ["01B0", "FF5F", "253E", "00A0"],
    description: "Nov 8 capture 34: 253E sustained 42.5 ms cadence for 5,648 frames. At about 58.6 s, 16C1, 72E1, 3845, and 21C5 appeared in F00–F03 and persisted for 267 cycles with EC80 in F07. Codes are candidate hypotheses, not confirmed DTCs.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 4, evidenceLevel: evidenceLevelName(4),
    classification: "SELF_TEST", risk: "HIGH", timeoutMs: 240000,
    requiredEcuState: "KEY_ON_ENGINE_RUNNING", repeats: true, requiresMapOrQualifier: false,
    armCommand: "ARM_KOER", readCommand: "READ_KOER", variantKey: "KOER",
    sendable: true, blockedReason: null,
  }),
  D_KOEO_2594: Object.freeze({
    id: "KOEO_ALT", letter: "D", name: "Alternate KOEO request", commandWord: "2594",
    envelope: ["01B0", "FF5F", "2594", "00A0"],
    description: "Alternate KOEO request from flxkrmr with 4-slot receive window.",
    source: "flxkrmr/eec-iv-reader-arduino", sourceUrl: "https://github.com/flxkrmr/eec-iv-reader-arduino",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "SELF_TEST", risk: "MEDIUM", timeoutMs: 60000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: true, requiresMapOrQualifier: false,
    armCommand: "ARM_KOEO_ALT", readCommand: "READ_KOEO_ALT", variantKey: "KOEO_ALT",
    sendable: true, blockedReason: null,
  }),
  E_LOAD_PIDMAP: Object.freeze({
    id: "PIDMAP_TX", letter: "E", name: "Transmit/load PID map", commandWord: "4196",
    envelope: ["01B0", "FF5F", "4196", "00A0"],
    description: "Initial request block intended to load the diagnostic PID map sequence before reading live values. No November 8 vehicle verification is recorded.",
    source: "doncreat0r/eeciv + flxkrmr", sourceUrl: "https://github.com/doncreat0r/eeciv",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "STATE_CHANGING", risk: "LOW", timeoutMs: 10000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: true,
    armCommand: "ARM_LIVE", readCommand: "READ_LIVE", variantKey: "LIVE",
    sendable: true, blockedReason: null,
  }),
  F_READ_PIDMAP: Object.freeze({
    id: "PIDMAP", letter: "F", name: "Read PID map (005E literal)", commandWord: "005E",
    envelope: ["01B0", "FF5F", "005E", "00A0"],
    description: "The published tables.h literal 005E has a parity mismatch: generic VPARITY for (0x00, ID E) yields 004E. In Nov 8 capture 24, 005E was transmitted and pad-witness verified, but the ECU stayed at 10.0 ms with no structural response. Retained for historical verification.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "UNRESOLVED_MISMATCH", evidenceNumericLevel: 2, evidenceLevel: evidenceLevelName(2),
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_PIDMAP", readCommand: "READ_PIDMAP", variantKey: "PIDMAP",
    sendable: true, blockedReason: null,
  }),
  F_PIDMAP_PARITY_HYPOTHESIS: Object.freeze({
    id: "PIDMAP_ALT", letter: "F", name: "PID map generic parity alternative", commandWord: "004E",
    envelope: ["01B0", "FF5F", "004E", "00A0"],
    description: "Parity-derived alternative to 005E. Nov 8 capture 25 observed a structural response at about 42.5 ms for 16 frames, but no decoded PID map was returned.",
    source: "local parity derivation", sourceUrl: null,
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 3, evidenceLevel: evidenceLevelName(3),
    classification: "READ_ONLY", risk: "MEDIUM", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_PIDMAP_ALT", readCommand: "READ_PIDMAP_ALT", variantKey: "PIDMAP_ALT",
    sendable: true, blockedReason: null,
  }),
  G_READ_PID_VALUES: Object.freeze({
    id: "PID_VALUES", letter: "G", name: "Read PID values", commandWord: "21F6",
    envelope: ["01B0", "FF5F", "21F6", "00A0"],
    description: "Streams PID telemetry values after map configuration and is used in LIVE profiles. No November 8 vehicle verification is recorded.",
    source: "doncreat0r/eeciv + flxkrmr", sourceUrl: "https://github.com/doncreat0r/eeciv",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 180 * 60 * 1000,
    requiredEcuState: "ANY_POWERED", repeats: true, requiresMapOrQualifier: true,
    armCommand: "ARM_PID_VALUES", readCommand: "READ_PID_VALUES", variantKey: "PID_VALUES",
    sendable: true, blockedReason: null,
  }),
  H_CLEAR_FLAGS: Object.freeze({
    id: "CLEAR_A1", letter: "H", name: "Clear DCL flags (01A1)", commandWord: "01A1",
    envelope: ["01B0", "FF5F", "01A1", "00A0"],
    description: "Clears internal DCL error/status flags register in ECU.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "STATE_CHANGING", risk: "MEDIUM", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_CLEAR_A1", readCommand: "READ_CLEAR_A1", variantKey: "CLEAR_A1",
    sendable: true, blockedReason: null,
  }),
  H_CLEAR_FLAGS_ALT: Object.freeze({
    id: "CLEAR_F4", letter: "H", name: "Clear DCL errors (01F4)", commandWord: "01F4",
    envelope: ["01B0", "FF5F", "01F4", "00A0"],
    description: "Alternative DCL error clear command from flxkrmr reference.",
    source: "flxkrmr/eec-iv-reader-arduino", sourceUrl: "https://github.com/flxkrmr/eec-iv-reader-arduino",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "STATE_CHANGING", risk: "MEDIUM", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_CLEAR_F4", readCommand: "READ_CLEAR_F4", variantKey: "CLEAR_F4",
    sendable: true, blockedReason: null,
  }),
  I_LOAD_DMRMAP: Object.freeze({
    id: "DMRMAP_TX", letter: "I", name: "Transmit/load DMR map", commandWord: "42A6",
    envelope: ["01B0", "FF5F", "42A6", "00A0"],
    description: "Loads memory address map into ECU for Direct Memory Read.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "CONFIG_CHANGE", risk: "HIGH", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: true,
    armCommand: "ARM_DMRMAP_TX", readCommand: "READ_DMRMAP_TX", variantKey: "DMRMAP_TX",
    sendable: true, blockedReason: null,
  }),
  J_READ_DMRMAP: Object.freeze({
    id: "DMRMAP", letter: "J", name: "Read DMR map", commandWord: "242E",
    envelope: ["01B0", "FF5F", "242E", "00A0"],
    description: "Nov 8 capture 26: observed 42.5 ms cadence for one 16-frame cycle, including structured raw response words. No DMR address map was decoded.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 3, evidenceLevel: evidenceLevelName(3),
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_DMRMAP", readCommand: "READ_DMRMAP", variantKey: "DMRMAP",
    sendable: true, blockedReason: null,
  }),
  K_READ_DMR_VALUES: Object.freeze({
    id: "DMR_VALUES", letter: "K", name: "Read DMR values", commandWord: "22C6",
    envelope: ["01B0", "FF5F", "22C6", "00A0"],
    description: "Nov 8 capture 27: observed 22.5 ms cadence for one 16-frame cycle and a structured raw response. No valid loaded DMR map or addressed values were established.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 3, evidenceLevel: evidenceLevelName(3),
    classification: "READ_ONLY", risk: "MEDIUM", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: true,
    armCommand: "ARM_DMR", readCommand: "READ_DMR", variantKey: "DMR",
    sendable: true, blockedReason: null,
  }),
  L_READ_COMBINED: Object.freeze({
    id: "PID_DMR_BOTH", letter: "L", name: "Read combined PID + DMR values", commandWord: "271E",
    envelope: ["01B0", "FF5F", "271E", "00A0"],
    description: "Nov 8 capture 28: observed 42.5 ms cadence for one 16-frame cycle and a structured raw response. No decoded PID or DMR values were established.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 3, evidenceLevel: evidenceLevelName(3),
    classification: "READ_ONLY", risk: "MEDIUM", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: true,
    armCommand: "ARM_BOTH", readCommand: "READ_BOTH", variantKey: "BOTH",
    sendable: true, blockedReason: null,
  }),
  M_CHANGE_BAUD: Object.freeze({
    id: "CHANGE_BAUD", letter: "M", name: "Change DCL baud", commandWord: "8174",
    envelope: ["01B0", "FF5F", "8174", "00A0"],
    description: "Switches communication speed. Upstream SetBaudrate() is commented out; no recovery sequence.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "CONFIG_CHANGE", risk: "CRITICAL", timeoutMs: 5000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_CHANGE_BAUD", readCommand: "READ_CHANGE_BAUD", variantKey: "CHANGE_BAUD",
    sendable: true, blockedReason: null,
  }),
  Q_STOP_PID_FLOW: Object.freeze({
    id: "STOP_PID_FLOW", letter: "Q", name: "Stop PID value flow", commandWord: "411E",
    envelope: ["01B0", "FF5F", "411E", "00A0"],
    description: "Zero/stop active live PID streaming block flow.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "SEQUENCE_DEPENDENT", risk: "LOW", timeoutMs: 5000,
    requiredEcuState: "ACTIVE_PID_FLOW", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_STOP_PID_FLOW", readCommand: "READ_STOP_PID_FLOW", variantKey: "STOP_PID_FLOW",
    sendable: true, blockedReason: null,
  }),
  MEM_READ: Object.freeze({
    id: "MEMORY_READ", letter: null, name: "Experimental reverse-engineering memory read candidate (42F3 / 22D3)", commandWord: "42F3 / 22D3",
    envelope: ["01B0", "FF5F", "42F3", "00A0"],
    description: "Nov 8 capture 29: 42F3 / 22D3 changed cadence to 15.0 ms for one 16-frame cycle, then dropped. 22D3 carries parity byte D3, while generic VPARITY expects 93; continued transmission did not sustain the response.",
    source: "local reverse-engineering candidate", sourceUrl: null,
    parityStatus: "UNRESOLVED_MISMATCH", evidenceNumericLevel: 3, evidenceLevel: evidenceLevelName(3),
    classification: "READ_ONLY", risk: "HIGH", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: true, requiresMapOrQualifier: true,
    armCommand: "ARM_MEM", readCommand: "READ_MEM", variantKey: "MEM",
    sendable: true, blockedReason: null,
  }),
  MEM_OFF0: Object.freeze({
    id: "MEM_OFF0", letter: null, name: "MEM offset-zero hypothesis", commandWord: "42F3 / 22D3",
    envelope: ["01B0", "FF5F", "42F3", "00A0"],
    description: "Requires bridge firmware v28 with the frame 0 transition fix. Bench hypothesis for offset 0: TX was verified, but Nov 8 capture 30 matched the one-cycle MEM response and showed no independently armed offset-zero word; the offset itself remains untested.",
    source: "local reverse-engineering experiment", sourceUrl: null,
    parityStatus: "FIXED_LITERAL_93", evidenceNumericLevel: 2, evidenceLevel: evidenceLevelName(2),
    classification: "READ_ONLY", risk: "HIGH", timeoutMs: 13000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: true, requiresMapOrQualifier: true,
    armCommand: "ARM_MEM_OFF0", readCommand: "READ_MEM_OFF0", variantKey: "MEM_OFF0",
    sendable: true, blockedReason: null,
  }),
  MEM_SINGLE: Object.freeze({
    id: "MEM_SINGLE", letter: null, name: "MEM request-only single block", commandWord: "42F3",
    envelope: ["01B0", "FF5F", "42F3", "00A0"],
    description: "Nov 8 capture 31: the initial 42F3 request produced 15.0 ms cadence for one 16-frame cycle, then returned to 10.0 ms without a continuation.",
    source: "local reverse-engineering experiment", sourceUrl: null,
    parityStatus: "NOT_APPLICABLE", evidenceNumericLevel: 3, evidenceLevel: evidenceLevelName(3),
    classification: "READ_ONLY", risk: "HIGH", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_MEM_SINGLE", readCommand: "READ_MEM_SINGLE", variantKey: "MEM_SINGLE",
    sendable: true, blockedReason: null,
  }),
  MEM_PARITY: Object.freeze({
    id: "MEM_PARITY", letter: null, name: "MEM generic VPARITY continuation", commandWord: "42F3 / 2293",
    envelope: ["01B0", "FF5F", "42F3", "00A0"],
    description: "Nov 8 capture 32: parity-correct continuation 2293 sustained 15.0 ms timing for about 10 seconds (about 38 cycles, 635 frames). F14/F15 showed a structured changing sequence (19 → 14 → 0F → 0A → 05 → FF → FA → F5 → F0 …); its meaning remains unverified.",
    source: "local VPARITY derivation", sourceUrl: null,
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 4, evidenceLevel: evidenceLevelName(4),
    classification: "READ_ONLY", risk: "HIGH", timeoutMs: 13000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: true, requiresMapOrQualifier: true,
    armCommand: "ARM_MEM_PARITY", readCommand: "READ_MEM_PARITY", variantKey: "MEM_PARITY",
    sendable: true, blockedReason: null,
  }),
  OFF_GO_OFFLINE: Object.freeze({
    id: "GO_OFFLINE", letter: null, name: "Go offline mode", commandWord: "80CE / 7F20",
    envelope: ["01B0", "FF5F", "80CE", "7F20"],
    description: "Instructs ECU to terminate diagnostic session and return to autonomous CART bus master mode.",
    source: "current bridge firmware", sourceUrl: null,
    parityStatus: "GENERIC_MATCH", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "SEQUENCE_DEPENDENT", risk: "MEDIUM", timeoutMs: 15000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: true,
    armCommand: "ARM_OFF", readCommand: "READ_OFF", variantKey: "OFF",
    sendable: true, blockedReason: null,
  }),
  OUTPUT_SWITCH_TEST: Object.freeze({
    id: "OUTPUT_SWITCH_TEST", letter: null, name: "Output Switch Test", commandWord: "procedure", envelope: null,
    description: "Level 1 guided KOEO relay/solenoid output procedure from the factory service manual; not a raw DCL opcode and not tested in the November 8 vehicle captures.",
    source: "SPX 9640 service manual", sourceUrl: null, parityStatus: "NOT_APPLICABLE", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "FACTORY_PROCEDURE", risk: "HIGH", timeoutMs: 0, requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false,
    armCommand: null, readCommand: null, variantKey: null, sendable: true, blockedReason: null, runnerKey: "OUTPUT_SWITCH_TEST",
  }),
  CYLINDER_BALANCE_TEST: Object.freeze({
    id: "CYLINDER_BALANCE_TEST", letter: null, name: "Cylinder Balance Test", commandWord: "procedure", envelope: null,
    description: "Level 1 guided KOER cylinder-balance procedure from the factory service manual; not a raw DCL opcode and not tested in the November 8 vehicle captures.",
    source: "SPX 9640 service manual", sourceUrl: null, parityStatus: "NOT_APPLICABLE", evidenceNumericLevel: 1, evidenceLevel: evidenceLevelName(1),
    classification: "FACTORY_PROCEDURE", risk: "HIGH", timeoutMs: 0, requiredEcuState: "KEY_ON_ENGINE_RUNNING", repeats: false,
    armCommand: null, readCommand: null, variantKey: null, sendable: true, blockedReason: null, runnerKey: "CYLINDER_BALANCE_TEST",
  }),
};

const BASELINE_FIRMWARE_CANDIDATES = new Set([
  "STORED_0E", "STORED_A4", "CLEAR_DTC", "KOEO_253E", "KOER_253E", "GO_OFFLINE", "PIDMAP_TX",
]);
const DISCOVERY_FIRMWARE_CANDIDATES = new Set([
  "ECU_STATUS", "PIDMAP", "DMRMAP", "DMR_VALUES", "PID_DMR_BOTH",
]);
const EXPANDED_FIRMWARE_CANDIDATES = new Set([
  "PIDMAP_ALT", "KOEO_ALT", "CLEAR_A1", "CLEAR_F4", "CHANGE_BAUD", "DMRMAP_TX",
  "STOP_PID_FLOW", "PID_VALUES", "MEMORY_READ", "MEM_OFF0", "MEM_SINGLE", "MEM_PARITY",
]);

function minimumFirmwareFor(candidate) {
  if (candidate.id === "MEM_OFF0") return 28;
  if (BASELINE_FIRMWARE_CANDIDATES.has(candidate.id)) return 21;
  if (DISCOVERY_FIRMWARE_CANDIDATES.has(candidate.id)) return 24;
  if (EXPANDED_FIRMWARE_CANDIDATES.has(candidate.id)) return 27;
  return candidate.classification === "CONTROL" ? 0 : 21;
}

export const EXPERIMENT_CATALOGUE = Object.freeze(Object.fromEntries(
  Object.entries(EXPERIMENT_CATALOGUE_SOURCE).map(([key, candidate]) => [key,
    Object.freeze({ ...candidate, requiredFirmwareVersion: minimumFirmwareFor(candidate) })]),
));

// Canonical action catalogue name for UI dispatch policy.
export const COMMAND_CATALOGUE = EXPERIMENT_CATALOGUE;

/**
 * Fixed words that frame every four-word DCL request envelope. These are not
 * independent ECU commands: 01B0 opens the request, FF5F synchronizes the idle
 * bus, and 00A0 terminates the request. They are kept here, separate from the
 * executable experiment catalogue, so no standalone transmission is invented.
 */
export const PROTOCOL_FRAMING_REFERENCE = Object.freeze([
  Object.freeze({
    id: "CONTROL_01B0", word: "01B0", name: "Request envelope start control word",
    role: "ENVELOPE_START", position: 1, envelope: ["01B0"],
    description: "First word in the fixed four-word diagnostic request envelope; not a standalone ECU inquiry.",
    source: "current bridge request envelope", sourceUrl: null,
    classification: "CONTROL", requiredFirmwareVersion: 0, sendable: false,
    blockedReason: "Framing/control word; not a standalone diagnostic inquiry.",
  }),
  Object.freeze({
    id: "CONTROL_FF5F", word: "FF5F", name: "Idle synchronization control word",
    role: "IDLE_SYNC", position: 2, envelope: ["FF5F"],
    description: "Idle synchronization block; used as word 2 of our four-word request envelope.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    classification: "CONTROL", requiredFirmwareVersion: 0, sendable: false,
    blockedReason: "Framing/control word; not a standalone diagnostic inquiry.",
  }),
  Object.freeze({
    id: "CONTROL_00A0", word: "00A0", name: "Request envelope terminator",
    role: "ENVELOPE_END", position: 4, envelope: ["00A0"],
    description: "Fourth word in the fixed four-word request envelope; not a standalone ECU inquiry.",
    source: "current bridge request envelope", sourceUrl: null,
    classification: "CONTROL", requiredFirmwareVersion: 0, sendable: false,
    blockedReason: "Framing/control word; not a standalone diagnostic inquiry.",
  }),
]);

export function parseFirmwareVersion(status) {
  const value = typeof status === "number" || typeof status === "string"
    ? status
    : status?.fields?.fw ?? parseFields(String(status?.raw || status || "")).fw;
  const match = String(value ?? "").match(/(?:^|[^0-9])(\d+)(?:$|[^0-9])/);
  return match ? Number(match[1]) : null;
}

export function firmwareCompatibility(candidate, firmwareVersion) {
  const required = Number(candidate?.requiredFirmwareVersion) || 0;
  const connected = parseFirmwareVersion(firmwareVersion);
  if (connected == null) {
    return {
      required,
      connected: null,
      supported: false,
      message: "Bridge firmware version unverified. Connect an authenticated bridge in safe IDLE to verify compatibility.",
    };
  }
  if (connected < required) {
    return {
      required,
      connected,
      supported: false,
      message: `Requires Firmware v${required}+ (Connected bridge: v${connected}). Please flash firmware v${required} to execute.`,
    };
  }
  return { required, connected, supported: true, message: "" };
}

function probeSpec(id, label, extra = {}) {
  const candidate = Object.values(EXPERIMENT_CATALOGUE).find(item => item.id === id);
  const evidenceNumericLevel = candidate?.evidenceNumericLevel ?? EVIDENCE_LEVELS.LEVEL_1_NOT_TESTED;
  const evidenceLevel = candidate?.evidenceLevel ?? evidenceLevelName(evidenceNumericLevel);
  return Object.freeze({
    word: candidate?.commandWord || "",
    label,
    description: candidate?.description || "",
    source: candidate?.source || "",
    sourceUrl: candidate?.sourceUrl ?? null,
    evidenceNumericLevel,
    evidenceLevel,
    evidence: `${evidenceLevel}; not validated on 97AB-12A650-KA.`,
    parityNote: candidate?.parityNote || "",
    armCommand: candidate?.armCommand || null,
    readCommand: candidate?.readCommand || null,
    variantKey: candidate?.variantKey || null,
    classification: candidate?.classification || "READ_ONLY",
    risk: candidate?.risk || "LOW",
    requiredEcuState: candidate?.requiredEcuState || "ANY_POWERED",
    repeats: !!candidate?.repeats,
    parityStatus: candidate?.parityStatus || "NOT_APPLICABLE",
    envelope: candidate?.envelope || null,
    sendable: !!candidate?.sendable,
    blockedReason: candidate?.blockedReason || null,
    ...extra,
  });
}

/** Operation metadata is derived from the catalogue; candidate safety stays single-sourced. */
export const DCL_PROBE_VARIANTS = Object.freeze({
  ECU_STATUS: probeSpec("ECU_STATUS", "ECU status · 0381"),
  PIDMAP: probeSpec("PIDMAP", "Read PID map · 005E", {
    parityNote: "The published 005E literal differs from the generic VPARITY result 004E. Both are retained as separate candidates; no automatic fallback is used.",
  }),
  PIDMAP_ALT: probeSpec("PIDMAP_ALT", "PID-map parity alternative · 004E", {
    parityNote: "The generic-parity alternative produced a one-cycle 42.5 ms structural response in Nov 8 capture 25; a decoded PID map was not returned.",
  }),
  DMRMAP: probeSpec("DMRMAP", "Read DMR map · 242E"),
  DMR: probeSpec("DMR_VALUES", "Read DMR values · 22C6"),
  BOTH: probeSpec("PID_DMR_BOTH", "Read PID + DMR · 271E"),
  KOEO_ALT: probeSpec("KOEO_ALT", "Alternate KOEO · 2594"),
  CLEAR_A1: probeSpec("CLEAR_A1", "Clear DCL flags · 01A1"),
  CLEAR_F4: probeSpec("CLEAR_F4", "Clear DCL errors · 01F4"),
  DMRMAP_TX: probeSpec("DMRMAP_TX", "Transmit/load DMR map · 42A6"),
  CHANGE_BAUD: probeSpec("CHANGE_BAUD", "Change DCL baud · 8174"),
  STOP_PID_FLOW: probeSpec("STOP_PID_FLOW", "Stop PID flow · 411E"),
  MEM: probeSpec("MEMORY_READ", "Experimental memory read · 42F3 / 22D3"),
  MEM_OFF0: probeSpec("MEM_OFF0", "MEM offset-zero hypothesis · 42F3 / 22D3"),
  MEM_SINGLE: probeSpec("MEM_SINGLE", "MEM request-only · 42F3"),
  MEM_PARITY: probeSpec("MEM_PARITY", "MEM VPARITY continuation · 42F3 / 2293"),
  PID_VALUES: probeSpec("PID_VALUES", "Read PID values · 21F6"),
});

export const MEM_EXPERIMENTS = Object.freeze([
  Object.freeze({ id: "MEM", initialWord: "42F3", continuationWord: "22D3", offsetScope: "1..15", parityMethod: "Fixed firmware literal 22D3 (continuation byte 93)", firmwareVariant: "MEM", title: "Standard sequence" }),
  Object.freeze({ id: "MEM_OFF0", initialWord: "42F3", continuationWord: "22D3", offsetScope: "0..15 (offset 0 hypothesis)", parityMethod: "Fixed firmware literal 22D3 (continuation byte 93)", firmwareVariant: "MEM_OFF0", title: "Offset zero hypothesis" }),
  Object.freeze({ id: "MEM_SINGLE", initialWord: "42F3", continuationWord: "—", offsetScope: "Initial request only", parityMethod: "No continuation", firmwareVariant: "MEM_SINGLE", title: "Single block only" }),
  Object.freeze({ id: "MEM_PARITY", initialWord: "42F3", continuationWord: "2293", offsetScope: "1..15", parityMethod: "Generic Ford VPARITY", firmwareVariant: "MEM_PARITY", title: "Generic VPARITY continuation" }),
]);

export const FACTORY_PROCEDURES = Object.freeze({
  OUTPUT_SWITCH_TEST: Object.freeze({
    id: "OUTPUT_SWITCH_TEST", variant: "KOEO", title: "Output Switch Test",
    ecuState: "Key on, engine off; stationary, neutral, parking brake applied.",
    prompts: Object.freeze([
      "Depress and release the accelerator once to advance the output sequence.",
      "Observe the cooling fan relay output.",
      "Observe the fuel pump relay output.",
      "Observe the EVAP solenoid output.",
      "Observe the IAC output.",
    ]),
  }),
  CYLINDER_BALANCE_TEST: Object.freeze({
    id: "CYLINDER_BALANCE_TEST", variant: "KOER", title: "Cylinder Balance Test",
    ecuState: "Warm engine idling steadily in neutral; stationary with parking brake applied.",
    prompts: Object.freeze([
      "When the test prompts, tap the throttle once to establish the RPM-dip baseline.",
      "Allow the ECU to step through each cylinder. Keep the engine idling steadily and do not hold the throttle.",
    ]),
  }),
});

export const DCL_BLOCKED_CANDIDATES = Object.freeze(PROTOCOL_FRAMING_REFERENCE
  .map(candidate => Object.freeze({
    word: candidate.word,
    label: candidate.name,
    source: candidate.source,
    reason: candidate.blockedReason || "Not an independently sendable bridge operation.",
  })));

/** Fixed read-only discovery order: exactly the eight passive-probe candidates. */
export const DISCOVERY_PASS_ORDER = Object.freeze([
  "STORED_0E", "STORED_A4", "ECU_STATUS", "PIDMAP", "PIDMAP_ALT", "DMRMAP", "DMR_VALUES", "PID_DMR_BOTH",
]);

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
  MEM_OFF0: { command: "MEM_OFF0", kind: "memory", label: "MEM offset zero", timeoutMs: 13000, expectMs: 13000 },
  MEM_SINGLE: { command: "MEM_SINGLE", kind: "memory", label: "MEM single block", timeoutMs: TIMEOUTS.MEM, expectMs: TIMEOUTS.MEM },
  MEM_PARITY: { command: "MEM_PARITY", kind: "memory", label: "MEM VPARITY", timeoutMs: 13000, expectMs: 13000 },
  OFF: { command: "OFF", kind: "offline", label: "OFF", timeoutMs: TIMEOUTS.OFF, expectMs: 15000 },
  ECU_STATUS: { command: "ECU_STATUS", kind: "probe", label: "ECU status · 03 81", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  PIDMAP: { command: "PIDMAP", kind: "probe", label: "PID map · 00 5E", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  PIDMAP_ALT: { command: "PIDMAP_ALT", kind: "probe", label: "PID map alternative · 00 4E", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  DMRMAP: { command: "DMRMAP", kind: "probe", label: "DMR map · 24 2E", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  DMR: { command: "DMR", kind: "probe", label: "DMR values · 22 C6", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  BOTH: { command: "BOTH", kind: "probe", label: "PID + DMR values · 27 1E", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  PID_VALUES: { command: "PID_VALUES", kind: "probe", label: "PID values · 21 F6", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  KOEO_ALT: { command: "KOEO_ALT", kind: "probe", label: "Alternate KOEO · 25 94", timeoutMs: TIMEOUTS.KOEO, expectMs: TIMEOUTS.KOEO },
  CLEAR_A1: { command: "CLEAR_A1", kind: "probe", label: "Clear DCL flags · 01 A1", timeoutMs: TIMEOUTS.CLR, expectMs: TIMEOUTS.CLR },
  CLEAR_F4: { command: "CLEAR_F4", kind: "probe", label: "Clear DCL errors · 01 F4", timeoutMs: TIMEOUTS.CLR, expectMs: TIMEOUTS.CLR },
  DMRMAP_TX: { command: "DMRMAP_TX", kind: "probe", label: "Transmit DMR map · 42 A6", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  CHANGE_BAUD: { command: "CHANGE_BAUD", kind: "probe", label: "Change DCL baud · 81 74", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  STOP_PID_FLOW: { command: "STOP_PID_FLOW", kind: "probe", label: "Stop PID flow · 41 1E", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
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
  if (raw.startsWith("KLINE ")) return { type: "kline", raw, channel: "KLINE", hardwareVerified: false, fields: parseFields(raw) };
  if (raw.startsWith("RXB ")) {
    const match = raw.match(/^RXB t_us=(\d{1,10}) (?:seq_start=(\d{1,20}) )?data=([0-9A-F]{2,32}) dt=(\d+(?:,\d+)*)(?: seq_start=(\d{1,20}))?$/);
    if (match) {
      const base = Number(match[1]);
      const data = match[3];
      const offsets = match[4].split(",").map(Number);
      const seqText = match[2] ?? match[5] ?? null;
      const seqStart = seqText == null ? null : Number(seqText);
      if (base <= 0xffffffff && data.length % 2 === 0 &&
          offsets.length === data.length / 2 && offsets[0] === 0 &&
          offsets.every((n, i) => Number.isSafeInteger(n) && n >= 0 && n <= 0xffffffff && (!i || n >= offsets[i - 1]))) {
        return { type: "rx_batch", raw, events: offsets.map((dt, i) => ({
          type: "rx", t_us: (base + dt) >>> 0, byte: parseInt(data.slice(i * 2, i * 2 + 2), 16),
          seq: seqStart != null ? seqStart + i : null,
        })) };
      }
    }
    return { type: "fault", raw, reason: "RX_BATCH_FORMAT" };
  }
  if (raw === "AUTH OK" || raw === "AUTH OK transport=BLE") return { type: "auth", ok: true, raw };
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
      evidence: num(fields, "evidence"), epoch: num(fields, "epoch"), sequence: num(fields, "tx_seq"),
      block: num(fields, "block"), completed: num(fields, "complete"),
    };
  }
  if (raw.startsWith("RX ")) {
    const match = raw.match(/^RX t_us=(\d{1,10}) byte=([0-9A-F]{2})(?: seq=(\d{1,20}))?$/);
    if (!match || Number(match[1]) > 0xffffffff) return { type: "fault", raw, reason: "RX_FORMAT" };
    const sequence = match[3] == null ? null : Number(match[3]);
    return { type: "rx", raw, t_us: Number(match[1]), byte: Number.parseInt(match[2], 16),
      seq: Number.isSafeInteger(sequence) ? sequence : null };
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
