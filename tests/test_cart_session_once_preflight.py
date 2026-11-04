"""USB-only host preflight; no physical DCL transmission is exercised."""

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "cart_session_once.py"
spec = importlib.util.spec_from_file_location("cart_session_once_test_module", SCRIPT)
assert spec is not None and spec.loader is not None
cart = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cart)


class FakeSerial:
    def __init__(self, noise=b"", *, nonstop=False, firmware_reply=None):
        self.input = bytearray(noise)
        self.nonstop = nonstop
        self.firmware_reply = firmware_reply or cart.READY
        self.writes = []

    @property
    def in_waiting(self):
        return len(self.input) or (32 if self.nonstop else 0)

    def read(self, size=1):
        if self.nonstop and not self.input:
            self.input.extend(b"x\x00\x80" * 40)
        data = bytes(self.input[:size])
        del self.input[:size]
        return data

    def write(self, data):
        self.writes.append(data)
        if data == b"STATUS\n":
            self.input.extend(self.firmware_reply)
        return len(data)

    def flush(self):
        pass

    def read_until(self, sep, size=128):
        result = bytearray()
        while len(result) < size and self.input:
            value = self.read(1)
            result.extend(value)
            if result.endswith(sep):
                break
        return bytes(result)


class SerialPreflightTests(unittest.TestCase):
    def test_startup_garbage_drains_then_two_exact_statuses(self):
        conn = FakeSerial(noise=b"x\x00\x80" * 800)
        self.assertEqual(cart.wait_until_quiet(conn, quiet_seconds=0.015,
                                               max_seconds=0.2), 2400)
        self.assertEqual(cart.status(conn), cart.READY)
        self.assertEqual(cart.status(conn), cart.READY)
        self.assertEqual(conn.writes, [b"STATUS\n", b"STATUS\n"])

    def test_persistent_garbage_aborts_before_any_status_or_start(self):
        conn = FakeSerial(nonstop=True)
        with self.assertRaisesRegex(RuntimeError, "did not settle"):
            cart.wait_until_quiet(conn, quiet_seconds=0.01, max_seconds=0.035)
        self.assertEqual(conn.writes, [])

    def test_wrong_firmware_reply_is_not_accepted(self):
        conn = FakeSerial(firmware_reply=b"STATUS rx2=HIGH tx=WAITING_FOR_EXPLICIT_ECHOID\r\n")
        with self.assertRaisesRegex(RuntimeError, "incorrect firmware"):
            cart.status(conn)
        self.assertEqual(conn.writes, [b"STATUS\n"])

    def test_noisy_response_is_not_accepted(self):
        conn = FakeSerial(firmware_reply=b"garbage\n")
        with self.assertRaisesRegex(RuntimeError, "incorrect firmware"):
            cart.status(conn)
        self.assertEqual(conn.writes, [b"STATUS\n"])


if __name__ == "__main__":
    unittest.main()
