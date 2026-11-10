#!/usr/bin/env python3
"""Measure read-only bridge link performance over Wi-Fi or bonded BLE.

Run the same duration/heartbeat profile once per transport and compare the
result JSON files with ``--compare WIFI.json BLE.json``. The script sends only
AUTH (BLE) and read-only STATUS heartbeats; it never starts or resumes a
vehicle/ECU read. RX/RXB telemetry is measured if present on the link. With no
telemetry, loss and gap rates are null rather than reported as zero.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import hashlib
import json
import os
import re
import select
import socket
import stat
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

DEFAULT_TOKEN_FILE = Path("~/.config/sme105/bridge-token").expanduser()
DEFAULT_HOST = "10.77.13.1"
DEFAULT_PORT = 8765
DEFAULT_SSID = "SME105-DIRECT-2BF8"
AUTH_SALT_PREFIX = b"SME105-DCL-AUTH-V1:"
UART_BAUD = 9600
UART_BITS_PER_BYTE_8N1 = 10
UART_RAW_PAYLOAD_MAX_BYTES_PER_S = UART_BAUD // UART_BITS_PER_BYTE_8N1
DEFAULT_BLE_NAME = "SME105-DCL"
SERVICE_UUID = "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
BLE_RX_UUID = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
BLE_TX_UUID = "6e400003-b5a3-f393-e0a9-e50e"
TOKEN_RE = re.compile(rb"^[0-9a-fA-F]{32}$")
RX_RE = re.compile(rb"^RX t_us=(\d{1,10}) byte=([0-9A-Fa-f]{2})(?: seq=(\d{1,20}))?$")
RXB_RE = re.compile(rb"^RXB t_us=(\d{1,10}) data=([0-9A-Fa-f]+) dt=([0-9,]+)$")
MAX_LINE = 4096


class BenchmarkError(RuntimeError):
    """Safe-to-display error; never includes protocol payloads or secrets."""


def load_token(path: Path) -> bytes:
    try:
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or
                info.st_uid != os.getuid()):
            raise BenchmarkError("token file must be an owner-only regular file")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            current = os.fstat(stream.fileno())
            if ((current.st_dev, current.st_ino) != (info.st_dev, info.st_ino) or
                    not stat.S_ISREG(current.st_mode) or current.st_mode & 0o077):
                raise BenchmarkError("token file changed or has unsafe permissions")
            data = stream.read(128)
    except OSError as exc:
        raise BenchmarkError("cannot read private token file") from exc
    token = data.strip(b"\r\n")
    if data not in (token, token + b"\n") or not TOKEN_RE.fullmatch(token):
        raise BenchmarkError("invalid token file format")
    return token.lower()


def wifi_authentication_token(args: argparse.Namespace) -> bytes:
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


def percentile(values: list[float], percentile_value: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile_value / 100.0
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def round_or_none(value: float | None, digits: int = 3) -> float | None:
    return round(value, digits) if value is not None else None


class EventLog:
    def __init__(self, path: Path | None) -> None:
        self.stream = None
        if path is None:
            return
        try:
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT |
                         getattr(os, "O_NOFOLLOW", 0), 0o600)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                os.close(fd)
                raise BenchmarkError("event log must be an owner-owned regular file")
            os.fchmod(fd, 0o600)
            self.stream = os.fdopen(fd, "a", encoding="utf-8", buffering=1)
        except OSError as exc:
            raise BenchmarkError("cannot open event log") from exc

    def write(self, event: str, **fields: Any) -> None:
        if self.stream is None:
            return
        row = {"monotonic_s": round(time.monotonic(), 6), "event": event, **fields}
        self.stream.write(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n")
        self.stream.flush()

    def close(self) -> None:
        if self.stream is not None:
            self.stream.close()


class Metrics:
    def __init__(self, gap_threshold_ms: float, event_log: EventLog) -> None:
        self.gap_threshold_us = int(gap_threshold_ms * 1000)
        self.events = event_log
        self.heartbeat_rtt_ms: list[float] = []
        self.heartbeat_sent = 0
        self.heartbeat_missed = 0
        self.inbound_bytes = 0
        self.telemetry_bytes = 0
        self.telemetry_records = 0
        self.sequence_records = 0
        self.sequence_missing = 0
        self.sequence_anomalies = 0
        self.last_sequence: int | None = None
        self.gap_count = 0
        self.last_wire_us: int | None = None
        self.connection_epochs = 0
        self.connection_losses = 0
        self.reconnect_durations_s: list[float] = []

    def heartbeat(self, rtt_ms: float) -> None:
        self.heartbeat_rtt_ms.append(rtt_ms)
        self.events.write("heartbeat", rtt_method="STATUS RTT",
                          status_rtt_ms=round(rtt_ms, 3))

    def miss_heartbeat(self) -> None:
        self.heartbeat_missed += 1
        self.events.write("heartbeat_timeout")

    def observe_line(self, line: bytes, host_time: float) -> None:
        match = RX_RE.fullmatch(line)
        if match:
            timestamp = int(match.group(1))
            if timestamp > 0xFFFFFFFF:
                return
            wire_times = [timestamp]
            self.telemetry_bytes += 1
            sequence = match.group(3)
            if sequence is not None:
                value = int(sequence)
                self.sequence_records += 1
                if self.last_sequence is not None and value > self.last_sequence + 1:
                    self.sequence_missing += value - self.last_sequence - 1
                elif self.last_sequence is not None and value <= self.last_sequence:
                    self.sequence_anomalies += 1
                if self.last_sequence is None or value > self.last_sequence:
                    self.last_sequence = value
        else:
            batch = RXB_RE.fullmatch(line)
            if not batch:
                return
            data_hex = batch.group(2)
            if len(data_hex) % 2:
                return
            offsets = [int(part) for part in batch.group(3).split(b",")]
            count = len(data_hex) // 2
            if len(offsets) != count:
                return
            base = int(batch.group(1))
            if base > 0xFFFFFFFF:
                return
            wire_times = [(base + offset) & 0xFFFFFFFF for offset in offsets]
            self.telemetry_bytes += count
        for timestamp in wire_times:
            if self.last_wire_us is not None:
                delta = (timestamp - self.last_wire_us) & 0xFFFFFFFF
                if self.gap_threshold_us < delta < 0x80000000:
                    self.gap_count += 1
            self.last_wire_us = timestamp
        self.telemetry_records += 1

    def summary(self, elapsed_s: float, transport: str, profile: dict[str, Any]) -> dict[str, Any]:
        telemetry_loss_rate = None
        if self.sequence_records and not self.sequence_anomalies:
            telemetry_loss_rate = self.sequence_missing / (self.sequence_records + self.sequence_missing)
        sample_intervals = max(0, self.telemetry_bytes - 1)
        gap_rate = self.gap_count / sample_intervals if sample_intervals else None
        return {
            "schema": "sme105-wifi-ble-benchmark-v1",
            "transport": transport,
            "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "duration_s": round(elapsed_s, 3),
            "profile": profile,
            "heartbeats": {
                "rtt_method": "STATUS RTT",
                "sent": self.heartbeat_sent,
                "received": len(self.heartbeat_rtt_ms),
                "timeouts": self.heartbeat_missed,
                "status_rtt_p50_ms": round_or_none(percentile(self.heartbeat_rtt_ms, 50)),
                "status_rtt_p95_ms": round_or_none(percentile(self.heartbeat_rtt_ms, 95)),
                "status_rtt_p99_ms": round_or_none(percentile(self.heartbeat_rtt_ms, 99)),
            },
            "throughput": {
                "inbound_application_bytes": self.inbound_bytes,
                "inbound_bytes_per_s": round(self.inbound_bytes / elapsed_s, 3) if elapsed_s else 0,
                "telemetry_bytes": self.telemetry_bytes,
                "telemetry_bytes_per_s": round(self.telemetry_bytes / elapsed_s, 3) if elapsed_s else 0,
                "uart_9600_8n1_theoretical_max_raw_payload_bytes_per_s": UART_RAW_PAYLOAD_MAX_BYTES_PER_S,
                "telemetry_uart_payload_utilization_pct": round(
                    self.telemetry_bytes / elapsed_s / UART_RAW_PAYLOAD_MAX_BYTES_PER_S * 100, 3
                ) if elapsed_s else None,
            },
            "telemetry": {
                "records": self.telemetry_records,
                "sequenced_records": self.sequence_records,
                "sequence_gaps": self.sequence_missing if self.sequence_records else None,
                "sequence_anomalies": self.sequence_anomalies if self.sequence_records else None,
                "loss_rate": round(telemetry_loss_rate, 6) if telemetry_loss_rate is not None else None,
                "gap_count": self.gap_count if self.telemetry_records else None,
                "gap_rate": round(gap_rate, 6) if gap_rate is not None else None,
                "gap_rate_basis": "gaps divided by timestamped RX byte intervals",
                "gap_threshold_ms": self.gap_threshold_us / 1000,
            },
            "connections": {
                "epochs": self.connection_epochs,
                "losses": self.connection_losses,
                "losses_per_hour": round(self.connection_losses * 3600 / elapsed_s, 3) if elapsed_s else 0,
                "reconnection_duration_s": {
                    "count": len(self.reconnect_durations_s),
                    "p50": round_or_none(percentile(self.reconnect_durations_s, 50)),
                    "p95": round_or_none(percentile(self.reconnect_durations_s, 95)),
                    "max": round(max(self.reconnect_durations_s), 3) if self.reconnect_durations_s else None,
                },
            },
            "safety": {
                "vehicle_read_started": False,
                "note": "Only authenticated transport setup and read-only STATUS heartbeats were sent.",
            },
        }


class LineCollector:
    def __init__(self, metrics: Metrics) -> None:
        self.metrics = metrics
        self.buffer = bytearray()

    def feed(self, data: bytes, now: float, on_line: Callable[[bytes, float], None]) -> None:
        self.metrics.inbound_bytes += len(data)
        self.buffer.extend(data)
        if len(self.buffer) > MAX_LINE and b"\n" not in self.buffer:
            raise BenchmarkError("overlong line from bridge")
        while b"\n" in self.buffer:
            raw, _, tail = self.buffer.partition(b"\n")
            self.buffer[:] = tail
            if len(raw) > MAX_LINE:
                raise BenchmarkError("overlong line from bridge")
            line = raw.removesuffix(b"\r")
            self.metrics.observe_line(line, now)
            on_line(line, now)


def wifi_auth(host: str, port: int, token: bytes, timeout: float) -> socket.socket:
    try:
        conn = socket.create_connection((host, port), timeout=timeout)
        conn.settimeout(timeout)
        conn.sendall(b"AUTH " + token + b"\n")
        response = bytearray()
        while len(response) <= 64 and not response.endswith(b"\n"):
            byte = conn.recv(1)
            if not byte:
                raise BenchmarkError("bridge closed before authentication")
            response.extend(byte)
        auth_line = bytes(response).removesuffix(b"\n").removesuffix(b"\r")
        if auth_line not in (b"AUTH OK", b"AUTH OK retained=1"):
            raise BenchmarkError("bridge authentication rejected")
        conn.setblocking(False)
        return conn
    except (OSError, BenchmarkError) as exc:
        try:
            conn.close()
        except (UnboundLocalError, OSError):
            pass
        if isinstance(exc, BenchmarkError):
            raise
        raise BenchmarkError("Wi-Fi connection failed") from exc


def run_wifi(args: argparse.Namespace, metrics: Metrics, events: EventLog, started: float,
             deadline: float, token: bytes) -> None:
    conn: socket.socket | None = None
    lines = LineCollector(metrics)
    pending_heartbeat: float | None = None
    heartbeat_deadline = 0.0
    next_heartbeat = started
    reconnect_started: float | None = None
    retry_at = started

    def handle_line(line: bytes, arrived: float) -> None:
        nonlocal pending_heartbeat
        if line.startswith(b"STATUS ") and pending_heartbeat is not None:
            rtt = max(0.0, (arrived - pending_heartbeat) * 1000.0)
            metrics.heartbeat(rtt)
            pending_heartbeat = None

    while time.monotonic() < deadline:
        now = time.monotonic()
        if conn is None:
            if now < retry_at:
                time.sleep(min(retry_at - now, max(0.0, deadline - now)))
                continue
            try:
                conn = wifi_auth(args.host, args.port, token, args.connect_timeout)
                metrics.connection_epochs += 1
                events.write("connected", transport="wifi", connection_epoch=metrics.connection_epochs)
                if reconnect_started is not None:
                    recovered_at = time.monotonic()
                    metrics.reconnect_durations_s.append(recovered_at - reconnect_started)
                    events.write("reconnected", duration_s=round(recovered_at - reconnect_started, 3))
                    reconnect_started = None
                pending_heartbeat = None
                next_heartbeat = time.monotonic()
                continue
            except BenchmarkError:
                retry_at = time.monotonic() + args.reconnect_delay
                events.write("connect_attempt_failed", transport="wifi")
                continue
        now = time.monotonic()
        if pending_heartbeat is not None and now >= heartbeat_deadline:
            metrics.miss_heartbeat()
            pending_heartbeat = None
            events.write("connection_lost", transport="wifi", reason="heartbeat_timeout")
            metrics.connection_losses += 1
            reconnect_started = now
            conn.close()
            conn = None
            retry_at = now + args.reconnect_delay
            continue
        if pending_heartbeat is None and now >= next_heartbeat:
            try:
                conn.sendall(b"STATUS\n")
                pending_heartbeat = time.monotonic()
                metrics.heartbeat_sent += 1
                heartbeat_deadline = pending_heartbeat + args.heartbeat_timeout
                next_heartbeat = pending_heartbeat + args.interval
            except OSError:
                events.write("connection_lost", transport="wifi", reason="write_error")
                metrics.connection_losses += 1
                reconnect_started = now
                conn.close()
                conn = None
                retry_at = now + args.reconnect_delay
                continue
        wake_at = deadline
        if pending_heartbeat is None:
            wake_at = min(wake_at, next_heartbeat)
        else:
            wake_at = min(wake_at, heartbeat_deadline)
        try:
            readable, _, _ = select.select([conn], [], [], max(0.0, wake_at - time.monotonic()))
            if not readable:
                continue
            data = conn.recv(4096)
            if not data:
                raise OSError("eof")
            lines.feed(data, time.monotonic(), handle_line)
        except (OSError, BenchmarkError, ValueError):
            events.write("connection_lost", transport="wifi", reason="socket_read_error")
            metrics.connection_losses += 1
            reconnect_started = time.monotonic()
            try:
                conn.close()
            except OSError:
                pass
            conn = None
            retry_at = time.monotonic() + args.reconnect_delay
            pending_heartbeat = None
    if conn is not None:
        conn.close()


async def find_ble_device(args: argparse.Namespace):
    try:
        from bleak import BleakScanner
    except ImportError as exc:
        raise BenchmarkError("BLE mode requires the Python bleak package") from exc
    if args.address:
        device = await BleakScanner.find_device_by_address(args.address, timeout=args.scan_timeout)
    else:
        device = await BleakScanner.find_device_by_name(args.name, timeout=args.scan_timeout)
    return device


async def run_ble(args: argparse.Namespace, metrics: Metrics, events: EventLog,
                  started: float, deadline: float) -> None:
    try:
        from bleak import BleakClient
    except ImportError as exc:
        raise BenchmarkError("BLE mode requires the Python bleak package") from exc

    reconnect_started: float | None = None
    retry_at = started
    loop = asyncio.get_running_loop()
    while time.monotonic() < deadline:
        now = time.monotonic()
        if now < retry_at:
            await asyncio.sleep(min(retry_at - now, max(0.0, deadline - now)))
            continue
        try:
            device = await find_ble_device(args)
        except BenchmarkError:
            raise
        except Exception:
            device = None
        if device is None:
            events.write("connect_attempt_failed", transport="ble", reason="device_not_found")
            retry_at = time.monotonic() + args.reconnect_delay
            continue

        notifications: asyncio.Queue[bytes] = asyncio.Queue()
        disconnected = asyncio.Event()

        def did_disconnect(_client: object) -> None:
            loop.call_soon_threadsafe(disconnected.set)

        client = BleakClient(device, timeout=args.connect_timeout,
                             disconnected_callback=did_disconnect)
        try:
            await client.connect()
            if not client.is_connected:
                raise BenchmarkError("BLE connection did not become active")
            await client.start_notify(BLE_TX_UUID,
                                      lambda _sender, data: notifications.put_nowait(bytes(data)))
            collector = LineCollector(metrics)
            auth_ok = asyncio.Event()
            pending_heartbeat: float | None = None
            next_heartbeat = time.monotonic()
            heartbeat_deadline = 0.0

            def on_line(line: bytes, arrived: float) -> None:
                nonlocal pending_heartbeat
                if line == b"AUTH OK transport=BLE":
                    auth_ok.set()
                elif line.startswith(b"DENIED "):
                    events.write("ble_authorization_denied")
                    disconnected.set()
                elif line.startswith(b"STATUS ") and pending_heartbeat is not None:
                    metrics.heartbeat(max(0.0, (arrived - pending_heartbeat) * 1000.0))
                    pending_heartbeat = None

            # BLE link encryption/authentication is enforced by the bridge's
            # bonded GATT characteristics. AUTH BLE claims its single control
            # session and does not start a vehicle operation.
            await client.write_gatt_char(BLE_RX_UUID, b"AUTH BLE\n", response=True)
            auth_limit = time.monotonic() + args.heartbeat_timeout
            while not auth_ok.is_set() and not disconnected.is_set() and time.monotonic() < auth_limit:
                try:
                    data = await asyncio.wait_for(notifications.get(), timeout=min(0.2, auth_limit - time.monotonic()))
                except asyncio.TimeoutError:
                    continue
                collector.feed(data, time.monotonic(), on_line)
            if not auth_ok.is_set():
                raise BenchmarkError("BLE authentication response timed out or was denied")
            metrics.connection_epochs += 1
            events.write("connected", transport="ble", connection_epoch=metrics.connection_epochs)
            if reconnect_started is not None:
                recovered_at = time.monotonic()
                metrics.reconnect_durations_s.append(recovered_at - reconnect_started)
                events.write("reconnected", duration_s=round(recovered_at - reconnect_started, 3))
                reconnect_started = None
            pending_heartbeat = None
            next_heartbeat = time.monotonic()
            loss_reason: str | None = None

            while time.monotonic() < deadline and client.is_connected and not disconnected.is_set():
                now = time.monotonic()
                if pending_heartbeat is not None and now >= heartbeat_deadline:
                    metrics.miss_heartbeat()
                    loss_reason = "heartbeat_timeout"
                    break
                if pending_heartbeat is None and now >= next_heartbeat:
                    try:
                        pending_heartbeat = time.monotonic()
                        metrics.heartbeat_sent += 1
                        heartbeat_deadline = pending_heartbeat + args.heartbeat_timeout
                        next_heartbeat = pending_heartbeat + args.interval
                        await client.write_gatt_char(BLE_RX_UUID, b"STATUS\n", response=True)
                    except Exception:
                        loss_reason = "gatt_write_error"
                        break
                wake_at = min(deadline, next_heartbeat if pending_heartbeat is None else heartbeat_deadline)
                timeout = max(0.01, min(0.2, wake_at - time.monotonic()))
                try:
                    data = await asyncio.wait_for(notifications.get(), timeout=timeout)
                except asyncio.TimeoutError:
                    continue
                collector.feed(data, time.monotonic(), on_line)
            # This loop only exits early after a GATT disconnect, heartbeat
            # timeout, or write failure. Count all of those as one loss and
            # measure recovery through the next authenticated epoch.
            if time.monotonic() < deadline:
                metrics.connection_losses += 1
                reconnect_started = time.monotonic()
                events.write("connection_lost", transport="ble",
                             reason=loss_reason or "gatt_disconnected")
        except BenchmarkError:
            events.write("connect_attempt_failed", transport="ble", reason="authentication_or_gatt")
            if reconnect_started is None and metrics.connection_epochs:
                reconnect_started = time.monotonic()
        except Exception:
            events.write("connect_attempt_failed", transport="ble", reason="gatt_error")
            if reconnect_started is None and metrics.connection_epochs:
                reconnect_started = time.monotonic()
        finally:
            if client.is_connected:
                try:
                    await client.disconnect()
                except Exception:
                    pass
        retry_at = time.monotonic() + args.reconnect_delay


def compare_results(first_path: Path, second_path: Path) -> dict[str, Any]:
    try:
        first = json.loads(first_path.read_text(encoding="utf-8"))
        second = json.loads(second_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise BenchmarkError("cannot read benchmark result JSON") from exc
    if {first.get("transport"), second.get("transport")} != {"wifi", "ble"}:
        raise BenchmarkError("comparison requires one Wi-Fi result and one BLE result")
    wifi = first if first["transport"] == "wifi" else second
    ble = second if second["transport"] == "ble" else first
    return {
        "schema": "sme105-wifi-ble-comparison-v1",
        "wifi": wifi,
        "ble": ble,
        "same_heartbeat_interval": wifi.get("profile", {}).get("heartbeat_interval_s") == ble.get("profile", {}).get("heartbeat_interval_s"),
        "metric_delta_wifi_minus_ble": {
            "status_rtt_p50_ms": _subtract(wifi, ble, "heartbeats", "status_rtt_p50_ms"),
            "status_rtt_p95_ms": _subtract(wifi, ble, "heartbeats", "status_rtt_p95_ms"),
            "status_rtt_p99_ms": _subtract(wifi, ble, "heartbeats", "status_rtt_p99_ms"),
            "inbound_bytes_per_s": _subtract(wifi, ble, "throughput", "inbound_bytes_per_s"),
            "losses_per_hour": _subtract(wifi, ble, "connections", "losses_per_hour"),
        },
        "note": "Separate runs are directly comparable only when profile, bridge state, workload, placement, and RF conditions match.",
    }


def _subtract(left: dict[str, Any], right: dict[str, Any], group: str, key: str) -> float | None:
    a = left.get(group, {}).get(key)
    b = right.get(group, {}).get(key)
    return round(a - b, 3) if isinstance(a, (int, float)) and isinstance(b, (int, float)) else None


def write_result(result: dict[str, Any], path: Path | None) -> None:
    encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
    if path is None:
        print(encoded, end="")
        return
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC |
                     getattr(os, "O_NOFOLLOW", 0), 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            os.close(fd)
            raise BenchmarkError("result target must be an owner-owned regular file")
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(encoded)
    except OSError as exc:
        raise BenchmarkError("cannot write benchmark result") from exc
    print(encoded, end="")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--transport", choices=("wifi", "ble"),
                        help="benchmark one transport; run once for each firmware/link")
    parser.add_argument("--compare", nargs=2, type=Path, metavar=("WIFI_JSON", "BLE_JSON"),
                        help="compare two saved result files and exit")
    parser.add_argument("--duration", type=float, default=300.0, help="measurement seconds")
    parser.add_argument("--interval", type=float, default=1.0, help="read-only STATUS heartbeat seconds")
    parser.add_argument("--heartbeat-timeout", type=float, default=3.0)
    parser.add_argument("--connect-timeout", type=float, default=8.0)
    parser.add_argument("--reconnect-delay", type=float, default=1.0)
    parser.add_argument("--telemetry-gap-ms", type=float, default=1000.0,
                        help="count RX/RXB inter-sample gaps longer than this")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--sta", action="store_true",
                        help="use station-mode token-file authentication instead of direct SoftAP")
    parser.add_argument("--ssid", default=DEFAULT_SSID,
                        help=f"direct SoftAP SSID used for token derivation (default: {DEFAULT_SSID})")
    parser.add_argument("--password", help="direct SoftAP WPA2 password (prompted when omitted)")
    parser.add_argument("--token-file", type=Path,
                        help="private 0600 bridge token file (used with --sta)")
    parser.add_argument("--address", help="bonded BLE address; otherwise scan by name")
    parser.add_argument("--name", default=DEFAULT_BLE_NAME, help="BLE advertised name")
    parser.add_argument("--scan-timeout", type=float, default=5.0)
    parser.add_argument("--events", type=Path, help="optional owner-only JSONL event log")
    parser.add_argument("--result", type=Path, help="save final JSON result (mode 0600)")
    args = parser.parse_args()
    if args.compare:
        if args.transport:
            parser.error("--compare cannot be combined with --transport")
        try:
            write_result(compare_results(*args.compare), args.result)
            return 0
        except BenchmarkError as exc:
            print(f"wifi_ble_benchmark: {exc}", file=sys.stderr)
            return 2
    if not args.transport:
        parser.error("select --transport wifi|ble, or provide --compare WIFI_JSON BLE_JSON")
    if args.transport == "wifi":
        if args.sta and args.password is not None:
            parser.error("--password is only valid for direct SoftAP mode")
        if not args.sta and args.token_file is not None:
            parser.error("--token-file requires --sta")
    elif args.sta or args.password is not None or args.token_file is not None:
        parser.error("Wi-Fi authentication options require --transport wifi")
    if (args.duration <= 0 or args.interval <= 0 or args.heartbeat_timeout <= 0 or
            args.connect_timeout <= 0 or args.reconnect_delay <= 0 or
            args.telemetry_gap_ms <= 0 or args.scan_timeout <= 0 or
            not 1 <= args.port <= 65535):
        parser.error("duration, port, and timing values are outside their valid range")

    events = EventLog(args.events)
    metrics = Metrics(args.telemetry_gap_ms, events)
    started = time.monotonic()
    deadline = started + args.duration
    try:
        if args.transport == "wifi":
            token = wifi_authentication_token(args)
            run_wifi(args, metrics, events, started, deadline, token)
        else:
            asyncio.run(run_ble(args, metrics, events, started, deadline))
        elapsed = max(0.0, time.monotonic() - started)
        profile = {
            "duration_s": args.duration,
            "heartbeat_interval_s": args.interval,
            "heartbeat_timeout_s": args.heartbeat_timeout,
            "telemetry_gap_threshold_ms": args.telemetry_gap_ms,
        }
        write_result(metrics.summary(elapsed, args.transport, profile), args.result)
        return 0
    except (BenchmarkError, OSError) as exc:
        print(f"wifi_ble_benchmark: {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("wifi_ble_benchmark: interrupted before result was finalized", file=sys.stderr)
        return 130
    finally:
        events.close()


if __name__ == "__main__":
    raise SystemExit(main())
