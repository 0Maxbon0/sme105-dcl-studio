"""Cross-platform serial-port discovery without opening devices."""

from __future__ import annotations

import os
import sys
from typing import Any

from serial.tools import list_ports

_LINUX_RELAUNCH = "sg dialout -c 'ford-dcl-gui'"


def current_group_names() -> tuple[str, ...]:
    """Return supplementary group names for this process."""

    names: list[str] = []
    try:
        import grp
    except ImportError:
        return ()
    for gid in os.getgroups():
        try:
            names.append(grp.getgrgid(gid).gr_name)
        except KeyError:
            continue
    return tuple(sorted(set(names)))


def serial_access_status() -> dict[str, Any]:
    """Explain why a Linux tty may be visible but unreadable."""

    if sys.platform == "win32":
        return {
            "ok": True,
            "platform": sys.platform,
            "hint": "Windows uses the vendor USB/UART driver and COM ports.",
        }
    groups = current_group_names()
    configured = False
    try:
        import grp

        configured = os.environ.get("USER", os.environ.get("LOGNAME", "")) in set(
            grp.getgrnam("dialout").gr_mem
        )
    except (ImportError, KeyError):
        configured = False
    active = "dialout" in groups
    if active:
        hint = "This process has dialout membership."
    elif configured:
        hint = (
            "The account is in dialout, but this process is not. Close the app "
            f"and relaunch with `{_LINUX_RELAUNCH}`, or fully quit Cursor and "
            "open a new login session."
        )
    else:
        hint = (
            'Add the user with `sudo usermod -aG dialout "$USER"`, then log out '
            f"and back in, or relaunch with `{_LINUX_RELAUNCH}`."
        )
    return {
        "ok": active,
        "platform": sys.platform,
        "dialout_configured": configured,
        "dialout_active": active,
        "groups": list(groups),
        "relaunch_command": _LINUX_RELAUNCH,
        "hint": hint,
    }


def list_serial_ports() -> list[dict[str, Any]]:
    """Return normalized pyserial port metadata."""

    access = serial_access_status()
    output = []
    for port in sorted(list_ports.comports(), key=lambda item: item.device.lower()):
        permission = (
            True
            if sys.platform == "win32"
            else os.access(port.device, os.R_OK | os.W_OK)
        )
        stable_identity = (
            f"{port.vid:04X}:{port.pid:04X}:{port.serial_number or ''}"
            if port.vid is not None and port.pid is not None
            else port.hwid
        )
        output.append(
            {
                "device": port.device,
                "name": port.name,
                "description": port.description,
                "manufacturer": port.manufacturer,
                "product": port.product,
                "serial_number": port.serial_number,
                "vid": port.vid,
                "pid": port.pid,
                "location": port.location,
                "hwid": port.hwid,
                "stable_identity": stable_identity,
                "permission": permission,
                "access_hint": None if permission else access["hint"],
            }
        )
    return output
