"""Allow-listed PlatformIO build/upload runner with streamed output."""

from __future__ import annotations

import shutil
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from ..capture import utc_now
from .resources import resource_path

_SKETCHES = frozenset({"passive_ascii", "passive_binary", "dcl_master"})
_UPLOADABLE = frozenset({"passive_ascii", "passive_binary"})
_UPLOAD_CONFIRMATION = "FLASH_RECEIVE_ONLY_FIRMWARE"


def platformio_executable() -> str | None:
    """Locate PlatformIO Core without accepting operator-supplied paths."""

    names = ("pio.exe", "pio") if sys.platform == "win32" else ("pio",)
    candidates: list[Path] = []
    for name in names:
        found = shutil.which(name)
        if found:
            candidates.append(Path(found))
        candidates.append(Path(sys.executable).resolve().parent / name)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


class FirmwareRunner:
    """Run only known PlatformIO projects without accepting shell text."""

    def __init__(self, publish: Callable[[dict[str, Any]], None]) -> None:
        self._publish = publish
        self._lock = threading.RLock()
        self._process: subprocess.Popen[str] | None = None
        self._thread: threading.Thread | None = None
        self._last_exit_code: int | None = None

    def status(self) -> dict[str, Any]:
        with self._lock:
            running = self._thread is not None and self._thread.is_alive()
            return {
                "running": running,
                "platformio": platformio_executable(),
                "last_exit_code": self._last_exit_code,
                "upload_confirmation": _UPLOAD_CONFIRMATION,
                "uploadable_sketches": sorted(_UPLOADABLE),
                "buildable_sketches": sorted(_SKETCHES),
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
            if sketch not in _UPLOADABLE:
                raise PermissionError("active-master upload is locked")
            if confirmation != _UPLOAD_CONFIRMATION:
                raise PermissionError("receive-only firmware confirmation is required")
            if not port:
                raise ValueError("serial port is required for firmware upload")
        executable = platformio_executable()
        if executable is None:
            raise RuntimeError("PlatformIO Core is not installed or not on PATH")
        project_dir = resource_path("firmware", sketch)
        if not (project_dir / "platformio.ini").is_file():
            raise FileNotFoundError(f"firmware project is unavailable: {project_dir}")
        command = [
            executable,
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
        with self._lock:
            if self._process is not None and self._process.poll() is None:
                self._process.terminate()
        return self.status()
