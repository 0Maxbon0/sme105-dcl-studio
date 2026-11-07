/** ASCII line protocol for the SME105 bridge. No DOM, no Bluetooth. */

export const APP_VERSION = "1.8.12";

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
  DCL_PROBE: 20000,
};

export const EXPERIMENT_CATALOGUE = Object.freeze({
  A_ECU_STATUS: Object.freeze({
    id: "A_ECU_STATUS", letter: "A", name: "ECU status", commandWord: "0381",
    envelope: ["01B0", "FF5F", "0381", "00A0"],
    description: "Queries general ECU operating status byte; external scanner table labels it 'Get status'.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 10000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_ECU_STATUS", readCommand: "READ_ECU_STATUS", variantKey: "ECU_STATUS",
    sendable: true, blockedReason: null,
  }),
  B_STORED_0E: Object.freeze({
    id: "B_STORED_0E", letter: "B", name: "Read stored DTCs (0E)", commandWord: "260E",
    envelope: ["01B0", "FF5F", "260E", "00A0"],
    description: "Read stored continuous trouble codes profile with 14-slot response window.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "HISTORICAL_ECU_EVIDENCE",
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 20000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_0E", readCommand: "READ_0E", variantKey: "0E",
    sendable: true, blockedReason: null,
  }),
  B_STORED_A4: Object.freeze({
    id: "B_STORED_A4", letter: "B", name: "Read stored DTCs (A4)", commandWord: "26A4",
    envelope: ["01B0", "FF5F", "26A4", "00A0"],
    description: "Alternative stored trouble code profile from flxkrmr reader with 4-slot window.",
    source: "flxkrmr/eec-iv-reader-arduino", sourceUrl: "https://github.com/flxkrmr/eec-iv-reader-arduino",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "HISTORICAL_ECU_EVIDENCE",
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 20000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_A4", readCommand: "READ_A4", variantKey: "A4",
    sendable: true, blockedReason: null,
  }),
  C_CLEAR_DTC: Object.freeze({
    id: "C_CLEAR_DTC", letter: "C", name: "Clear DTCs", commandWord: "0291",
    envelope: ["01B0", "FF5F", "0291", "00A0"],
    description: "Destructive command that clears continuous memory fault codes. Single-shot transmission then 4s capture.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "STATE_CHANGING",
    classification: "STATE_CHANGING", risk: "MEDIUM", timeoutMs: 12000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_CLR", readCommand: "READ_CLR", variantKey: "CLR",
    sendable: true, blockedReason: "State-changing: requires separate operator approval modal.",
  }),
  D_KOEO_253E: Object.freeze({
    id: "D_KOEO_253E", letter: "D", name: "KOEO on-demand self-test", commandWord: "253E",
    envelope: ["01B0", "FF5F", "253E", "00A0"],
    description: "Key On Engine Off diagnostic self-test. Actuates relays and monitors sensors; repeating DPS request.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "HISTORICAL_ECU_EVIDENCE",
    classification: "STATE_CHANGING", risk: "MEDIUM", timeoutMs: 60000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: true, requiresMapOrQualifier: false,
    armCommand: "ARM_KOEO", readCommand: "READ_KOEO", variantKey: "KOEO",
    sendable: true, blockedReason: "Controlled self-test: requires operator key-on/engine-off precondition.",
  }),
  D_KOER_253E: Object.freeze({
    id: "D_KOER_253E", letter: "D", name: "KOER running self-test", commandWord: "253E",
    envelope: ["01B0", "FF5F", "253E", "00A0"],
    description: "Key On Engine Running diagnostic self-test with dynamic operator prompts and goose pulse.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "HISTORICAL_ECU_EVIDENCE",
    classification: "STATE_CHANGING", risk: "HIGH", timeoutMs: 240000,
    requiredEcuState: "KEY_ON_ENGINE_RUNNING", repeats: true, requiresMapOrQualifier: false,
    armCommand: "ARM_KOER", readCommand: "READ_KOER", variantKey: "KOER",
    sendable: true, blockedReason: "Controlled self-test: engine running with operator steering/brake/throttle interactions.",
  }),
  D_KOEO_2594: Object.freeze({
    id: "D_KOEO_2594", letter: "D", name: "Alternate KOEO request", commandWord: "2594",
    envelope: ["01B0", "FF5F", "2594", "00A0"],
    description: "Alternate KOEO request from flxkrmr with 4-slot receive window.",
    source: "flxkrmr/eec-iv-reader-arduino", sourceUrl: "https://github.com/flxkrmr/eec-iv-reader-arduino",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "STATE_CHANGING", risk: "MEDIUM", timeoutMs: 60000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: true, requiresMapOrQualifier: false,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Deferred: hold for separate self-test profile evaluation; 253E is established.",
  }),
  E_LOAD_PIDMAP: Object.freeze({
    id: "E_LOAD_PIDMAP", letter: "E", name: "Transmit/load PID map", commandWord: "4196",
    envelope: ["01B0", "FF5F", "4196", "00A0"],
    description: "Initial request block that loads the diagnostic PID map sequence before reading live values.",
    source: "doncreat0r/eeciv + flxkrmr", sourceUrl: "https://github.com/doncreat0r/eeciv",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "HISTORICAL_ECU_EVIDENCE",
    classification: "STATE_CHANGING", risk: "LOW", timeoutMs: 10000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: true,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Part of multi-block live data sequence; not an independent read query.",
  }),
  F_READ_PIDMAP: Object.freeze({
    id: "F_READ_PIDMAP", letter: "F", name: "Read PID map (005E literal)", commandWord: "005E",
    envelope: ["01B0", "FF5F", "005E", "00A0"],
    description: "Reads the active PID map from ECU. Published literal 005E has parity mismatch vs generic formula (004E). Dedicated 'f' handler in reference code is commented out.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "UNRESOLVED_MISMATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_PIDMAP", readCommand: "READ_PIDMAP", variantKey: "PIDMAP",
    sendable: true, blockedReason: null,
  }),
  F_PIDMAP_PARITY_HYPOTHESIS: Object.freeze({
    id: "F_PIDMAP_PARITY_HYPOTHESIS", letter: "F", name: "PID map generic parity hypothesis", commandWord: "004E",
    envelope: ["01B0", "FF5F", "004E", "00A0"],
    description: "Parity-calculated alternative to 005E. Not published as a command by any external reference. Distinct from received frame-ID E.",
    source: "local parity derivation", sourceUrl: null,
    parityStatus: "GENERIC_MATCH", evidenceLevel: "REVERSE_ENGINEERING_HYPOTHESIS",
    classification: "READ_ONLY", risk: "MEDIUM", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Denied hypothesis: 005E is the published literal; never automatically fall back to 004E.",
  }),
  G_READ_PID_VALUES: Object.freeze({
    id: "G_READ_PID_VALUES", letter: "G", name: "Read PID values", commandWord: "21F6",
    envelope: ["01B0", "FF5F", "21F6", "00A0"],
    description: "Streams PID telemetry values after map configuration. Used continuously in LIVE profiles.",
    source: "doncreat0r/eeciv + flxkrmr", sourceUrl: "https://github.com/doncreat0r/eeciv",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "HISTORICAL_ECU_EVIDENCE",
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 180 * 60 * 1000,
    requiredEcuState: "ANY_POWERED", repeats: true, requiresMapOrQualifier: true,
    armCommand: "ARM_LIVE", readCommand: "READ_LIVE", variantKey: "LIVE",
    sendable: false, blockedReason: "Requires pre-loaded PID map; access via LIVE/LIVE2/LIVE3/ALL modes.",
  }),
  H_CLEAR_FLAGS: Object.freeze({
    id: "H_CLEAR_FLAGS", letter: "H", name: "Clear DCL flags (01A1)", commandWord: "01A1",
    envelope: ["01B0", "FF5F", "01A1", "00A0"],
    description: "Clears internal DCL error/status flags register in ECU.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "STATE_CHANGING", risk: "MEDIUM", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Deferred: state-clearing command; requires verified protocol requirement before transmission.",
  }),
  H_CLEAR_FLAGS_ALT: Object.freeze({
    id: "H_CLEAR_FLAGS_ALT", letter: "H", name: "Clear DCL errors (01F4)", commandWord: "01F4",
    envelope: ["01B0", "FF5F", "01F4", "00A0"],
    description: "Alternative DCL error clear command from flxkrmr reference.",
    source: "flxkrmr/eec-iv-reader-arduino", sourceUrl: "https://github.com/flxkrmr/eec-iv-reader-arduino",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "STATE_CHANGING", risk: "MEDIUM", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: false,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Deferred: state-clearing command; excluded from passive discovery.",
  }),
  I_LOAD_DMRMAP: Object.freeze({
    id: "I_LOAD_DMRMAP", letter: "I", name: "Transmit/load DMR map", commandWord: "42A6",
    envelope: ["01B0", "FF5F", "42A6", "00A0"],
    description: "Loads memory address map into ECU for Direct Memory Read.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "STATE_CHANGING", risk: "HIGH", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: false, requiresMapOrQualifier: true,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Deferred: map payload and SME-105 memory compatibility are unverified.",
  }),
  J_READ_DMRMAP: Object.freeze({
    id: "J_READ_DMRMAP", letter: "J", name: "Read DMR map", commandWord: "242E",
    envelope: ["01B0", "FF5F", "242E", "00A0"],
    description: "Read existing DMR memory address map from ECU. Raw response capture only.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "READ_ONLY", risk: "LOW", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: "ARM_DMRMAP", readCommand: "READ_DMRMAP", variantKey: "DMRMAP",
    sendable: true, blockedReason: null,
  }),
  K_READ_DMR_VALUES: Object.freeze({
    id: "K_READ_DMR_VALUES", letter: "K", name: "Read DMR values", commandWord: "22C6",
    envelope: ["01B0", "FF5F", "22C6", "00A0"],
    description: "Streams DMR values using address iteration; requires valid loaded DMR map.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "READ_ONLY", risk: "MEDIUM", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: true,
    armCommand: "ARM_DMR", readCommand: "READ_DMR", variantKey: "DMR",
    sendable: false, blockedReason: "Deferred pending protocol support: requires valid DMR map and address-qualifier iteration.",
  }),
  L_READ_COMBINED: Object.freeze({
    id: "L_READ_COMBINED", letter: "L", name: "Read combined PID + DMR values", commandWord: "271E",
    envelope: ["01B0", "FF5F", "271E", "00A0"],
    description: "Requests simultaneous streaming of configured PID and DMR tables.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "READ_ONLY", risk: "MEDIUM", timeoutMs: 20000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: true,
    armCommand: "ARM_BOTH", readCommand: "READ_BOTH", variantKey: "BOTH",
    sendable: false, blockedReason: "Deferred pending protocol support: requires verified combined map structure and response schema.",
  }),
  M_CHANGE_BAUD: Object.freeze({
    id: "M_CHANGE_BAUD", letter: "M", name: "Change baud rate", commandWord: "8174",
    envelope: ["01B0", "FF5F", "8174", "00A0"],
    description: "Switches communication speed. Upstream SetBaudrate() is commented out; no recovery sequence.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "MODE_CHANGING", risk: "CRITICAL", timeoutMs: 5000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Deferred: risks permanent communication desynchronization; no recovery sequence.",
  }),
  Q_STOP_PID_FLOW: Object.freeze({
    id: "Q_STOP_PID_FLOW", letter: "Q", name: "Stop PID data flow", commandWord: "411E",
    envelope: ["01B0", "FF5F", "411E", "00A0"],
    description: "Zero/stop active live PID streaming block flow.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "UNVERIFIED_CANDIDATE",
    classification: "MODE_CHANGING", risk: "LOW", timeoutMs: 5000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Deferred: sequence-dependent mode control; our bridge uses timeout/STOP.",
  }),
  R_IDLE_BLOCK: Object.freeze({
    id: "R_IDLE_BLOCK", letter: "R", name: "Idle/control block", commandWord: "FF5F",
    envelope: null,
    description: "Idle synchronization block; used as word 2 of our four-word request envelope.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    parityStatus: "GENERIC_MATCH", evidenceLevel: "CONTROL_WORD",
    classification: "CONTROL", risk: "LOW", timeoutMs: 0,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: false,
    armCommand: null, readCommand: null, variantKey: null,
    sendable: false, blockedReason: "Framing/control word; not a standalone diagnostic inquiry.",
  }),
  MEM_READ: Object.freeze({
    id: "MEM_READ", letter: null, name: "Experimental reverse-engineering memory read candidate (42F3 / 22D3)", commandWord: "42F3 / 22D3",
    envelope: ["01B0", "FF5F", "42F3", "00A0"],
    description: "Experimental reverse-engineering read candidate. The target address map is unverified for SME-105; 22D3 parity byte 93 differs from the generic-rule result 2293.",
    source: "local reverse-engineering candidate", sourceUrl: null,
    parityStatus: "UNRESOLVED_MISMATCH", evidenceLevel: "REVERSE_ENGINEERING_HYPOTHESIS",
    classification: "READ_ONLY", risk: "HIGH", timeoutMs: 10000,
    requiredEcuState: "KEY_ON_ENGINE_OFF", repeats: true, requiresMapOrQualifier: true,
    armCommand: "ARM_MEM", readCommand: "READ_MEM", variantKey: "MEM",
    sendable: false, blockedReason: "Deferred pending protocol validation: target address map unverified for SME-105 and 22D3 parity byte 93 differs from the generic-rule result 2293.",
  }),
  OFF_GO_OFFLINE: Object.freeze({
    id: "OFF_GO_OFFLINE", letter: null, name: "Go offline mode", commandWord: "80CE",
    envelope: ["01B0", "FF5F", "80CE", "7F20"],
    description: "Instructs ECU to terminate diagnostic session and return to autonomous CART bus master mode.",
    source: "current bridge firmware", sourceUrl: null,
    parityStatus: "GENERIC_MATCH", evidenceLevel: "HISTORICAL_ECU_EVIDENCE",
    classification: "MODE_CHANGING", risk: "MEDIUM", timeoutMs: 15000,
    requiredEcuState: "ANY_POWERED", repeats: false, requiresMapOrQualifier: true,
    armCommand: "ARM_OFF", readCommand: "READ_OFF", variantKey: "OFF",
    sendable: true, blockedReason: "Mode-changing: disconnects diagnostic session and returns bus to ECU.",
  }),
});

// Canonical action catalogue name for UI dispatch policy.
export const COMMAND_CATALOGUE = EXPERIMENT_CATALOGUE;

export const DCL_PROBE_VARIANTS = Object.freeze({
  ECU_STATUS: Object.freeze({
    word: "0381", label: "ECU status", description: "Candidate status request. The external source labels it Get status.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    evidence: "Experimental third-party command map; not validated on 97AB-12A650-KA.",
    sendable: true, blockedReason: null,
  }),
  PIDMAP: Object.freeze({
    word: "005E", label: "Read PID map", description: "The source command table labels this as read PID map (comment: 0x23). Its dedicated 'f' response-state handler is commented out in the reference code, so no decoded response schema is established.",
    parityNote: "Unresolved source-table mismatch: the published 005E literal fails the generic VPARITY calculation, which gives 004E. No ECU test or independent reference confirms a protocol exception; this may be a source-table typo or an unverified command. Preserve 005E as the published candidate; do not automatically send 004E.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    evidence: "Experimental third-party command map; not validated on 97AB-12A650-KA.",
    sendable: true, blockedReason: null,
  }),
  DMRMAP: Object.freeze({
    word: "242E", label: "Read DMR map", description: "The source command table labels this as read DMR map; no dedicated 'j' response-state handler is present in its scanner code. The acronym's exact expansion remains unresolved.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    evidence: "Experimental third-party command map; not validated on 97AB-12A650-KA.",
    sendable: true, blockedReason: null,
  }),
  DMR: Object.freeze({
    word: "22C6", label: "Read DMR values", description: "The source labels this as read DMR values and has a 'k' address-iteration response handler. Its default DMR map is a list of addresses 0x10–0x4F with zero second bytes, not a validated sensor dictionary.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    evidence: "Experimental third-party command map; not validated on 97AB-12A650-KA.",
    sendable: true, blockedReason: null,
  }),
  BOTH: Object.freeze({
    word: "271E", label: "Read PID + DMR values", description: "The source command table labels this as combined PID/DMR values; no dedicated 'l' response-state handler is present in its scanner code, so capture raw only.",
    source: "doncreat0r/eeciv · tables.h", sourceUrl: "https://github.com/doncreat0r/eeciv/blob/master/tables.h",
    evidence: "Experimental third-party command map; not validated on 97AB-12A650-KA.",
    sendable: true, blockedReason: null,
  }),
});

export const DCL_BLOCKED_CANDIDATES = Object.freeze([
  { word: "42F3 / 22D3", label: "Experimental reverse-engineering memory-read candidate (MEM)", source: "local reverse-engineering candidate", reason: "Deferred pending protocol validation: target address map unverified for SME-105 and 22D3 parity byte 93 differs from the generic-rule result 2293." },
  { word: "01A1", label: "Clear DCL error/flag register", source: "doncreat0r/eeciv", reason: "State-clearing command; deferred pending protocol support." },
  { word: "01F4", label: "Clear DCL errors", source: "flxkrmr/eec-iv-reader-arduino", reason: "State-clearing command; deferred pending protocol support." },
  { word: "0291", label: "Clear DTCs", source: "doncreat0r/eeciv", reason: "Already exposed as CLR; destructive state-change requiring separate approval." },
  { word: "004E", label: "Parity-derived PID-map alternative", source: "local parity hypothesis only", reason: "Not listed by an external source; 005E is the published literal. Never automatically fall back to 004E." },
  { word: "8174", label: "Change DCL baud rate", source: "doncreat0r/eeciv", reason: "Risks permanent communication desynchronization; upstream code commented out." },
  { word: "42A6", label: "Transmit DMR map", source: "doncreat0r/eeciv", reason: "Loads a map into the ECU; payload and target compatibility are unverified." },
  { word: "411E", label: "Stop PID value flow", source: "doncreat0r/eeciv", reason: "Sequence-dependent state control; not an independent read request." },
  { word: "2594", label: "Alternate KOEO request", source: "flxkrmr/eec-iv-reader-arduino", reason: "Diagnostic self-test candidate; hold for a separate engine-off test procedure." },
  { word: "26A4", label: "Alternate stored-code read", source: "flxkrmr/eec-iv-reader-arduino", reason: "Already available as READ_A4; keep separate from the 260E experiment." },
  { word: "260E", label: "Stored-code read", source: "doncreat0r/eeciv", reason: "Already available as READ_0E; not a new discovery probe." },
  { word: "253E", label: "KOEO/KOER self-test", source: "doncreat0r/eeciv", reason: "Already available as controlled KOEO/KOER tests; not a passive query." },
  { word: "4196", label: "Transmit PID map", source: "doncreat0r/eeciv + flxkrmr", reason: "Already used by LIVE modes; this is a map-load step, not a sensor-discovery query." },
  { word: "21F6", label: "Read PID values", source: "doncreat0r/eeciv + flxkrmr", reason: "Already used by LIVE modes; not a new standalone discovery command." },
  { word: "80CE / 7F20", label: "Go offline", source: "current bridge firmware", reason: "Already exposed as OFF; changes diagnostic communication state." },
  { word: "FF5F", label: "Idle block", source: "doncreat0r/eeciv", reason: "Already used as the second word in our fixed request sequence; not an independent command." },
  { word: "00A0", label: "Request terminator/idle word", source: "current bridge sequence", reason: "Already used as the fourth word; not an independent query." },
  { word: "procedure", label: "Output Switch / Output State Test", source: "SPX 9640 manual", reason: "Factory scan-tool procedure, not a raw DCL opcode; relays/solenoids toggle after KOEO setup, and injectors are not energized." },
  { word: "procedure", label: "Cylinder Balance Test", source: "SPX 9640 manual", reason: "Factory guided KOER routine, not a free-form injector opcode; PCM cuts fuel per cylinder while engine runs." },
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
  OFF: { command: "OFF", kind: "offline", label: "OFF", timeoutMs: TIMEOUTS.OFF, expectMs: 15000 },
  ECU_STATUS: { command: "ECU_STATUS", kind: "probe", label: "ECU status · 03 81", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  PIDMAP: { command: "PIDMAP", kind: "probe", label: "PID map · 00 5E", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  DMRMAP: { command: "DMRMAP", kind: "probe", label: "DMR map · 24 2E", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  DMR: { command: "DMR", kind: "probe", label: "DMR values · 22 C6", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
  BOTH: { command: "BOTH", kind: "probe", label: "PID + DMR values · 27 1E", timeoutMs: TIMEOUTS.DCL_PROBE, expectMs: TIMEOUTS.DCL_PROBE },
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
    const match = raw.match(/^RX t_us=(\d{1,10}) byte=([0-9A-F]{2})(?: seq=\d{1,20})?$/);
    if (!match || Number(match[1]) > 0xffffffff) return { type: "fault", raw, reason: "RX_FORMAT" };
    return { type: "rx", raw, t_us: Number(match[1]), byte: Number.parseInt(match[2], 16) };
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
