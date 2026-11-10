#!/usr/bin/env python3
"""Log secret-free Wi-Fi bridge health from authenticated TCP/8765.

The tool only sends the read-only WIFI_AP_STATUS, WIFI_DIAG, and STATUS
commands. A STATUS request supplies the application heartbeat STATUS RTT. Output is
JSON Lines with monotonic time and a new connection_epoch after each AUTH OK.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import os
import re
import socket
import stat
import sys
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import TextIO

DEFAULT_TOKEN_FILE = Path("~/.config/sme105/bridge-token").expanduser()
DEFAULT_HOST = "10.77.13.1"
DEFAULT_PORT = 8765
DEFAULT_SSID = "SME105-DIRECT-2BF8"
AUTH_SALT_PREFIX = b"SME105-DCL-AUTH-V1:"
TOKEN_RE = re.compile(rb"^[0-9a-fA-F]{32}$")
FIELD_RE = re.compile(rb"^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:+-]+)$")
MAX_LINE = 4096


class DiagnosticError(RuntimeError):
    """Safe-to-display diagnostic error without wire data or credentials."""


def load_token(path: Path) -> bytes:
    """Read the existing private token file without following symlinks."""
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or
                info.st_uid != os.getuid()):
            raise DiagnosticError("token file must be an owner-only regular file")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            current = os.fstat(stream.fileno())
            if ((current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or
                    not stat.S_ISREG(current.st_mode) or current.st_mode & 0o077):
                raise DiagnosticError("token file changed or has unsafe permissions")
            data = stream.read(128)
    except OSError as exc:
        raise DiagnosticError("cannot read private token file") from exc
    token = data.strip(b"\r\n")
    if data not in (token, token + b"\n") or not TOKEN_RE.fullmatch(token):
        raise DiagnosticError("invalid token file format")
    return token.lower()


def authentication_token(args: argparse.Namespace) -> bytes:
    """Resolve STA token-file auth or derive the direct SoftAP token."""
    if args.sta:
        return load_token((args.token_file or DEFAULT_TOKEN_FILE).expanduser())

    password_text = args.password
    args.password = None
    if password_text is None:
        password_text = getpass.getpass("SoftAP password: ")
    password_buffer = bytearray(password_text.encode("utf-8"))
    del password_text
    try:
        derived = hashlib.pbkdf2_hmac(
            "sha256", password_buffer,
            AUTH_SALT_PREFIX + args.ssid.encode("utf-8"),
            10000, dklen=16
        ).hex().lower()
        return derived.encode("ascii")
    finally:
        password_buffer[:] = b"\x00" * len(password_buffer)


def parse_fields(line: bytes, prefix: bytes) -> dict[str, str]:
    if len(line) > MAX_LINE or not line.startswith(prefix + b" "):
        raise DiagnosticError("unexpected diagnostic response")
    fields: dict[str, str] = {}
    for item in line[len(prefix) + 1:].split():
        match = FIELD_RE.fullmatch(item)
        if not match:
            raise DiagnosticError("malformed diagnostic response")
        key, value = match.group(1).decode("ascii"), match.group(2).decode("ascii")
        if key in fields:
            raise DiagnosticError("duplicate diagnostic field")
        fields[key] = value
    return fields


def number(fields: dict[str, str], *names: str) -> int | None:
    for name in names:
        value = fields.get(name)
        if value is not None:
            try:
                return int(value, 10)
            except ValueError:
                return None
    return None


class JsonlSink:
    def __init__(self, path: Path | None) -> None:
        self._stream: TextIO | None = None
        if path is None:
            self._stream = sys.stdout
            return
        try:
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT |
                         getattr(os, "O_NOFOLLOW", 0), 0o600)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                os.close(fd)
                raise DiagnosticError("log target must be an owner-owned regular file")
            os.fchmod(fd, 0o600)
            self._stream = os.fdopen(fd, "a", encoding="utf-8", buffering=1)
        except OSError as exc:
            raise DiagnosticError("cannot open JSONL log") from exc

    def write(self, record: dict[str, object]) -> None:
        assert self._stream is not None
        self._stream.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
        self._stream.flush()

    def close(self) -> None:
        if self._stream is not None and self._stream is not sys.stdout:
            self._stream.close()


class AuthenticatedLink:
    """Bounded line reader for the bridge's authenticated command stream."""

    def __init__(self, host: str, port: int, token: bytes, timeout: float) -> None:
        try:
            self.sock = socket.create_connection((host, port), timeout=timeout)
            self.sock.settimeout(timeout)
            self.sock.sendall(b"AUTH " + token + b"\n")
            auth = self._read_line()
            if auth not in (b"AUTH OK", b"AUTH OK retained=1"):
                raise DiagnosticError("bridge authentication rejected")
            self.sock.settimeout(0.25)
        except (OSError, DiagnosticError) as exc:
            try:
                self.sock.close()
            except (AttributeError, OSError):
                pass
            if isinstance(exc, DiagnosticError):
                raise
            raise DiagnosticError("connection or authentication failed") from exc
        self.buffer = bytearray()
        self.pending: deque[bytes] = deque()

    def _read_line(self) -> bytes:
        line = bytearray()
        while len(line) <= MAX_LINE:
            chunk = self.sock.recv(1)
            if not chunk:
                raise DiagnosticError("bridge closed the connection")
            if chunk == b"\n":
                return bytes(line).removesuffix(b"\r")
            line.extend(chunk)
        raise DiagnosticError("overlong bridge response")

    def request(self, command: bytes, prefix: bytes, timeout: float) -> bytes:
        self.sock.sendall(command + b"\n")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for index, line in enumerate(self.pending):
                if line.startswith(prefix + b" "):
                    del self.pending[index]
                    return line
            remaining = max(0.01, deadline - time.monotonic())
            self.sock.settimeout(min(0.25, remaining))
            try:
                data = self.sock.recv(2048)
            except TimeoutError:
                continue
            if not data:
                raise DiagnosticError("bridge closed the connection")
            self.buffer.extend(data)
            if len(self.buffer) > MAX_LINE and b"\n" not in self.buffer:
                raise DiagnosticError("overlong bridge response")
            while b"\n" in self.buffer:
                raw, _, rest = self.buffer.partition(b"\n")
                self.buffer[:] = rest
                line = raw.removesuffix(b"\r")
                if line.startswith(prefix + b" "):
                    return line
                # Unsolicited RX/RXB or other status lines are deliberately
                # discarded. Raw bridge/vehicle data is never copied to logs.
        raise DiagnosticError("read-only command response timed out")

    def close(self) -> None:
        self.sock.close()


def station_rssi(ap: dict[str, str], diag: dict[str, str]) -> int | None:
    """Use explicit AP client RSSI fields only; WIFI_DIAG rssi is STA RSSI."""
    aliases = ("station_rssi_dbm", "station_rssi", "client_rssi_dbm", "sta_rssi", "sta0_rssi")
    value = number(ap, *aliases)
    if value is None:
        value = number(diag, *aliases)
    if value is None:
        for fields in (ap, diag):
            for key in sorted(fields):
                if re.fullmatch(r"sta[0-9]+_rssi", key):
                    value = number(fields, key)
                    if value is not None:
                        break
            if value is not None:
                break
    return value


def selected_counters(fields: dict[str, str], patterns: tuple[str, ...]) -> dict[str, int]:
    result: dict[str, int] = {}
    for key, value in fields.items():
        if any(pattern in key.lower() for pattern in patterns):
            try:
                result[key] = int(value, 10)
            except ValueError:
                continue
    return result


def record_base(epoch: int, started: float, kind: str) -> dict[str, object]:
    now = time.monotonic()
    return {
        "time_utc": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
        "monotonic_s": round(now, 6),
        "elapsed_s": round(now - started, 3),
        "connection_epoch": epoch,
        "record": kind,
    }


def run(args: argparse.Namespace) -> int:
    token = authentication_token(args)
    sink = JsonlSink(args.output)
    started = time.monotonic()
    deadline = started + args.duration if args.duration > 0 else None
    epoch = 0
    link: AuthenticatedLink | None = None
    previous_stations: int | None = None
    previous_diag: dict[str, str] = {}
    try:
        while deadline is None or time.monotonic() < deadline:
            if link is None:
                try:
                    link = AuthenticatedLink(args.host, args.port, token, args.timeout)
                    epoch += 1
                    previous_stations = None
                    previous_diag = {}
                    event = record_base(epoch, started, "connected")
                    event["authenticated"] = True
                    sink.write(event)
                except DiagnosticError as exc:
                    event = record_base(epoch, started, "connection_error")
                    event["error"] = str(exc)
                    sink.write(event)
                    time.sleep(min(args.interval, args.retry_interval))
                    continue
            sample_start = time.monotonic()
            try:
                ap = parse_fields(link.request(b"WIFI_AP_STATUS", b"WIFI_AP_STATUS", args.timeout), b"WIFI_AP_STATUS")
                diag = parse_fields(link.request(b"WIFI_DIAG", b"WIFI_DIAG", args.timeout), b"WIFI_DIAG")
                heartbeat_start = time.monotonic()
                status_line = link.request(b"STATUS", b"STATUS", args.timeout)
                heartbeat_ms = (time.monotonic() - heartbeat_start) * 1000.0
                # STATUS has a fixed identity token before its key/value data.
                # Validate the identity prefix without copying bridge state to
                # a diagnostic log.
                if not status_line.startswith(b"STATUS SME105_USB_BRIDGE_V1 "):
                    raise DiagnosticError("unexpected bridge STATUS identity")
                stations = number(ap, "stations", "clients")
                events: list[str] = []
                if stations is not None and previous_stations is not None:
                    if stations > previous_stations:
                        events.append("station_associated")
                    elif stations < previous_stations:
                        events.append("station_disassociated")
                diag_disconnects = number(diag, "disconnects")
                prior_disconnects = number(previous_diag, "disconnects")
                if (diag_disconnects is not None and prior_disconnects is not None and
                        diag_disconnects > prior_disconnects):
                    events.append("wifi_disconnect_counter_incremented")
                ap_stops = number(diag, "ap_stops")
                prior_ap_stops = number(previous_diag, "ap_stops")
                if ap_stops is not None and prior_ap_stops is not None and ap_stops > prior_ap_stops:
                    events.append("ap_stop_counter_incremented")
                record = record_base(epoch, started, "sample")
                record.update({
                    "ap": {
                        "mode": ap.get("mode"),
                        "state": ap.get("state"),
                        "ip": ap.get("ip"),
                        "channel": number(ap, "channel"),
                        "stations": stations,
                        "associated_station_rssi_dbm": station_rssi(ap, diag),
                    },
                    "wifi_diag": {
                        key: value for key, value in diag.items()
                        if key in {"disconnects", "last_reason", "got_ip", "reconnects",
                                   "reinitializations", "listener_failures", "listener_restarts",
                                   "listener", "mdns", "offline_ms", "rssi", "mode",
                                   "ap_clients", "ap_stops", "channel", "connection_epochs",
                                   "socket_send_errors", "queue_watermark"}
                    },
                    "socket_error_counters": selected_counters(
                        {**ap, **diag}, ("socket_error", "socket_send_error", "socket_fail", "tcp_error", "tcp_fail", "send_error")
                    ),
                    "backpressure_counters": selected_counters(
                        {**ap, **diag}, ("backpressure", "overflow", "output_drop", "transport_drop")
                    ),
                    "output_queue_watermark": number(diag, "queue_watermark") if "queue_watermark" in diag else number(ap, "queue_watermark"),
                    "status_rtt_ms": round(heartbeat_ms, 3),
                    "rtt_method": "STATUS RTT",
                    "heartbeat_status_identity_valid": True,
                    "station_events": events,
                    "capabilities": {
                        "associated_station_rssi": station_rssi(ap, diag) is not None,
                        "socket_error_counters": bool(selected_counters({**ap, **diag},
                            ("socket_error", "socket_send_error", "socket_fail", "tcp_error", "tcp_fail", "send_error"))),
                        "backpressure_counters": bool(selected_counters({**ap, **diag},
                            ("backpressure", "overflow", "output_drop", "transport_drop"))),
                    },
                })
                sink.write(record)
                previous_stations, previous_diag = stations, diag
                remaining = args.interval - (time.monotonic() - sample_start)
                if remaining > 0:
                    time.sleep(min(remaining, max(0, deadline - time.monotonic())
                                    if deadline is not None else remaining))
            except (DiagnosticError, OSError, TimeoutError) as exc:
                record = record_base(epoch, started, "disconnected")
                record["error"] = str(exc) if isinstance(exc, DiagnosticError) else "socket operation failed"
                sink.write(record)
                link.close()
                link = None
                previous_stations = None
                previous_diag = {}
    except KeyboardInterrupt:
        pass
    finally:
        if link is not None:
            link.close()
        sink.close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"bridge IPv4/DNS name (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--sta", action="store_true",
                        help="use station-mode token-file authentication instead of direct SoftAP")
    parser.add_argument("--ssid", default=DEFAULT_SSID,
                        help=f"direct SoftAP SSID used for token derivation (default: {DEFAULT_SSID})")
    parser.add_argument("--password", help="direct SoftAP WPA2 password (prompted when omitted)")
    parser.add_argument("--token-file", type=Path,
                        help="private 0600 bridge token file (used with --sta)")
    parser.add_argument("--interval", type=float, default=2.0, help="seconds between samples")
    parser.add_argument("--timeout", type=float, default=3.0, help="per-command/connect timeout")
    parser.add_argument("--retry-interval", type=float, default=2.0, help="delay before reconnect")
    parser.add_argument("--duration", type=float, default=0.0,
                        help="run seconds; 0 runs until Ctrl-C")
    parser.add_argument("--output", type=Path, help="append JSONL to owner-only file (default: stdout)")
    args = parser.parse_args()
    if args.sta and args.password is not None:
        parser.error("--password is only valid for direct SoftAP mode")
    if not args.sta and args.token_file is not None:
        parser.error("--token-file requires --sta")
    if (args.port < 1 or args.port > 65535 or args.interval <= 0 or
            args.timeout <= 0 or args.retry_interval <= 0 or args.duration < 0):
        parser.error("port and timing values are outside their valid range")
    try:
        return run(args)
    except DiagnosticError as exc:
        print(f"rf_wifi_diagnostics: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
