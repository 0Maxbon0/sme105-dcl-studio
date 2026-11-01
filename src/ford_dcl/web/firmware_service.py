"""Allow-listed PlatformIO build/upload runner with streamed output."""

from __future__ import annotations

import importlib.util
import shutil
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..capture import utc_now
from .resources import resource_path

_SKETCHES = frozenset(
    {"passive_ascii", "passive_binary", "dcl_master", "bench_test", "sniffer"}
)
_UPLOAD_CONFIRMATIONS = {
    "passive_ascii": "FLASH_RECEIVE_ONLY_FIRMWARE",
    "passive_binary": "FLASH_RECEIVE_ONLY_FIRMWARE",
    "sniffer": "FLASH_RECEIVE_ONLY_FIRMWARE",
    "bench_test": "FLASH_BENCH_TEST_DESK_ONLY",
}
_UPLOADABLE = frozenset(_UPLOAD_CONFIRMATIONS)
_BENCH_MONITOR_BAUD = 115200


def platformio_command() -> list[str] | None:
    """Return an allow-listed PlatformIO invocation, or None if missing."""

    # Do not Path.resolve() sys.executable. A venv python is often a symlink
    # to /usr/bin/python3.x; resolving it then running -m platformio uses the
    # system interpreter, which does not have the venv site-packages.
    if importlib.util.find_spec("platformio") is not None:
        return [sys.executable, "-m", "platformio"]
    names = ("pio.exe", "pio") if sys.platform == "win32" else ("pio",)
    python = Path(sys.executable)
    home = Path.home()
    candidates: list[Path] = []
    for name in names:
        candidates.append(python.parent / name)
        candidates.append(home / ".platformio" / "penv" / "Scripts" / name)
        candidates.append(home / ".platformio" / "penv" / "bin" / name)
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if candidate.is_file():
            return [str(candidate)]
    return None


def platformio_executable() -> str | None:
    """Locate PlatformIO Core without accepting operator-supplied paths."""

    command = platformio_command()
    if command is None:
        return None
    return " ".join(command)


class FirmwareRunner:
    """Run only known PlatformIO projects without accepting shell text."""

    def __init__(self, publish: Callable[[dict[str, Any]], None]) -> None:
        self._publish = publish
        self._lock = threading.RLock()
        self._process: subprocess.Popen[str] | None = None
        self._thread: threading.Thread | None = None
        self._last_exit_code: int | None = None
        self._monitor_thread: threading.Thread | None = None
        self._monitor_stop = threading.Event()
        self._monitor_port: str | None = None

    def status(self) -> dict[str, Any]:
        with self._lock:
            running = self._thread is not None and self._thread.is_alive()
            monitor_running = (
                self._monitor_thread is not None and self._monitor_thread.is_alive()
            )
            return {
                "running": running,
                "platformio": platformio_executable(),
                "last_exit_code": self._last_exit_code,
                "upload_confirmation": _UPLOAD_CONFIRMATIONS["passive_binary"],
                "bench_upload_confirmation": _UPLOAD_CONFIRMATIONS["bench_test"],
                "uploadable_sketches": sorted(_UPLOADABLE),
                "buildable_sketches": sorted(_SKETCHES),
                "monitor_running": monitor_running,
                "monitor_port": self._monitor_port if monitor_running else None,
                "monitor_baud": _BENCH_MONITOR_BAUD,
            }

    def run(
        self,
        *,
        sketch: str,
        action: str,
        port: str | None = None,
        confirmation: str | None = None,
    ) -> dict[str, Any]:
        if sketch not in _SKETCHES:
            raise ValueError("unknown firmware project")
        if action not in {"build", "upload"}:
            raise ValueError("firmware action must be build or upload")
        if action == "upload":
            required = _UPLOAD_CONFIRMATIONS.get(sketch)
            if required is None:
                raise PermissionError("active-master upload is locked")
            if confirmation != required:
                raise PermissionError("firmware confirmation is required")
            if not port:
                raise ValueError("serial port is required for firmware upload")
            self.stop_monitor()
        executable = platformio_command()
        if executable is None:
            raise RuntimeError("PlatformIO Core is not installed or not on PATH")
        project_dir = resource_path("firmware", sketch)
        if not (project_dir / "platformio.ini").is_file():
            raise FileNotFoundError(f"firmware project is unavailable: {project_dir}")
        command = [
            *executable,
            "run",
            "--project-dir",
            str(project_dir),
            "--environment",
            "esp32dev",
        ]
        if action == "upload":
            command.extend(("--target", "upload", "--upload-port", str(port)))
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise RuntimeError("a firmware task is already running")
            self._last_exit_code = None
            self._thread = threading.Thread(
                target=self._worker,
                args=(command, sketch, action),
                name="ford-dcl-firmware",
                daemon=True,
            )
            self._thread.start()
        return self.status()

    def _worker(self, command: list[str], sketch: str, action: str) -> None:
        self._publish(
            {
                "event": "firmware_task_started",
                "utc": utc_now(),
                "sketch": sketch,
                "action": action,
            }
        )
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                shell=False,
            )
            with self._lock:
                self._process = process
            assert process.stdout is not None
            for line in process.stdout:
                self._publish(
                    {
                        "event": "firmware_log",
                        "utc": utc_now(),
                        "message": line.rstrip(),
                    }
                )
            exit_code = process.wait()
            with self._lock:
                self._last_exit_code = exit_code
            self._publish(
                {
                    "event": "firmware_task_finished",
                    "utc": utc_now(),
                    "exit_code": exit_code,
                }
            )
        except Exception as exc:
            with self._lock:
                self._last_exit_code = -1
            self._publish(
                {
                    "event": "firmware_task_failed",
                    "utc": utc_now(),
                    "error": type(exc).__name__,
                    "detail": str(exc),
                }
            )
        finally:
            with self._lock:
                self._process = None

    def cancel(self) -> dict[str, Any]:
        self.stop_monitor()
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                self._process.terminate()
        return self.status()

    def start_monitor(self, port: str) -> dict[str, Any]:
        """Read USB ASCII logs from the desk bench sketch at 115200."""

        selected = str(port or "").strip()
        if not selected:
            raise ValueError("serial port is required for the bench monitor")
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                raise RuntimeError("stop the firmware task before opening the monitor")
            if self._monitor_thread is not None and self._monitor_thread.is_alive():
                raise RuntimeError("the bench monitor is already running")
            self._monitor_stop = threading.Event()
            self._monitor_port = selected
            self._monitor_thread = threading.Thread(
                target=self._monitor_worker,
                args=(selected,),
                name="ford-dcl-bench-monitor",
                daemon=True,
            )
            self._monitor_thread.start()
        return self.status()

    def stop_monitor(self) -> dict[str, Any]:
        self._monitor_stop.set()
        thread = None
        with self._lock:
            thread = self._monitor_thread
        if thread is not None:
            thread.join(2.0)
        return self.status()

    def _monitor_worker(self, port: str) -> None:
        import serial

        self._publish(
            {
                "event": "bench_monitor_started",
                "utc": utc_now(),
                "port": port,
                "baud": _BENCH_MONITOR_BAUD,
            }
        )
        try:
            with serial.Serial(port, _BENCH_MONITOR_BAUD, timeout=0.25) as link:
                buffer = b""
                while not self._monitor_stop.is_set():
                    chunk = link.read(256)
                    if not chunk:
                        continue
                    buffer += chunk
                    while b"\n" in buffer:
                        raw, buffer = buffer.split(b"\n", 1)
                        message = raw.decode("utf-8", errors="replace").rstrip("\r")
                        if message:
                            self._publish(
                                {
                                    "event": "firmware_log",
                                    "utc": utc_now(),
                                    "message": message,
                                }
                            )
        except Exception as exc:
            self._publish(
                {
                    "event": "bench_monitor_failed",
                    "utc": utc_now(),
                    "error": type(exc).__name__,
                    "detail": str(exc),
                }
            )
        finally:
            with self._lock:
                if self._monitor_port == port:
                    self._monitor_port = None
            self._publish(
                {
                    "event": "bench_monitor_stopped",
                    "utc": utc_now(),
                    "port": port,
                }
            )
