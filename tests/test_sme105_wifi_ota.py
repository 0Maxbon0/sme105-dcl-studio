"""Offline signed-image and one-shot authenticated OTA socket regression tests.

Every key in this test file is ephemeral and randomly generated in a temp
directory. Never load or sign with the owner's actual OTA private key.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import socket
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import sme105_wifi_ota as ota
from scripts.sme105_wifi_setup import save_token
from tests.test_sme105_usb_bridge import GOOD_STATUS

TEST_TOKEN = b"0123456789abcdef0123456789abcdef"
OTA_COMMAND = re.compile(
    rb"^OTA_BEGIN2 ([1-9][0-9]*) ([0-9a-f]{64}) ([1-9][0-9]*) "
    rb"([A-Za-z0-9+/=]+)\n$"
)


class EphemeralSignedBundle(unittest.TestCase):
    """A new, untrusted test signer intentionally different from production."""

    def setUp(self) -> None:
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        root = Path(self.scratch.name)
        self.private = root / "temporary-ecdsa-private.pem"
        self.public = root / "temporary-ecdsa-public.pem"
        self.firmware = root / "firmware.bin"
        self.manifest = root / "firmware.ota.json"
        self.token_path = root / "token"
        # openssl tooling is used only for generating TEMPORARY test keys.
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "EC",
             "-pkeyopt", "ec_paramgen_curve:P-256",
             "-out", str(self.private)],
            check=True, capture_output=True, timeout=10,
        )
        self.private.chmod(0o600)
        subprocess.run(
            ["openssl", "pkey", "-in", str(self.private),
             "-pubout", "-out", str(self.public)],
            check=True, capture_output=True, timeout=10,
        )
        der = subprocess.run(
            ["openssl", "pkey", "-pubin", "-in", str(self.public), "-outform", "DER"],
            check=True, capture_output=True, timeout=10,
        ).stdout
        self.pin = patch.object(ota, "PINNED_PUBLIC_KEY_SHA256",
                                hashlib.sha256(der).hexdigest())
        self.pin.start()
        self.addCleanup(self.pin.stop)
        # Placeholder ESP32 app image. No real firmware and no hardware.
        self.firmware.write_bytes(b"\xE9" + bytes(range(256)) * 256)
        self.signed = ota.sign_manifest(
            self.firmware, self.manifest, 2, self.private, self.public
        )
        save_token(self.token_path, TEST_TOKEN)


class TestSignedManifest(EphemeralSignedBundle):
    def test_canonical_signed_message_exact(self) -> None:
        expected = (
            b"SME105-OTA-V1\nesp32dev\n65537\n" +
            hashlib.sha256(self.firmware.read_bytes()).hexdigest().encode("ascii") +
            b"\n2\n"
        )
        self.assertEqual(self.signed.signed_bytes, expected)
        data = json.loads(self.manifest.read_text())
        self.assertEqual(
            self.manifest.read_bytes(),
            (json.dumps(data, separators=(",", ":"), sort_keys=True) + "\n").encode(),
        )
        self.assertEqual(data["version"], 2)
        self.assertEqual(data["board"], "esp32dev")
        self.assertEqual(data["protocol"], "SME105-OTA-V1")
        self.assertEqual(base64.b64decode(data["signature"]), self.signed.signature)
        self.assertEqual(ota.verify_bundle(self.firmware, self.manifest, self.public),
                         self.signed)

    def test_manifest_tamper_wrong_board_digest_size_version_signature(self) -> None:
        orig = json.loads(self.manifest.read_text())
        cases = [
            {"version": 3},
            {"board": "esp8266"},
            {"protocol": "SME105-OTA-V0"},
            {"size": orig["size"] + 1},
            {"sha256": "f" * 64},
            {"signature": base64.b64encode(b"0" * 70).decode("ascii")},
        ]
        for i, altered in enumerate(cases):
            with self.subTest(case=i):
                manifest = self.manifest.with_name(f"changed-{i}.json")
                manifest.write_bytes(ota._manifest_json(orig | altered))
                with self.assertRaises(ota.OTAError):
                    ota.verify_bundle(self.firmware, manifest, self.public)

    def test_noncanonical_duplicate_and_noninteger_version_fail(self) -> None:
        obj = json.loads(self.manifest.read_text())
        bads = [
            json.dumps(obj, indent=2).encode(),
            self.manifest.read_bytes().rstrip(b"\n"),
            (self.manifest.read_bytes().rstrip(b"\n")[:-1] +
             b',"version":2}\n'),
            ota._manifest_json(obj | {"version": "2"}),
            ota._manifest_json(obj | {"version": True}),
            ota._manifest_json(obj | {"version": -1}),
        ]
        for i, data in enumerate(bads):
            with self.subTest(case=i):
                file = self.manifest.with_name(f"malformed-{i}.json")
                file.write_bytes(data)
                with self.assertRaises(ota.OTAError):
                    ota.verify_bundle(self.firmware, file, self.public)

    def test_image_corruption_symlink_size_and_magic(self) -> None:
        self.firmware.write_bytes(b"\xE9" + b"X" * 65536)
        with self.assertRaisesRegex(ota.OTAError, "does not match"):
            ota.verify_bundle(self.firmware, self.manifest, self.public)
        self.firmware.write_bytes(b"BAD MAGIC" + b"X" * 65536)
        with self.assertRaises(ota.OTAError):
            ota.verify_bundle(self.firmware, self.manifest, self.public)
        self.firmware.write_bytes(b"\xE9" * (ota.MAX_APP_BYTES + 1))
        with self.assertRaises(ota.OTAError):
            ota.verify_bundle(self.firmware, self.manifest, self.public)
        symlink = self.firmware.with_name("linked.bin")
        symlink.symlink_to(self.firmware)
        with self.assertRaises(ota.OTAError):
            ota.verify_bundle(symlink, self.manifest, self.public)

    def test_wrong_public_key_pin_and_signing_key_perms(self) -> None:
        with patch.object(ota, "PINNED_PUBLIC_KEY_SHA256", "0" * 64), self.assertRaisesRegex(
                ota.OTAError, "trust anchor"):
            ota.verify_bundle(self.firmware, self.manifest, self.public)
        self.private.chmod(0o644)
        new_manifest = self.manifest.with_name("bad-priv.json")
        with self.assertRaisesRegex(ota.OTAError, "mode 0600"):
            ota.sign_manifest(self.firmware, new_manifest, 3,
                              self.private, self.public)
        self.assertFalse(new_manifest.exists())

    def test_no_manifest_overwrite_no_signing_key_output(self) -> None:
        before = self.manifest.read_bytes()
        with self.assertRaises(ota.OTAError):
            ota.sign_manifest(self.firmware, self.manifest, 3,
                              self.private, self.public)
        self.assertEqual(before, self.manifest.read_bytes())
        with patch.object(ota, "PINNED_PUBLIC_KEY_SHA256", "0" * 64), self.assertRaises(
                ota.OTAError):
            ota.sign_manifest(self.firmware,
                              self.manifest.with_name("bad-sign.json"), 3,
                              self.private, self.public)

    def test_sec1_private_key_rejected_without_creating_manifest(self) -> None:
        sec1 = self.private.with_name("not-pkcs8.pem")
        subprocess.run(
            ["openssl", "ec", "-in", str(self.private), "-out", str(sec1)],
            check=True, capture_output=True, timeout=10,
        )
        sec1.chmod(0o600)
        self.assertIn(b"BEGIN EC PRIVATE KEY", sec1.read_bytes())
        target = self.manifest.with_name("sec1-rejected.json")
        with self.assertRaisesRegex(ota.OTAError, "PKCS#8"):
            ota.sign_manifest(self.firmware, target, 3, sec1, self.public)
        self.assertFalse(target.exists())

    def test_default_cli_offline_does_not_contact_wifi(self) -> None:
        output: list[str] = []
        with patch.object(ota, "OTAConnection", side_effect=AssertionError("network")):
            code = ota.main([
                "--firmware", str(self.firmware),
                "--manifest", str(self.manifest),
                "--public-key", str(self.public),
            ], display=output.append)
        self.assertEqual(code, 0)
        self.assertTrue(any("Offline-only" in line for line in output))
        self.assertFalse(any("private" in line for line in output))


class FakeOTAServer:
    def __init__(self, *, mode: str = "okay"):
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(2)
        self.listener.settimeout(5)
        self.port = self.listener.getsockname()[1]
        self.mode = mode
        self.received: list[bytes] = []
        self.auth: bytes | None = None
        self.postboot_auth: bytes | None = None
        self.postboot_commands: list[bytes] = []
        self.confirm_count = 0
        self.received_image = b""
        self.acknowledged: list[int] = []
        self.error: Exception | None = None
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.done = threading.Event()

    @staticmethod
    def _line(conn: socket.socket) -> bytes:
        data = bytearray()
        while not data.endswith(b"\n"):
            one = conn.recv(1)
            if not one:
                break
            data.extend(one)
            if len(data) > 256:
                raise RuntimeError("unbounded command from OTA host")
        return bytes(data)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.listener.close()
        self.done.wait(3)
        self.thread.join(timeout=3)

    def _serve_transient_reboot(self, *, version: int, size: int) -> None:
        """Optional authenticated prior boot, before the new partition starts."""
        with self.listener.accept()[0] as conn:
            conn.settimeout(3)
            if self._line(conn) != b"AUTH " + TEST_TOKEN + b"\n":
                raise AssertionError("transient reboot AUTH mismatch")
            if self.mode == "lost_auth_old":
                conn.sendall(b"AUTH FAIL\n")
                return
            conn.sendall(b"AUTH OK\n")
            if self._line(conn) != b"HELLO\n":
                raise AssertionError("transient reboot HELLO missing")
            if self.mode == "lost_busy":
                conn.sendall(b"DENIED ota_busy\r\n")
                return
            conn.sendall(
                b"HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1\r\n"
            )
            if self._line(conn) != b"STATUS\n":
                raise AssertionError("transient reboot STATUS missing")
            conn.sendall(GOOD_STATUS.rstrip(b"\n") + b"\r\n")
            if self._line(conn) != b"PINS\n":
                raise AssertionError("transient reboot PINS missing")
            conn.sendall(
                b"PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 "
                b"di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1\r\n"
            )
            if self._line(conn) != b"OTA_STATUS\n":
                raise AssertionError("transient reboot OTA_STATUS missing")
            reported_size = size - 1 if self.mode == "lost_bad_transition" else size
            conn.sendall(
                f"OTA_STATUS state=REBOOT_PENDING received={reported_size} "
                f"size={size} running=ota_0 boot=ota_1 "
                f"accepted_version={version - 1} boot_health=VALID "
                "confirm_required=0 rollback=1\r\n".encode()
            )

    def _serve_postboot(self, *, version: int, digest: str) -> None:
        """Fresh authenticated device after simulated ESP32 reboot."""
        with self.listener.accept()[0] as conn:
            conn.settimeout(3)
            self.postboot_auth = self._line(conn)
            if self.postboot_auth != b"AUTH " + TEST_TOKEN + b"\n":
                conn.sendall(b"DENIED auth\n")
                return
            if self.mode == "lost_auth_denied":
                conn.sendall(b"AUTH FAIL\n")
                return
            conn.sendall(b"AUTH OK\n")
            confirmed = False
            polls_after_confirmation = 0
            while True:
                command = self._line(conn)
                if not command:
                    break
                self.postboot_commands.append(command)
                if command == b"HELLO\n":
                    conn.sendall(
                        b"HELLO SME105_USB_BRIDGE_V1 protocol=1 "
                        b"usb_baud=115200 no_auto_tx=1\r\n"
                    )
                elif command == b"STATUS\n":
                    conn.sendall(GOOD_STATUS.rstrip(b"\n") + b"\r\n")
                elif command == b"PINS\n":
                    conn.sendall(
                        b"PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 "
                        b"di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1\r\n"
                    )
                elif command == b"OTA_STATUS\n":
                    if confirmed:
                        polls_after_confirmation += 1
                    marked_valid = confirmed and polls_after_confirmation >= 3
                    state = "VALID" if marked_valid else "PENDING_VERIFY"
                    accepted = version if marked_valid else version - 1
                    partition = "ota_1"
                    if not confirmed:
                        if self.mode in ("lost_old", "lost_rollback"):
                            state, partition = "VALID", "ota_0"
                        elif self.mode == "lost_nonpending":
                            state = "UNDEFINED"
                        elif self.mode == "lost_wrong_version":
                            accepted = version
                        elif self.mode == "lost_same_partition":
                            partition = "ota_0"
                        elif self.mode == "lost_bad_status":
                            conn.sendall(b"OTA_STATUS broken\r\n")
                            continue
                    conn.sendall(
                        f"OTA_STATUS state=IDLE received=0 size=0 running={partition} "
                        f"boot={partition} accepted_version={accepted} "
                        f"boot_health={state} "
                        f"confirm_required={1 if state == 'PENDING_VERIFY' else 0} "
                        "rollback=1\r\n"
                        .encode("ascii")
                    )
                elif command.startswith(b"OTA_CONFIRM "):
                    expected = f"OTA_CONFIRM {version} {digest}\n".encode()
                    if command != expected:
                        raise AssertionError("wrong signed digest/version in OTA_CONFIRM")
                    if confirmed:
                        raise AssertionError("OTA_CONFIRM automatically retried")
                    self.confirm_count += 1
                    confirmed = True
                    if self.mode == "lost_confirm_ack":
                        return
                    conn.sendall(f"OTA_CONFIRM OK version={version}\r\n".encode())
                else:
                    raise AssertionError(f"unsafe postboot command {command!r}")

    def _run(self) -> None:
        try:
            with self.listener.accept()[0] as conn:
                conn.settimeout(3)
                self.auth = self._line(conn)
                if self.auth != b"AUTH " + TEST_TOKEN + b"\n":
                    conn.sendall(b"AUTH FAIL\n")
                    return
                conn.sendall(b"AUTH OK\n")
                self.received.append(self._line(conn))
                if self.received[-1] != b"HELLO\n":
                    raise AssertionError("HELLO not first command after AUTH")
                conn.sendall(
                    b"HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1\r\n"
                )
                self.received.append(self._line(conn))
                if self.received[-1] != b"STATUS\n":
                    raise AssertionError("STATUS required before OTA")
                conn.sendall(
                    GOOD_STATUS.rstrip(b"\n") + b"\r\n"
                )
                self.received.append(self._line(conn))
                if self.received[-1] != b"PINS\n":
                    raise AssertionError("PINS required before OTA")
                conn.sendall(
                    b"PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 "
                    b"di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1\r\n"
                )
                self.received.append(self._line(conn))
                if self.received[-1] != b"OTA_STATUS\n":
                    raise AssertionError("OTA_STATUS required before OTA")
                current_version = 2 if self.mode == "check" else 1
                conn.sendall(
                    "OTA_STATUS state=IDLE received=0 size=0 "
                    "running=ota_0 boot=ota_0 "
                    f"accepted_version={current_version} "
                    "boot_health=VALID confirm_required=0 rollback=1\r\n".encode("ascii")
                )
                maybe_begin = self._line(conn)
                if not maybe_begin:
                    return  # second confirmation declined: no flash
                self.received.append(maybe_begin)
                manifest = OTA_COMMAND.fullmatch(maybe_begin)
                if manifest is None:
                    raise AssertionError("bad OTA_BEGIN frame")
                image_bytes = int(manifest[1])
                digest = manifest[2].decode("ascii")
                version = int(manifest[3])
                sig = base64.b64decode(manifest[4], validate=True)
                if sig[0] != 0x30:
                    raise AssertionError("wrong ECDSA signature")
                if self.mode == "bad_ready":
                    conn.sendall(b"OTA_READY size=999\r\n")
                    return
                if self.mode == "abort":
                    conn.sendall(b"OTA_FAIL reason=DENIED\r\n")
                    return
                conn.sendall(
                    f"OTA_READY size={image_bytes} chunk=8192\r\n".encode()
                )
                chunks = bytearray()
                for begin in range(0, image_bytes, 8192):
                    window_size = min(8192, image_bytes - begin)
                    while len(chunks) < begin + window_size:
                        piece = conn.recv(min(begin + window_size - len(chunks), 4096))
                        if not piece:
                            self.received_image = bytes(chunks)
                            return
                        chunks.extend(piece)
                    cumulative = begin + window_size
                    self.received_image = bytes(chunks)
                    if self.mode == "disconnect" and cumulative == 8192:
                        return
                    if cumulative < image_bytes:
                        if self.mode == "bad_progress" and cumulative == 8192:
                            conn.sendall(b"OTA_PROGRESS received=8191\r\n")
                            return
                        if self.mode == "early_ok" and cumulative == 8192:
                            conn.sendall(
                                f"OTA_OK version={version} sha256={digest} "
                                "rebooting=1\r\n".encode()
                            )
                            return
                        if self.mode == "replayed_progress" and cumulative == 16384:
                            conn.sendall(b"OTA_PROGRESS received=8192\r\n")
                            return
                        if self.mode == "malformed_progress" and cumulative == 8192:
                            conn.sendall(b"OTA_PROGRESS received=8192 extra=1\r\n")
                            return
                        if self.mode == "missing_progress" and cumulative == 8192:
                            return
                        conn.sendall(
                            f"OTA_PROGRESS received={cumulative}\r\n".encode()
                        )
                        self.acknowledged.append(cumulative)
                if self.mode == "bad_done":
                    conn.sendall(
                        f"OTA_OK version={version} sha256={'0'*64} rebooting=1\r\n".encode()
                    )
                    return
                if self.mode == "malformed_done":
                    conn.sendall(
                        f"OTA_OK version={version} sha256={digest} "
                        "rebooting=1 extra=1\r\n".encode()
                    )
                    return
                if self.mode == "partial_done":
                    conn.sendall(f"OTA_OK version={version}".encode())
                    return
                if self.mode == "silent_close":
                    return
                if not self.mode.startswith("lost_"):
                    conn.sendall(
                        f"OTA_OK version={version} sha256={digest} rebooting=1\r\n".encode()
                    )
            if self.mode in ("lost_busy", "lost_transition", "lost_bad_transition",
                             "lost_auth_old"):
                self._serve_transient_reboot(version=version, size=image_bytes)
            if self.mode == "okay" or (
                    self.mode.startswith("lost_") and
                    self.mode != "lost_bad_transition"):
                self._serve_postboot(version=version, digest=digest)
        except (OSError, AssertionError, RuntimeError) as exc:
            self.error = exc
        finally:
            self.done.set()


class TestOTAWire(EphemeralSignedBundle):
    def test_live_usb_flashed_ota_status_exact_protocol_and_confirm_guard(self):
        baseline = (
            b"OTA_STATUS state=IDLE received=0 size=0 running=app0 boot=app0 "
            b"accepted_version=1 boot_health=UNDEFINED confirm_required=0 rollback=1"
        )
        self.assertEqual(
            ota.OTAConnection._validate_ota_status(baseline),
            (1, "UNDEFINED", "app0"),
        )
        pending = (
            b"OTA_STATUS state=IDLE received=0 size=0 running=app1 boot=app1 "
            b"accepted_version=1 boot_health=PENDING_VERIFY confirm_required=1 rollback=1"
        )
        self.assertEqual(
            ota.OTAConnection._validate_ota_status(pending),
            (1, "PENDING_VERIFY", "app1"),
        )
        valid = (
            b"OTA_STATUS state=IDLE received=0 size=0 running=app1 boot=app1 "
            b"accepted_version=2 boot_health=VALID confirm_required=0 rollback=1"
        )
        self.assertEqual(
            ota.OTAConnection._validate_ota_status(valid),
            (2, "VALID", "app1"),
        )
        for malformed in (
            baseline.replace(b"confirm_required=0 ", b""),
            baseline.replace(b"confirm_required=0", b"confirm_required=1"),
            pending.replace(b"confirm_required=1", b"confirm_required=0"),
            valid.replace(b"confirm_required=0", b"confirm_required=1"),
            valid.replace(b"confirm_required=0", b"confirm_required=2"),
        ):
            with self.subTest(malformed=malformed), self.assertRaises(ota.OTAError):
                ota.OTAConnection._validate_ota_status(malformed)

    def cli(self, server: FakeOTAServer, approvals: list[bool]) -> tuple[int, list[str]]:
        prompt_iter = iter(approvals)
        attempts: list[str] = []
        output: list[str] = []
        def confirm(text: str) -> str:
            attempts.append(text)
            accepted = next(prompt_iter)
            return text.split("'")[1] if accepted else "NO"
        code = ota.main([
            "--firmware", str(self.firmware),
            "--manifest", str(self.manifest),
            "--public-key", str(self.public),
            "--token-file", str(self.token_path),
            "--host", "127.0.0.1",
            "--tcp-port", str(server.port),
            "--upload",
        ], ask=confirm, display=output.append)
        return code, output

    def test_exact_signed_manifest_auth_double_confirmation_and_full_image(self):
        with FakeOTAServer() as server:
            code, output = self.cli(server, [True, True])
        self.assertEqual(code, 0, output)
        self.assertEqual(server.auth, b"AUTH " + TEST_TOKEN + b"\n")
        self.assertEqual(server.received[:4], [b"HELLO\n", b"STATUS\n",
                                                b"PINS\n", b"OTA_STATUS\n"])
        self.assertEqual(server.received_image, self.signed.image)
        self.assertEqual(server.error, None)
        self.assertEqual(len(server.received), 5)
        self.assertEqual(server.postboot_auth, b"AUTH " + TEST_TOKEN + b"\n")
        self.assertEqual(server.confirm_count, 1)
        self.assertEqual(server.postboot_commands.count(b"OTA_CONFIRM 2 " +
                                                       self.signed.firmware_sha256.encode() +
                                                       b"\n"), 1)
        self.assertEqual(server.postboot_commands.count(b"OTA_STATUS\n"), 4)
        self.assertNotIn(TEST_TOKEN.decode(), "\n".join(output))
        self.assertTrue(any("postboot image health is VALID" in x for x in output))

    def test_first_confirmation_denied_no_tcp_connection(self):
        with patch.object(ota, "OTAConnection", side_effect=AssertionError("network")):
            code = ota.main([
                "--firmware", str(self.firmware),
                "--manifest", str(self.manifest),
                "--public-key", str(self.public),
                "--host", "127.0.0.1", "--upload",
            ], ask=lambda _: "NO", display=lambda _: None)
        self.assertEqual(code, 2)

    def test_second_confirmation_denied_no_ota_begin_or_firmware_bytes(self):
        with FakeOTAServer() as server:
            code, _ = self.cli(server, [True, False])
        self.assertEqual(code, 2)
        self.assertEqual(server.received, [b"HELLO\n", b"STATUS\n",
                                            b"PINS\n", b"OTA_STATUS\n"])
        self.assertEqual(server.received_image, b"")

    def test_bad_ready_denies_any_image_byte(self):
        with FakeOTAServer(mode="bad_ready") as server:
            code, output = self.cli(server, [True, True])
        self.assertEqual(code, 3, output)
        self.assertEqual(server.received_image, b"")

    def test_remote_abort_or_corrupt_completion_never_claims_success(self):
        for mode in ("abort", "bad_done", "malformed_done", "partial_done",
                     "silent_close", "disconnect"):
            with (self.subTest(mode=mode),
                  patch.object(ota, "POSTBOOT_CONFIRM_WINDOW_S", 1.2),
                  FakeOTAServer(mode=mode) as server):
                code, output = self.cli(server, [True, True])
                self.assertEqual(code, 3, output)
                self.assertFalse(any(x.startswith("Firmware reported matching") for x in output))
                self.assertEqual(server.received.count(b"HELLO\n"), 1)
                self.assertEqual(server.confirm_count, 0)

    def test_lost_final_ota_ok_recovers_only_exact_new_pending_boot(self):
        for mode in ("lost_pending", "lost_busy", "lost_transition",
                     "lost_auth_old"):
            with self.subTest(mode=mode), FakeOTAServer(mode=mode) as server:
                code, output = self.cli(server, [True, True])
            self.assertEqual(code, 0, output)
            self.assertEqual(server.received_image, self.signed.image)
            self.assertEqual(len(server.received), 5)
            self.assertEqual(server.postboot_auth, b"AUTH " + TEST_TOKEN + b"\n")
            self.assertEqual(server.confirm_count, 1)
            self.assertEqual(server.postboot_commands.count(
                f"OTA_CONFIRM 2 {self.signed.firmware_sha256}\n".encode()), 1)
            self.assertEqual(server.postboot_commands.count(b"OTA_STATUS\n"), 4)
            self.assertTrue(any("Final OTA_OK absent" in line for line in output))
            self.assertTrue(any("postboot image health is VALID" in line for line in output))
            self.assertIsNone(server.error)

    def test_lost_final_receipt_rejects_old_boot_nonpending_wrong_version_and_partition(self):
        for mode in ("lost_old", "lost_rollback", "lost_nonpending",
                     "lost_wrong_version", "lost_same_partition", "lost_bad_status",
                     "lost_bad_transition"):
            with self.subTest(mode=mode), FakeOTAServer(mode=mode) as server:
                code, output = self.cli(server, [True, True])
            self.assertEqual(code, 3, output)
            self.assertEqual(server.received_image, self.signed.image)
            self.assertEqual(server.confirm_count, 0)
            self.assertFalse(any("health is VALID" in line for line in output))
            self.assertIsNone(server.error)

    def test_postboot_auth_denied_after_reboot_grace_fails_without_confirmation(self):
        with (patch.object(ota, "REBOOT_AUTH_GRACE_S", 0),
              FakeOTAServer(mode="lost_auth_denied") as server):
            code, output = self.cli(server, [True, True])
        self.assertEqual(code, 3, output)
        self.assertEqual(server.confirm_count, 0)
        self.assertEqual(server.received_image, self.signed.image)
        self.assertFalse(any("health is VALID" in line for line in output))
        self.assertIsNone(server.error)

    def test_lost_postboot_confirmation_ack_never_resends_confirmation_or_image(self):
        with (patch.object(ota, "POSTBOOT_CONFIRM_WINDOW_S", 1.5),
              FakeOTAServer(mode="lost_confirm_ack") as server):
            code, output = self.cli(server, [True, True])
        self.assertEqual(code, 3, output)
        self.assertEqual(server.confirm_count, 1)
        self.assertEqual(server.received_image, self.signed.image)
        self.assertFalse(any("health is VALID" in line for line in output))
        self.assertIsNone(server.error)

    def test_stop_and_wait_upload_0_8mb_windows_and_final_reboot_confirm(self):
        size = 827936
        self.firmware.write_bytes(b"\xE9" + bytes(range(256)) * 3234 + b"\x00" * (size - 1 - 256 * 3234))
        self.manifest.unlink()
        self.signed = ota.sign_manifest(
            self.firmware, self.manifest, 2, self.private, self.public
        )
        self.assertEqual(len(self.signed.image), size)
        with FakeOTAServer() as server:
            code, output = self.cli(server, [True, True])
        self.assertEqual(code, 0, output)
        self.assertEqual(server.received_image, self.signed.image)
        self.assertEqual(len(server.acknowledged), (size - 1) // 8192)
        self.assertEqual(server.acknowledged,
                         list(range(8192, size, 8192)))
        self.assertEqual(server.confirm_count, 1)
        self.assertIsNone(server.error)

    def test_malformed_early_replayed_and_missing_progress_stop_next_window(self):
        expected_bytes = {
            "bad_progress": 8192,
            "early_ok": 8192,
            "malformed_progress": 8192,
            "missing_progress": 8192,
            "replayed_progress": 16384,
            "disconnect": 8192,
        }
        for mode, bound in expected_bytes.items():
            with self.subTest(mode=mode), FakeOTAServer(mode=mode) as server:
                code, output = self.cli(server, [True, True])
            self.assertEqual(code, 3, output)
            self.assertEqual(len(server.received_image), bound)
            self.assertEqual(len(server.received), 5)
            self.assertEqual(server.confirm_count, 0)
            self.assertFalse(any("Authenticated first boot confirmed" in x for x in output))

    def test_invalid_signed_bundle_cannot_connect_even_with_upload_flag(self):
        self.firmware.write_bytes(b"\xE9" + b"X" * 65536)
        with patch.object(ota, "OTAConnection", side_effect=AssertionError("network")):
            code = ota.main([
                "--firmware", str(self.firmware),
                "--manifest", str(self.manifest),
                "--public-key", str(self.public),
                "--host", "127.0.0.1", "--upload",
            ], ask=lambda _: "YES", display=lambda _: None)
        self.assertEqual(code, 3)

    def test_public_dns_destination_denied_before_token_or_any_tcp(self):
        with patch.object(ota.socket, "getaddrinfo", return_value=[
            (socket.AF_INET, socket.SOCK_STREAM, 6, "",
             ("8.8.8.8", 8765)),
        ]), patch.object(ota, "AuthenticatedTcpPort",
                          side_effect=AssertionError("token leaked")), self.assertRaisesRegex(
                              ota.OTAError, "public internet"):
            ota.OTAConnection("untrusted.example", TEST_TOKEN)

    def test_check_installed_read_only_accepts_matching_confirmed_version(self):
        with FakeOTAServer(mode="check") as server:
            output: list[str] = []
            code = ota.main([
                "--firmware", str(self.firmware),
                "--manifest", str(self.manifest),
                "--public-key", str(self.public),
                "--token-file", str(self.token_path),
                "--host", "127.0.0.1", "--tcp-port", str(server.port),
                "--check-installed",
            ], ask=lambda _: self.fail("read-only mode must not prompt for flash"),
               display=output.append)
        self.assertEqual(code, 0, output)
        self.assertEqual(server.received, [b"HELLO\n", b"STATUS\n",
                                            b"PINS\n", b"OTA_STATUS\n"])
        self.assertEqual(server.received_image, b"")
        self.assertTrue(any("VALID boot health" in value for value in output))


if __name__ == "__main__":
    unittest.main()
