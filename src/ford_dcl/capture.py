"""Loss-conscious USB capture for ASCII and binary ESP firmware.

USB bytes are always stored before interpretation. ASCII mode recognizes
whitespace-separated uppercase two-digit hexadecimal tokens; line endings are
ordinary whitespace and are never interpreted as DCL frame boundaries. Binary
mode validates fixed SLIP records from :mod:`ford_dcl.transport`.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from .transport import DecodeBatch, RecordType, TransportStreamDecoder

_HEX_TOKEN = re.compile(rb"^[0-9A-F]{2}$")
_ASCII_WHITESPACE = frozenset(b" \t\r\n\v\f")
CaptureFormat = Literal["ascii", "binary"]


def utc_now() -> str:
    """Return a microsecond-resolution UTC timestamp."""

    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="microseconds")
        .replace("+00:00", "Z")
    )


@dataclass(frozen=True, slots=True)
class ParsedToken:
    """One token recognized from the whitespace-delimited USB text stream."""

    kind: Literal["hex_byte", "banner_text", "malformed_text", "token_overflow"]
    raw: bytes
    start_offset: int
    end_offset: int
    value: int | None = None
    detail: str = ""


class TextTokenParser:
    """Incrementally parse arbitrary chunks of firmware text.

    Printable non-hex tokens before the first byte are treated as banner text.
    Once byte output starts, non-hex tokens are malformed text. Non-printable
    tokens are always malformed. Lines have no semantic role.
    """

    def __init__(self, max_token_size: int = 4096) -> None:
        if max_token_size < 2:
            raise ValueError("max_token_size must be at least 2")
        self.max_token_size = max_token_size
        self._token = bytearray()
        self._token_start = 0
        self._stream_offset = 0
        self._data_started = False
        self._discarding_token = False

    @property
    def stream_offset(self) -> int:
        """Number of raw USB bytes consumed."""

        return self._stream_offset

    def feed(self, data: bytes, *, final: bool = False) -> list[ParsedToken]:
        """Consume raw USB bytes and return completed tokens."""

        output: list[ParsedToken] = []
        for byte in data:
            offset = self._stream_offset
            self._stream_offset += 1
            if byte in _ASCII_WHITESPACE:
                if not self._discarding_token:
                    token = self._complete_token(offset)
                    if token is not None:
                        output.append(token)
                self._discarding_token = False
                self._token.clear()
                continue
            if self._discarding_token:
                continue
            if not self._token:
                self._token_start = offset
            self._token.append(byte)
            if len(self._token) > self.max_token_size:
                output.append(
                    ParsedToken(
                        kind="token_overflow",
                        raw=bytes(self._token[: self.max_token_size]),
                        start_offset=self._token_start,
                        end_offset=self._stream_offset,
                        detail=f"token exceeded {self.max_token_size} bytes; remainder discarded",
                    )
                )
                self._token.clear()
                self._discarding_token = True

        if final:
            if not self._discarding_token:
                token = self._complete_token(self._stream_offset)
                if token is not None:
                    output.append(token)
            self._token.clear()
            self._discarding_token = False
        return output

    def _complete_token(self, end_offset: int) -> ParsedToken | None:
        if not self._token:
            return None
        raw = bytes(self._token)
        self._token.clear()
        if _HEX_TOKEN.fullmatch(raw):
            self._data_started = True
            return ParsedToken(
                "hex_byte",
                raw,
                self._token_start,
                end_offset,
                value=int(raw, 16),
            )
        printable = all(0x20 <= byte <= 0x7E for byte in raw)
        kind: Literal["banner_text", "malformed_text"]
        kind = (
            "banner_text" if printable and not self._data_started else "malformed_text"
        )
        detail = (
            "firmware banner text" if kind == "banner_text" else "not uppercase XX hex"
        )
        return ParsedToken(kind, raw, self._token_start, end_offset, detail=detail)


def parse_text_bytes(data: bytes) -> list[ParsedToken]:
    """Parse a complete byte string without serial hardware."""

    return TextTokenParser().feed(data, final=True)


@dataclass(frozen=True, slots=True)
class CaptureConfig:
    """Serial and storage settings for a capture session."""

    port: str
    output_dir: Path
    baudrate: int = 115_200
    rotate_size: int = 64 * 1024 * 1024
    read_size: int = 16 * 1024
    reconnect_delay: float = 1.0
    reconnect: bool = True
    format: CaptureFormat = "ascii"
    session_metadata: Mapping[str, str] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.port:
            raise ValueError("port cannot be empty")
        if self.baudrate <= 0:
            raise ValueError("baudrate must be positive")
        if self.rotate_size <= 0:
            raise ValueError("rotate_size must be positive")
        if self.read_size <= 0:
            raise ValueError("read_size must be positive")
        if self.reconnect_delay < 0:
            raise ValueError("reconnect_delay cannot be negative")
        if self.format not in {"ascii", "binary"}:
            raise ValueError("format must be 'ascii' or 'binary'")
        if any(
            not isinstance(key, str) or not key or not isinstance(value, str)
            for key, value in self.session_metadata.items()
        ):
            raise ValueError(
                "session metadata must use non-empty string keys and string values"
            )


class CaptureSession:
    """Create-only session storage with raw rotation and JSONL events."""

    def __init__(
        self,
        config: CaptureConfig,
        event_sink: Callable[[Mapping[str, Any]], None] | None = None,
    ) -> None:
        self.config = config
        self._event_sink = event_sink
        config.output_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        self.path = self._create_session_dir(config.output_dir, stamp)
        self.started_utc = utc_now()
        self.started_monotonic_ns = time.monotonic_ns()
        self._events = (self.path / "events.jsonl").open("x", encoding="utf-8")
        self._event_count = 0
        self._usb_bytes = 0
        self._parsed_bytes = 0
        self._transport_records = 0
        self._transport_errors = 0
        self._segment_index = -1
        self._segment_file: Any | None = None
        self._segment_name = ""
        self._segment_size = 0
        self._segment_hash: Any | None = None
        self._segments: list[dict[str, Any]] = []
        self._closed = False
        self._write_metadata()
        self._open_segment()
        self.event(
            "session_started",
            port=config.port,
            baudrate=config.baudrate,
            rotate_size=config.rotate_size,
            format=config.format,
            line_framing=False,
        )

    @staticmethod
    def _create_session_dir(parent: Path, stamp: str) -> Path:
        for suffix in ("", *(f"-{number:02d}" for number in range(1, 100))):
            candidate = parent / f"{stamp}{suffix}"
            try:
                candidate.mkdir()
            except FileExistsError:
                continue
            return candidate
        raise FileExistsError(
            f"cannot allocate unique session directory under {parent}"
        )

    def _write_metadata(self) -> None:
        metadata = {
            "schema": "ford-dcl-capture",
            "schema_version": 2,
            "created_utc": self.started_utc,
            "created_monotonic_ns": self.started_monotonic_ns,
            "port": self.config.port,
            "usb_baudrate": self.config.baudrate,
            "rotate_size": self.config.rotate_size,
            "read_size": self.config.read_size,
            "reconnect": self.config.reconnect,
            "reconnect_delay": self.config.reconnect_delay,
            "format": self.config.format,
            "raw_format": "exact USB bytes split only for size rotation",
            "content_format": (
                "whitespace-separated uppercase XX tokens"
                if self.config.format == "ascii"
                else "SLIP-framed fixed 15-byte MCU records"
            ),
            "line_framing": False,
            "session": dict(sorted(self.config.session_metadata.items())),
        }
        with (self.path / "metadata.json").open("x", encoding="utf-8") as handle:
            json.dump(metadata, handle, indent=2, sort_keys=True)
            handle.write("\n")

    def _open_segment(self) -> None:
        self._segment_index += 1
        self._segment_name = f"usb-{self._segment_index:04d}.bin"
        self._segment_file = (self.path / self._segment_name).open("xb")
        self._segment_size = 0
        self._segment_hash = hashlib.sha256()
        self.event("raw_file_opened", file=self._segment_name)

    def _close_segment(self) -> None:
        if self._segment_file is None or self._segment_hash is None:
            return
        self._segment_file.flush()
        self._segment_file.close()
        segment = {
            "file": self._segment_name,
            "size": self._segment_size,
            "sha256": self._segment_hash.hexdigest(),
        }
        self._segments.append(segment)
        self.event("raw_file_closed", **segment)
        self._segment_file = None
        self._segment_hash = None

    def event(
        self,
        kind: str,
        *,
        utc: str | None = None,
        monotonic_ns: int | None = None,
        **fields: Any,
    ) -> None:
        """Append one timestamped event."""

        if self._closed:
            raise RuntimeError("capture session is closed")
        record = {
            "event": kind,
            "utc": utc if utc is not None else utc_now(),
            "monotonic_ns": (
                monotonic_ns if monotonic_ns is not None else time.monotonic_ns()
            ),
            **fields,
        }
        self._events.write(json.dumps(record, separators=(",", ":"), sort_keys=True))
        self._events.write("\n")
        self._events.flush()
        self._event_count += 1
        if self._event_sink is not None:
            try:
                self._event_sink(record)
            except Exception:
                # Capture integrity must not depend on an optional UI listener.
                pass

    def write_raw(self, data: bytes, *, utc: str, monotonic_ns: int) -> None:
        """Persist exact USB bytes, rotating without splitting or losing bytes."""

        position = 0
        while position < len(data):
            if self._segment_file is None or self._segment_hash is None:
                self._open_segment()
            capacity = self.config.rotate_size - self._segment_size
            if capacity == 0:
                self._close_segment()
                self._open_segment()
                capacity = self.config.rotate_size
            part = data[position : position + capacity]
            offset = self._segment_size
            self._segment_file.write(part)
            self._segment_file.flush()
            self._segment_hash.update(part)
            self._segment_size += len(part)
            self._usb_bytes += len(part)
            self.event(
                "raw_usb",
                utc=utc,
                monotonic_ns=monotonic_ns,
                file=self._segment_name,
                offset=offset,
                length=len(part),
            )
            position += len(part)

    def record_tokens(
        self,
        tokens: Sequence[ParsedToken],
        *,
        utc: str,
        monotonic_ns: int,
    ) -> None:
        """Store parser output while coalescing consecutive byte tokens."""

        pending: list[ParsedToken] = []

        def flush_bytes() -> None:
            if not pending:
                return
            values = bytes(token.value for token in pending if token.value is not None)
            self._parsed_bytes += len(values)
            self.event(
                "hex_bytes",
                utc=utc,
                monotonic_ns=monotonic_ns,
                data=values.hex().upper(),
                count=len(values),
                first_offset=pending[0].start_offset,
                last_offset=pending[-1].end_offset,
            )
            pending.clear()

        for token in tokens:
            if token.kind == "hex_byte":
                pending.append(token)
                continue
            flush_bytes()
            fields: dict[str, Any] = {
                "raw_hex": token.raw.hex().upper(),
                "start_offset": token.start_offset,
                "end_offset": token.end_offset,
                "detail": token.detail,
            }
            if token.kind in {"banner_text", "malformed_text"}:
                fields["text"] = token.raw.decode("ascii", errors="backslashreplace")
            self.event(
                token.kind,
                utc=utc,
                monotonic_ns=monotonic_ns,
                **fields,
            )
        flush_bytes()

    def record_transport(
        self,
        batch: DecodeBatch,
        *,
        utc: str,
        monotonic_ns: int,
    ) -> None:
        """Append validated binary records and nonfatal decoder errors."""

        for record in batch.records:
            self._transport_records += 1
            if record.record_type == RecordType.DATA:
                self._parsed_bytes += 1
            self.event(
                "transport_record",
                utc=utc,
                monotonic_ns=monotonic_ns,
                version=record.version,
                type=record.record_type,
                direction=record.direction,
                status=record.status,
                timestamp_us=record.timestamp_us,
                value=record.value,
                value_hex=f"{record.value:02X}",
            )
        for error in batch.errors:
            self._transport_errors += 1
            self.event(
                "transport_error",
                utc=utc,
                monotonic_ns=monotonic_ns,
                code=error.code,
                detail=error.detail,
                frame_hex=error.frame_hex,
            )

    def close(self, reason: str) -> None:
        """Finalize segment hashes and append the terminal session summary."""

        if self._closed:
            return
        self._close_segment()
        self.event(
            "session_ended",
            reason=reason,
            usb_bytes=self._usb_bytes,
            parsed_bytes=self._parsed_bytes,
            transport_records=self._transport_records,
            transport_errors=self._transport_errors,
            raw_segments=self._segments,
            prior_event_count=self._event_count,
        )
        self._events.flush()
        self._events.close()
        self._closed = True


class SerialCapture:
    """Reconnect-capable pyserial capture runner."""

    def __init__(
        self,
        config: CaptureConfig,
        event_sink: Callable[[Mapping[str, Any]], None] | None = None,
    ) -> None:
        self.config = config
        self.event_sink = event_sink
        self.stop_event = threading.Event()
        self.session_path: Path | None = None

    def stop(self) -> None:
        """Request clean shutdown."""

        self.stop_event.set()

    def run(self) -> Path:
        """Capture until stopped or interrupted and return the session path."""

        try:
            import serial
        except ImportError as exc:  # pragma: no cover - depends on installation
            raise RuntimeError("pyserial is required for capture") from exc

        session = CaptureSession(self.config, self.event_sink)
        self.session_path = session.path
        parser = TextTokenParser() if self.config.format == "ascii" else None
        decoder = TransportStreamDecoder() if self.config.format == "binary" else None
        connection: Any | None = None
        connected_once = False
        reason = "stopped"
        try:
            while not self.stop_event.is_set():
                try:
                    connection = serial.Serial(
                        port=self.config.port,
                        baudrate=self.config.baudrate,
                        timeout=0.25,
                    )
                    session.event(
                        "reconnected" if connected_once else "connected",
                        port=self.config.port,
                    )
                    connected_once = True
                    backlog_concern = False
                    while not self.stop_event.is_set():
                        waiting = int(getattr(connection, "in_waiting", 0))
                        if waiting > self.config.read_size and not backlog_concern:
                            session.event(
                                "overflow_concern",
                                observed_in_waiting=waiting,
                                read_size=self.config.read_size,
                                detail=(
                                    "serial backlog exceeded one host read; this does not "
                                    "prove data loss"
                                ),
                            )
                            backlog_concern = True
                        elif waiting <= self.config.read_size:
                            backlog_concern = False
                        data = connection.read(
                            min(waiting, self.config.read_size) if waiting else 1
                        )
                        if not data:
                            continue
                        observed_utc = utc_now()
                        observed_monotonic = time.monotonic_ns()
                        session.write_raw(
                            data,
                            utc=observed_utc,
                            monotonic_ns=observed_monotonic,
                        )
                        if parser is not None:
                            session.record_tokens(
                                parser.feed(data),
                                utc=observed_utc,
                                monotonic_ns=observed_monotonic,
                            )
                        else:
                            assert decoder is not None
                            session.record_transport(
                                decoder.feed(data),
                                utc=observed_utc,
                                monotonic_ns=observed_monotonic,
                            )
                except (serial.SerialException, OSError) as exc:
                    if parser is not None:
                        session.record_tokens(
                            parser.feed(b"", final=True),
                            utc=utc_now(),
                            monotonic_ns=time.monotonic_ns(),
                        )
                        # Never combine a token split across two physical
                        # serial connections.
                        parser = TextTokenParser()
                    elif decoder is not None:
                        session.record_transport(
                            decoder.finish(),
                            utc=utc_now(),
                            monotonic_ns=time.monotonic_ns(),
                        )
                    event = (
                        "disconnected" if connection is not None else "connect_failed"
                    )
                    session.event(event, error=type(exc).__name__, detail=str(exc))
                    if not self.config.reconnect:
                        reason = event
                        break
                    self.stop_event.wait(self.config.reconnect_delay)
                finally:
                    if connection is not None:
                        try:
                            connection.close()
                        except (serial.SerialException, OSError) as exc:
                            session.event(
                                "close_error",
                                error=type(exc).__name__,
                                detail=str(exc),
                            )
                        connection = None
                if not self.config.reconnect and not self.stop_event.is_set():
                    break
        except KeyboardInterrupt:
            reason = "keyboard_interrupt"
            self.stop_event.set()
            session.event("shutdown_requested", source="Ctrl+C")
        finally:
            final_utc = utc_now()
            final_monotonic = time.monotonic_ns()
            if parser is not None:
                session.record_tokens(
                    parser.feed(b"", final=True),
                    utc=final_utc,
                    monotonic_ns=final_monotonic,
                )
            else:
                assert decoder is not None
                session.record_transport(
                    decoder.finish(),
                    utc=final_utc,
                    monotonic_ns=final_monotonic,
                )
            session.close(reason)
        return session.path
