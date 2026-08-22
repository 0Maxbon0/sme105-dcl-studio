"""Validated persistent settings for the local application."""

from __future__ import annotations

import json
import os
import tempfile
import threading
from collections.abc import Mapping
from copy import deepcopy
from pathlib import Path
from typing import Any

from .resources import config_dir, data_dir, resource_path

DEFAULT_SETTINGS: dict[str, Any] = {
    "port": "",
    "usb_baudrate": 460800,
    "capture_format": "binary",
    "reconnect": True,
    "reconnect_delay": 1.0,
    "duration_seconds": 30.0,
    "rotate_size": 64 * 1024 * 1024,
    "read_size": 16 * 1024,
    "dcl_baud": 9600,
    "dcl_format": "8N2-candidate",
    "firmware": "passive_binary-v3",
    "adapter": "XY-K485-receive-only",
    "ignition_state": "off",
    "engine_state": "stopped",
    "session_label": "KOEO_BASELINE",
    "output_dir": str(data_dir() / "captures"),
    "analysis_dir": str(data_dir() / "analysis"),
    "profile_path": str(resource_path("profiles", "sme_105.json")),
    "high_idle_rpm": 1000.0,
    "fully_warm_ect_deg_c": 80.0,
    "minimum_iac_percent": 10.0,
    "expert_overrides": False,
    "wizard_progress": {},
}

_ALLOWED = frozenset(DEFAULT_SETTINGS)


class SettingsStore:
    """Thread-safe JSON settings store with atomic replacement."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or config_dir() / "settings.json"
        self._lock = threading.RLock()

    def load(self) -> dict[str, Any]:
        with self._lock:
            document = deepcopy(DEFAULT_SETTINGS)
            if self.path.exists():
                raw = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(raw, Mapping):
                    raise ValueError("settings file must contain a JSON object")
                document.update(
                    {key: value for key, value in raw.items() if key in _ALLOWED}
                )
            return validate_settings(document)

    def update(self, changes: Mapping[str, Any]) -> dict[str, Any]:
        unknown = sorted(set(changes) - _ALLOWED)
        if unknown:
            raise ValueError(f"unknown settings: {', '.join(unknown)}")
        with self._lock:
            document = self.load()
            document.update(changes)
            document = validate_settings(document)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary = tempfile.mkstemp(
                prefix="settings-", suffix=".json", dir=self.path.parent
            )
            try:
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    json.dump(document, handle, indent=2, sort_keys=True)
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                Path(temporary).replace(self.path)
            except Exception:
                Path(temporary).unlink(missing_ok=True)
                raise
            return document


def validate_settings(document: Mapping[str, Any]) -> dict[str, Any]:
    """Validate settings and return a detached mutable document."""

    result = dict(document)
    if result["capture_format"] not in {"ascii", "binary"}:
        raise ValueError("capture_format must be ascii or binary")
    for key in ("usb_baudrate", "rotate_size", "read_size", "dcl_baud"):
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"{key} must be a positive integer")
    for key in (
        "reconnect_delay",
        "duration_seconds",
        "high_idle_rpm",
        "fully_warm_ect_deg_c",
        "minimum_iac_percent",
    ):
        value = result[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0:
            raise ValueError(f"{key} must be a non-negative number")
    if result["duration_seconds"] == 0:
        raise ValueError("duration_seconds must be positive")
    if not isinstance(result["reconnect"], bool):
        raise ValueError("reconnect must be boolean")
    if not isinstance(result["expert_overrides"], bool):
        raise ValueError("expert_overrides must be boolean")
    if not isinstance(result["wizard_progress"], Mapping):
        raise ValueError("wizard_progress must be an object")
    for key in (
        "port",
        "dcl_format",
        "firmware",
        "adapter",
        "ignition_state",
        "engine_state",
        "session_label",
        "output_dir",
        "analysis_dir",
        "profile_path",
    ):
        if not isinstance(result[key], str):
            raise ValueError(f"{key} must be a string")
    return result
