"""Provision SME-105 ESP32 WiFi over local USB only, without exposing secrets.

The firmware stores its own token and credentials in NVS. The host never reads
NetworkManager or another password store, never prints SSID/PSK/token, and
does not enable any vehicle or generic bus-transmit command.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import os
import re
import stat
import sys
import time
from collections.abc import Callable
from pathlib import Path

import serial

# Direct execution (`python scripts/sme105_wifi_setup.py`) puts scripts/ rather
# than the repository root on sys.path. Allow both that documented command and
# `python -m scripts.sme105_wifi_setup` without requiring a custom PYTHONPATH.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.sme105_usb_bridge import (
    BAUD,
    DEFAULT_TOKEN_FILE,
    HELLO_REPLY,
    PINS_REPLY,
    BridgeError,
    parse_status,
)

MAX_RESPONSE_LINE = 512
TOKEN_RE = re.compile(rb"^[0-9a-fA-F]{32}$")
IPV4 = re.compile(rb"^(?:\d{1,3}\.){3}\d{1,3}$")


class ProvisioningError(RuntimeError):
    """Safe to display: never includes credentials, token or sensitive input."""


def validate_credentials(ssid: str, password: str) -> tuple[bytes, bytes]:
    if not isinstance(ssid, str) or not isinstance(password, str):
        raise ProvisioningError("WiFi SSID and password must be entered as text")
    ssid_bytes = ssid.encode("utf-8")
    password_bytes = password.encode("utf-8")
    if (not 1 <= len(ssid_bytes) <= 32 or
            not 8 <= len(password_bytes) <= 63):
        raise ProvisioningError("SSID must be 1–32 UTF-8 bytes; WPA2 password 8–63 bytes")
    if (any(ord(c) < 32 or ord(c) == 127 for c in ssid) or
            any(ord(c) < 32 or ord(c) == 127 for c in password) or
            "\x00" in ssid or "\x00" in password):
        raise ProvisioningError("Credentials must not contain control characters")
    # Firmware's strict decoder accepts printable ASCII 32..126, including
    # spaces, but not Unicode WPA passwords. Reject unsupported bytes before
    # sending secrets to the device.
    if any(byte < 32 or byte > 126 for byte in password_bytes):
        raise ProvisioningError("This firmware accepts printable ASCII passwords only")
    return ssid_bytes, password_bytes


def wifi_config_command(ssid: bytes, password: bytes) -> bytes:
    return (b"WIFI_CONFIG " + base64.b64encode(ssid) + b" " +
            base64.b64encode(password) + b"\n")


class UsbSetupClient:
    """Bounded and strictly line-oriented USB provisioning transport."""

    def __init__(self, port: serial.Serial) -> None:
        self.port = port
        self._buffer = bytearray()

    def _readline(self, timeout: float = 3.0) -> bytes:
        limit = time.monotonic() + timeout
        while time.monotonic() < limit:
            end = self._buffer.find(b"\n")
            if end >= 0:
                line = bytes(self._buffer[:end])
                del self._buffer[:end + 1]
                if line.endswith(b"\r"):
                    line = line[:-1]
                return line
            if len(self._buffer) > MAX_RESPONSE_LINE:
                raise ProvisioningError("Overlong/untrusted USB provisioning response")
            received = self.port.read(128)
            if received:
                self._buffer.extend(received)
        raise ProvisioningError("Timed out waiting for firmware provisioning reply")

    def _send(self, command: bytes) -> None:
        # Only a fixed finite set of provisioning commands, plus one locally
        # encoded credential line; no generic arbitrary UART write interface.
        allowed = (
            command in (b"HELLO\n", b"STATUS\n", b"PINS\n",
                        b"WIFI_STATUS\n", b"WIFI_TOKEN\n",
                        b"WIFI_AP_STATUS\n", b"WIFI_STA_MODE\n",
                        b"WIFI_AP_MODE\n") or
            bool(re.fullmatch(rb"WIFI_(?:AP_)?CONFIG [A-Za-z0-9+/=]+ [A-Za-z0-9+/=]+\n", command))
        )
        if not allowed:
            raise ProvisioningError("Non-provisioning USB command blocked")
        try:
            n = self.port.write(command)
            if n != len(command):
                raise ProvisioningError("USB provisioning write incomplete; outcome unknown")
            self.port.flush()
        except (OSError, serial.SerialException) as exc:
            raise ProvisioningError("Failed to write USB provisioning command") from exc

    def request(self, command: bytes, *, timeout: float = 3.0) -> bytes:
        self._send(command)
        return self._readline(timeout)

    def verify_identity(self) -> None:
        if self.request(b"HELLO\n") != HELLO_REPLY:
            raise ProvisioningError("Unexpected SME-105 firmware identity; no credentials sent")
        status = self.request(b"STATUS\n")
        try:
            validated = parse_status(status)
        except BridgeError as exc:
            raise ProvisioningError("Unsafe bridge firmware STATUS; no credentials sent") from exc
        if (validated is None or validated.field("stage") != "0" or
                validated.field("fault") != "0"):
            raise ProvisioningError("Bridge busy or faulted; no credentials sent")
        if self.request(b"PINS\n") != PINS_REPLY:
            raise ProvisioningError("Unexpected GPIO topology; no credentials sent")


def parse_wifi_token(reply: bytes) -> bytes:
    """Accepted token response is narrow and cannot contain arbitrary text."""
    if not reply.startswith(b"WIFI_TOKEN "):
        raise ProvisioningError("Missing WiFi token response")
    value = reply[len(b"WIFI_TOKEN "):]
    if not TOKEN_RE.fullmatch(value):
        raise ProvisioningError("Invalid WiFi token received from firmware")
    return value.lower()


def check_destination(path: Path, *, replace: bool = False) -> None:
    target = path.expanduser()
    if target.exists() or target.is_symlink():
        if not replace:
            raise ProvisioningError(
                "Token destination exists; use --replace-token to rotate it explicitly"
            )
        info = target.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                info.st_mode & 0o077):
            raise ProvisioningError("Existing token must be owner-only regular file")


def save_token(path: Path, token: bytes, *, replace: bool = False) -> None:
    if not TOKEN_RE.fullmatch(token):
        raise ProvisioningError("Refusing invalid WiFi token")
    path = path.expanduser()
    check_destination(path, replace=replace)
    # Keep newly created config directory private; reject symlink endpoints.
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.parent.is_symlink() or not path.parent.is_dir():
        raise ProvisioningError("Unsafe WiFi configuration directory")
    temporary = path.with_name(path.name + f".{os.getpid()}.new")
    fd = -1
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            fd = -1
            os.fchmod(stream.fileno(), 0o600)
            stream.write(token + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            # Atomic create-without-replacement: no window for a concurrent
            # process to place a token and have ours unexpectedly overwrite it.
            try:
                os.link(temporary, path, follow_symlinks=False)
            except FileExistsError as exc:
                raise ProvisioningError(
                    "Token destination appeared during provisioning"
                ) from exc
            temporary.unlink()
        os.chmod(path, 0o600, follow_symlinks=False)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def main(argv: list[str] | None = None,
         ask_ssid: Callable[[str], str] = input,
         ask_password: Callable[[str], str] = getpass.getpass,
         display: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyUSB0",
                        help="physical ESP32 USB serial device (not TCP)")
    parser.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN_FILE,
                        help="private 0600 token destination; never put token on CLI")
    parser.add_argument("--replace-token", action="store_true",
                        help="explicitly replace an existing private local token")
    parser.add_argument("--startup-seconds", type=float, default=1.5)
    args = parser.parse_args(argv)
    if not 0 <= args.startup_seconds <= 10:
        parser.error("startup-seconds must be 0..10")
    try:
        check_destination(args.token_file, replace=args.replace_token)
        ssid, password = validate_credentials(
            ask_ssid("WiFi SSID (2.4 GHz network): "),
            ask_password("WiFi password (not echoed): "),
        )
        # The password remains local until the exact firmware/DE/GPIO checks
        # pass, and is sent only over the physical USB port (never TCP).
        with serial.Serial(args.port, BAUD, timeout=0.05,
                           write_timeout=0.8, dsrdtr=False,
                           rtscts=False) as port:
            port.dtr = False
            port.rts = False
            if args.startup_seconds:
                time.sleep(args.startup_seconds)
                port.reset_input_buffer()
            client = UsbSetupClient(port)
            client.verify_identity()
            result = client.request(wifi_config_command(ssid, password), timeout=8)
            # Exact positive ACK required before asking for the fresh token.
            if result != b"WIFI_CONFIG OK saved=1 reconnecting=1":
                raise ProvisioningError("WiFi configuration not positively acknowledged")
            # NVS commit precedes asynchronous STA association. A CONNECTING
            # answer is not failure; poll status only, with no config retry.
            deadline = time.monotonic() + 30.0
            address: str | None = None
            while time.monotonic() < deadline:
                wifi = client.request(b"WIFI_STATUS\n", timeout=3)
                state, observed = parse_wifi_status(wifi)
                if state == "CONNECTED":
                    address = observed
                    break
                if state == "DISABLED":
                    raise ProvisioningError(
                        "WiFi disabled after saving credentials; no token saved"
                    )
                time.sleep(min(0.7, max(0.0, deadline - time.monotonic())))
            if address is None:
                raise ProvisioningError(
                    "WiFi credentials saved to NVS, but association not confirmed; "
                    "check 2.4 GHz router and rerun provisioning only if needed"
                )
            token = parse_wifi_token(client.request(b"WIFI_TOKEN\n"))
            save_token(args.token_file, token, replace=args.replace_token)
            display("WiFi provisioning accepted by firmware. TCP authentication token "
                    "saved in owner-only file (0600).")
            display(f"Bridge IP: {address}; mDNS: sme105-bridge.local; TCP port: 8765")
            display("Run the bridge terminal with --host sme105-bridge.local "
                    "and --token-file. No ECU command has been sent.")
        return 0
    except (ProvisioningError, serial.SerialException, OSError, EOFError,
            KeyboardInterrupt) as exc:
        # Avoid exception text for arbitrary serial APIs which might include
        # the credential payload. Display only controlled, static messages.
        if isinstance(exc, ProvisioningError):
            display(f"Provisioning denied: {exc}")
        else:
            display("Provisioning stopped or USB unavailable; no credential displayed")
        return 2


def parse_wifi_status(reply: bytes) -> tuple[str, str | None]:
    """Strict CONNECTING/CONNECTED/DISABLED status; never claim an unbound IP."""
    if not reply.startswith(b"WIFI_STATUS "):
        raise ProvisioningError("Missing WiFi status response")
    parts = reply.split(b" ")[1:]
    fields: dict[bytes, bytes] = {}
    for part in parts:
        if b"=" not in part:
            raise ProvisioningError("Malformed WiFi status reply")
        key, value = part.split(b"=", 1)
        if key in fields:
            raise ProvisioningError("Duplicated WiFi status field")
        fields[key] = value
    if set(fields) != {b"state", b"ip", b"port", b"clients", b"host"}:
        raise ProvisioningError("Unexpected or missing WiFi status fields")
    state = fields[b"state"]
    if (state not in (b"CONNECTED", b"CONNECTING", b"DISABLED") or
            fields[b"port"] != b"8765" or fields[b"clients"] not in (b"0", b"1") or
            fields[b"host"] not in (b"NONE", b"sme105-bridge.local")):
        raise ProvisioningError("Untrusted WiFi state, port or host")
    ip = fields.get(b"ip", b"")
    if state != b"CONNECTED":
        if ip != b"0.0.0.0":
            raise ProvisioningError("Non-connected status has unexpected IP")
        return state.decode("ascii"), None
    if not IPV4.fullmatch(ip):
        raise ProvisioningError("No valid WiFi IPv4 address in firmware status")
    octets = [int(part) for part in ip.split(b".")]
    if any(o > 255 for o in octets) or octets[0] in (0, 127, 255):
        raise ProvisioningError("Invalid WiFi IP address")
    if fields[b"host"] == b"NONE":
        # Firmware can receive DHCP address before mDNS setup finishes.
        # Poll instead of asserting the advertised hostname is ready.
        return "CONNECTING", None
    return "CONNECTED", ip.decode("ascii")


if __name__ == "__main__":
    sys.exit(main())
