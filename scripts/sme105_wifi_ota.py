"""Signed, one-shot SME105 ESP32 firmware OTA client.

No vehicle commands, no password acquisition, no automatic retry. The ESP32
firmware must independently verify the same ECDSA P-256 signature against its
embedded public key before swapping the boot partition.

The normal invocation verifies the *exact* firmware image and signed manifest
offline. Network upload requires the separate explicit --upload flag and two
operator confirmations.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import ipaddress
import json
import os
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Self

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.sme105_usb_bridge import (
    DEFAULT_TOKEN_FILE,
    PINS_REPLY,
    AuthenticatedTcpPort,
    BridgeError,
    load_wifi_token,
    parse_status,
)

# Maximum OTA app slot in the project's explicit dual-OTA partition layout.
# The bootloader, partitions and NVS are NEVER overwritten by this tool.
MAX_APP_BYTES = 0x140000
MIN_APP_BYTES = 65536
MAX_MANIFEST_BYTES = 4096
MAX_SIGNATURE_BYTES = 80  # bounded DER ECDSA-P256
IMAGE_MAGIC = 0xE9
BOARD = "esp32dev"
PROTOCOL = "SME105-OTA-V1"
PINNED_PUBLIC_KEY_SHA256 = "4f3bb05f5a94fe931bce67f91057ab17e3d5ea4734dc066a722f47c27e682e79"
DEFAULT_PUBLIC_KEY = Path("~/.config/sme105/ota-signing-pubkey.pem").expanduser()
DEFAULT_PRIVATE_KEY = Path("~/.config/sme105/ota-signing-key.pem").expanduser()
HASH_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_FIRMWARE_VERSION = 0xFFFFFFFF
MAX_COMMAND_LINE = 240
MAX_REPLY_LINE = 256
POSTBOOT_CONFIRM_WINDOW_S = 45.0
REBOOT_AUTH_GRACE_S = 6.0
OTA_UPLOAD_WINDOW_S = 240.0
OTA_FLOW_CHUNK_BYTES = 8192
OTA_PROGRESS_TIMEOUT_S = 12.0
OTA_STATUS_RE = re.compile(
    rb"^OTA_STATUS state=(IDLE|RECEIVING|REBOOT_PENDING) "
    rb"received=([0-9]{1,10}) size=([0-9]{1,10}) "
    rb"running=([A-Za-z0-9_-]{1,24}) boot=([A-Za-z0-9_-]{1,24}) "
    rb"accepted_version=([0-9]{1,10}) "
    rb"boot_health=(VALID|UNDEFINED|PENDING_VERIFY|NEW|ABORTED|INVALID) "
    rb"confirm_required=([01]) "
    rb"rollback=1$"
)


class OTAError(RuntimeError):
    """Fail-closed error with no token/signing-key content in message."""


class OTAResponseTimeout(OTAError):
    """No reply bytes arrived before the bounded deadline."""


class OTAConnectionLost(OTAError):
    """Transport was lost while waiting for a firmware reply."""


class OTAUnsafeRecovery(OTAError):
    """A received authenticated state disproves a safe OTA recovery."""


class OTATransientReboot(OTAError):
    """Authenticated prior firmware is still completing its reboot."""


@dataclass(frozen=True)
class UploadCompletion:
    receipt_matched: bool
    postboot_deadline: float


def _stat_private(path: Path) -> os.stat_result:
    try:
        info = path.lstat()
    except OSError as exc:
        raise OTAError("Protected key/token file inaccessible") from exc
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
            stat.S_IMODE(info.st_mode) != 0o600):
        raise OTAError("Protected key/token must be regular, owned by current user, mode 0600")
    return info


def _open_regular(path: Path, *, private: bool = False) -> BinaryIO:
    """No-symlink, race checked open; don't follow a replaced path."""
    try:
        before = _stat_private(path) if private else path.lstat()
        if not stat.S_ISREG(before.st_mode):
            raise OTAError("Firmware/manifest must be a regular file, not a link")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        stream = os.fdopen(fd, "rb")
        after = os.fstat(stream.fileno())
        if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
            stream.close()
            raise OTAError("Firmware/manifest changed during file open")
        if private and (stat.S_IMODE(after.st_mode) != 0o600 or
                        after.st_uid != os.getuid()):
            stream.close()
            raise OTAError("Protected key permissions changed")
        return stream
    except OSError as exc:
        raise OTAError("Firmware/manifest file unavailable") from exc


def _load_image_bytes(image_path: Path) -> tuple[bytes, str]:
    """Snapshot firmware once; no TOCTOU between verification and upload."""
    with _open_regular(image_path) as stream:
        if not MIN_APP_BYTES <= os.fstat(stream.fileno()).st_size <= MAX_APP_BYTES:
            raise OTAError("ESP32 firmware size outside bounded OTA app slot")
        binary = stream.read(MAX_APP_BYTES + 1)
    if not MIN_APP_BYTES <= len(binary) <= MAX_APP_BYTES or binary[0] != IMAGE_MAGIC:
        raise OTAError("Invalid or oversized ESP32 firmware image")
    return binary, hashlib.sha256(binary).hexdigest()


def canonical_signed_bytes(size: int, digest: str, version: int) -> bytes:
    if (type(size) is not int or not MIN_APP_BYTES <= size <= MAX_APP_BYTES or
            type(version) is not int or not 1 <= version <= MAX_FIRMWARE_VERSION or
            not isinstance(digest, str) or HASH_RE.fullmatch(digest) is None):
        raise OTAError("Unsigned firmware metadata is invalid")
    return f"{PROTOCOL}\n{BOARD}\n{size}\n{digest}\n{version}\n".encode("ascii")


def _run_openssl(arguments: list[str], *, stdin: bytes | None = None) -> bytes:
    """Invoke the local OpenSSL, never pass secrets or tokens in argv."""
    try:
        result = subprocess.run(
            ["openssl", *arguments],
            input=stdin, capture_output=True,
            check=False, timeout=10,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired) as exc:
        raise OTAError("Local OpenSSL verification unavailable") from exc
    if result.returncode:
        # Never emit stderr: it can contain key locations or library state.
        raise OTAError("ECDSA-P256 signature verification failed")
    return result.stdout


def read_pinned_public_key(public_pem: Path) -> bytes:
    with _open_regular(public_pem.expanduser()) as source:
        pem = source.read(2049)
    if (len(pem) > 2048 or b"-----BEGIN PUBLIC KEY-----" not in pem or
            b"-----END PUBLIC KEY-----" not in pem):
        raise OTAError("Invalid OTA public key PEM")
    der = _run_openssl(["pkey", "-pubin", "-outform", "DER"], stdin=pem)
    if hashlib.sha256(der).hexdigest() != PINNED_PUBLIC_KEY_SHA256:
        raise OTAError("OTA public key does not match compiled ESP32 trust anchor")
    return pem


def verify_p256(message: bytes, der_signature: bytes, public_pem: Path) -> None:
    """Verify exact signed bytes using OpenSSL 3's ECDSA SHA256 verifier."""
    if not 64 <= len(der_signature) <= MAX_SIGNATURE_BYTES or der_signature[0] != 0x30:
        raise OTAError("Invalid P-256 DER signature format")
    pem = read_pinned_public_key(public_pem)
    # No private signing material is read or written here. The temp file
    # contains only public signature bytes and is owner-only.
    with tempfile.TemporaryDirectory(prefix="sme105-ota-verify-") as folder:
        sig_path = Path(folder) / "signature.der"
        pub_path = Path(folder) / "pinned-pub.pem"
        with sig_path.open("xb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(der_signature)
        with pub_path.open("xb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(pem)
        _run_openssl(
            ["dgst", "-sha256", "-verify", str(pub_path),
             "-signature", str(sig_path)],
            stdin=message,
        )


@dataclass(frozen=True)
class VerifiedImage:
    firmware_path: Path
    manifest_path: Path
    firmware_size: int
    firmware_sha256: str
    firmware_version: int
    signed_bytes: bytes
    signature: bytes
    image: bytes


def read_manifest_file(path: Path) -> bytes:
    with _open_regular(path) as handle:
        if os.fstat(handle.fileno()).st_size > MAX_MANIFEST_BYTES:
            raise OTAError("Manifest exceeds size limit")
        result = handle.read(MAX_MANIFEST_BYTES + 1)
    if not result or len(result) > MAX_MANIFEST_BYTES:
        raise OTAError("Invalid manifest length")
    return result


def _decode_signature(text: str) -> bytes:
    try:
        data = base64.b64decode(text, validate=True)
    except (ValueError, TypeError, base64.binascii.Error) as exc:
        raise OTAError("Invalid signed manifest signature encoding") from exc
    if not 64 <= len(data) <= MAX_SIGNATURE_BYTES or data[0] != 0x30:
        raise OTAError("Invalid DER ECDSA signature")
    return data


def _unique_json_pairs(items: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in items:
        if key in result:
            raise OTAError("Duplicate JSON manifest field")
        result[key] = value
    return result


def _manifest_json(data: dict[str, object]) -> bytes:
    return (json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=True) +
            "\n").encode("ascii")


def verify_bundle(firmware: Path, manifest: Path, public_key: Path) -> VerifiedImage:
    image, digest = _load_image_bytes(firmware)
    payload = read_manifest_file(manifest)
    try:
        data = json.loads(payload.decode("ascii"), object_pairs_hook=_unique_json_pairs)
    except (UnicodeError, ValueError, TypeError) as exc:
        raise OTAError("Invalid signed firmware manifest JSON") from exc
    if not isinstance(data, dict) or set(data) != {
            "protocol", "board", "size", "sha256", "version", "signature"}:
        raise OTAError("Unknown/missing firmware manifest fields")
    if _manifest_json(data) != payload:
        raise OTAError("Manifest is not in exact canonical JSON form")
    if data["protocol"] != PROTOCOL or data["board"] != BOARD:
        raise OTAError("Firmware manifest targets the wrong bridge")
    size, version, sha = data["size"], data["version"], data["sha256"]
    if (type(size) is not int or size != len(image) or
            type(version) is not int or not 1 <= version <= MAX_FIRMWARE_VERSION or
            type(sha) is not str or sha != digest):
        raise OTAError("Signed manifest version/size/SHA256 does not match exact firmware image")
    signature_text = data["signature"]
    if not isinstance(signature_text, str):
        raise OTAError("Malformed signature in firmware manifest")
    signature = _decode_signature(signature_text)
    signed = canonical_signed_bytes(size, sha, version)
    verify_p256(signed, signature, public_key)
    return VerifiedImage(firmware, manifest, size, sha, version,
                         signed, signature, image)


def _read_private_key_snapshot(key_path: Path) -> bytes:
    with _open_regular(key_path.expanduser(), private=True) as stream:
        value = stream.read(8193)
    if (len(value) > 8192 or b"-----BEGIN PRIVATE KEY-----" not in value or
            b"-----END PRIVATE KEY-----" not in value):
        raise OTAError("Private signing key must be owner-only PKCS#8 PEM")
    return value


def sign_manifest(firmware: Path, destination: Path, version: int,
                  signing_key: Path, public_key: Path) -> VerifiedImage:
    image, digest = _load_image_bytes(firmware)
    signed = canonical_signed_bytes(len(image), digest, version)
    # Verify the pinned trust anchor before touching private signing material.
    read_pinned_public_key(public_key)
    key_bytes = _read_private_key_snapshot(signing_key)
    # OpenSSL needs a private PEM file, but it is only copied to a protected,
    # short-lived temporary directory (0700), never onto CLI/stdout.
    with tempfile.TemporaryDirectory(prefix="sme105-ota-sign-") as folder:
        snapshot = Path(folder) / "owner-only-key.pem"
        with snapshot.open("xb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(key_bytes)
        signature = _run_openssl(
            ["dgst", "-sha256", "-sign", str(snapshot)],
            stdin=signed,
        )
    verify_p256(signed, signature, public_key)
    data = {
        "protocol": PROTOCOL,
        "board": BOARD,
        "size": len(image),
        "sha256": digest,
        "version": version,
        "signature": base64.b64encode(signature).decode("ascii"),
    }
    packed = _manifest_json(data)
    if len(packed) > MAX_MANIFEST_BYTES:
        raise OTAError("Signed manifest exceeds bounded size")
    try:
        with destination.open("xb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(packed)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise OTAError("Cannot create signed manifest (no overwrite allowed)") from exc
    return verify_bundle(firmware, destination, public_key)


class OTAConnection:
    """Authenticated TCP stream restricted to the OTA command exchange."""

    def __init__(self, host: str, token: bytes, *, port: int = 8765,
                 tcp_factory: Callable[..., AuthenticatedTcpPort] = AuthenticatedTcpPort):
        if not host or not 1 <= port <= 65535:
            raise OTAError("Invalid private LAN bridge address/port")
        # AUTH is cleartext on the LAN by this firmware contract. Resolve
        # before sending any token and pass a *numeric* vetted address into
        # the TCP adapter to prevent a second DNS resolution/rebinding hop.
        try:
            addresses = socket.getaddrinfo(host, port, family=socket.AF_INET,
                                           type=socket.SOCK_STREAM)
        except (OSError, ValueError) as exc:
            raise OTAError("Could not resolve same-LAN ESP32 hostname") from exc
        candidates = {entry[4][0] for entry in addresses}
        if not candidates:
            raise OTAError("No same-LAN ESP32 IPv4 address found")
        for candidate in candidates:
            parsed = ipaddress.ip_address(candidate)
            if (parsed.is_unspecified or parsed.is_multicast or parsed.is_reserved or
                    not (parsed.is_private or parsed.is_loopback or parsed.is_link_local)):
                raise OTAError("Refusing to send OTA AUTH token to a public internet address")
        self.target_ipv4 = addresses[0][4][0]
        self.tcp_port = port
        try:
            self._port = tcp_factory(self.target_ipv4, token, port=port)
        except BridgeError as exc:
            if str(exc) == "WiFi bridge authentication rejected":
                raise OTAUnsafeRecovery("Postboot WiFi AUTH was explicitly rejected") from exc
            raise
        self._closed = False

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        if not self._closed:
            self._closed = True
            self._port.close()

    def _write_exact(self, blob: bytes) -> None:
        try:
            # Shared bridge terminal optimizes read() latency with a 50ms
            # socket timeout. During flash, ESP32 may backpressure TCP
            # writes for longer than 50ms; give each bounded sendall up to
            # four seconds, then restore the nonblocking reader timeout.
            sock = getattr(self._port, "_socket", None)
            previous_timeout = sock.gettimeout() if sock is not None else None
            try:
                if sock is not None:
                    sock.settimeout(4.0)
                if self._port.write(blob) != len(blob):
                    raise OTAError("Partial OTA socket write, outcome uncertain")
                self._port.flush()
            finally:
                if sock is not None:
                    sock.settimeout(previous_timeout)
        except (BridgeError, OSError, TimeoutError) as exc:
            raise OTAError("OTA transport failed; do NOT retry automatically") from exc

    def _line(self, seconds: float = 4.0) -> bytes:
        deadline = time.monotonic() + seconds
        packet = bytearray()
        while time.monotonic() < deadline:
            try:
                datum = self._port.read(1)
            except (BridgeError, OSError) as exc:
                if packet:
                    raise OTAError("Partial OTA firmware reply; recovery denied") from exc
                raise OTAConnectionLost("OTA connection lost; outcome unconfirmed") from exc
            if not datum:
                time.sleep(0.005)
                continue
            packet.extend(datum)
            if len(packet) > MAX_REPLY_LINE:
                raise OTAError("Oversized or malformed OTA firmware reply")
            if datum == b"\n":
                if packet.endswith(b"\r\n"):
                    line = bytes(packet[:-2])
                else:
                    line = bytes(packet[:-1])
                if b"\x00" in line or b"\r" in line or b"\n" in line:
                    raise OTAError("Invalid OTA reply control character")
                return line
        if packet:
            raise OTAError("Partial OTA firmware reply timed out; recovery denied")
        raise OTAResponseTimeout("OTA firmware response timeout; no automatic retry")

    @staticmethod
    def _reboot_busy(response: bytes, *, allowed: bool) -> bytes:
        if allowed and response == b"DENIED ota_busy":
            raise OTATransientReboot("Prior OTA firmware still rebooting")
        return response

    def _exchange(self, command: bytes, expected: bytes, *,
                  allow_reboot_busy: bool = False) -> None:
        if not command.endswith(b"\n") or len(command) > MAX_COMMAND_LINE:
            raise OTAError("Invalid OTA command length")
        self._write_exact(command)
        answer = self._reboot_busy(self._line(), allowed=allow_reboot_busy)
        if answer != expected:
            raise OTAError("Firmware identity, status or OTA reply mismatch")

    @staticmethod
    def _validate_ota_status(response: bytes) -> tuple[int, str, str]:
        reported = OTA_STATUS_RE.fullmatch(response)
        if reported is None:
            raise OTAError("OTA_STATUS absent/malformed; rollback health unknown")
        accepted_version = int(reported[6])
        boot_health = reported[7].decode("ascii")
        confirm_required = reported[8] == b"1"
        if (reported[1] != b"IDLE" or int(reported[2]) or int(reported[3]) or
                reported[4] == b"NONE" or reported[5] == b"NONE" or
                reported[4] != reported[5] or
                accepted_version > MAX_FIRMWARE_VERSION):
            raise OTAError("OTA denied: boot/partition health not stable and idle")
        if confirm_required != (boot_health == "PENDING_VERIFY"):
            raise OTAError("OTA denied: boot health and confirmation requirement disagree")
        return accepted_version, boot_health, reported[4].decode("ascii")

    def _query_status(
        self, *, transition: tuple[int, str, int] | None = None,
    ) -> tuple[int, str, str]:
        allow_reboot_busy = transition is not None
        self._exchange(b"HELLO\n",
                       b"HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1",
                       allow_reboot_busy=allow_reboot_busy)
        self._write_exact(b"STATUS\n")
        response = self._reboot_busy(self._line(), allowed=allow_reboot_busy)
        try:
            status = parse_status(response)
        except BridgeError as exc:
            raise OTAError("OTA denied: firmware STATUS identity failed") from exc
        if (status is None or status.field("stage") != "0" or
                status.field("fault") != "0"):
            raise OTAError("OTA denied: firmware not idle or has a fault")
        self._exchange(b"PINS\n", PINS_REPLY, allow_reboot_busy=allow_reboot_busy)
        self._write_exact(b"OTA_STATUS\n")
        response = self._reboot_busy(self._line(), allowed=allow_reboot_busy)
        if transition is not None:
            reported = OTA_STATUS_RE.fullmatch(response)
            if reported is not None and reported[1] == b"REBOOT_PENDING":
                old_version, old_partition, signed_size = transition
                if (int(reported[2]) == signed_size and
                        int(reported[3]) == signed_size and
                        reported[4].decode("ascii") == old_partition and
                        reported[5].decode("ascii") != old_partition and
                        int(reported[6]) == old_version and
                        reported[7] in (b"VALID", b"UNDEFINED") and
                        reported[8] == b"0"):
                    raise OTATransientReboot("Prior OTA image is REBOOT_PENDING")
                raise OTAUnsafeRecovery("Contradictory pre-reboot OTA_STATUS")
        return self._validate_ota_status(response)

    def verify_idle(self) -> tuple[int, str]:
        accepted_version, health, _ = self._query_status()
        if health not in ("VALID", "UNDEFINED"):
            raise OTAError("OTA denied: active boot health verification or rollback state")
        return accepted_version, health

    def postboot_state(
        self, image: VerifiedImage, *, prior_version: int, prior_partition: str,
    ) -> tuple[int, str, str]:
        return self._query_status(
            transition=(prior_version, prior_partition, image.firmware_size),
        )

    def confirm_postboot(self, image: VerifiedImage) -> None:
        # The post-reboot firmware independently compares BOTH decimal
        # version and lowercase image digest to its NVS pending manifest.
        expected = f"OTA_CONFIRM OK version={image.firmware_version}".encode("ascii")
        command = (
            f"OTA_CONFIRM {image.firmware_version} {image.firmware_sha256}\n"
        ).encode("ascii")
        self._exchange(command, expected)

    def poll_confirmed_boot(self, image: VerifiedImage, *, deadline: float) -> None:
        """Keep authenticated TCP alive until bootloader app is marked VALID.

        Firmware clears its pending authorization if the connection drops.
        Therefore, NEVER close the successful OTA_CONFIRM TCP session while
        the new image still reports PENDING_VERIFY.
        """
        while time.monotonic() < deadline:
            self._write_exact(b"OTA_STATUS\n")
            response = self._line(seconds=min(4.0, max(0.1, deadline - time.monotonic())))
            # The firmware can asynchronously announce VALID just before
            # answering a concurrent OTA_STATUS query. Validate but do not
            # rely on the unsolicited message for success.
            if response.startswith(b"OTA_BOOT "):
                expected = f"OTA_BOOT state=VALID version={image.firmware_version}".encode()
                if response != expected:
                    raise OTAError("Unexpected ESP32 boot state during OTA verification")
                response = self._line(seconds=min(4.0, max(0.1, deadline - time.monotonic())))
            accepted, health, _ = self._validate_ota_status(response)
            if accepted == image.firmware_version and health == "VALID":
                return
            if (accepted >= image.firmware_version or health != "PENDING_VERIFY"):
                raise OTAError("New OTA boot lost PENDING_VERIFY before becoming VALID")
            remaining = deadline - time.monotonic()
            if remaining > 0:
                time.sleep(min(0.5, remaining))
        raise OTAError("OTA_CONFIRM acknowledged, but boot health did not become VALID")

    def upload(self, image: VerifiedImage) -> UploadCompletion:
        """No retries and no new vehicle TX; firmware verifies signed header."""
        if len(image.image) != image.firmware_size:
            raise OTAError("Local firmware image length changed unexpectedly")
        if hashlib.sha256(image.image).hexdigest() != image.firmware_sha256:
            raise OTAError("Local image digest changed unexpectedly")
        b64_signature = base64.b64encode(image.signature).decode("ascii")
        command = (
            f"OTA_BEGIN2 {image.firmware_size} {image.firmware_sha256} "
            f"{image.firmware_version} {b64_signature}\n"
        ).encode("ascii")
        if len(command) > MAX_COMMAND_LINE:
            raise OTAError("Signed OTA header exceeds firmware limit")
        self._exchange(
            command,
            f"OTA_READY size={image.firmware_size} chunk={OTA_FLOW_CHUNK_BYTES}".encode("ascii"),
        )
        # Stop-and-wait flow control: one exact bounded chunk per positive
        # cumulative acknowledgment. The firmware owns UART/flash scheduling.
        # No automatic retries/replays or concurrent outstanding windows.
        deadline = time.monotonic() + OTA_UPLOAD_WINDOW_S
        for i in range(0, image.firmware_size, OTA_FLOW_CHUNK_BYTES):
            if time.monotonic() >= deadline:
                raise OTAError("OTA upload time budget exhausted; no binary retry")
            limit = min(image.firmware_size, i + OTA_FLOW_CHUNK_BYTES)
            self._write_exact(image.image[i:limit])
            if limit < image.firmware_size:
                actual = self._line(seconds=min(
                    OTA_PROGRESS_TIMEOUT_S,
                    max(0.1, deadline - time.monotonic()),
                ))
                expected = f"OTA_PROGRESS received={limit}".encode("ascii")
                if actual != expected:
                    raise OTAError(
                        "OTA_PROGRESS cumulative byte count mismatch; "
                        "next firmware window NOT transmitted"
                    )
        # The ESP32 can finish esp_ota_end/set_boot_partition and reset before
        # its final OTA_OK reaches TCP. Start the boot budget at the final write
        # and reserve most of the 45s rollback window for fresh AUTH/CONFIRM.
        postboot_deadline = time.monotonic() + POSTBOOT_CONFIRM_WINDOW_S
        try:
            completed = self._line(seconds=min(
                4.0, max(0.1, deadline - time.monotonic()),
            ))
        except (OTAResponseTimeout, OTAConnectionLost):
            # Recovery is authorized ONLY after the entire signed body was sent
            # and only for a completely absent final receipt. All mismatched,
            # malformed and partial replies still fail closed.
            return UploadCompletion(False, postboot_deadline)
        expected = (
            f"OTA_OK version={image.firmware_version} sha256="
            f"{image.firmware_sha256} rebooting=1"
        ).encode("ascii")
        if completed != expected:
            raise OTAError("ESP32 did not positively confirm matching OTA version and SHA256")
        return UploadCompletion(True, postboot_deadline)


def verify_first_boot(
    host_ipv4: str, token: bytes, image: VerifiedImage,
    *, prior_version: int, prior_partition: str, receipt_matched: bool,
    deadline: float, port: int = 8765, display: Callable[[str], None] = print,
) -> None:
    """Single OTA_CONFIRM after reboot, with bounded read-only reauth polling.

    The image bytes are NEVER resent. Before confirmation, connection
    attempts are allowed as the ESP32 restarts and re-associates. Once the
    confirmation command is dispatched, subsequent connections, if needed,
    perform only read-only OTA_STATUS checks; they never resend confirmation.
    """
    confirm_attempted = False
    last_error = "ESP32 did not provide authenticated first-boot health"
    while time.monotonic() < deadline:
        try:
            with OTAConnection(host_ipv4, token, port=port) as remote:
                accepted, health, partition = remote.postboot_state(
                    image, prior_version=prior_version, prior_partition=prior_partition,
                )
                if not receipt_matched and (
                        health != "PENDING_VERIFY" or
                        accepted != prior_version or
                        partition == prior_partition):
                    raise OTAUnsafeRecovery(
                        "Missing OTA_OK: authenticated new-boot PENDING_VERIFY, "
                        "previous accepted version and changed partition not proven"
                    )
                if accepted == image.firmware_version and health == "VALID":
                    if not receipt_matched:
                        raise OTAUnsafeRecovery(
                            "Missing OTA_OK: cannot infer upload success from VALID alone"
                        )
                    display("Authenticated first boot confirmed: exact signed version "
                            "accepted and marked VALID, rollback protection active.")
                    return
                if (health == "PENDING_VERIFY" and
                        accepted == prior_version and
                        partition != prior_partition and
                        not confirm_attempted):
                    # Never retry the OTA_CONFIRM command if its ACK is lost:
                    # the next TCP connection can only inspect OTA_STATUS.
                    confirm_attempted = True
                    remote.confirm_postboot(image)
                    remote.poll_confirmed_boot(image, deadline=deadline)
                    display("OTA_CONFIRM accepted: postboot image health is VALID.")
                    return
                elif health not in ("UNDEFINED", "PENDING_VERIFY", "VALID"):
                    raise OTAError("ESP32 reported invalid/aborted first-boot health")
                if accepted > image.firmware_version:
                    raise OTAUnsafeRecovery("Remote version unexpectedly exceeds uploaded firmware")
        except OTAUnsafeRecovery as exc:
            # For only the first few seconds after the complete final write,
            # the old app can explicitly deny AUTH while still REBOOT_PENDING.
            # Never send a command in that session. A later rejection, or one
            # after an attempted OTA_CONFIRM, is a terminal authorization error.
            auth_grace_end = min(
                deadline,
                deadline - POSTBOOT_CONFIRM_WINDOW_S + REBOOT_AUTH_GRACE_S,
            )
            if (str(exc) != "Postboot WiFi AUTH was explicitly rejected" or
                    confirm_attempted or time.monotonic() >= auth_grace_end):
                raise
            last_error = "Previous app refused AUTH during bounded reboot grace"
        except OTATransientReboot as exc:
            # The signed image is not yet running. Only read-only reconnects
            # are allowed, inside the original bounded first-boot window.
            last_error = str(exc)
        except OTAError as exc:
            if not receipt_matched and not isinstance(exc, (OTAConnectionLost, OTAResponseTimeout)):
                # An authenticated malformed or contradictory status is not
                # evidence that the signed image reached a new boot.
                raise
            last_error = str(exc)
        except BridgeError as exc:
            # Pre-confirm auth/connect failures are expected during reboot;
            # no re-upload. An uncertain confirmation MUST NOT be resent.
            last_error = str(exc)
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.5, remaining))
    raise OTAError(
        "OTA image was transferred, but authenticated first-boot confirmation "
        f"is NOT verified ({last_error}); do NOT retry firmware upload"
    )


def require_operator_confirmation(
    image: VerifiedImage, *,
    attempt: int, ask: Callable[[str], str] = input,
) -> bool:
    short_digest = image.firmware_sha256[:12]
    expected = (
        f"VERIFY {image.firmware_version} {short_digest}"
        if attempt == 1 else
        f"UPLOAD {image.firmware_version} {short_digest}"
    )
    return ask(
        f"Type EXACTLY '{expected}' to authorize OTA step {attempt}/2: "
    ) == expected


def main(argv: list[str] | None = None,
         ask: Callable[[str], str] = input,
         display: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Future OTA workflow, after signing key/public trust anchor are "
            "installed and initial USB flash has finished:\n"
            "  1. --firmware firmware.bin --manifest image.ota.json "
            "--sign-manifest --version 2\n"
            "  2. --firmware firmware.bin --manifest image.ota.json "
            "(offline signature verification)\n"
            "  3. --firmware firmware.bin --manifest image.ota.json "
            "--host sme105-bridge.local --upload\n"
            "  4. Later, after reboot: same args with --check-installed "
            "instead of --upload.\n"
            "Never port-forward TCP 8765 or use OTA while the vehicle is active. "
            "Network upload requires two exact typed confirmations."
        ),
    )
    parser.add_argument("--firmware", required=True, type=Path,
                        help="exact PlatformIO ESP32 application .bin, not a full flash image")
    parser.add_argument("--manifest", required=True, type=Path,
                        help="immutable signed JSON manifest for the exact .bin")
    parser.add_argument("--public-key", type=Path, default=DEFAULT_PUBLIC_KEY,
                        help="public key must match ESP32-baked SHA256 fingerprint")
    parser.add_argument("--signing-key", type=Path, default=DEFAULT_PRIVATE_KEY,
                        help="private signing key, owner-only mode 0600; never uploaded")
    parser.add_argument("--version", type=int,
                        help="positive monotonic OTA integer version for --sign-manifest")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--sign-manifest", action="store_true",
                      help="sign image metadata offline (no connection; never overwrite)")
    mode.add_argument("--upload", action="store_true",
                      help="one active OTA attempt after two typed confirmations")
    mode.add_argument("--check-installed", action="store_true",
                      help="later read-only network check of accepted version and rollback health")
    parser.add_argument("--host", help="same-LAN bridge hostname or IPv4; required with --upload")
    parser.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN_FILE)
    parser.add_argument("--tcp-port", type=int, default=8765, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.sign_manifest and args.version is None:
        parser.error("--sign-manifest requires --version integer")
    if not args.sign_manifest and args.version is not None:
        parser.error("--version is only accepted with --sign-manifest")
    if (args.upload or args.check_installed) and not args.host:
        parser.error("--upload/--check-installed require --host")
    if args.host and not (args.upload or args.check_installed):
        parser.error("--host is only for explicit network operations")
    try:
        if args.sign_manifest:
            image = sign_manifest(
                args.firmware, args.manifest, args.version,
                args.signing_key, args.public_key,
            )
        else:
            image = verify_bundle(args.firmware, args.manifest, args.public_key)
        display(f"Signed image VERIFIED offline: board={BOARD} "
                f"version={image.firmware_version} size={image.firmware_size} "
                f"SHA256={image.firmware_sha256}")
        display("Firmware public key matches pinned ESP32 trust-anchor fingerprint.")
        if not (args.upload or args.check_installed):
            display("Offline-only operation: no WiFi connection, OTA or vehicle TX.")
            return 0
        if args.upload:
            display("WARNING: OTA may reboot the ESP32 and interrupt vehicle observation.")
            display("Only use on a stable, trusted local 2.4GHz LAN, with vehicle "
                    "disconnected/ignition OFF and independent recovery access.")
            if not require_operator_confirmation(image, attempt=1, ask=ask):
                display("Cancelled before network access; no OTA bytes sent.")
                return 2
        token = load_wifi_token(args.token_file.expanduser())
        with OTAConnection(args.host, token, port=args.tcp_port) as transport:
            accepted_version, boot_health, prior_partition = transport._query_status()
            if boot_health not in ("VALID", "UNDEFINED"):
                raise OTAError("OTA denied: active boot health verification or rollback state")
            if args.check_installed:
                if (accepted_version != image.firmware_version or
                        boot_health != "VALID"):
                    raise OTAError("Postboot accepted version or VALID health differs from signed image")
                display("Read-only postboot OTA_STATUS confirms matching accepted version, "
                        "VALID boot health and rollback protection; no new OTA bytes sent.")
                return 0
            if image.firmware_version <= accepted_version:
                raise OTAError("OTA version is not above device accepted anti-rollback version")
            display("The second approval also authorizes ONE authenticated "
                    "OTA_CONFIRM after reboot; never another firmware transfer.")
            if not require_operator_confirmation(image, attempt=2, ask=ask):
                display("Cancelled before OTA_BEGIN; firmware unchanged.")
                return 2
            completion = transport.upload(image)
            ip_address = transport.target_ipv4
        if completion.receipt_matched:
            display("OTA_OK matched image SHA/version; checking authenticated new-boot "
                    "health without retrying any firmware bytes.")
        else:
            display("Final OTA_OK absent after complete signed image; checking fresh "
                    "authenticated PENDING_VERIFY before one authorized OTA_CONFIRM. "
                    "No firmware bytes will be retransmitted.")
        verify_first_boot(
            ip_address, token, image, prior_version=accepted_version,
            prior_partition=prior_partition, receipt_matched=completion.receipt_matched,
            deadline=completion.postboot_deadline, port=args.tcp_port, display=display,
        )
        return 0
    except (OTAError, BridgeError, OSError, EOFError, KeyboardInterrupt) as exc:
        if isinstance(exc, (OTAError, BridgeError)):
            display(f"OTA DENIED/UNCERTAIN: {exc}")
        else:
            display("OTA interrupted or local file inaccessible; no automatic retry.")
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
