"""Host-only WiFi provisioning/token and authenticated TCP fake-server tests."""

from __future__ import annotations

import hashlib
import os
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import sme105_usb_bridge as bridge
from scripts import sme105_wifi_setup as setup
from tests.test_sme105_usb_bridge import GOOD_STATUS, RX_LINES, FakePort

TOKEN = b"0123456789abcdef0123456789abcdef"


class LocalTcpFirmware:
    """One loopback TCP accept, AUTH-first firmware, no ECU/hardware traffic."""

    def __init__(self, *, allow_auth: bool = True,
                 drop_after_auth: bool = False, bad_auth_reply: bool = False):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.listener.settimeout(3)
        self.port = self.listener.getsockname()[1]
        self.allow_auth = allow_auth
        self.bad_auth_reply = bad_auth_reply
        self.drop_after_auth = drop_after_auth
        self.commands: list[bytes] = []
        self.auth_attempt: bytes | None = None
        self.failed = None
        self._done = threading.Event()
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.listener.close()
        self._done.wait(3)
        self.thread.join(timeout=3)

    @staticmethod
    def read_line(conn: socket.socket) -> bytes:
        line = bytearray()
        while not line.endswith(b"\n"):
            data = conn.recv(1)
            if not data:
                break
            line.extend(data)
            if len(line) > 128:
                raise AssertionError("unbounded TCP command")
        return bytes(line)

    def _serve(self):
        try:
            with self.listener.accept()[0] as conn:
                conn.settimeout(3)
                self.auth_attempt = self.read_line(conn)
                if not self.allow_auth:
                    conn.sendall(b"AUTH FAIL\n")
                    return
                if self.auth_attempt != b"AUTH " + TOKEN + b"\n":
                    conn.sendall(b"AUTH FAIL\n")
                    return
                if self.bad_auth_reply:
                    conn.sendall(b"AUTH OK extra\n")
                    return
                conn.sendall(b"AUTH OK\n")
                if self.drop_after_auth:
                    return
                while True:
                    command = self.read_line(conn)
                    if not command:
                        break
                    self.commands.append(command)
                    if command == b"HELLO\n":
                        conn.sendall(bridge.HELLO_REPLY + b"\n")
                    elif command == b"STATUS\n":
                        conn.sendall(GOOD_STATUS)
                    elif command == b"PINS\n":
                        conn.sendall(bridge.PINS_REPLY + b"\n")
                    elif command == b"LISTEN_9600\n":
                        conn.sendall(b"EVENT session=LISTEN_9600 origin=RO_ONLY no_tx=1\n")
                        conn.sendall(RX_LINES)
                        conn.sendall(
                            b"END reason=15 ro_bytes=3 ro_lost=0 uart_errors=0 "
                            b"pad_verified=0 words_started=0 ecu_verified=0 dtc_verified=0 DE=LOW\n"
                        )
                    elif command == b"STOP\n":
                        conn.sendall(b"EVENT stop=idle DE=LOW\n")
                    else:
                        raise AssertionError(f"unapproved TCP command {command!r}")
        except (OSError, AssertionError) as exc:
            self.failed = exc
        finally:
            self._done.set()


class FakeSetupPort(FakePort):
    def __init__(self, *, invalid_ack: bool = False,
                 asynchronous_connect: bool = False):
        super().__init__()
        self.invalid_ack = invalid_ack
        self.asynchronous_connect = asynchronous_connect
        self.wifi_status_queries = 0
        self.config_payload: bytes | None = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def write(self, data: bytes) -> int:
        if data.startswith(b"WIFI_CONFIG "):
            self.writes.append(b"WIFI_CONFIG <private>\n")
            self.config_payload = data
            self._emit(
                b"DENIED wifi_config_invalid\n" if self.invalid_ack else
                b"WIFI_CONFIG OK saved=1 reconnecting=1\n"
            )
            return len(data)
        if data == b"WIFI_STATUS\n":
            self.writes.append(data)
            self.wifi_status_queries += 1
            if self.asynchronous_connect and self.wifi_status_queries == 1:
                self._emit(b"WIFI_STATUS state=CONNECTING ip=0.0.0.0 "
                           b"port=8765 clients=0 host=NONE\n")
            elif self.asynchronous_connect and self.wifi_status_queries == 2:
                self._emit(b"WIFI_STATUS state=CONNECTED ip=192.168.1.12 "
                           b"port=8765 clients=0 host=NONE\n")
            else:
                self._emit(b"WIFI_STATUS state=CONNECTED ip=192.168.1.12 "
                           b"port=8765 clients=0 host=sme105-bridge.local\n")
            return len(data)
        if data == b"WIFI_TOKEN\n":
            self.writes.append(data)
            self._emit(b"WIFI_TOKEN " + TOKEN + b"\n")
            return len(data)
        return super().write(data)


class CredentialsAndStorageTests(unittest.TestCase):
    def test_documented_direct_script_entrypoint_imports_bridge(self):
        # Regression: `PYTHONPATH=src python scripts/sme105_wifi_setup.py`
        # used to fail before displaying help with ModuleNotFoundError: scripts.
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(
            [sys.executable, str(root / "scripts" / "sme105_wifi_setup.py"), "--help"],
            cwd=root,
            env={**os.environ, "PYTHONPATH": "src"},
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("--port", result.stdout)

    def test_ssid_wpa_bounds_and_valid_b64(self):
        name, password = setup.validate_credentials("Lab WiFi", "password with spaces")
        wire = setup.wifi_config_command(name, password)
        self.assertTrue(wire.startswith(b"WIFI_CONFIG "))
        self.assertNotIn(name, wire)
        self.assertNotIn(password, wire)
        for invalid in (("", "12345678"), ("x" * 33, "12345678"),
                        ("good", "1234567"), ("good", "q" * 64),
                        ("bad\nssid", "12345678"), ("good", "no\tgood123"),
                        ("good", "pässword123")):
            with self.subTest(invalid=invalid[0][:6]), self.assertRaises(
                    setup.ProvisioningError):
                setup.validate_credentials(*invalid)

    def test_wifi_status_and_token_parsing_rejects_ambiguous_lines(self):
        self.assertEqual(
            setup.parse_wifi_status(
                b"WIFI_STATUS state=CONNECTED ip=192.168.1.12 "
                b"port=8765 clients=0 host=sme105-bridge.local"
            ), ("CONNECTED", "192.168.1.12")
        )
        self.assertEqual(
            setup.parse_wifi_status(
                b"WIFI_STATUS state=CONNECTING ip=0.0.0.0 "
                b"port=8765 clients=0 host=sme105-bridge.local"
            ), ("CONNECTING", None)
        )
        self.assertEqual(
            setup.parse_wifi_status(
                b"WIFI_STATUS state=CONNECTED ip=192.168.1.12 "
                b"port=8765 clients=0 host=NONE"
            ), ("CONNECTING", None)
        )
        self.assertEqual(setup.parse_wifi_token(b"WIFI_TOKEN " + TOKEN), TOKEN)
        common = b" port=8765 clients=0 host=sme105-bridge.local"
        for reply in (b"WIFI_STATUS state=CONNECTING ip=192.168.1.12" + common,
                      b"WIFI_STATUS state=CONNECTED ip=999.168.1.12" + common,
                      b"WIFI_STATUS state=CONNECTED ip=192.168.1.12 ip=1.1.1.1" + common,
                      b"WIFI_STATUS state=CONNECTED ip=127.0.0.1" + common):
            with self.subTest(reply=reply), self.assertRaises(setup.ProvisioningError):
                setup.parse_wifi_status(reply)
        for reply in (b"WIFI_TOKEN " + TOKEN + b" extra",
                      b"WIFI_TOKEN " + TOKEN[:-1], b"WIFI_TOKEN none"):
            with self.subTest(reply=reply), self.assertRaises(setup.ProvisioningError):
                setup.parse_wifi_token(reply)

    def test_token_private_atomic_and_no_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "cfg" / "bridge-token"
            setup.save_token(path, TOKEN)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(bridge.load_wifi_token(path), TOKEN)
            with self.assertRaises(setup.ProvisioningError):
                setup.save_token(path, b"f" * 32)
            setup.save_token(path, b"f" * 32, replace=True)
            self.assertEqual(bridge.load_wifi_token(path), b"f" * 32)
            path.chmod(0o644)
            with self.assertRaises(bridge.BridgeError):
                bridge.load_wifi_token(path)
            other = Path(folder) / "other"
            other.write_bytes(TOKEN)
            path.unlink()
            path.symlink_to(other)
            with self.assertRaises(bridge.BridgeError):
                bridge.load_wifi_token(path)

    def test_usb_provision_credentials_no_logging_and_no_ecu_commands(self):
        with tempfile.TemporaryDirectory() as folder:
            port = FakeSetupPort()
            output: list[str] = []
            password = "PRIVATE_PASSWORD_123"
            ssid = "private access point"
            with patch.object(setup.serial, "Serial", return_value=port):
                result = setup.main(
                    ["--port", "FAKE", "--token-file",
                     str(Path(folder) / "bridge-token"), "--startup-seconds", "0"],
                    ask_ssid=lambda _: ssid, ask_password=lambda _: password,
                    display=output.append,
                )
            self.assertEqual(result, 0, output)
            self.assertTrue(port.closed)
            self.assertIn(b"WIFI_STATUS\n", port.writes)
            self.assertIn(b"WIFI_TOKEN\n", port.writes)
            self.assertFalse(any(command in port.writes for command in (
                b"OBSERVE\n", b"READ_A4\n", b"READ_0E\n",
                b"LISTEN_9600\n", b"ARM_A4\n",
            )))
            text = "\n".join(output)
            self.assertNotIn(ssid, text)
            self.assertNotIn(password, text)
            self.assertNotIn(TOKEN.decode(), text)
            self.assertEqual(
                bridge.load_wifi_token(Path(folder) / "bridge-token"), TOKEN
            )

    def test_usb_rejected_config_preserves_no_token(self):
        with tempfile.TemporaryDirectory() as folder:
            port = FakeSetupPort(invalid_ack=True)
            target = Path(folder) / "bridge-token"
            output = []
            with patch.object(setup.serial, "Serial", return_value=port):
                code = setup.main(
                    ["--port", "FAKE", "--token-file", str(target),
                     "--startup-seconds", "0"],
                    ask_ssid=lambda _: "Office",
                    ask_password=lambda _: "password123", display=output.append,
                )
            self.assertNotEqual(code, 0)
            self.assertFalse(target.exists())
            self.assertNotIn(b"WIFI_TOKEN\n", port.writes)
            self.assertNotIn("password123", "\n".join(output))

    def test_usb_connecting_and_mdns_pending_poll_without_resending_password(self):
        with tempfile.TemporaryDirectory() as folder:
            port = FakeSetupPort(asynchronous_connect=True)
            output: list[str] = []
            with patch.object(setup.serial, "Serial", return_value=port), patch.object(
                    setup.time, "sleep", return_value=None):
                code = setup.main(
                    ["--port", "FAKE", "--token-file", str(Path(folder) / "bridge-token"),
                     "--startup-seconds", "0"],
                    ask_ssid=lambda _: "Office", ask_password=lambda _: "valid ascii pass",
                    display=output.append,
                )
            self.assertEqual(code, 0, output)
            self.assertEqual(port.wifi_status_queries, 3)
            self.assertEqual(port.writes.count(b"WIFI_CONFIG <private>\n"), 1)
            self.assertNotIn("valid ascii pass", "\n".join(output))

    def test_bad_firmware_identity_denies_usb_secret_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            port = FakeSetupPort()
            port.status_line = GOOD_STATUS.replace(b"auto_tx=0", b"auto_tx=1")
            with patch.object(setup.serial, "Serial", return_value=port):
                result = setup.main(
                    ["--port", "FAKE", "--token-file",
                     str(Path(folder) / "bridge-token"), "--startup-seconds", "0"],
                    ask_ssid=lambda _: "Office", ask_password=lambda _: "secure passphrase",
                    display=lambda _: None,
                )
            self.assertNotEqual(result, 0)
            self.assertIsNone(port.config_payload)
            self.assertNotIn(b"WIFI_TOKEN\n", port.writes)


class AuthenticatedTcpTests(unittest.TestCase):
    def private_token(self, folder: Path) -> Path:
        path = folder / "bridge-token"
        setup.save_token(path, TOKEN)
        return path

    def test_auth_before_any_control_no_auto_tx_and_byte_exact_capture(self):
        with tempfile.TemporaryDirectory() as folder, LocalTcpFirmware() as fw:
            path = self.private_token(Path(folder))
            output: list[str] = []
            result = bridge.main(
                ["--host", "127.0.0.1", "--tcp-port", str(fw.port),
                 "--token-file", str(path), "--output-dir", folder,
                 "--command", "LISTEN", "--seconds", "3"],
                display=output.append, input_fn=lambda _: "DO_NOT_AUTHORIZE",
            )
            self.assertEqual(result, 0, output[-4:])
            self.assertEqual(fw.auth_attempt, b"AUTH " + TOKEN + b"\n")
            self.assertEqual(
                fw.commands,
                [b"HELLO\n", b"STATUS\n", b"PINS\n",
                 b"STATUS\n", b"LISTEN_9600\n", b"STOP\n"],
            )
            self.assertFalse(fw.failed)
            evidence = next(Path(folder).glob("*-usb-bridge.txt")).read_bytes()
            binary = next(Path(folder).glob("*-usb-bridge.bin")).read_bytes()
            self.assertEqual(binary, b"\x00\x6d\xcc")
            self.assertNotIn(b"AUTH ", evidence)
            self.assertNotIn(TOKEN, evidence)
            self.assertEqual(hashlib.sha256(binary).hexdigest(),
                             hashlib.sha256(b"\x00\x6d\xcc").hexdigest())
            self.assertNotIn(TOKEN.decode(), "\n".join(output))

    def test_auth_rejected_no_bridge_commands(self):
        with tempfile.TemporaryDirectory() as folder, LocalTcpFirmware(
                allow_auth=False) as fw:
            path = self.private_token(Path(folder))
            result = bridge.main(
                ["--host", "127.0.0.1", "--tcp-port", str(fw.port),
                 "--token-file", str(path), "--output-dir", folder,
                 "--command", "REQUEST_A4"],
                display=lambda _: None, input_fn=lambda _: "SEND REQUEST_A4",
            )
            self.assertNotEqual(result, 0)
            self.assertEqual(fw.commands, [])
            self.assertEqual(fw.auth_attempt, b"AUTH " + TOKEN + b"\n")

    def test_wrong_token_and_malformed_reply_no_commands(self):
        for bad_reply in (True, False):
            with self.subTest(bad_reply=bad_reply), LocalTcpFirmware(
                    bad_auth_reply=bad_reply) as fw:
                wrong_token = TOKEN if bad_reply else b"f" * 32
                with self.assertRaises(bridge.BridgeError):
                    bridge.AuthenticatedTcpPort("127.0.0.1", wrong_token, port=fw.port)
                self.assertEqual(fw.commands, [])

    def test_disconnect_fails_closed_and_no_reconnect(self):
        with LocalTcpFirmware(drop_after_auth=True) as fw:
            tcp = bridge.AuthenticatedTcpPort("127.0.0.1", TOKEN, port=fw.port)
            try:
                with self.assertRaises(bridge.BridgeError):
                    for _ in range(10):
                        tcp.read(4096)
                        time.sleep(0.01)
            finally:
                tcp.close()
            self.assertEqual(fw.commands, [])

    def test_no_unsafe_token_path_or_host(self):
        for host in ("", "https://bridge", "bridge.local:8765", "bad\r\nAUTH"):
            with self.subTest(host=host), self.assertRaises(bridge.BridgeError):
                bridge.AuthenticatedTcpPort(host, TOKEN)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "bridge-token"
            path.write_bytes(TOKEN)
            path.chmod(0o644)
            with self.assertRaises(bridge.BridgeError):
                bridge.load_wifi_token(path)


if __name__ == "__main__":
    unittest.main()
