import importlib.util
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "verify_dcl_desk.py"
spec = importlib.util.spec_from_file_location("verify_dcl_desk_tests", SCRIPT)
assert spec is not None and spec.loader is not None
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


class DeskVerifierTests(unittest.TestCase):
    def test_exact_required_lines_pass(self):
        bench.verify_reply(bench.STATUS, b"\r\n".join(bench.EXPECTED) + b"\r\n", bench.STATUS)

    def test_wrong_firmware_fails(self):
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            bench.verify_reply(b"STATUS other\r\n", b"\r\n".join(bench.EXPECTED), bench.STATUS)

    def test_missing_real_uart_trial_fails(self):
        with self.assertRaisesRegex(RuntimeError, "self-test failed"):
            bench.verify_reply(bench.STATUS, b"SELFTEST PASS\r\n", bench.STATUS)

    def test_extra_lines_fail(self):
        with self.assertRaisesRegex(RuntimeError, "self-test failed"):
            bench.verify_reply(
                bench.STATUS, b"\r\n".join(bench.EXPECTED) + b"\r\nECHOED ECU DATA\r\n",
                bench.STATUS)

    def test_safe_command_allowlist_is_strict(self):
        class NoSerial:
            in_waiting = 0
        for command in (b"START\n", b"ECHOID\n", b"READ_CODES\n", b"C\n", b"\x26\x0e"):
            with self.subTest(command=command):
                with self.assertRaises(ValueError):
                    bench.exchange(NoSerial(), command, .01)


if __name__ == "__main__":
    unittest.main()
