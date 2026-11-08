"""Offline regression of real firmware recovery policy, no board or RF actions."""

from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "firmware/sme105_usb_bridge/sme105_usb_bridge.ino"


class WiFiRecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.code = SOURCE.read_text(encoding="utf-8")

    def test_cpp_actual_recovery_policy_including_wrap_and_vehicle_guard(self) -> None:
        if not shutil.which("g++"):
            self.skipTest("g++ unavailable")
        code = self.code
        section = code.split("// Integral action result", 1)[1].split("void startSta()", 1)[0]
        values: list[str] = []
        for name in ("kStaRetryMs", "kStaReinitMs", "kListenerRetryMs", "kApRetryMs"):
            match = re.search(r"constexpr uint32_t " + name + r" = (\d+);", code)
            self.assertIsNotNone(match)
            values.append(f"constexpr uint32_t {name} = {match.group(1)};")
        definitions = "\n".join(values)
        cpp = f"""
#include <cstdint>
#include <cassert>
{definitions}
// Integral action result{section}
int main() {{
  assert(chooseWiFiRecovery(9000,0,0,0,false)==kWiFiRecoveryNone);
  assert(chooseWiFiRecovery(10000,0,0,0,false)==kWiFiRecoveryReconnect);
  assert(chooseWiFiRecovery(60000,0,50000,0,false)==kWiFiRecoveryReinitialize);
  assert(chooseWiFiRecovery(60000,0,50000,0,true)==kWiFiRecoveryNone);
  assert(chooseWiFiRecovery(65000,0,60000,60000,false)==kWiFiRecoveryNone);
  assert(chooseWiFiRecovery(70000,0,60000,60000,false)==kWiFiRecoveryReconnect);
  assert(chooseWiFiRecovery(0x500,0xfffff000,0xfffff000,0xfffff000,false)==kWiFiRecoveryNone);
  assert(listenerRetryDue(5000,0));
  assert(!listenerRetryDue(5999,3000));
  assert(listenerRetryDue(6000,3000));
  assert(listenerRetryDue(0x100,0xfffff000));
  assert(directApRetryDue(10000,0,false));
  assert(!directApRetryDue(10000,5000,false));
  assert(directApRetryDue(15000,5000,false));
  assert(!directApRetryDue(15000,5000,true));
  assert(directApRetryDue(0x100,0xffffd000,false));
}}
"""
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            inp = root / "test.cc"
            binary = root / "test"
            inp.write_text(cpp, encoding="utf-8")
            subprocess.run(["g++", "-std=c++17", "-Wall", "-Wextra", "-Werror",
                            str(inp), "-o", str(binary)], check=True, timeout=20)
            subprocess.run([str(binary)], check=True, timeout=10)

    def test_network_repair_does_not_grant_vehicle_or_ota_authority(self) -> None:
        code = self.code
        network = code.split("void pollWiFi()", 1)[1].split("void runCommand(", 1)[0]
        self.assertIn("busSessionActive()", network)
        self.assertIn("wifiServerStarted = static_cast<bool>(wifiServer)", network)
        self.assertIn("wifiServer.end();", network)
        self.assertIn("WiFi.disconnect(false, false)", network)
        self.assertIn("dropTcpClient(tcpAuthenticated)", network)
        self.assertIn("wifiGotIpEvents", network)
        self.assertIn("MDNS.begin(\"sme105-bridge\")", network)
        self.assertNotIn("beginSession(", network)
        self.assertNotIn("beginSignedOta(", network)
        self.assertIn('WiFi.onEvent(onStaDisconnect, ARDUINO_EVENT_WIFI_STA_DISCONNECTED)', code)
        self.assertIn('WiFi.onEvent(onStaGotIp, ARDUINO_EVENT_WIFI_STA_GOT_IP)', code)
        diagnostic = code.split("void printWiFiDiag()", 1)[1].split("void processWiFiProvision", 1)[0]
        self.assertIn("last_reason=", diagnostic)
        self.assertIn("listener_failures=", diagnostic)
        self.assertNotIn("wifiToken", diagnostic)
        self.assertNotIn('getString("pass"', diagnostic)

    def test_usb_maintenance_cannot_bypass_pending_signed_ota_ledger(self) -> None:
        code = self.code
        boot = code.split("void initializeOtaBootHealth()", 1)[1].split("void serviceOtaHealthAndRestart()", 1)[0]
        pending = boot.index("if (pendingVerify)")
        usb_adoption = boot.index("if (!pendingKeysExist)")
        self.assertLess(pending, usb_adoption)
        self.assertIn("imageState == ESP_OTA_IMG_VALID", boot)
        self.assertIn('wifiPrefs.putUInt("ota_ver", kUsbInstalledBuildVersion)', boot)
        self.assertIn("otaFirstBootPending = true", boot)
        self.assertIn("otaBootHealthFailed = true", boot)
        self.assertIn("constexpr uint32_t kOtaCurrentVersion = 1", code)
        self.assertIn("constexpr uint32_t kUsbInstalledBuildVersion = 27", code)


if __name__ == "__main__":
    unittest.main()
