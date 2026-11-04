"""Save the SME105 USB-only Wi-Fi PSK to a known NetworkManager profile.

Run with /usr/bin/python3 on Ubuntu (python3-dbus). This is a narrowly scoped
local secret-agent operation. No password on CLI, stdout, or environment.
"""
from __future__ import annotations

import os
import re
import stat
import sys
from pathlib import Path

import dbus

PROFILE = "SME105-Direct-USB"
IFACE = "wlx1cbfce64dd94"
SSID = "SME105-DIRECT-2BF8"
ADDRESS = "10.77.13.2"
PSK_FILE = Path.home() / ".config/sme105/direct-ap-pass"


class SecretProvisionError(Exception):
    pass


def private_psk() -> str:
    if not PSK_FILE.exists() or PSK_FILE.is_symlink():
        raise SecretProvisionError("Missing private AP key")
    info = PSK_FILE.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
            info.st_mode & 0o077):
        raise SecretProvisionError("AP key file is not owner-only")
    value = PSK_FILE.read_text("ascii").strip()
    if not re.fullmatch(r"[!-~]{16,63}", value):
        raise SecretProvisionError("Invalid AP key bytes")
    return value


def set_secret() -> None:
    key = private_psk()
    bus = dbus.SystemBus()
    base = "org.freedesktop.NetworkManager"
    settings = dbus.Interface(
        bus.get_object(base, "/org/freedesktop/NetworkManager/Settings"),
        base + ".Settings",
    )
    matches = []
    for path in settings.ListConnections():
        connection = dbus.Interface(
            bus.get_object(base, path), base + ".Settings.Connection"
        )
        config = connection.GetSettings()
        identity = config.get("connection", {})
        if str(identity.get("id", "")) != PROFILE:
            continue
        matches.append((connection, config))
    if len(matches) != 1:
        raise SecretProvisionError("No unique direct USB Wi-Fi profile")
    connection, config = matches[0]
    wifi = config.get("802-11-wireless", {})
    sec = config.get("802-11-wireless-security", {})
    ip4 = config.get("ipv4", {})
    ip6 = config.get("ipv6", {})
    identity = config.get("connection", {})
    actual_ssid = bytes(wifi.get("ssid", b"")).decode("utf-8", "replace")
    addresses = ip4.get("address-data", [])
    correct_ip = any(str(a.get("address")) == ADDRESS and int(a.get("prefix", -1)) == 24
                     for a in addresses)
    if (str(identity.get("interface-name")) != IFACE or
            actual_ssid != SSID or str(sec.get("key-mgmt")) != "wpa-psk" or
            str(ip4.get("method")) != "manual" or
            not bool(ip4.get("never-default", False)) or
            str(ip4.get("gateway", "")) or ip4.get("dns", []) or
            ip4.get("routes", []) or not correct_ip or
            str(ip6.get("method")) != "disabled"):
        raise SecretProvisionError("Unsafe or unexpected USB-only profile")
    # Update the existing profile atomically via NetworkManager's D-Bus API:
    # unlike nmcli ..., this never places the PSK in process command arguments.
    sec["psk"] = dbus.String(key)
    sec["psk-flags"] = dbus.UInt32(0)
    connection.Update(config)


if __name__ == "__main__":
    try:
        set_secret()
        print("NetworkManager USB-only WPA2 secret saved privately.")
        sys.exit(0)
    except (SecretProvisionError, dbus.DBusException, OSError, UnicodeError):
        print("NetworkManager USB-only secret provisioning failed; nothing disclosed.")
        sys.exit(2)
