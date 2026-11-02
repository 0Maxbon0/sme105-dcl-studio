"""No bus access: native field host identity, endings and immutable files."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts import sme105_timed_session as host


class FakePort:
    def __init__(self, *, response=b"", data=b""):
        self.response = response
        self.rx = bytearray(data)
        self.sent: list[bytes] = []

    @property
    def in_waiting(self):
        return len(self.rx)

    def read(self, count=1):
        chunk = bytes(self.rx[:count])
        del self.rx[:count]
        return chunk

    def read_until(self, marker=b"\n", size=180):
        return self.response[:size]

    def write(self, raw):
        self.sent.append(raw)
        return len(raw)

    def flush(self):
        pass


class TimedHostTests(unittest.TestCase):
    def test_status_requires_exact_native_firmware_identity_and_timer(self):
        correct = (b"STATUS SME105_DTC_ONE_SHOT_V1 DE=LOW B_TX=COMPILE_LOCKED "
                   b"used=0 deadline_timer=1\r\n")
        self.assertTrue(host.status(FakePort(response=correct)))
        for wrong in (
            correct.replace(b"V1", b"V2"),
            correct.replace(b"deadline_timer=1", b"deadline_timer=0"),
            correct.replace(b"COMPILE_LOCKED", b"ENABLED"),
        ):
            with self.subTest(wrong=wrong), self.assertRaises(RuntimeError):
                host.status(FakePort(response=wrong))
        self.assertFalse(host.status(FakePort(response=correct.replace(b"used=0", b"used=1"))))

    def test_finished_capture_does_not_issue_more_requests(self):
        device = FakePort(data=b"CART_EVT t_us=1 byte=00\r\n"
                          b"CART_END DTC_UNVERIFIED B_TX_LOCKED\r\n")
        content = host.capture(device, deadline_seconds=1)
        self.assertIn(b"CART_END ", content)
        self.assertEqual(device.sent, [b"CAPTURE_CART_ONCE\n"])
        dry_run = FakePort(data=b"CART_END DTC_UNVERIFIED B_TX_LOCKED\r\n")
        self.assertEqual(host.capture(dry_run, action="PLAN_B_ONCE"),
                         b"CART_END DTC_UNVERIFIED B_TX_LOCKED\r\n")
        self.assertEqual(dry_run.sent, [b"PLAN_B_ONCE\n"])
        with self.assertRaises(ValueError):
            host.capture(FakePort(), action="READ_B_ONCE")

    def test_partial_and_trailing_garbage_are_not_silently_discarded(self):
        for raw in (
            b"CART_EVT t_us=1 byte=00\r\n",
            b"CART_END DTC_UNVERIFIED B_TX_LOCKED\r\nUNEXPECTED\n",
        ):
            with self.subTest(raw=raw):
                device = FakePort(data=raw)
                with self.assertRaises(host.CaptureIncomplete) as context:
                    host.capture(device, deadline_seconds=0.001)
                self.assertEqual(context.exception.raw, raw)

    def test_evidence_is_create_only(self):
        with tempfile.TemporaryDirectory() as target:
            original = b"timed CART bytes\r\n"
            path = host.write_evidence(original, Path(target))
            self.assertEqual(path.read_bytes(), original)
            with self.assertRaises(FileExistsError), path.open("xb"):
                pass


if __name__ == "__main__":
    unittest.main()
