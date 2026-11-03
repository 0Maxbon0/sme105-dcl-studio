"""Host-only fake serial proofs for the permanent SME-105 USB terminal."""

from __future__ import annotations

import hashlib
import queue
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import sme105_usb_bridge as bridge

GOOD_STATUS = (
    b"STATUS SME105_USB_BRIDGE_V1 stage=0 DE=LOW auto_tx=0 gate4=1 "
    b"pad_rx=0 read_used=0 fault=0\n"
)
RX_LINES = (
    b"RX t_us=120 byte=00\n"
    b"RX t_us=1220 byte=6D\n"
    b"RX t_us=2320 byte=CC\n"
)
END_GOOD = (
    b"END reason=15 ro_bytes=3 ro_lost=0 uart_errors=0 "
    b"pad_verified=0 words_started=0 ecu_verified=0 dtc_verified=0 DE=LOW\n"
)


class FakePort:
    """Byte-stream serial fake with independently running reader queue."""

    def __init__(self, *, status: bytes = GOOD_STATUS,
                 bad_arm: bool = False, mismatch: bool = False,
                 wrong_count: bool = False, delayed_end: bool = False) -> None:
        self.writes: list[bytes] = []
        self._rx = queue.Queue()
        self.status_line = status
        self.bad_arm = bad_arm
        self.mismatch = mismatch
        self.wrong_count = wrong_count
        self.delayed_end = delayed_end
        self.pending_end: bytes | None = None
        self.dtr = False
        self.rts = False
        self.closed = False
        self.rx_seen = threading.Event()

    def _emit(self, data: bytes) -> None:
        # Arbitrary short chunks exercise split ASCII frames.
        for start in range(0, len(data), 17):
            self._rx.put(data[start:start + 17])

    def read(self, size: int = 1) -> bytes:
        try:
            item = self._rx.get(timeout=0.03)
        except queue.Empty:
            return b""
        if b"RX t_us=" in item:
            self.rx_seen.set()
        return item[:size]

    def flush(self) -> None:
        pass

    def write(self, data: bytes) -> int:
        self.writes.append(data)
        cmd = data.decode("ascii").strip()
        if cmd == "HELLO":
            self._emit(bridge.HELLO_REPLY + b"\n")
        elif cmd == "STATUS":
            self._emit(self.status_line)
        elif cmd == "PINS":
            self._emit(bridge.PINS_REPLY + b"\n")
        elif cmd == "LISTEN_9600":
            self._emit(b"EVENT session=LISTEN_9600 origin=RO_ONLY no_tx=1\n")
            self._emit(RX_LINES)
            result = END_GOOD.replace(b"ro_bytes=3", b"ro_bytes=4") if self.wrong_count else END_GOOD
            if self.delayed_end:
                self.pending_end = result
            else:
                self._emit(result)
        elif cmd in ("ARM_A4", "ARM_0E"):
            which = "0E" if cmd == "ARM_A4" and self.bad_arm else cmd[4:]
            self._emit(
                f"EVENT read_armed variant={which} valid_ms=15000 no_tx_yet=1\n".encode()
            )
        elif cmd in ("READ_A4", "READ_0E"):
            third = b"26A4" if cmd == "READ_A4" else b"260E"
            observed = b"6DCC" if self.mismatch else b"01B0"
            match = b"0" if self.mismatch else b"1"
            self._emit(b"EVENT session=READ_CANDIDATE\n")
            self._emit(RX_LINES)
            self._emit(b"TX_PAD slot=0 expected=01B0 observed=" + observed +
                       b" tx_us=100 done_us=2200 match=" + match + b"\n")
            self._emit(b"TX_PAD slot=1 expected=FF5F observed=FF5F "
                       b"tx_us=10000 done_us=12100 match=1\n")
            self._emit(b"TX_PAD slot=2 expected=" + third +
                       b" observed=" + third +
                       b" tx_us=20000 done_us=22100 match=1\n")
            self._emit(b"TX_PAD slot=3 expected=00A0 observed=00A0 "
                       b"tx_us=30000 done_us=32100 match=1\n")
            self._emit(END_GOOD.replace(b"pad_verified=0 words_started=0",
                                         b"pad_verified=4 words_started=4"))
        elif cmd == "OBSERVE":
            self._emit(b"EVENT session=OBSERVE\n")
            self._emit(RX_LINES)
            self._emit(END_GOOD)
        elif cmd == "STOP":
            self._emit(b"EVENT stop=idle DE=LOW\n")
            if self.pending_end is not None:
                self._emit(self.pending_end)
                self.pending_end = None
        else:
            raise AssertionError(f"unexpected wire command {data!r}")
        return len(data)

    def close(self) -> None:
        self.closed = True


class BridgeEvidenceTests(unittest.TestCase):
    def test_verbatim_usb_and_exact_uart_octets_sha(self):
        raw = b"EVENT session=LISTEN_9600 origin=RO_ONLY no_tx=1\r\n" + RX_LINES
        with tempfile.TemporaryDirectory() as folder:
            evidence = bridge.EvidenceRecorder(Path(folder), "one")
            for index in range(0, len(raw), 5):
                evidence.feed(raw[index:index + 5])
            txt_sha, bin_sha = evidence.close()
            self.assertEqual(evidence.txt_path.read_bytes(), raw)
            self.assertEqual(evidence.bin_path.read_bytes(), b"\x00\x6d\xcc")
            self.assertEqual(txt_sha, hashlib.sha256(raw).hexdigest())
            self.assertEqual(bin_sha, hashlib.sha256(b"\x00\x6d\xcc").hexdigest())
            self.assertIsNone(evidence.fault)
            with self.assertRaises(FileExistsError):
                bridge.EvidenceRecorder(Path(folder), "one")

    def test_fails_closed_on_malformed_event_truncation_timestamp_and_sequence(self):
        samples = (
            RX_LINES.splitlines(keepends=True)[0] + b"RX t_us=1220 byte=GG\n",
            RX_LINES.splitlines(keepends=True)[0] + b"RX t_us=2 byte=6D\n",
            b"RX t_us=100 byte=00 seq=1\nRX t_us=110 byte=6D seq=3\n",
            b"RX t_us=100 byte=00\nRX t_us=110 byte=6D seq=2\n",
            b"RX t_us=100 byte=00\nRX t_us=110 byte=",
        )
        for index, packet in enumerate(samples):
            with self.subTest(index=index), tempfile.TemporaryDirectory() as folder:
                evidence = bridge.EvidenceRecorder(Path(folder), "case")
                evidence.feed(packet)
                evidence.close()
                self.assertIsNotNone(evidence.fault)
                self.assertEqual(evidence.txt_path.read_bytes(), packet)

    def test_status_exact_version_gpio_de_and_duplicates(self):
        good = bridge.parse_status(GOOD_STATUS.rstrip(b"\n"))
        self.assertEqual(good.field("stage"), "0")
        self.assertEqual(good.field("read_used"), "0")
        for bad in (
            GOOD_STATUS.replace(b"SME105_USB_BRIDGE_V1", b"OTHER"),
            GOOD_STATUS.replace(b"DE=LOW", b"DE=HIGH"),
            GOOD_STATUS.replace(b"auto_tx=0", b"auto_tx=1"),
            GOOD_STATUS.replace(b"gate4=1", b"gate4=0"),
            GOOD_STATUS.replace(b"stage=0", b"stage=9"),
            GOOD_STATUS.replace(b" fault=0", b""),
            GOOD_STATUS.replace(b" pad_rx=0", b" pad_rx=0 pad_rx=0"),
        ):
            with self.subTest(bad=bad[:45]), self.assertRaises(bridge.BridgeError):
                bridge.parse_status(bad.rstrip(b"\n"))


class BridgeTerminalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)

    def start_client(self, port: FakePort):
        evidence = bridge.EvidenceRecorder(self.folder)
        output: list[str] = []
        client = bridge.BridgeClient(port, evidence, output.append)
        client.start()
        client.verify_identity()
        self.addCleanup(lambda: client.close() if not evidence.closed else None)
        return client, evidence, output

    def test_hello_status_pins_are_usb_only_and_listen_is_passive(self):
        port = FakePort()
        client, evidence, _ = self.start_client(port)
        self.assertEqual(port.writes, [b"HELLO\n", b"STATUS\n", b"PINS\n"])
        client.execute("LISTEN", lambda _: False)
        client.wait_end(2)
        client.stop()
        client.close()
        self.assertIn(b"LISTEN_9600\n", port.writes)
        self.assertNotIn(b"OBSERVE\n", port.writes)
        self.assertNotIn(b"ARM_A4\n", port.writes)
        self.assertEqual(evidence.bin_path.read_bytes(), b"\x00\x6d\xcc")
        self.assertIsNone(client.fault)

    def test_car_hello_requires_confirmation_and_dispatches_observe_once(self):
        port = FakePort()
        client, evidence, _ = self.start_client(port)
        client.execute("HELLO", lambda _: False)
        self.assertNotIn(b"OBSERVE\n", port.writes)
        client.execute("HELLO", lambda name: name == "HELLO")
        client.wait_end(2)
        self.assertEqual(port.writes.count(b"OBSERVE\n"), 1)
        with self.assertRaisesRegex(bridge.BridgeError, "already attempted"):
            client.execute("HELLO", lambda _: True)
        client.stop()
        client.close()
        self.assertEqual(evidence.bin_path.read_bytes(), b"\x00\x6d\xcc")

    def test_arm_ack_second_approval_and_matching_source(self):
        port = FakePort()
        client, evidence, _ = self.start_client(port)
        approvals = []
        def authorize(name: str) -> bool:
            approvals.append(name)
            return True
        client.execute("REQUEST_A4", authorize)
        client.wait_end(2)
        self.assertEqual(approvals, ["REQUEST_A4", "READ_A4"])
        self.assertIn(b"ARM_A4\n", port.writes)
        self.assertIn(b"READ_A4\n", port.writes)
        self.assertNotIn(b"READ_0E\n", port.writes)
        client.stop()
        client.close()
        self.assertEqual(evidence.rx_bytes, 3)
        self.assertIsNone(client.fault)
        with self.assertRaisesRegex(bridge.BridgeError, "already attempted"):
            client.execute("REQUEST_A4", lambda _: True)

    def test_request_second_confirmation_cancel_or_wrong_arm_never_sends_read(self):
        for port, authorize in (
            (FakePort(), lambda name: name == "REQUEST_A4"),
            (FakePort(bad_arm=True), lambda _: True),
        ):
            with self.subTest(wrong_arm=port.bad_arm):
                client, _, _ = self.start_client(port)
                if port.bad_arm:
                    with self.assertRaisesRegex(bridge.BridgeError, "wrong ARM"):
                        client.execute("REQUEST_A4", authorize)
                else:
                    client.execute("REQUEST_A4", authorize)
                self.assertIn(b"ARM_A4\n", port.writes)
                self.assertNotIn(b"READ_A4\n", port.writes)
                client.stop()
                client.close()

    def test_reported_gpio17_mismatch_locks_future_transmission(self):
        port = FakePort(mismatch=True)
        client, evidence, _ = self.start_client(port)
        client.execute("REQUEST_A4", lambda _: True)
        with self.assertRaises(bridge.BridgeError):
            client.wait_end(2)
        self.assertIn("GPIO17", client.fault)
        self.assertEqual(evidence.rx_bytes, 3)
        with self.assertRaises(bridge.BridgeError):
            client.execute("HELLO", lambda _: True)
        client.close()

    def test_firmware_end_count_mismatch_is_an_integrity_fault(self):
        port = FakePort(wrong_count=True)
        client, evidence, _ = self.start_client(port)
        client.execute("LISTEN", lambda _: False)
        with self.assertRaises(bridge.BridgeError):
            client.wait_end(2)
        self.assertIn("RX count mismatch", client.fault)
        client.close()
        self.assertEqual(evidence.bin_path.read_bytes(), b"\x00\x6d\xcc")

    def test_main_cli_read_only_no_implicit_observe_with_stop_and_hash(self):
        port = FakePort()
        output = []
        with patch.object(bridge.serial, "Serial", return_value=port):
            result = bridge.main(
                ["--port", "FAKE", "--output-dir", str(self.folder),
                 "--startup-seconds", "0", "--command", "STATUS"],
                input_fn=lambda _: "NOT_USED",
                display=output.append,
            )
        self.assertEqual(result, 0)
        self.assertEqual(port.writes,
                         [b"HELLO\n", b"STATUS\n", b"PINS\n", b"STOP\n"])
        self.assertTrue(port.closed)
        self.assertTrue(any("SHA256=" in line for line in output))
        self.assertEqual(len(list(self.folder.glob("*.bin"))), 1)
        self.assertEqual(next(self.folder.glob("*.bin")).read_bytes(), b"")

    def test_main_interactive_receives_while_prompt_waits(self):
        port = FakePort()
        output = []
        inputs = iter(("LISTEN", "EXIT"))
        def ui(prompt):
            answer = next(inputs)
            if answer == "EXIT":
                self.assertTrue(port.rx_seen.wait(1), "serial reader blocked at user prompt")
                time.sleep(0.05)
            return answer
        with patch.object(bridge.serial, "Serial", return_value=port):
            code = bridge.main(["--port", "FAKE", "--output-dir", str(self.folder),
                                "--startup-seconds", "0"],
                               input_fn=ui, display=output.append)
        self.assertEqual(code, 0, output[-5:])
        self.assertIn(b"LISTEN_9600\n", port.writes)
        self.assertIn(b"STOP\n", port.writes)
        self.assertEqual(next(self.folder.glob("*.bin")).read_bytes(), b"\x00\x6d\xcc")

    def test_wrong_firmware_never_sends_vehicle_command(self):
        port = FakePort(status=GOOD_STATUS.replace(b"DE=LOW", b"DE=HIGH"))
        with patch.object(bridge.serial, "Serial", return_value=port):
            result = bridge.main(
                ["--port", "FAKE", "--output-dir", str(self.folder),
                 "--startup-seconds", "0", "--command", "REQUEST_A4"],
                input_fn=lambda _: "SEND REQUEST_A4",
                display=lambda _: None,
            )
        self.assertNotEqual(result, 0)
        self.assertNotIn(b"ARM_A4\n", port.writes)
        self.assertNotIn(b"READ_A4\n", port.writes)
        self.assertNotIn(b"OBSERVE\n", port.writes)

    def test_no_raw_write_api(self):
        port = FakePort()
        client, _, _ = self.start_client(port)
        for command in ("HEX 01B0", "CLEAR", "DESK", "ARM_X", "TX_RAW"):
            with self.assertRaises(bridge.BridgeError):
                client.execute(command, lambda _: True)
        self.assertFalse(any(line.startswith(b"READ_") for line in port.writes))
        client.stop()
        client.close()


if __name__ == "__main__":
    unittest.main()
