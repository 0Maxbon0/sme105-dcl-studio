import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "analyze_field_capture.py"
spec = importlib.util.spec_from_file_location("analyze_field_capture_tests", SCRIPT)
assert spec is not None and spec.loader is not None
field = importlib.util.module_from_spec(spec)
spec.loader.exec_module(field)


def fixture(raw: bytes, *, errors=0, invalid=0, order=0, partial=0, started=1,
            stopped=0, capped=0):
    return (
        b"CAPTURE_START mode=MON9600_8N1 duration_ms=5000\r\n"
        + (b"RAW t_ms=13 n=" + str(len(raw)).encode()
           + b" hex=" + raw.hex(" ").upper().encode() + b"\r\n" if raw else b"")
        + b"CAPTURE_END bytes=" + str(len(raw)).encode()
        + b" uart_errors=" + str(errors).encode()
        + b" headers4=" + str(len(raw)//4-invalid).encode()
        + b" invalid4=" + str(invalid).encode()
        + b" order_errors=" + str(order).encode()
        + b" partial4=" + str(partial).encode()
        + b" started_id0=" + str(started).encode()
        + b" stopped=" + str(stopped).encode()
        + b" capped=" + str(capped).encode()
        + b"\r\nNOTE raw quartets are ID-only candidates, NOT fault codes\r\n"
    )


class FieldCaptureAnalysisTests(unittest.TestCase):
    def test_empty_capture_is_silent_not_successful_dtc(self):
        result = field.analyze(fixture(b"", started=0))
        self.assertEqual(result["classification"], "silent-capture")
        self.assertFalse(result["is_dtc_read"])

    def test_two_valid_cart_ids_no_dtc(self):
        result = field.analyze(fixture(bytes.fromhex("00 00 00 A0 00 00 00 B1")))
        self.assertEqual(result["classification"], "candidate-cart-id-only-no-dtc-words")
        self.assertFalse(result["is_ecu_source_authenticated"])

    def test_corrupt_header_is_never_dtc(self):
        result = field.analyze(fixture(bytes.fromhex("00 00 00 A1"), invalid=1))
        self.assertEqual(result["classification"], "unsegmented-raw-data-no-validated-dtc")

    def test_errors_never_pass(self):
        result = field.analyze(fixture(bytes.fromhex("00 00 00 A0"), errors=1))
        self.assertEqual(result["classification"], "incomplete-or-uart-error")

    def test_reject_incorrect_counts_and_truncation(self):
        good = fixture(bytes.fromhex("00 00 00 A0"))
        for damaged in [
            good.replace(b"bytes=4", b"bytes=6"),
            good.replace(b"n=4 ", b"n=3 "),
            good.replace(b"CAPTURE_END ", b"CAPTURE_END BAD"),
            good.replace(b"00 00 00 A0", b"00 00 GG A0"),
            good + good,
            good.replace(b"NOTE raw quartets are ID-only candidates", b"MISSING"),
        ]:
            with self.subTest(damaged=damaged), self.assertRaises(ValueError):
                field.analyze(damaged)


if __name__ == "__main__":
    unittest.main()
