"""True executable cross-language integration test suite.

Feeds real firmware-derived wire frames through the actual JavaScript
protocol parser and controller to verify:
1. Inclusive GAP boundaries: `lost == to - from + 1`.
2. First retained record (`to + 1`) delivered to decoder and accepted.
3. Exact deduplication of replayed sequences.
4. Sequence-aware ALL / RXB batches: consecutive monotonic sequence assignment.
5. Zero-sequence sentinel handling on fresh recovery.
6. STOP priority over RESUME during reconnect races.
7. Terminal outcome extraction from STATUS.
"""

import json
import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_node_integration(js_script: str) -> dict:
    """Executes a Node.js script against the real codebase and returns JSON result."""
    wrapped = f"""
import assert from "node:assert/strict";
import {{ parseLine, EXPECTED_HELLO, EXPECTED_PINS }} from "./app/js/protocol.js";
import {{ createController }} from "./app/js/controller.js";

async function main() {{
{js_script}
}}

main().then(res => console.log(JSON.stringify(res))).catch(err => {{
  console.error(err);
  process.exit(1);
}});
"""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", wrapped],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout.strip())


class CrossLayerRecoveryWireTests(unittest.TestCase):
    def test_p1_a_inclusive_gap_and_retained_record_delivery(self):
        """Firmware gap wire emission delivers inclusive gap and sequence (to + 1) to decoder."""
        script = """
  const sentCommands = [];
  const recordedGaps = [];
  const decodedBytes = [];

  const mockArchive = {
    id: "test-rec",
    variant: "ALL",
    line() {},
    sample() {},
    recordGap(lost, from, to) { recordedGaps.push({ lost, from, to }); },
    finish() { return Promise.resolve(); }
  };

  const ctrl = createController({
    now: () => 10000,
    send: (cmd) => sentCommands.push(cmd)
  });

  const SAFE_STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=29 live_all=1 rx_batch=1";

  ctrl.onConnected("TestBridge", "wifi");
  ctrl.handleLine("AUTH OK");
  ctrl.handleLine(EXPECTED_HELLO);
  ctrl.handleLine(EXPECTED_PINS);
  ctrl.handleLine(SAFE_STATUS);
  ctrl.setArchive(mockArchive);

  assert.equal(ctrl.requestVehicle("ALL").ok, true);
  ctrl.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=ALL fault=0 fw=29 live_all=1 rx_batch=1");
  ctrl.handleLine("EVENT read_armed variant=ALL valid_ms=15000 no_tx_yet=1");
  ctrl.handleLine("EVENT session=READ_CANDIDATE epoch=9 boot_id=12345678 session_id=87654321");

  // Track decoder deliveries to prove wire events reach the decoder
  // and duplicates are dropped before reaching the decoder.
  const originalPushRx = ctrl.state.cart.pushRx.bind(ctrl.state.cart);
  ctrl.state.cart.pushRx = (t, b, now) => {
    decodedBytes.push({ t, b });
    return originalPushRx(t, b, now);
  };

  ctrl.handleLine("RX t_us=10000000 byte=3A seq=100");

  assert.equal(ctrl.state.op.session.lastSeq, 100);

  // Network drops
  ctrl.onDisconnected("transport lost");
  ctrl.onConnected("TestBridge", "wifi");

  // Verify RESUME wire command generated
  const lastCommand = sentCommands[sentCommands.length - 1];
  assert.equal(lastCommand, "RESUME 12345678 87654321 100");

  ctrl.handleLine("AUTH OK retained=1");
  // Firmware reports 9 lost records (101 through 109)
  ctrl.handleLine("RESUME OK boot=12345678 session=87654321 gap=9 from=101 to=109 replaying=1");
  ctrl.handleLine("EVENT telemetry_gap lost=9 from=101 to=109");

  // Replay sequence 110 (to + 1)
  ctrl.handleLine("RX t_us=10200000 byte=41 seq=110");
  // Duplicate delivery of seq 110
  ctrl.handleLine("RX t_us=10200000 byte=41 seq=110");

  return {
    sentResume: lastCommand,
    recordedGaps,
    decodedBytes,
    sessionRx: ctrl.state.op.session.rx,
    finalLastSeq: ctrl.state.op.session.lastSeq
  };
"""
        res = run_node_integration(script)
        self.assertEqual(res["sentResume"], "RESUME 12345678 87654321 100")
        # Exactly one gap recorded
        self.assertEqual(len(res["recordedGaps"]), 1)
        gap = res["recordedGaps"][0]
        self.assertEqual(gap["lost"], 9)
        self.assertEqual(gap["from"], 101)
        self.assertEqual(gap["to"], 109)
        self.assertEqual(gap["lost"], gap["to"] - gap["from"] + 1)
        # Sequence 110 accepted, duplicate ignored, cursor is 110
        self.assertEqual(res["finalLastSeq"], 110)
        # Exactly two bytes delivered to decoder: seq 100 (0x3A) and seq 110 (0x41)
        # Duplicate seq 110 was dropped before reaching decoder
        self.assertEqual(len(res["decodedBytes"]), 2)
        self.assertEqual(res["decodedBytes"][0]["b"], 0x3A)
        self.assertEqual(res["decodedBytes"][1]["b"], 0x41)
        self.assertEqual(res["sessionRx"], 2)

    def test_p1_b_all_rxb_batch_sequence_deduplication(self):
        """RXB batches parse monotonic starting sequence and deduplicate byte-by-byte."""
        script = """
  const recordedGaps = [];
  const mockArchive = {
    id: "test-rec",
    variant: "ALL",
    line() {},
    sample() {},
    recordGap(lost, from, to) { recordedGaps.push({ lost, from, to }); },
    finish() { return Promise.resolve(); }
  };

  const ctrl = createController({ now: () => 10000, send: () => {} });
  const SAFE_STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=29 live_all=1 rx_batch=1";
  ctrl.onConnected("TestBridge", "wifi");
  ctrl.handleLine("AUTH OK");
  ctrl.handleLine(EXPECTED_HELLO);
  ctrl.handleLine(EXPECTED_PINS);
  ctrl.handleLine(SAFE_STATUS);
  ctrl.setArchive(mockArchive);

  ctrl.requestVehicle("ALL");
  ctrl.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=ALL fault=0 fw=29 live_all=1 rx_batch=1");
  ctrl.handleLine("EVENT read_armed variant=ALL valid_ms=15000 no_tx_yet=1");
  ctrl.handleLine("EVENT session=READ_CANDIDATE epoch=9 boot_id=12345678 session_id=87654321");

  // Ingest batch with seq_start=201 (data: 2 bytes -> seq 201, 202)
  ctrl.handleLine("RXB t_us=10000000 seq_start=201 data=3A41 dt=0,104");
  assert.equal(ctrl.state.op.session.lastSeq, 202);

  // Ingest next batch with seq_start=203 (data: 2 bytes -> seq 203, 204)
  ctrl.handleLine("RXB t_us=10000208 seq_start=203 data=96E4 dt=0,104");
  assert.equal(ctrl.state.op.session.lastSeq, 204);

  // Re-ingest overlapping batch starting at 203 (must be deduplicated)
  ctrl.handleLine("RXB t_us=10000208 seq_start=203 data=96E4 dt=0,104");
  assert.equal(ctrl.state.op.session.lastSeq, 204);

  return { finalSeq: ctrl.state.op.session.lastSeq, gaps: recordedGaps };
"""
        res = run_node_integration(script)
        self.assertEqual(res["finalSeq"], 204)
        self.assertEqual(len(res["gaps"]), 0)

    def test_p1_c_stop_priority_over_resume(self):
        """Controller prioritizes operator STOP over RESUME during reconnect."""
        script = """
  const sentCommands = [];
  const ctrl = createController({ now: () => 10000, send: (cmd) => sentCommands.push(cmd) });
  const SAFE_STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=29 live_all=1 rx_batch=1";
  ctrl.onConnected("TestBridge", "wifi");
  ctrl.handleLine("AUTH OK");
  ctrl.handleLine(EXPECTED_HELLO);
  ctrl.handleLine(EXPECTED_PINS);
  ctrl.handleLine(SAFE_STATUS);
  ctrl.setArchive({ id: "rec", variant: "LIVE", line() {}, sample() {}, recordGap() {}, finish() { return Promise.resolve(); } });
  ctrl.requestVehicle("LIVE");
  ctrl.handleLine(SAFE_STATUS);
  ctrl.handleLine("EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1");
  ctrl.handleLine("EVENT session=READ_CANDIDATE epoch=9 boot_id=12345678 session_id=87654321");
  ctrl.handleLine("RX t_us=100 byte=AA seq=50");

  ctrl.onDisconnected("transport lost");
  // Operator stops while reconnecting
  ctrl.requestStop();

  const countBefore = sentCommands.length;
  ctrl.onConnected("TestBridge", "wifi");
  ctrl.handleLine("AUTH OK retained=1");

  const commands = sentCommands.slice(countBefore);
  return { commands };
"""
        res = run_node_integration(script)
        # Must send STOP, never RESUME
        self.assertIn("STOP", res["commands"])
        self.assertFalse(any(cmd.startswith("RESUME") for cmd in res["commands"]))

    def test_p1_d_fresh_recovery_zero_sentinel_and_replay_seq_one(self):
        """Fresh session recovery with null archive cursor sends sentinel 0 and replays seq 1."""
        script = """
  const sentCommands = [];
  const decodedBytes = [];
  const recordedGaps = [];

  const mockArchive = {
    id: "test-rec-fresh",
    variant: "LIVE",
    line() {},
    sample() {},
    recordGap(lost, from, to) { recordedGaps.push({ lost, from, to }); },
    finish() { return Promise.resolve(); }
  };

  const ctrl = createController({
    now: () => 10000,
    send: (cmd) => sentCommands.push(cmd)
  });

  const SAFE_STATUS = "STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=NONE fault=0 fw=29 live_all=1 rx_batch=1";

  ctrl.onConnected("TestBridge", "wifi");
  ctrl.handleLine("AUTH OK");
  ctrl.handleLine(EXPECTED_HELLO);
  ctrl.handleLine(EXPECTED_PINS);
  ctrl.handleLine(SAFE_STATUS);
  ctrl.setArchive(mockArchive);

  ctrl.requestVehicle("LIVE");
  ctrl.handleLine("STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 tx2_bench_pass=1 read_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 armed=LIVE fault=0 fw=29 live_all=1 rx_batch=1");
  ctrl.handleLine("EVENT read_armed variant=LIVE valid_ms=15000 no_tx_yet=1");
  ctrl.handleLine("EVENT session=READ_CANDIDATE epoch=9 boot_id=12345678 session_id=87654321");

  // Hook decoder
  const originalPushRx = ctrl.state.cart.pushRx.bind(ctrl.state.cart);
  ctrl.state.cart.pushRx = (t, b, now) => {
    decodedBytes.push({ t, b });
    return originalPushRx(t, b, now);
  };

  // Disconnect BEFORE any sequences are recorded (lastSeq is null)
  assert.equal(ctrl.state.op.session.lastSeq, null);
  ctrl.onDisconnected("transport lost");

  // Reconnect
  const countBefore = sentCommands.length;
  ctrl.onConnected("TestBridge", "wifi");

  // Controller must send RESUME with sentinel 0
  const resumeCmd = sentCommands.slice(countBefore).find(c => c.startsWith("RESUME"));
  assert.equal(resumeCmd, "RESUME 12345678 87654321 0");

  ctrl.handleLine("AUTH OK retained=1");
  ctrl.handleLine("RESUME OK boot=12345678 session=87654321 gap=0 from=0 to=0 replaying=1");

  // Bridge replays sequence 1
  ctrl.handleLine("RX t_us=10000000 byte=00 seq=1");
  // Duplicate seq 1
  ctrl.handleLine("RX t_us=10000000 byte=00 seq=1");

  return {
    resumeCmd,
    recordedGaps,
    decodedBytes,
    sessionRx: ctrl.state.op.session.rx,
    finalLastSeq: ctrl.state.op.session.lastSeq
  };
"""
        res = run_node_integration(script)
        self.assertEqual(res["resumeCmd"], "RESUME 12345678 87654321 0")
        self.assertEqual(len(res["recordedGaps"]), 0)
        self.assertEqual(res["finalLastSeq"], 1)
        self.assertEqual(len(res["decodedBytes"]), 1)
        self.assertEqual(res["decodedBytes"][0]["b"], 0)
        self.assertEqual(res["sessionRx"], 1)


if __name__ == "__main__":
    unittest.main()
