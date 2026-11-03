"""Interactive, evidence-preserving USB terminal for the SME-105 ESP32 bridge.

All vehicle timing, DCL signalling, and UART receive timestamps belong to
the firmware. This host only issues a small fixed command vocabulary and
stores the receiver's reported raw octets. It never interprets DTCs.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import socket
import stat
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

import serial

ROOT = Path(__file__).resolve().parents[1]
BAUD = 115200
TCP_PORT = 8765
DEFAULT_TOKEN_FILE = Path("~/.config/sme105/bridge-token").expanduser()
TOKEN_HEX = re.compile(rb"^[0-9a-fA-F]{32}$")
COMMANDS = ("STATUS", "LISTEN", "HELLO", "REQUEST_A4", "REQUEST_0E", "STOP", "EXIT")
CAR_TRANSMIT = frozenset(("HELLO", "REQUEST_A4", "REQUEST_0E"))
WIRE_COMMANDS = frozenset(("HELLO", "PINS", "STATUS", "LISTEN_9600", "OBSERVE", "ARM_A4",
                           "READ_A4", "ARM_0E", "READ_0E", "STOP"))
SOURCE_WORDS = "01B0 FF5F 26A4 00A0"
V5_GPIO17_WORDS = "6DCC 29E9 6C3C 9847"
MAX_LINE = 2048
RX_RECORD = re.compile(rb"^RX t_us=(\d{1,10}) byte=([0-9A-F]{2})(?: seq=(\d{1,20}))?$")
KEY_VALUE = re.compile(rb"^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:-]+$")
HELLO_REPLY = b"HELLO SME105_USB_BRIDGE_V1 protocol=1 usb_baud=115200 no_auto_tx=1"
PINS_REPLY = (b"PINS ro16=GPIO16_UART1 de18=GPIO18_RMT2..5 "
              b"di17=GPIO17_UART2_TX+PAD_RX no_arbitrary_tx=1")
ARM_EVENT = re.compile(
    rb"^EVENT read_armed variant=(A4|0E) valid_ms=15000 no_tx_yet=1$"
)
END_RECORD = re.compile(
    rb"^END reason=(\d{1,3}) ro_bytes=(\d{1,10}) ro_lost=(\d{1,10}) "
    rb"uart_errors=(\d{1,10}) pad_verified=([0-4]) words_started=([0-4]) "
    rb"ecu_verified=0 dtc_verified=0 DE=LOW$"
)
TX_PAD = re.compile(
    rb"^TX_PAD slot=([0-3]) expected=([0-9A-F]{4}) "
    rb"observed=([0-9A-F]{4}) tx_us=(\d{1,10}) "
    rb"done_us=(\d{1,10}) match=([01])$"
)


class BridgeError(RuntimeError):
    """Untrusted bridge identity, truncated capture, or uncertain command."""


class SerialPort(Protocol):
    def read(self, size: int = 1) -> bytes: ...

    def write(self, data: bytes) -> int: ...

    def flush(self) -> None: ...


def load_wifi_token(path: Path) -> bytes:
    """Load a provisioned 128-bit token without logging or disclosing it."""
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise BridgeError("WiFi token file must be regular, private (0600), and not a symlink")
        if info.st_uid != os.getuid():
            raise BridgeError("WiFi token file ownership mismatch")
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            current = os.fstat(stream.fileno())
            if (not stat.S_ISREG(current.st_mode) or current.st_mode & 0o077 or
                    (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino)):
                raise BridgeError("WiFi token file changed during open")
            data = stream.read(128)
    except OSError as exc:
        raise BridgeError("Cannot read secure WiFi token file") from exc
    token = data.strip(b"\r\n")
    if not TOKEN_HEX.fullmatch(token) or data not in (token, token + b"\n"):
        raise BridgeError("Invalid WiFi token file format (expected 32 hex characters)")
    return token.lower()


class AuthenticatedTcpPort:
    """Serial-like adapter for one authenticated, non-reconnecting TCP socket.

    No user command crosses the network until AUTH OK is received. Authentication
    traffic is intentionally excluded from the raw ECU evidence transcript and
    never printed. read() distinguishes a quiet socket from EOF.
    """

    def __init__(self, host: str, token: bytes, *,
                 port: int = TCP_PORT, connect_timeout: float = 4.0,
                 read_timeout: float = 0.05) -> None:
        if not host or host.strip() != host or any(
                c in host for c in ("/", "\\", ":", " ", "\n", "\r", "@")):
            raise BridgeError("Invalid WiFi hostname: supply only an IPv4 or DNS/mDNS name")
        if not TOKEN_HEX.fullmatch(token):
            raise BridgeError("Malformed WiFi credential")
        if not 1 <= port <= 65535:
            raise BridgeError("Invalid TCP port")
        try:
            conn = socket.create_connection((host, port), timeout=connect_timeout)
        except OSError as exc:
            raise BridgeError("Cannot connect to authenticated SME105 WiFi bridge") from exc
        self._socket = conn
        self.closed = False
        try:
            conn.settimeout(connect_timeout)
            conn.sendall(b"AUTH " + token + b"\n")
            response = bytearray()
            # Read a single frame strictly; never emit/log credentials or
            # treat extra bytes as an already-authorized command response.
            while not response.endswith(b"\n") and len(response) < 64:
                chunk = conn.recv(1)
                if not chunk:
                    raise BridgeError("WiFi authentication socket closed")
                response.extend(chunk)
            if bytes(response) != b"AUTH OK\n":
                raise BridgeError("WiFi bridge authentication rejected")
            conn.settimeout(read_timeout)
        except (OSError, BridgeError) as exc:
            conn.close()
            if isinstance(exc, BridgeError):
                raise
            raise BridgeError("WiFi bridge authentication failed") from exc

    def read(self, size: int = 1) -> bytes:
        if self.closed:
            raise BridgeError("WiFi bridge socket closed")
        try:
            data = self._socket.recv(size)
        except TimeoutError:
            return b""
        except OSError as exc:
            raise BridgeError("WiFi bridge connection lost") from exc
        if not data:
            raise BridgeError("WiFi bridge disconnected (no automatic reconnection)")
        return data

    def write(self, data: bytes) -> int:
        if self.closed:
            raise BridgeError("WiFi bridge socket closed")
        try:
            self._socket.sendall(data)
        except OSError as exc:
            raise BridgeError("WiFi bridge write failed; command outcome uncertain") from exc
        return len(data)

    def flush(self) -> None:
        # TCP sendall() has no userland buffered bytes to flush; it does not
        # imply that the firmware accepted or executed any vehicle command.
        pass

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self._socket.close()


@dataclass(frozen=True)
class BridgeStatus:
    fields: dict[bytes, bytes]
    de_low: bool

    def field(self, name: str) -> str | None:
        value = self.fields.get(name.encode("ascii"))
        return value.decode("ascii") if value is not None else None


def parse_status(line: bytes) -> BridgeStatus | None:
    """Require a complete, unique, explicitly identified bridge status.

    The key-value suffix permits new *informational* fields. Every required
    safety-critical field is matched against one exact accepted value.
    """
    parts = line.split(b" ")
    if not parts or parts[0] != b"STATUS":
        return None
    if len(parts) < 3 or parts[1] != b"SME105_USB_BRIDGE_V1":
        raise BridgeError("unexpected firmware STATUS identity")
    fields: dict[bytes, bytes] = {}
    for entry in parts[2:]:
        if not KEY_VALUE.fullmatch(entry):
            raise BridgeError("malformed firmware STATUS line")
        name, value = entry.split(b"=", 1)
        if name in fields:
            raise BridgeError("duplicate firmware STATUS field")
        fields[name] = value
    expected = {
        b"auto_tx": b"0",
        b"DE": b"LOW",
        b"gate4": b"1",
    }
    if any(fields.get(name) != value for name, value in expected.items()):
        raise BridgeError("firmware identity/pin/DE mismatch; vehicle TX denied")
    if (fields.get(b"stage") not in tuple(str(n).encode() for n in range(9)) or
            fields.get(b"pad_rx") not in (b"0", b"1") or
            fields.get(b"read_used") not in (b"0", b"1") or
            not fields.get(b"fault", b"").isdigit()):
        raise BridgeError("missing/invalid bridge state or fault code")
    return BridgeStatus(fields=fields, de_low=True)


class EvidenceRecorder:
    """Append verbatim USB transcript and exactly the RO bytes reported.

    The .txt is never re-encoded: it is the exact serial byte stream. The
    .bin contains only octets from validated RX events, in arrival order,
    with timestamps and optional sequence numbers retained in the transcript.
    Malformed/missing-sequence events invalidate completeness without
    deleting any USB evidence actually received.
    """

    def __init__(self, folder: Path, stamp: str | None = None) -> None:
        folder.mkdir(parents=True, exist_ok=True)
        unique = stamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        self.txt_path = folder / f"{unique}-usb-bridge.txt"
        self.bin_path = folder / f"{unique}-usb-bridge.bin"
        self._txt = self.txt_path.open("xb")
        try:
            self._bin = self.bin_path.open("xb")
        except BaseException:
            self._txt.close()
            raise
        self._txt_hash = hashlib.sha256()
        self._bin_hash = hashlib.sha256()
        self._buffer = bytearray()
        self._discard_overlong_line = False
        self.closed = False
        self.usb_bytes = 0
        self.rx_bytes = 0
        self.last_seq: int | None = None
        self.uses_sequence: bool | None = None
        self.last_time_us: int | None = None
        self.fault: str | None = None

    def _fault(self, reason: str) -> None:
        if self.fault is None:
            self.fault = reason

    def feed(self, data: bytes) -> list[bytes]:
        if self.closed:
            raise BridgeError("capture already closed")
        # The transcript persists BEFORE any interpretation of framed events.
        self._txt.write(data)
        self._txt_hash.update(data)
        self.usb_bytes += len(data)
        completed: list[bytes] = []
        self._buffer.extend(data)
        while True:
            end = self._buffer.find(b"\n")
            if end < 0:
                if len(self._buffer) > MAX_LINE:
                    self._fault("overlong/truncated serial event")
                    self._discard_overlong_line = True
                    self._buffer.clear()
                break
            line = bytes(self._buffer[:end + 1])
            del self._buffer[:end + 1]
            if self._discard_overlong_line:
                self._discard_overlong_line = False
                continue
            if len(line) > MAX_LINE:
                self._fault("overlong serial event")
                continue
            completed.append(line)
            self._parse_rx(line.rstrip(b"\r\n"))
        return completed

    def _parse_rx(self, line: bytes) -> None:
        if not line.startswith(b"RX "):
            return
        record = RX_RECORD.fullmatch(line)
        if record is None:
            self._fault("malformed RX record")
            return
        timestamp = int(record[1])
        if timestamp > 0xFFFFFFFF:
            self._fault("RX timestamp outside uint32")
            return
        with_sequence = record[3] is not None
        if self.uses_sequence is None:
            self.uses_sequence = with_sequence
        elif self.uses_sequence != with_sequence:
            self._fault("mixed RX event formats with/without sequence")
        if with_sequence:
            sequence = int(record[3])
            if self.last_seq is not None and sequence != self.last_seq + 1:
                self._fault("missing, duplicated or reordered RX sequence")
            self.last_seq = sequence
        if (self.last_time_us is not None and
                ((timestamp - self.last_time_us) & 0xFFFFFFFF) > 0x7FFFFFFF):
            self._fault("RX timestamps reversed")
        self.last_time_us = timestamp
        # Once any continuity error happens, retain raw USB bytes but do not
        # silently append later bytes to an apparently complete binary.
        if self.fault:
            return
        octet = bytes.fromhex(record[2].decode("ascii"))
        self._bin.write(octet)
        self._bin_hash.update(octet)
        self.rx_bytes += 1

    def close(self) -> tuple[str, str]:
        if self.closed:
            return self._txt_hash.hexdigest(), self._bin_hash.hexdigest()
        if self._buffer or self._discard_overlong_line:
            self._fault("serial transcript has unterminated final line")
        self.closed = True
        for output in (self._txt, self._bin):
            output.flush()
            os.fsync(output.fileno())
            output.close()
        return self._txt_hash.hexdigest(), self._bin_hash.hexdigest()


class BridgeClient:
    """One serial reader throughout terminal input, with a guarded writer."""

    def __init__(self, port: SerialPort, evidence: EvidenceRecorder,
                 display: Callable[[str], None] = print) -> None:
        self.port = port
        self.evidence = evidence
        self.display = display
        self._condition = threading.Condition()
        self._stopping = threading.Event()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._write_lock = threading.Lock()
        self._status_generation = 0
        self._status: BridgeStatus | None = None
        self._hello_generation = 0
        self._pins_generation = 0
        self._arm_generation = 0
        self._arm_variant: str | None = None
        self._arm_deadline = 0.0
        self._stop_generation = 0
        self._end_generation = 0
        self._session_start_rx = 0
        self._session_name: str | None = None
        self._session_requested = False
        self._read_variant: str | None = None
        self._reader_error: str | None = None
        self._integrity_error: str | None = None
        self._di_mismatch = False
        self._pending_transmit = False
        self._hello_sent = False
        self._request_sent = False
        self._verified_status = False
        self._session_ended = threading.Event()

    @property
    def fault(self) -> str | None:
        with self._condition:
            return (self._reader_error or self._integrity_error or
                    self.evidence.fault or
                    ("GPIO17 TX/DI mismatch" if self._di_mismatch else None))

    def start(self) -> None:
        self._reader.start()

    def _read_loop(self) -> None:
        try:
            while not self._stopping.is_set():
                data = self.port.read(4096)
                if not data:
                    continue
                for raw_line in self.evidence.feed(data):
                    line = raw_line.rstrip(b"\r\n")
                    try:
                        parsed = parse_status(line)
                        if parsed is not None:
                            with self._condition:
                                self._status = parsed
                                self._verified_status = True
                                self._status_generation += 1
                                self._condition.notify_all()
                    except BridgeError as exc:
                        with self._condition:
                            self._integrity_error = str(exc)
                            self._condition.notify_all()
                    if line == HELLO_REPLY:
                        with self._condition:
                            self._hello_generation += 1
                            self._condition.notify_all()
                    elif line.startswith(b"HELLO "):
                        self._set_integrity_fault("untrusted USB HELLO identity")
                    if line == PINS_REPLY:
                        with self._condition:
                            self._pins_generation += 1
                            self._condition.notify_all()
                    elif line.startswith(b"PINS "):
                        self._set_integrity_fault("wrong bridge GPIO pin topology")
                    if line.startswith(b"EVENT session="):
                        with self._condition:
                            self._session_start_rx = self.evidence.rx_bytes
                            self._session_name = line.decode("ascii", "replace")
                            self._session_ended.clear()
                    if line.startswith(b"EVENT read_armed"):
                        armed = ARM_EVENT.fullmatch(line)
                        if armed is None:
                            self._set_integrity_fault("malformed firmware ARM reply")
                        else:
                            with self._condition:
                                self._arm_variant = armed[1].decode("ascii")
                                self._arm_deadline = time.monotonic() + 15.0
                                self._arm_generation += 1
                                self._condition.notify_all()
                    if line.startswith(b"TX_PAD "):
                        witness = TX_PAD.fullmatch(line)
                        expected_words = (
                            ("01B0", "FF5F", "26A4", "00A0")
                            if self._read_variant == "A4" else
                            ("01B0", "FF5F", "260E", "00A0")
                            if self._read_variant == "0E" else ()
                        )
                        if (witness is None or not expected_words or
                                witness[2].decode("ascii") !=
                                expected_words[int(witness[1])] or
                                witness[3] != witness[2] or witness[6] != b"1"):
                            self._di_mismatch = True
                            self._set_integrity_fault(
                                "GPIO17 pad TX mismatch; no further vehicle TX"
                            )
                    if (b"DI_MISMATCH" in line or b"TX_MISMATCH" in line or
                            b"di_match=0" in line):
                        with self._condition:
                            self._di_mismatch = True
                            self._condition.notify_all()
                    if line.startswith((b"FAULT ", b"FATAL ", b"DENIED ",
                                        b"EVENT rx_lost=", b"EVENT uart_errors=")):
                        self._set_integrity_fault(
                            "firmware fault, rejection or lost UART bytes"
                        )
                    if line.startswith(b"EVENT stop="):
                        with self._condition:
                            self._stop_generation += 1
                            self._condition.notify_all()
                    if line.startswith(b"END "):
                        ended = END_RECORD.fullmatch(line)
                        if ended is None:
                            self._set_integrity_fault("malformed/untrusted END record")
                        else:
                            reported = int(ended[2])
                            actual = self.evidence.rx_bytes - self._session_start_rx
                            if reported != actual:
                                self._set_integrity_fault(
                                    f"END RX count mismatch: firmware={reported}, USB={actual}"
                                )
                            if int(ended[3]) or int(ended[4]):
                                self._set_integrity_fault("firmware lost UART RX evidence")
                            if self._read_variant is not None and (
                                    int(ended[5]) != int(ended[6])):
                                self._set_integrity_fault(
                                    "one or more UART2 words lack GPIO17 pad confirmation"
                                )
                            with self._condition:
                                self._pending_transmit = False
                                self._session_name = None
                                self._session_requested = False
                                self._session_ended.set()
                                self._end_generation += 1
                                self._condition.notify_all()
                    self.display(raw_line.decode("utf-8", errors="backslashreplace").rstrip("\r\n"))
                if self.evidence.fault:
                    with self._condition:
                        self._integrity_error = self.evidence.fault
                        self._condition.notify_all()
        except (OSError, serial.SerialException, BridgeError) as exc:
            with self._condition:
                self._reader_error = f"serial capture failed: {exc}"
                self._condition.notify_all()
        finally:
            with self._condition:
                self._condition.notify_all()

    def _set_integrity_fault(self, message: str) -> None:
        with self._condition:
            if self._integrity_error is None:
                self._integrity_error = message
            self._condition.notify_all()

    def _send(self, command: str) -> None:
        if command not in WIRE_COMMANDS:
            raise BridgeError("unsupported USB command")
        data = (command + "\n").encode("ascii")
        with self._write_lock:
            try:
                written = self.port.write(data)
                if written != len(data):
                    raise BridgeError("partial USB command write; TX state uncertain")
                self.port.flush()
            except (OSError, serial.SerialException, BridgeError) as exc:
                raise BridgeError(f"USB command write failed: {exc}") from exc

    def _wait_response(self, name: str, generation: int,
                       timeout: float, *, allow_fault: bool = False) -> None:
        limit = time.monotonic() + timeout
        with self._condition:
            while getattr(self, name) == generation:
                if self._reader_error or (not allow_fault and (
                        self._integrity_error or self.evidence.fault)):
                    raise BridgeError(
                        self._reader_error or self._integrity_error or
                        self.evidence.fault or "firmware response untrusted"
                    )
                remaining = limit - time.monotonic()
                if remaining <= 0:
                    raise BridgeError(f"firmware {name} response timed out")
                self._condition.wait(remaining)

    def verify_identity(self, timeout: float = 2.0) -> None:
        """A USB-only HELLO, STATUS and PINS before any vehicle command."""
        with self._condition:
            start = self._hello_generation
        self._send("HELLO")
        self._wait_response("_hello_generation", start, timeout)
        self.status(timeout)
        with self._condition:
            start = self._pins_generation
        self._send("PINS")
        self._wait_response("_pins_generation", start, timeout)
        self.display("Firmware identity, pinned GPIOs, auto-TX-off and DE LOW verified")

    def status(self, timeout: float = 2.0) -> BridgeStatus:
        with self._condition:
            generation = self._status_generation
        if self.fault:
            raise BridgeError(f"bridge already faulted: {self.fault}")
        self._send("STATUS")
        deadline = time.monotonic() + timeout
        with self._condition:
            while self._status_generation == generation:
                if self._reader_error or self._integrity_error or self.evidence.fault:
                    raise BridgeError(self.fault or "bridge invalid")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BridgeError("firmware STATUS timeout; TX denied")
                self._condition.wait(remaining)
            assert self._status is not None
            return self._status

    def _validate_idle_for_vehicle(self, status: BridgeStatus) -> None:
        if (status.field("stage") != "0" or
                status.field("read_used") != "0" or
                status.field("fault") not in ("0", "15") or
                self._session_name is not None or self._pending_transmit):
            raise BridgeError("bridge busy, failed, or read already consumed")
        if self.fault:
            raise BridgeError(f"firmware/capture evidence fault: {self.fault}")

    def _await_arm(self, variant: str, timeout: float = 2.0) -> None:
        with self._condition:
            previous = self._arm_generation
            self._arm_variant = None
        self._send("ARM_" + variant)
        self._wait_response("_arm_generation", previous, timeout)
        if self._arm_variant != variant:
            raise BridgeError("wrong ARM variant from firmware; READ denied")

    def wait_end(self, timeout: float = 120.0) -> None:
        deadline = time.monotonic() + timeout
        with self._condition:
            while not self._session_ended.is_set():
                if self._reader_error or self._integrity_error or self.evidence.fault:
                    raise BridgeError(f"session evidence incomplete: {self.fault}")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BridgeError("END never arrived; no retry; evidence preserved")
                self._condition.wait(remaining)
        if self.fault:
            raise BridgeError(f"session evidence incomplete: {self.fault}")

    def stop(self, timeout: float = 3.0) -> None:
        if not self._verified_status:
            return
        with self._condition:
            previous = self._stop_generation
            was_active = (self._session_name is not None or
                          self._session_requested or self._pending_transmit)
        self._send("STOP")
        self._wait_response("_stop_generation", previous, timeout, allow_fault=True)
        if was_active:
            self.wait_end(timeout)

    def execute(self, command: str, authorize: Callable[[str], bool]) -> None:
        if command not in COMMANDS:
            raise BridgeError("unknown menu command")
        if command == "EXIT":
            return
        if command == "STATUS":
            status = self.status()
            self.display(f"Validated bridge stage={status.field('stage')} "
                         f"fault={status.field('fault')} "
                         f"read_used={status.field('read_used')} DE=LOW")
            return
        if command == "STOP":
            self.stop()
            self.display("STOP acknowledged by firmware (DE=LOW)")
            return
        if command == "HELLO" and self._hello_sent:
            raise BridgeError("HELLO already attempted this host session")
        if command.startswith("REQUEST_") and self._request_sent:
            raise BridgeError("request already attempted this host session")
        initial = self.status()
        if initial.field("stage") != "0" or self._session_name is not None:
            raise BridgeError("active bridge session; use STOP before a new command")
        if command == "LISTEN":
            self._session_requested = True
            self._session_ended.clear()
            self._send("LISTEN_9600")
            self.display("Started passive RO16 UART1 listening; raw events recorded.")
            return
        self._validate_idle_for_vehicle(initial)
        if command == "HELLO":
            if self._hello_sent:
                raise BridgeError("HELLO already attempted this host session")
        elif command.startswith("REQUEST_"):
            if self._request_sent:
                raise BridgeError("request already attempted this host session")
        else:
            raise BridgeError("unsupported vehicle TX command")
        if not authorize(command):
            self.display("Cancelled; no vehicle TX.")
            return
        checked = self.status()
        self._validate_idle_for_vehicle(checked)
        if command.startswith("REQUEST_"):
            # Firmware requires two physical USB messages: ARM then READ.
            # A second typed confirmation and fresh firmware STATUS is
            # required between them. No automatic ARM->READ execution.
            variant = command.removeprefix("REQUEST_")
            self._request_sent = True  # uncertain ARM may not be repeated
            self._await_arm(variant)
            if not authorize("READ_" + variant):
                self.display("Cancelled after ARM; no vehicle READ sent.")
                return
            checked = self.status()
            self._validate_idle_for_vehicle(checked)
            if (self._arm_variant != variant or
                    time.monotonic() >= self._arm_deadline - 1.0):
                raise BridgeError("ARM timed out or changed; READ denied")
            wire = "READ_" + variant
            self._read_variant = variant
        else:
            wire = "OBSERVE"
        # Mark the command spent BEFORE attempting a potentially partial write.
        self._pending_transmit = True
        self._session_requested = True
        self._session_ended.clear()
        if command == "HELLO":
            self._hello_sent = True
        else:
            self._request_sent = True
        self._send(wire)
        self.display(f"{wire} dispatched once. Streaming raw evidence; "
                     "no automatic retry or DTC interpretation.")

    def close(self) -> tuple[str, str]:
        self._stopping.set()
        if self._reader.ident is not None:
            self._reader.join(timeout=1.0)
        if self._reader.is_alive():
            raise BridgeError("serial reader did not stop; capture still active")
        return self.evidence.close()


def confirm_vehicle(command: str, user_input: Callable[[str], str] = input,
                    display: Callable[[str], None] = print) -> bool:
    display("WARNING: Real V5 GPIO17 DI packet decoded as "
            f"{V5_GPIO17_WORDS} despite requested {SOURCE_WORDS}. "
            "The transmit mismatch is unresolved; no DTC verified.")
    display("HELLO means active EchoID/GoCART. REQUEST uses source-fixed "
            "experimental B words. Confirm the adapter and KOEO condition.")
    return user_input(f"Type SEND {command} to authorize exactly one vehicle command: ").strip() == f"SEND {command}"


def menu(display: Callable[[str], None] = print) -> None:
    display("Commands: STATUS | LISTEN | HELLO | REQUEST_A4 | REQUEST_0E | STOP | EXIT")
    display("LISTEN is RX-only. HELLO uses active 2400-baud handshake; "
            "REQUEST needs ARM and a separately approved READ.")


def main(argv: list[str] | None = None,
         input_fn: Callable[[str], str] = input,
         display: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default="/dev/ttyUSB0")
    parser.add_argument("--host", help="WiFi bridge hostname/IP (for example sme105-bridge.local)")
    parser.add_argument("--token-file", type=Path, default=DEFAULT_TOKEN_FILE,
                        help="private 0600 file containing the 128-bit WiFi token")
    parser.add_argument("--tcp-port", type=int, default=TCP_PORT,
                        help=argparse.SUPPRESS)
    parser.add_argument("--startup-seconds", type=float, default=1.5,
                        help="settle ESP32 USB reset before accepting protocol records")
    parser.add_argument("--output-dir", type=Path,
                        default=ROOT / "captures" / "SME105_97AB")
    parser.add_argument("--command", choices=COMMANDS,
                        help="one command then exit; car TX still requires typed confirmation")
    parser.add_argument("--seconds", type=float, default=120.0,
                        help="maximum wait for END after one-off LISTEN/HELLO/REQUEST")
    args = parser.parse_args(argv)
    if args.seconds < 0 or args.seconds > 86400:
        parser.error("--seconds must be in [0, 86400]")
    if not 0 <= args.startup_seconds <= 10:
        parser.error("--startup-seconds must be in [0, 10]")
    evidence = EvidenceRecorder(args.output_dir)
    display(f"Transcript: {evidence.txt_path}")
    display(f"Raw RX octets: {evidence.bin_path}")
    client: BridgeClient | None = None
    port: SerialPort | None = None
    exit_code = 0
    try:
        if args.host:
            token = load_wifi_token(args.token_file.expanduser())
            port = AuthenticatedTcpPort(args.host, token, port=args.tcp_port)
        else:
            port = serial.Serial(args.port, BAUD, timeout=0.05,
                                 write_timeout=0.8, dsrdtr=False, rtscts=False)
            port.dtr = False
            port.rts = False
            # Opening CP210x USB can reset the device; discard only ROM boot
            # chatter before the first diagnostic operation. WiFi has no reset.
            if args.startup_seconds:
                time.sleep(args.startup_seconds)
                port.reset_input_buffer()
        client = BridgeClient(port, evidence, display=display)
        client.start()
        # USB HELLO does not communicate with the ECU. Confirm the exact
        # firmware version, pins and DE state before accepting menu input.
        client.verify_identity()
        if args.command is not None:
            if args.command in CAR_TRANSMIT:
                client.execute(args.command,
                               lambda action: confirm_vehicle(action, input_fn, display))
            elif args.command != "STATUS":
                client.execute(args.command, lambda _: False)
            if args.command in CAR_TRANSMIT | {"LISTEN"} and (
                    client._session_requested or client._pending_transmit or
                    client._session_name is not None):
                client.wait_end(args.seconds)
        else:
            menu(display)
            while True:
                try:
                    command = input_fn("bridge> ").strip().upper()
                except EOFError:
                    break
                if command == "EXIT":
                    break
                if command not in COMMANDS:
                    display("Unrecognized command. " + ", ".join(COMMANDS))
                    continue
                try:
                    client.execute(command, lambda action: confirm_vehicle(
                        action, input_fn, display))
                except BridgeError as exc:
                    display(f"DENIED: {exc}")
                if client.fault:
                    display(f"CAPTURE/BRIDGE FAULT: {client.fault}. "
                            "Vehicle commands disabled; evidence preserved.")
    except (BridgeError, serial.SerialException, OSError, KeyboardInterrupt) as exc:
        display(f"STOP: {exc}")
        exit_code = 2
    finally:
        try:
            if client is None:
                txt_sha, bin_sha = evidence.close()
            else:
                if client._verified_status:
                    try:
                        client.stop()
                    except BridgeError as exc:
                        display(f"STOP confirmation unavailable: {exc}")
                        exit_code = 3
                txt_sha, bin_sha = client.close()
            display(f"USB raw transcript: {evidence.txt_path} SHA256={txt_sha}")
            display(f"UART1 received binary: {evidence.bin_path} "
                    f"bytes={evidence.rx_bytes} SHA256={bin_sha}")
            if evidence.fault or (client is not None and client.fault):
                display(f"INCOMPLETE/UNTRUSTED capture: "
                        f"{evidence.fault or client.fault}; do not interpret as DTC.")
                exit_code = 3
        except (OSError, BridgeError) as exc:
            display(f"ERROR closing evidence: {exc}")
            exit_code = 2
        finally:
            if port is not None:
                try:
                    port.close()
                except (OSError, serial.SerialException, BridgeError) as exc:
                    display(f"Bridge close error: {exc}")
                    exit_code = 2
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
