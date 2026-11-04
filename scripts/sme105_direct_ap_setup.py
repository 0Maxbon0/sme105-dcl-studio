"""Provision SME105 direct WPA2 AP over USB and attach the dedicated RT5370.

Never changes the built-in Wi-Fi, default route, DNS, or the existing Venom STA
credentials. The AP key is generated once into an owner-only 0600 file, sent
only to a physically attached ESP32, and never printed or passed as argv.
"""
from __future__ import annotations

import argparse
import os
import secrets
import stat
import subprocess
import sys
import time
from pathlib import Path

import serial

# Direct execution resolves scripts/ as sys.path[0], not the repo root.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.sme105_usb_bridge import DEFAULT_TOKEN_FILE, TOKEN_HEX
from scripts.sme105_wifi_setup import (
    ProvisioningError,
    UsbSetupClient,
    validate_credentials,
    wifi_config_command,
)

AP_SSID = "SME105-DIRECT-2BF8"
AP_IP = "10.77.13.1"
HOST_IP = "10.77.13.2/24"
USB_IFACE = "wlx1cbfce64dd94"
HOST_PROFILE = "SME105-Direct-USB"
AP_PSK_FILE = Path("~/.config/sme105/direct-ap-pass").expanduser()
ESP_PORT = (
    "/dev/serial/by-id/"
    "usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0"
)


def read_or_create_private_key(path: Path) -> str:
    """Durably store a strong random AP key, never expose existing user data."""
    path = path.expanduser()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    parent = path.parent.lstat()
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or
            parent.st_mode & 0o077 or path.parent.is_symlink()):
        raise ProvisioningError("Private AP key folder has unsafe permissions")
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
                info.st_mode & 0o077):
            raise ProvisioningError("Existing AP key path is not a private regular file")
        value = path.read_text(encoding="ascii").strip()
    else:
        value = secrets.token_urlsafe(24)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as f:
                os.fchmod(f.fileno(), 0o600)
                f.write(value + "\n")
                f.flush()
                os.fsync(f.fileno())
        except BaseException:
            try:
                path.unlink()
            except OSError:
                pass
            raise
    validate_credentials(AP_SSID, value)
    if len(value) < 16 or not value.isascii():
        raise ProvisioningError("AP key must contain 16–63 printable ASCII characters")
    return value


def provision_esp(port_path: str, psk: str) -> None:
    """On-device AP config is USB only; no ECU operations are admitted."""
    ssid, password = validate_credentials(AP_SSID, psk)
    wire = wifi_config_command(ssid, password).replace(
        b"WIFI_CONFIG ", b"WIFI_AP_CONFIG ", 1
    )
    with serial.Serial(
        port_path, 115200, timeout=0.05, write_timeout=0.8,
        dsrdtr=False, rtscts=False,
    ) as port:
        port.dtr = False
        port.rts = False
        time.sleep(1.4)
        port.reset_input_buffer()
        client = UsbSetupClient(port)
        # Status-only retry; never repeat a secret-bearing command on uncertain
        # outcome and never send an active vehicle command.
        for attempt in range(2):
            try:
                client.verify_identity()
                break
            except ProvisioningError:
                if attempt:
                    raise
                time.sleep(0.6)
                port.reset_input_buffer()
        current = client.request(b"WIFI_AP_STATUS\n", timeout=3)
        if ap_is_active(current):
            return
        # Reuse saved AP config on later runs; never overwrite a working PSK
        # across multiple NVS writes or blindly resubmit a secret command.
        switched = client.request(b"WIFI_AP_MODE\n", timeout=8)
        if switched == b"DENIED wifi_ap_unavailable":
            reply = client.request(wire, timeout=12)
            if reply != b"WIFI_AP_CONFIG OK saved=1 starting=1":
                raise ProvisioningError("ESP32 did not acknowledge new AP credentials")
        elif switched != b"WIFI_AP_MODE OK starting=1":
            raise ProvisioningError("ESP32 did not acknowledge saved AP mode")
        for _ in range(16):
            info = client.request(b"WIFI_AP_STATUS\n", timeout=3)
            if ap_is_active(info):
                return
            time.sleep(0.5)
    raise ProvisioningError("ESP32 saved AP configuration, but AP did not report ACTIVE")


def ap_is_active(reply: bytes) -> bool:
    """Fail closed on wrong identity/IP even if the radio says 'ACTIVE'."""
    return reply in (
        (b"WIFI_AP_STATUS mode=AP state=ACTIVE ip=10.77.13.1 "
         b"stations=0 channel=6 port=8765 wpa2=1"),
        (b"WIFI_AP_STATUS mode=AP state=ACTIVE ip=10.77.13.1 "
         b"stations=1 channel=6 port=8765 wpa2=1"),
    )


def nmcli(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ("nmcli", *args), text=True, capture_output=True, timeout=20, check=False,
    )
    if check and result.returncode:
        raise ProvisioningError("NetworkManager USB-only connection command failed")
    return result


def prepare_usb_profile() -> None:
    """Static LAN-only link; absent gateway/DNS => cannot steal internet."""
    current = nmcli("-t", "-f", "NAME", "connection", "show").stdout.splitlines()
    if HOST_PROFILE in current:
        ssid = nmcli("-g", "802-11-wireless.ssid", "connection", "show", HOST_PROFILE).stdout.strip()
        iface = nmcli("-g", "connection.interface-name", "connection", "show", HOST_PROFILE).stdout.strip()
        if ssid != AP_SSID or iface != USB_IFACE:
            raise ProvisioningError("Existing network profile name belongs to another interface")
    else:
        # Prevent NetworkManager from auto-activating a partial profile with
        # an accidental DHCP/default route between add and hardening.
        nmcli("connection", "add", "type", "wifi", "ifname", USB_IFACE,
              "con-name", HOST_PROFILE, "ssid", AP_SSID, "autoconnect", "no")
    nmcli(
        "connection", "modify", HOST_PROFILE,
        "802-11-wireless.mode", "infrastructure",
        "802-11-wireless-security.key-mgmt", "wpa-psk",
        "connection.autoconnect", "yes",
        "connection.interface-name", USB_IFACE,
        "ipv4.method", "manual",
        "ipv4.addresses", HOST_IP,
        "ipv4.gateway", "",
        "ipv4.dns", "",
        "ipv4.routes", "",
        "ipv4.never-default", "yes",
        "ipv4.ignore-auto-dns", "yes",
        "ipv6.method", "disabled",
    )


def verify_existing_token() -> None:
    """The direct AP does not rotate the existing 128-bit TCP authority."""
    path = DEFAULT_TOKEN_FILE
    if not path.exists() or path.is_symlink():
        raise ProvisioningError("Existing private TCP token is required")
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or
            info.st_mode & 0o077 or
            not TOKEN_HEX.fullmatch(path.read_bytes().strip())):
        raise ProvisioningError("Existing TCP token is not a valid private file")


def activate_usb_profile() -> None:
    """Store the PSK via system python3-dbus without leaking it into argv."""
    helper = Path(__file__).with_name("sme105_nm_usb_secret.py")
    result = subprocess.run(
        ("/usr/bin/python3", str(helper)),
        text=True, capture_output=True, timeout=20, check=False,
    )
    if result.returncode:
        raise ProvisioningError("NetworkManager rejected the private USB Wi-Fi key")
    active = nmcli("-g", "GENERAL.CONNECTION", "device", "show", USB_IFACE).stdout.strip()
    if active != HOST_PROFILE:
        nmcli("connection", "up", "id", HOST_PROFILE, "ifname", USB_IFACE)


def verify_routes() -> None:
    route = subprocess.run(
        ("ip", "-4", "route", "get", AP_IP),
        check=True, capture_output=True, text=True, timeout=4,
    ).stdout
    default = subprocess.run(
        ("ip", "-4", "route", "get", "1.1.1.1"),
        check=True, capture_output=True, text=True, timeout=4,
    ).stdout
    if not (" dev " + USB_IFACE + " " in route and " src 10.77.13.2 " in route):
        raise ProvisioningError("Direct ESP route is not bound to USB adapter")
    if " dev wlp9s0 " not in default:
        raise ProvisioningError("Existing laptop internet route unexpectedly changed")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", default=ESP_PORT)
    parser.add_argument("--iface", default=USB_IFACE)
    args = parser.parse_args()
    if args.iface != USB_IFACE:
        parser.error("Only the independently detected dedicated USB Wi-Fi adapter is allowed")
    try:
        verify_existing_token()
        psk = read_or_create_private_key(AP_PSK_FILE)
        provision_esp(args.port, psk)
        print("ESP32 AP is ACTIVE at 10.77.13.1; WPA2 passphrase stored owner-only.")
        prepare_usb_profile()
        activate_usb_profile()
        verify_routes()
        print("USB Wi-Fi linked on 10.77.13.2, no default gateway; laptop internet remains on Venom.")
        return 0
    except (ProvisioningError, serial.SerialException, OSError,
            subprocess.SubprocessError) as exc:
        # Never echo untrusted exception text: it could embed the credential.
        print("Direct Wi-Fi setup incomplete. No AP password or token has been displayed.")
        if isinstance(exc, ProvisioningError):
            print("Safe diagnostic:", str(exc))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
