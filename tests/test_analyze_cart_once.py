"""Offline synthetic fixtures for the raw CART transcript analyzer."""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "analyze_cart_once.py"
spec = importlib.util.spec_from_file_location("analyze_cart_once_test_module", SCRIPT)
assert spec is not None and spec.loader is not None
cart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cart)


def session(payload: bytes, *, done="CART_DONE bytes=64 uart_errors=0") -> str:
    return "\n".join((
        "HELLO_RX n=12 hex=00 00 00 00 00 01 82 00 00 00 83 01",
        "TX_FRAME GO_CART bytes=11 watchdog=OK",
        f"CART_RX t_ms=90 n={len(payload)} hex={payload.hex(' ').upper()}",
        done,
    ))


class AnalyzerTests(unittest.TestCase):
    def test_complete_zero_payload_id_cycle(self):
        result = cart.analyze_text(session(cart.REFERENCE_CYCLE))
        self.assertEqual(result["decoded_byte_count"], 64)
        self.assertEqual(result["full_reference_cycles"], 1)
        self.assertTrue(result["exact_16_id_cycle"])
        self.assertTrue(result["sync_and_id_only"])
        self.assertEqual(result["invalid_frame_quartets"], 0)
        self.assertEqual(result["firmware_uart_errors"], 0)
        self.assertTrue(result["ordered_0_to_15_ids"])
        self.assertEqual(result["raw_bytes_not_part_of_sync_or_id"], 0)
        self.assertEqual(result["frame_count"], 16)
        self.assertEqual(result["integrity_warnings"],
                         ["missing_cart_monitor_9600_8n1_banner"])
        self.assertFalse(result["source_is_independently_verified_as_ecu"])

    def test_one_bad_id_cannot_pass(self):
        bad = bytearray(cart.REFERENCE_CYCLE)
        bad[7] ^= 0x10
        result = cart.analyze_text(session(bytes(bad)))
        self.assertFalse(result["exact_16_id_cycle"])
        self.assertGreater(result["invalid_frame_quartets"], 0)

    def test_truncated_terminal_uart_errors_are_unknown(self):
        result = cart.analyze_text(
            session(cart.REFERENCE_CYCLE, done="CART_DONE bytes=64 uart_errors"))
        self.assertEqual(result["decoded_byte_count"], 64)
        self.assertEqual(result["firmware_reported_byte_count"], 64)
        self.assertIsNone(result["firmware_uart_errors"])
        self.assertFalse(result["firmware_uart_errors_known"])
        self.assertTrue(result["truncated_cart_done_line"])
        self.assertIn("uart_error_count_missing_from_truncated_terminal_line",
                      result["integrity_warnings"])

    def test_missing_cycle_id_in_middle_must_fail(self):
        data = cart.REFERENCE_CYCLE[:4] + cart.REFERENCE_CYCLE[8:]
        result = cart.analyze_text(session(data, done="CART_DONE bytes=60 uart_errors=0"))
        self.assertFalse(result["ordered_0_to_15_ids"])
        self.assertFalse(result["exact_16_id_cycle"])

    def test_duplicate_frame_cannot_be_called_clean(self):
        data = cart.REFERENCE_CYCLE[:8] + cart.REFERENCE_CYCLE[4:8] + cart.REFERENCE_CYCLE[8:]
        result = cart.analyze_text(session(data, done="CART_DONE bytes=68 uart_errors=0"))
        self.assertFalse(result["ordered_0_to_15_ids"])
        self.assertFalse(result["exact_16_id_cycle"])

    def test_claimed_byte_count_mismatch_is_flagged(self):
        result = cart.analyze_text(session(cart.REFERENCE_CYCLE, done="CART_DONE bytes=65 uart_errors=0"))
        self.assertIn("firmware_and_transcript_byte_count_disagree",
                      result["integrity_warnings"])

    def test_missing_cart_banner_is_explicit_warning(self):
        result = cart.analyze_text(session(cart.REFERENCE_CYCLE))
        self.assertFalse(result["cart_monitor_9600_8n1_reported"])
        self.assertIn("missing_cart_monitor_9600_8n1_banner",
                      result["integrity_warnings"])

    def test_invalid_chunk_size_is_flagged_not_accepted(self):
        result = cart.analyze_text(
            session(cart.REFERENCE_CYCLE).replace("n=64 hex=", "n=63 hex="))
        self.assertFalse(result["exact_16_id_cycle"])
        self.assertIn("malformed_cart_rx_lines", result["integrity_warnings"])

    def test_real_saved_capture_if_available(self):
        log = (Path(__file__).resolve().parents[1] / "captures" / "CART_ONCE"
               / "20261102T150417765534Z.txt")
        if not log.exists():
            self.skipTest("operator's immutable private capture not present")
        result = cart.analyze_text(log.read_text())
        self.assertEqual(result["decoded_byte_count"], 3984)
        self.assertEqual(result["cart_rx_chunk_count"], 249)
        self.assertEqual(result["frame_count"], 996)
        self.assertEqual(result["full_reference_cycles"], 62)
        self.assertEqual(result["remaining_bytes"], 16)
        self.assertTrue(result["exact_16_id_cycle"])
        self.assertTrue(result["cart_monitor_9600_8n1_reported"])
        self.assertTrue(result["truncated_cart_done_line"])
        self.assertEqual(result["integrity_warnings"],
                         ["uart_error_count_missing_from_truncated_terminal_line"])

        frames = list(cart.iter_frame_rows(log.read_text()))
        self.assertEqual(len(frames), 996)
        self.assertEqual(frames[0]["host_batch_t_ms"], 74)
        self.assertEqual(frames[0]["frame_id"], 0)
        self.assertEqual(frames[15]["frame_id"], 15)
        self.assertEqual(frames[-1]["frame_id"], 3)
        self.assertTrue(all(f["reference_sync_id_match"] for f in frames))

    def test_frame_export_uses_host_batch_times_without_inventing_edge_time(self):
        frames = list(cart.iter_frame_rows(session(cart.REFERENCE_CYCLE)))
        self.assertEqual(len(frames), 16)
        self.assertEqual([f["frame_id"] for f in frames], list(range(16)))
        self.assertEqual({f["host_batch_t_ms"] for f in frames}, {90})

    def test_frame_export_rejects_incomplete_quartet(self):
        with self.assertRaisesRegex(ValueError, "incomplete"):
            list(cart.iter_frame_rows(session(b"\x00\x00\x00")))

    def test_frame_export_includes_end_chunk_without_fake_timestamp(self):
        content = ("CART_RX t_ms=74 n=3 hex=00 00 00\n"
                   "CART_RX_END n=1 hex=A0\n")
        frames = list(cart.iter_frame_rows(content))
        self.assertEqual(len(frames), 1)
        self.assertEqual(frames[0]["host_batch_t_ms"], "")
        self.assertEqual(frames[0]["sync_and_id_hex"], "00 00 00 A0")


if __name__ == "__main__":
    unittest.main()
