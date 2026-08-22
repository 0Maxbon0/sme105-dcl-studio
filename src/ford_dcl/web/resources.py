"""Resource and user-data paths for source and frozen installations."""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_SLUG = "sme105-dcl-studio"


def resource_path(*parts: str) -> Path:
    """Return a bundled project resource path."""

    if getattr(sys, "frozen", False):
        root = Path(sys._MEIPASS)
    else:
        root = Path(__file__).resolve().parents[3]
    return root.joinpath(*parts)


def config_dir() -> Path:
    """Return the OS-appropriate per-user configuration directory."""

    override = os.environ.get("FORD_DCL_CONFIG_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        return base / "SME105DCLStudio"
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / APP_SLUG


def data_dir() -> Path:
    """Return the writable application-data directory."""

    override = os.environ.get("FORD_DCL_DATA_DIR")
    if override:
        return Path(override).expanduser().resolve()
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "SME105DCLStudio"
    base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / APP_SLUG
