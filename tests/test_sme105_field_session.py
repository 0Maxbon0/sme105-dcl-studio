import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "sme105_field_session.py"
spec = importlib.util.spec_from_file_location("sme105_field", SCRIPT)
assert spec is not None and spec.loader is not None
field = importlib.util.module_from_spec(spec)
spec.loader.exec_module(field)


class FakeSerial:
    def __init__(self, response=b"", *, unsolicited=b""):
        self.response = response
        self.input = bytearray(unsolicited)
        self.writes = []

    @property
    def in_waiting(self):
        return len(self.input)

    def read(self, size=1):
        out = bytes(self.input[:size])
        del self.input[:size]
        return out

    def read_until(self, sep=b"\n", size=160):
        out = bytearray()
        while self.input and len(out) < size:
            out.extend(self.read(1))
            if out.endswith(sep):
                break
        return bytes(out)

    def write(self, data):
        self.writes.append(data)
        if data == b"STATUS\n":
            self.input.extend(self.response)
        return len(data)

    def flush(self):
        pass


class FieldConsoleTests(unittest.TestCase):
    def test_identity_exact(self):
        conn = FakeSerial(
            b"STATUS SME105_FIELD_V1 DE=LOW TX=ONE_SHOT_CART_REF_ONLY "
            b"RX=HIGH watchdog=READY\r\n"
        )
        self.assertEqual(field.get_status(conn), (True, True))
        self.assertEqual(conn.writes, [b"STATUS\n"])

    def test_reject_wrong_firmware_and_noise(self):
        for response in [
            b"STATUS BENCH_ONLY DE=LOW NO_DCL_TX_TO_AB\r\n",
            (b"STATUS SME105_FIELD_V1 DE=LOW TX=ONE_SHOT_CART_REF_ONLY "
             b"RX=HIGH watchdog=READY\r\nMALICIOUS\n"),
            (b"STATUS SME105_FIELD_V1 DE=LOW TX=ONE_SHOT_CART_REF_ONLY "
             b"RX=HIGH watchdog=FAILED\r\n"),
        ]:
            with self.subTest(response=response), self.assertRaises(RuntimeError):
                field.get_status(FakeSerial(response))

    def test_reject_unsolicited_before_status(self):
        conn = FakeSerial(unsolicited=b"noise")
        with self.assertRaisesRegex(RuntimeError, "unsolicited"):
            field.get_status(conn)
        self.assertEqual(conn.writes, [])

    def test_monitor_requires_complete_clean_terminal(self):
        okay = (
            b"RAW t_ms=10 n=4 hex=00 00 00 A0\r\n"
            b"CAPTURE_END bytes=4 uart_errors=0 headers4=1 invalid4=0 "
            b"order_errors=0 partial4=0 started_id0=1 stopped=0 capped=0\r\n"
            b"NOTE raw quartets are ID-only candidates, NOT fault codes\r\n"
        )
        self.assertTrue(field.evaluate_capture(okay, "monitor9600")[0])
        for broken in [
            okay.replace(b"uart_errors=0", b"uart_errors=1"),
            okay.replace(b"capped=0", b"capped=1"),
            okay.replace(b"stopped=0", b"stopped=1"),
            okay.split(b"CAPTURE_END")[0],
        ]:
            self.assertFalse(field.evaluate_capture(broken, "monitor9600")[0])

    def test_cart_requires_two_frames_and_full_capture(self):
        valid = (
            b"TX_FRAME ECHO_ID n=11 timeout=OK\r\n"
            b"ACK_CANDIDATE 01 origin=UNVERIFIED\r\n"
            b"TX_FRAME GO_CART n=11 timeout=OK\r\n"
            b"CAPTURE_END bytes=3984 uart_errors=0 headers4=996 invalid4=0 "
            b"order_errors=0 partial4=0 started_id0=1 stopped=0 capped=0\r\n"
            b"CART_REF_END result=COMPLETE TX_LOCKED\r\n"
        )
        self.assertTrue(field.evaluate_capture(valid, "cart-ref")[0])
        self.assertFalse(field.evaluate_capture(valid.replace(b"n=11", b"n=10", 1), "cart-ref")[0])
        self.assertFalse(field.evaluate_capture(valid.replace(b"COMPLETE", b"ABORT"), "cart-ref")[0])
        self.assertFalse(field.evaluate_capture(valid.replace(b"uart_errors=0", b"uart_errors=3"), "cart-ref")[0])

    def test_evidence_immutable_and_exact(self):
        with tempfile.TemporaryDirectory() as root:
            a = field.write_evidence(b"RAW\r\n", "monitor2400", root=Path(root))
            self.assertEqual(a.read_bytes(), b"RAW\r\n")
            # Prove xb won't overwrite any existing capture.
            with self.assertRaises(FileExistsError), a.open("xb"):
                pass

    def test_no_diagnostic_opcodes_ever_exposed_as_writable_actions(self):
        self.assertFalse(any("dtc" in name or "clear" in name for name in field.MONITOR_CHOICES))
        src = (SCRIPT.parents[1] / "firmware" / "sme105_field_console" /
               "sme105_field_console.ino").read_text()
        self.assertNotIn('bus.write(kReadDtc', src)
        self.assertNotIn('bus.write(kClear', src)
        self.assertIn('activeAttemptConsumed = true;', src)


if __name__ == "__main__":
    unittest.main()
