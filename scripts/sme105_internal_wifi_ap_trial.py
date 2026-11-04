"""Safely trial a second AP interface on the built-in Realtek Wi-Fi radio.

Prepare as the desktop user. Activate as root *only after the user approves
Ubuntu authentication*. Never use GNOME's normal hotspot button: that converts
the existing Venom STA into an AP and disconnects internet.
"""
from __future__ import annotations

import argparse
import os
import re
import secrets
import stat
import subprocess
import sys
import time
from pathlib import Path

SSID = "SME105-LOQ"
MAIN = "wlp9s0"
VIRTUAL = "sme105ap"
PROFILE = "SME105-LOQ-Internal-AP"
CHANNEL = "8"  # Must match the 2.4 GHz home-router STA association.
IPV4 = "10.77.14.1/24"
SECRET = Path.home() / ".config/sme105/loq-ap-pass"


class SetupError(Exception):
    pass


def run(*args: str, allow_fail: bool = False, timeout: int = 15) -> str:
    result = subprocess.run(
        args, capture_output=True, text=True, timeout=timeout, check=False,
    )
    if result.returncode and not allow_fail:
        raise SetupError(f"Command failed: {args[0]} {args[1] if len(args)>1 else ''}")
    return result.stdout.strip()


def verify_main_connected() -> None:
    if run("nmcli", "-g", "GENERAL.CONNECTION", "device", "show", MAIN) != "Venom":
        raise SetupError("Venom STA must be connected before trying concurrent AP")
    if "dev wlp9s0" not in run("ip", "-4", "route", "get", "1.1.1.1"):
        raise SetupError("Existing internet route must stay on internal Wi-Fi")
    link = run("iwconfig", MAIN)
    if not re.search(r"Frequency:2\.447 GHz", link):
        raise SetupError("Venom must currently use channel 8 (2447 MHz)")


def load_secret(create: bool) -> str:
    folder = SECRET.parent
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = folder.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077):
        raise SetupError("Private SME105 configuration directory is not safe")
    if SECRET.exists() or SECRET.is_symlink():
        info = SECRET.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077):
            raise SetupError("Existing AP secret file is not owner-only")
        value = SECRET.read_text(encoding="ascii").strip()
    elif create:
        value = secrets.token_urlsafe(24)
        fd = os.open(SECRET, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as f:
            f.write(value + "\n")
    else:
        raise SetupError("No private AP key exists")
    if not re.fullmatch(r"[A-Za-z0-9_-]{24,63}", value):
        raise SetupError("Unexpected private AP key format")
    return value


def save_profile_secret(value: str) -> None:
    import dbus

    bus = dbus.SystemBus()
    base = "org.freedesktop.NetworkManager"
    settings = dbus.Interface(
        bus.get_object(base, "/org/freedesktop/NetworkManager/Settings"),
        base + ".Settings",
    )
    matches = []
    for path in settings.ListConnections():
        conn = dbus.Interface(bus.get_object(base, path), base + ".Settings.Connection")
        config = conn.GetSettings()
        if str(config.get("connection", {}).get("id", "")) == PROFILE:
            matches.append((conn, config))
    if len(matches) != 1:
        raise SetupError("Expected exactly one dedicated AP connection")
    conn, config = matches[0]
    ident = config.get("connection", {})
    wifi = config.get("802-11-wireless", {})
    security = config.get("802-11-wireless-security", {})
    ip4 = config.get("ipv4", {})
    ip6 = config.get("ipv6", {})
    if (str(ident.get("interface-name")) != VIRTUAL
            or bool(ident.get("autoconnect", False))
            or bytes(wifi.get("ssid", b"")).decode() != SSID
            or str(wifi.get("mode")) != "ap"
            or str(wifi.get("band")) != "bg"
            or int(wifi.get("channel", 0)) != int(CHANNEL)
            or str(security.get("key-mgmt")) != "wpa-psk"
            or str(ip4.get("method")) != "shared"
            or not ip4.get("never-default", False)
            or str(ip6.get("method")) != "disabled"):
        raise SetupError("Refusing secret update: AP profile settings changed")
    security["psk"] = dbus.String(value)
    security["psk-flags"] = dbus.UInt32(0)
    conn.Update(config)


def prepare() -> None:
    if os.geteuid() == 0:
        raise SetupError("Run --prepare as desktop user, never sudo")
    verify_main_connected()
    value = load_secret(create=True)
    existing = run("nmcli", "-t", "-f", "NAME", "connection", "show").splitlines()
    if PROFILE not in existing:
        run("nmcli", "connection", "add", "type", "wifi", "ifname",
            VIRTUAL, "con-name", PROFILE, "ssid", SSID, "autoconnect", "no")
    run("nmcli", "connection", "modify", PROFILE,
        "connection.interface-name", VIRTUAL, "connection.autoconnect", "no",
        "802-11-wireless.mode", "ap", "802-11-wireless.band", "bg",
        "802-11-wireless.channel", CHANNEL,
        "802-11-wireless-security.key-mgmt", "wpa-psk",
        "ipv4.method", "shared", "ipv4.addresses", IPV4,
        "ipv4.never-default", "yes",
        "ipv6.method", "disabled")
    save_profile_secret(value)
    verify_main_connected()
    print("Prepared SME105-LOQ WPA2 profile on future virtual AP (inactive).")
    print("Venom internet intact. Private PSK saved; no firmware changes.")


def ensure_virtual() -> bool:
    if os.path.exists("/sys/class/net/" + VIRTUAL):
        info = run("iw", "dev", VIRTUAL, "info")
        if "type AP" not in info:
            raise SetupError("Existing interface name is not an AP")
        return False
    run("iw", "phy", "phy0", "interface", "add", VIRTUAL, "type", "__ap")
    return True


def deactivate() -> None:
    if os.geteuid() != 0:
        raise SetupError("Root authorization needed to remove virtual AP")
    run("nmcli", "connection", "down", PROFILE, allow_fail=True)
    if os.path.exists("/sys/class/net/" + VIRTUAL):
        run("iw", "dev", VIRTUAL, "del", allow_fail=True)
    print("Virtual AP stopped; Venom interface was never modified.")


def activate() -> None:
    if os.geteuid() != 0:
        raise SetupError("Root authorization needed for iw virtual AP interface")
    # Do not run if the user's main connection has moved.
    verify_main_connected()
    if not Path("/usr/sbin/iw").exists() and not Path("/usr/bin/iw").exists():
        raise SetupError("Install Ubuntu package iw with: sudo apt install iw")
    new_interface = False
    success = False
    try:
        new_interface = ensure_virtual()
        # NetworkManager may need a moment to enumerate a virtual radio.
        for _ in range(12):
            info = run("nmcli", "-t", "-f", "DEVICE,TYPE", "device", "status")
            if f"{VIRTUAL}:wifi" in info:
                break
            time.sleep(0.25)
        run("nmcli", "connection", "up", "id", PROFILE, "ifname", VIRTUAL, timeout=25)
        for _ in range(10):
            verify_main_connected()
            if run("nmcli", "-g", "GENERAL.CONNECTION", "device", "show", VIRTUAL) != PROFILE:
                raise SetupError("AP virtual link stopped unexpectedly")
            time.sleep(0.5)
        info = run("iw", "dev", VIRTUAL, "info")
        if "type AP" not in info or "channel 8 " not in info:
            raise SetupError("Virtual AP is not operating on channel 8")
        print("PASS: STA Venom + internal virtual AP SME105-LOQ simultaneously active.")
        print("Laptop AP IPv4 10.77.14.1/24. ESP32 has NOT been reprovisioned yet.")
        success = True
    finally:
        if not success:
            run("nmcli", "connection", "down", PROFILE, allow_fail=True)
            if new_interface and os.path.exists("/sys/class/net/" + VIRTUAL):
                run("iw", "dev", VIRTUAL, "del", allow_fail=True)
            print("AP test failed; attempted automatic rollback of virtual interface.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--prepare", action="store_true")
    mode.add_argument("--activate", action="store_true")
    mode.add_argument("--stop", action="store_true")
    args = parser.parse_args()
    try:
        if args.prepare:
            prepare()
        elif args.activate:
            activate()
        else:
            deactivate()
    except (SetupError, OSError, subprocess.TimeoutExpired, UnicodeError, ValueError) as exc:
        print("ERROR:", str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
