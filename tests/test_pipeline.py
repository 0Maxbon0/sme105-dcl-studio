from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from ford_dcl.analyze import Event, change_deltas, rank_correlations
from ford_dcl.capture import (
    CaptureConfig,
    CaptureSession,
    TextTokenParser,
    utc_now,
)
from ford_dcl.commands import (
    CommandKind,
    CommandSession,
    CommandStateError,
    UnverifiedEncodingError,
    encode_command,
)
from ford_dcl.decode import decode_payload
from ford_dcl.diagnosis import (
    AirflowIsolation,
    DiagnosisBranch,
    MixtureEvidence,
    WarmIdleEvidence,
    classify_high_idle,
)
from ford_dcl.dtc import DTCClass, DTCKind, DTCSource, decode_dtc
from ford_dcl.framing import ByteSample, analyze_framing
from ford_dcl.framing import Direction as FrameDirection
from ford_dcl.inspect_capture import format_summary, inspect_session
from ford_dcl.markers import append_marker
from ford_dcl.profile import load_profile
from ford_dcl.transport import (
    Direction,
    RecordType,
    TransportRecord,
    TransportStreamDecoder,
    crc16_ccitt,
    encode_record,
    record_bytes,
)
from ford_dcl.words import (
    ByteAlignment,
    decode_pairs,
    decode_word,
    encode_word,
    observed_vector_evidence,
    vertical_nibble_parity,
)

ROOT = Path(__file__).resolve().parents[1]


class TextCaptureTests(unittest.TestCase):
    def test_incremental_parser_ignores_line_boundaries(self) -> None:
        parser = TextTokenParser()
        first = parser.feed(b"--- READY ---\nF")
        second = parser.feed(b"F 5F\n00 A")
        final = parser.feed(b"0 broken", final=True)
        tokens = [*first, *second, *final]
        values = [token.value for token in tokens if token.value is not None]
        self.assertEqual(values, [0xFF, 0x5F, 0x00, 0xA0])
        self.assertEqual(tokens[-1].kind, "malformed_text")

    def test_ascii_session_is_create_only_and_inspectable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config = CaptureConfig(
                port="fixture",
                output_dir=Path(temporary),
                rotate_size=9,
                format="ascii",
                session_metadata={"label": "fixture-session", "dcl_baud": "9600"},
            )
            session = CaptureSession(config)
            parser = TextTokenParser()
            raw = b"--- READY ---\nFF 5F 00 A0\n"
            observed_utc = utc_now()
            session.write_raw(raw, utc=observed_utc, monotonic_ns=100)
            session.record_tokens(
                parser.feed(raw, final=True),
                utc=observed_utc,
                monotonic_ns=100,
            )
            path = session.path
            session.close("fixture")

            summary = inspect_session(path)
            self.assertEqual(summary["parsed_byte_count"], 4)
            self.assertTrue(summary["event_raw_match"])
            self.assertGreater(len(summary["files"]), 1)
            self.assertEqual(summary["metadata"]["session"]["label"], "fixture-session")
            offset_zero = summary["candidate_pair_alignments"][0]
            self.assertEqual(offset_zero["valid_word_count"], 2)
            self.assertEqual(offset_zero["invalid_word_count"], 0)

    def test_operator_markers_are_append_only_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "markers.jsonl"
            first = append_marker(path, "TPS_SWEEP_START")
            second = append_marker(path, "TPS_SWEEP_END", "pedal released")
            records = [json.loads(line) for line in path.read_text().splitlines()]
        self.assertEqual([first, second], records)
        self.assertLessEqual(first["monotonic_ns"], second["monotonic_ns"])


class BinaryTransportTests(unittest.TestCase):
    def test_crc_reference_vector(self) -> None:
        self.assertEqual(crc16_ccitt(b"123456789"), 0x29B1)

    def test_fixed_record_round_trip_with_slip_escapes(self) -> None:
        record = TransportRecord(
            record_type=RecordType.DATA,
            direction=Direction.BUS_TO_MCU,
            status=0xDB,
            timestamp_us=0xC0DB_0102_0304_0506,
            value=0xC0,
        )
        unescaped = record_bytes(record)
        self.assertEqual(len(unescaped), 15)
        encoded = encode_record(record)
        decoder = TransportStreamDecoder()
        batches = [
            decoder.feed(encoded[:3]),
            decoder.feed(encoded[3:11]),
            decoder.feed(encoded[11:]),
        ]
        records = tuple(item for batch in batches for item in batch.records)
        errors = tuple(item for batch in batches for item in batch.errors)
        self.assertEqual(records, (record,))
        self.assertEqual(errors, ())

    def test_decoder_discards_initial_partial_frame_until_end(self) -> None:
        record = TransportRecord(
            RecordType.DATA, 10, 0x55, direction=Direction.BUS_TO_MCU
        )
        batch = TransportStreamDecoder().feed(b"\x01\x02\x03" + encode_record(record))
        self.assertEqual(batch.records, (record,))
        self.assertEqual(batch.errors, ())

    def test_crc_corruption_is_reported_and_stream_recovers(self) -> None:
        good = encode_record(
            TransportRecord(RecordType.DATA, 10, 0x55, direction=Direction.BUS_TO_MCU)
        )
        corrupt = bytearray(good)
        corrupt[5] ^= 0x01
        decoder = TransportStreamDecoder()
        batch = decoder.feed(bytes(corrupt) + good)
        self.assertEqual(len(batch.records), 1)
        self.assertTrue(any(error.code == "crc_mismatch" for error in batch.errors))

    def test_binary_capture_inspection_uses_mcu_timestamps(self) -> None:
        records = (
            TransportRecord(
                RecordType.DATA, 1_000, 0xFF, direction=Direction.BUS_TO_MCU
            ),
            TransportRecord(
                RecordType.DATA, 2_100, 0x5F, direction=Direction.BUS_TO_MCU
            ),
            TransportRecord(RecordType.UART_STATUS, 2_200, 0, status=0x04),
        )
        raw = b"".join(encode_record(record) for record in records)
        decoder = TransportStreamDecoder()
        with tempfile.TemporaryDirectory() as temporary:
            session = CaptureSession(
                CaptureConfig(
                    port="fixture",
                    output_dir=Path(temporary),
                    rotate_size=17,
                    format="binary",
                )
            )
            session.write_raw(raw, utc=utc_now(), monotonic_ns=123)
            session.record_transport(
                decoder.feed(raw),
                utc=utc_now(),
                monotonic_ns=123,
            )
            path = session.path
            session.close("fixture")
            summary = inspect_session(path, gap_ms=1.0)

        self.assertEqual(summary["parsed_byte_count"], 2)
        self.assertEqual(summary["transport"]["validated_record_count"], 3)
        self.assertEqual(summary["transport"]["uart_status_record_count"], 1)
        self.assertEqual(
            summary["gaps"]["basis"],
            "MCU timestamp_us between validated data records",
        )
        self.assertEqual(summary["gaps"]["gap_count"], 1)
        self.assertIn("UART status flags", format_summary(summary))


class WordAndFramingTests(unittest.TestCase):
    def test_observed_word_vectors_are_preserved(self) -> None:
        vectors = json.loads(
            (ROOT / "tests" / "fixtures" / "word_vectors.json").read_text()
        )
        for vector in vectors:
            wire = bytes.fromhex(vector["wire_hex"])
            decoded = decode_word(wire[0], wire[1])
            self.assertEqual(decoded.observed_parity, vector["parity"])
            self.assertTrue(decoded.valid)
            self.assertIn(vector["data"], [item.data for item in decoded.candidates])
        self.assertTrue(observed_vector_evidence()["vertical_nibble_parity"])

    def test_encode_decode_round_trip_for_each_alignment(self) -> None:
        for alignment in ByteAlignment:
            for value in (0, 1, 0x118, 0xABC, 0xFFF):
                wire = encode_word(value, alignment)
                decoded = decode_word(*wire)
                self.assertEqual(decoded.candidate(alignment).data, value)
                self.assertTrue(decoded.candidate(alignment).valid)
                self.assertEqual(
                    decoded.candidate(alignment).observed_parity,
                    vertical_nibble_parity(value),
                )

    def test_pair_offsets_and_direction_boundaries(self) -> None:
        response = encode_word(0x118) + encode_word(0x222)
        samples = [
            ByteSample(index * 0.001, value, FrameDirection.RESPONSE)
            for index, value in enumerate(response)
        ]
        request = encode_word(0x001)
        samples.extend(
            ByteSample(0.020 + index * 0.001, value, FrameDirection.REQUEST)
            for index, value in enumerate(request)
        )
        result = analyze_framing(samples)
        self.assertEqual(len(result.frames), 2)
        self.assertEqual(result.frames[0].direction, FrameDirection.RESPONSE)
        self.assertEqual(result.frames[1].direction, FrameDirection.REQUEST)
        self.assertEqual(decode_pairs(response, 0).invalid_count, 0)


class ProfileAndDtcTests(unittest.TestCase):
    def test_reference_profile_decodes_known_fixture_bytes(self) -> None:
        payload = bytearray(32)
        payload[0] = 100
        payload[1] = 0x01
        payload[10] = 100
        payload[22] = 0xFF
        payload[24] = 0x30
        payload[25] = 0x90
        result = decode_payload(payload, load_profile())
        self.assertTrue(result.length_valid)
        self.assertEqual(result.field("rpm").raw_value, 0x164)
        self.assertEqual(result.field("rpm").engineering_value, 1420)
        self.assertEqual(result.field("ect").engineering_value, 93)
        self.assertEqual(result.field("ect").unit, "degC")
        self.assertEqual(result.field("tps_mode").engineering_value, "closed")
        self.assertEqual(result.field("o2_mode").engineering_value, "Opened")

    def test_profile_rejects_short_payload_without_dropping_fields(self) -> None:
        result = decode_payload(b"\x00" * 4)
        self.assertFalse(result.valid)
        self.assertFalse(result.length_valid)
        self.assertIsNone(result.field("ect").raw_value)
        self.assertTrue(result.field("ect").issues)

    def test_dtc_bcd_pass_prompt_fault_and_unknown(self) -> None:
        passed = decode_dtc(0x111, source=DTCSource.KOEO)
        prompt = decode_dtc(0x010, source=DTCSource.KOER)
        fault = decode_dtc(0x116, source=DTCSource.CONTINUOUS_MEMORY)
        unknown = decode_dtc(0xAAA)
        self.assertEqual(passed.kind, DTCKind.PASS)
        self.assertEqual(prompt.kind, DTCKind.OPERATOR_PROMPT)
        self.assertEqual(fault.kind, DTCKind.FAULT)
        self.assertEqual(fault.code_class, DTCClass.COOLANT_TEMPERATURE)
        self.assertEqual(fault.display_code, 116)
        self.assertFalse(unknown.known)
        self.assertEqual(unknown.raw_hex, "AAA")


class CommandAndAnalysisTests(unittest.TestCase):
    def test_safe_command_state_and_unverified_encoding_gate(self) -> None:
        session = CommandSession()
        initialize = session.plan(CommandKind.INITIALIZE)
        with self.assertRaises(UnverifiedEncodingError):
            encode_command(initialize)
        session.commit(initialize)
        select = session.plan(CommandKind.MODULE_SELECT, module="EEC")
        session.commit(select)
        live = session.plan(CommandKind.LIVE_DATA)
        with self.assertRaises(UnverifiedEncodingError):
            encode_command(live)
        with self.assertRaises(CommandStateError):
            CommandSession().plan(CommandKind.LIVE_DATA)

    def test_change_and_correlation_rankings(self) -> None:
        events = tuple(
            Event(float(index), {"rpm": index * 100, "candidate": index * 2})
            for index in range(5)
        )
        deltas = change_deltas(events)
        self.assertEqual(deltas[0].changes["rpm"], 100)
        ranks = rank_correlations(events, "rpm")
        self.assertTrue(ranks[0].valid)
        self.assertEqual(ranks[0].field, "candidate")
        self.assertAlmostEqual(ranks[0].coefficient or 0, 1.0)

    def test_high_idle_requires_airflow_isolation_for_definitive_result(self) -> None:
        telemetry_only = classify_high_idle(
            WarmIdleEvidence(
                rpm=1250,
                ect_deg_c=93,
                tps_closed=True,
                iac_percent=3,
                mixture=MixtureEvidence.LEAN,
                repeated_sessions=3,
                source_capture_ids=("warm-1", "warm-2", "warm-3"),
            )
        )
        self.assertEqual(
            telemetry_only.branch,
            DiagnosisBranch.EXCESS_AIR_UNCONFIRMED,
        )
        self.assertFalse(telemetry_only.definitive)

        isolated = classify_high_idle(
            WarmIdleEvidence(
                rpm=1250,
                ect_deg_c=93,
                tps_closed=True,
                iac_percent=3,
                airflow_isolation=AirflowIsolation.RPM_REMAINED_HIGH,
                mixture=MixtureEvidence.LEAN,
                repeated_sessions=3,
                source_capture_ids=("warm-1", "warm-2", "warm-3"),
            )
        )
        self.assertEqual(
            isolated.branch,
            DiagnosisBranch.NON_IAC_AIRFLOW_CONFIRMED,
        )
        self.assertTrue(isolated.definitive)


if __name__ == "__main__":
    unittest.main()
