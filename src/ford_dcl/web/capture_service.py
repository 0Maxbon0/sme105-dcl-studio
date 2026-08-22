"""Single-owner capture lifecycle and live event ring buffer."""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..capture import CaptureConfig, SerialCapture, utc_now
from ..markers import append_marker
from ..transport import RecordType

_HIGH_VOLUME = frozenset({"raw_usb", "transport_record", "hex_bytes"})
_VOLUME_INTERVAL_S = 0.2


class CaptureManager:
    """Own at most one serial capture and expose its event stream."""

    def __init__(self, event_limit: int = 5000) -> None:
        self._lock = threading.RLock()
        self._events: deque[dict[str, Any]] = deque(maxlen=event_limit)
        self._sequence = 0
        self._runner: SerialCapture | None = None
        self._thread: threading.Thread | None = None
        self._timer: threading.Timer | None = None
        self._session_path: Path | None = None
        self._last_error: str | None = None
        self._started_monotonic: float | None = None
        self._volume: dict[str, int] = {}
        self._last_volume_emit = 0.0

    def publish(self, event: Mapping[str, Any]) -> None:
        """Append one event from any worker thread.

        High-volume capture bytes are coalesced so the live console remains
        usable. Session files still store every original record.
        """

        kind = str(event.get("event", ""))
        record_type = event.get("type")
        if (
            kind == "transport_record"
            and int(record_type or 0) == RecordType.UART_STATUS
        ):
            self._emit(event)
            return
        if kind in _HIGH_VOLUME:
            with self._lock:
                self._volume[kind] = self._volume.get(kind, 0) + 1
                now = time.monotonic()
                if now - self._last_volume_emit < _VOLUME_INTERVAL_S:
                    return
                counts = dict(self._volume)
                self._volume.clear()
                self._last_volume_emit = now
            self._emit(
                {
                    "event": "capture_throughput",
                    "utc": utc_now(),
                    "counts": counts,
                }
            )
            return
        self._emit(event)

    def _emit(self, event: Mapping[str, Any]) -> None:
        with self._lock:
            self._sequence += 1
            record = dict(event)
            record["sequence"] = self._sequence
            self._events.append(record)

    def _flush_volume(self) -> None:
        with self._lock:
            if not self._volume:
                return
            counts = dict(self._volume)
            self._volume.clear()
        self._emit(
            {
                "event": "capture_throughput",
                "utc": utc_now(),
                "counts": counts,
            }
        )

    def start(self, settings: Mapping[str, Any]) -> dict[str, Any]:
        """Start one capture worker or reject concurrent ownership."""

        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise RuntimeError("a capture is already running")
            port = str(settings.get("port", "")).strip()
            if not port:
                raise ValueError("select a serial port before capture")
            metadata = {
                "label": str(settings["session_label"]),
                "dcl_baud": str(settings["dcl_baud"]),
                "dcl_uart_format": str(settings["dcl_format"]),
                "firmware": str(settings["firmware"]),
                "adapter": str(settings["adapter"]),
                "ignition_state": str(settings["ignition_state"]),
                "engine_state": str(settings["engine_state"]),
            }
            config = CaptureConfig(
                port=port,
                output_dir=Path(str(settings["output_dir"])).expanduser(),
                baudrate=int(settings["usb_baudrate"]),
                rotate_size=int(settings["rotate_size"]),
                read_size=int(settings["read_size"]),
                reconnect_delay=float(settings["reconnect_delay"]),
                reconnect=bool(settings["reconnect"]),
                format=str(settings["capture_format"]),
                session_metadata=metadata,
            )
            self._runner = SerialCapture(config, self.publish)
            self._session_path = None
            self._last_error = None
            self._started_monotonic = time.monotonic()
            self._thread = threading.Thread(
                target=self._run_capture,
                name="ford-dcl-capture",
                daemon=True,
            )
            duration = float(settings["duration_seconds"])
            self._timer = threading.Timer(duration, self.stop)
            self._timer.daemon = True
            self._thread.start()
            self._timer.start()
            self.publish(
                {
                    "event": "application_capture_started",
                    "utc": utc_now(),
                    "duration_seconds": duration,
                    "port": port,
                }
            )
            return self.status()

    def _run_capture(self) -> None:
        assert self._runner is not None
        try:
            path = self._runner.run()
            with self._lock:
                self._session_path = path
        except Exception as exc:
            with self._lock:
                self._last_error = f"{type(exc).__name__}: {exc}"
            self.publish(
                {
                    "event": "application_capture_failed",
                    "utc": utc_now(),
                    "error": type(exc).__name__,
                    "detail": str(exc),
                }
            )
        finally:
            with self._lock:
                if self._timer is not None:
                    self._timer.cancel()
                    self._timer = None
                if self._runner is not None and self._runner.session_path is not None:
                    self._session_path = self._runner.session_path
            self._flush_volume()
            self.publish(
                {
                    "event": "application_capture_finished",
                    "utc": utc_now(),
                    "session": str(self._session_path) if self._session_path else None,
                }
            )

    def stop(self) -> dict[str, Any]:
        """Request capture shutdown without blocking a server worker."""

        with self._lock:
            if self._runner is not None:
                self._runner.stop()
            return self.status()

    def wait(self, timeout: float = 5.0) -> bool:
        """Wait for the capture thread; intended for shutdown and tests."""

        with self._lock:
            thread = self._thread
        if thread is None:
            return True
        thread.join(timeout)
        return not thread.is_alive()

    def status(self) -> dict[str, Any]:
        with self._lock:
            running = self._thread is not None and self._thread.is_alive()
            session = self._session_path
            if session is None and self._runner is not None:
                session = self._runner.session_path
            elapsed = (
                time.monotonic() - self._started_monotonic
                if running and self._started_monotonic is not None
                else None
            )
            return {
                "running": running,
                "session": str(session) if session is not None else None,
                "last_error": self._last_error,
                "elapsed_seconds": elapsed,
                "latest_sequence": self._sequence,
            }

    def events_since(self, sequence: int) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(item) for item in self._events if item["sequence"] > sequence]

    def marker(self, label: str, detail: str | None = None) -> dict[str, Any]:
        """Append an operator marker beside the active/latest session."""

        with self._lock:
            session = self._session_path
            if session is None and self._runner is not None:
                session = self._runner.session_path
        if session is None:
            raise RuntimeError("no capture session is available for a marker")
        record = append_marker(session / "operator-events.jsonl", label, detail)
        self.publish({"event": "operator_marker", **record})
        return record
