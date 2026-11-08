"""Fail-closed unit tests for the dedicated USB Wi-Fi to SME105 AP topology.

All tests are offline. No vehicle, ESP write, Wi-Fi scan or NM mutation.
"""
from __future__ import annotations

import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import sme105_direct_ap_setup as direct
from scripts.sme105_wifi_setup import ProvisioningError, UsbSetupClient

ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware/sme105_usb_bridge/sme105_usb_bridge.ino"


class FakePort:
    def __init__(self) -> None:
        self.writes: list[bytes] = []

    def write(self, data: bytes) -> int:
        self.writes.append(data)
        return len(data)

    def flush(self) -> None:
        pass


class SME105DirectApTests(unittest.TestCase):
    def test_private_key_persists_and_is_never_world_readable(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "private"
            path = root / "ap-key"
            key = direct.read_or_create_private_key(path)
            self.assertGreaterEqual(len(key), 24)
            self.assertEqual(direct.read_or_create_private_key(path), key)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(root.stat().st_mode), 0o700)
            self.assertRegex(key, r"^[A-Za-z0-9_-]{24,63}$")

    def test_preexisting_untrusted_secret_path_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "ap-key"
            path.write_text("fake-password-value-12345678\n")
            path.chmod(0o644)
            with self.assertRaises(ProvisioningError):
                direct.read_or_create_private_key(path)
            path.unlink()
            path.symlink_to(Path(folder) / "elsewhere")
            with self.assertRaises(ProvisioningError):
                direct.read_or_create_private_key(path)

    def test_whitelist_permits_ap_provision_only_from_usb_client(self) -> None:
        port = FakePort()
        client = UsbSetupClient(port)  # type: ignore[arg-type]
        encoded = b"WIFI_AP_CONFIG U01FMTUwNS1ESVJFQ1QtMkJGOA== MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=\n"
        client._send(encoded)
        client._send(b"WIFI_AP_STATUS\n")
        client._send(b"WIFI_AP_MODE\n")
        self.assertEqual(port.writes, [encoded, b"WIFI_AP_STATUS\n", b"WIFI_AP_MODE\n"])
        with self.assertRaises(ProvisioningError):
            client._send(b"READ_A4\n")

    def test_ap_firmware_transport_and_authority_boundaries(self) -> None:
        code = FIRMWARE.read_text()
        self.assertIn("const IPAddress kDirectApIp(10, 77, 13, 1)", code)
        self.assertIn("WiFi.softAP(ssid, pass, 6, 0, 1)", code)
        self.assertIn('wifiPrefs.putBool("ap_mode", true) == 1', code)
        self.assertIn('wifiPrefs.putBool("ap_mode", false) == 1', code)
        self.assertIn('wifiPrefs.getBool("ap_mode", false)', code)
        self.assertIn('const bool hadApSsid = wifiPrefs.isKey("ap_ssid")', code)
        self.assertIn('const bool hadApPass = wifiPrefs.isKey("ap_pass")', code)
        self.assertIn('if (wifiApMode || wifiPrefs.isKey("ap_bundle") || hadApSsid || hadApPass)', code)
        self.assertIn('wifiPrefs.putBytes("ap_bundle", &bundle, sizeof(bundle))', code)
        self.assertIn('wifiPrefs.getBytes("ap_bundle", &bundle, sizeof(bundle))', code)
        self.assertIn("networkOnline() &&", code.split("void serviceOtaHealthAndRestart()", 1)[1])
        self.assertIn("wifiApStopEvents != wifiLastHandledApStopEvent", code)
        ap_provision = code.split("void processDirectApProvision(", 1)[1].split(
            "void selectStaMode(", 1
        )[0]
        self.assertIn("if (!commandFromUSB)", ap_provision)
        self.assertIn("otaUpdating() || otaFirstBootPending", ap_provision)
        self.assertIn("minPassword", code.split("bool decodeWiFiCredentials(", 1)[1])
        self.assertIn("clearSecrets(password, sizeof(password))", ap_provision)
        self.assertNotIn("beginSession(", ap_provision)
        self.assertNotIn("beginSignedOta(", ap_provision)
        self.assertNotIn("WIFI_TOKEN ", ap_provision)
        rekey = ap_provision.split("void processDirectApRekey(", 1)[1]
        self.assertIn("if (!commandFromUSB)", rekey)
        self.assertIn("stage != IDLE", rekey)
        self.assertIn("slotInFlight", rekey)
        self.assertIn("otaUpdating() || otaFirstBootPending", rekey)
        self.assertIn("storeApBundle(ssid, password)", rekey)
        self.assertNotIn('wifiPrefs.remove("ap_ssid")', rekey)
        self.assertNotIn('wifiPrefs.remove("ap_pass")', rekey)
        self.assertNotIn('wifiPrefs.remove("token")', rekey)
        self.assertIn("WiFi.mode(WIFI_AP)", code)
        self.assertIn("WiFi.mode(WIFI_STA)", code)

    def test_host_profile_cannot_add_default_route_or_take_over_builtin_wifi(self) -> None:
        calls: list[tuple[str, ...]] = []
        def fake_nmcli(*args: str, **kwargs: object) -> object:
            calls.append(args)
            if args[:4] == ("-t", "-f", "NAME", "connection"):
                return mock.Mock(stdout="")
            return mock.Mock(stdout="")
        with mock.patch.object(direct, "nmcli", side_effect=fake_nmcli):
            direct.prepare_usb_profile()
        flat = " ".join(" ".join(x) for x in calls)
        self.assertIn("wlx1cbfce64dd94", flat)
        self.assertIn("10.77.13.2/24", flat)
        self.assertIn("ipv4.never-default yes", flat)
        self.assertIn("ipv4.gateway  ipv4.dns  ipv4.routes ", flat)
        self.assertIn("ipv4.ignore-auto-dns yes", flat)
        self.assertIn("ipv6.method disabled", flat)
        self.assertNotIn("wlp9s0", flat)
        self.assertNotIn("wifi-sec.psk ", flat)

    def test_usb_ap_status_not_trusted_without_exact_active_and_ip(self) -> None:
        with mock.patch.object(direct, "serial") as fake_serial, \
             mock.patch.object(direct.time, "sleep"), \
             mock.patch.object(direct, "UsbSetupClient") as client_cls:
            port = fake_serial.Serial.return_value.__enter__.return_value
            port.reset_input_buffer.return_value = None
            client = client_cls.return_value
            client.verify_identity.return_value = None
            client.request.side_effect = [
                b"WIFI_AP_STATUS mode=STA state=INACTIVE ip=0.0.0.0 stations=0 channel=6 port=8765 wpa2=1",
                b"DENIED wifi_ap_unavailable",
                b"WIFI_AP_CONFIG OK saved=1 starting=1",
                b"WIFI_AP_STATUS mode=AP state=INACTIVE ip=0.0.0.0 stations=0 channel=6 port=8765 wpa2=1",
            ] + [
                b"WIFI_AP_STATUS mode=AP state=ACTIVE ip=10.77.13.99 stations=0 channel=6 port=8765 wpa2=1"
            ] * 15
            with self.assertRaises(ProvisioningError):
                direct.provision_esp("fake-usb", "A" * 32)
            self.assertEqual(client.request.call_count, 19)

    def test_repeated_setup_reuses_active_ap_without_reprovision(self) -> None:
        with mock.patch.object(direct, "serial"), \
             mock.patch.object(direct.time, "sleep"), \
             mock.patch.object(direct, "UsbSetupClient") as client_cls:
            client = client_cls.return_value
            client.request.return_value = (
                b"WIFI_AP_STATUS mode=AP state=ACTIVE ip=10.77.13.1 "
                b"stations=0 channel=6 port=8765 wpa2=1"
            )
            direct.provision_esp("fake-usb", "A" * 32)
            self.assertEqual(client.request.call_count, 1)
            self.assertEqual(client.request.call_args.args[0], b"WIFI_AP_STATUS\n")


if __name__ == "__main__":
    unittest.main()
