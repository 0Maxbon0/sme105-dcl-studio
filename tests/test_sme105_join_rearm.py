"""Source and host checks for running-CART join and same-boot re-arm."""

from __future__ import annotations

import unittest
from types import SimpleNamespace

from scripts import sme105_usb_bridge as bridge

ROOT = bridge.ROOT
SKETCH = ROOT / "firmware/sme105_usb_bridge/sme105_usb_bridge.ino"
REARM = ("CAPTURE_TIMEOUT", "HOST_STOP", "BAD_IDLE", "HSK_TIMEOUT",
         "HSK_ACK", "HSK_TX", "CART_INIT")
LATCHED = ("PAD_MISMATCH", "PAD_FRAMING", "DE_MISSING", "DE_TIMEOUT",
           "CART_TIMER", "CART_HEADER", "CART_PHASE", "CART_ERR",
           "CART_CADENCE", "RX_OVERFLOW", "TRANSPORT_BACKPRESSURE")
HOST_LATCHED = ("6", "7", "8", "9", "10", "11", "12", "13", "14", "17", "18", "19")


def _between(text: str, start: str, end: str) -> str:
    return text.split(start, 1)[1].split(end, 1)[0]


def _status(fault: str, *, read_used: str = "0", offline_used: str = "0",
            stage: str = "0") -> bridge.BridgeStatus:
    line = (
        f"STATUS SME105_USB_BRIDGE_V1 stage={stage} DE=LOW auto_tx=0 gate4=1 "
        f"pad_rx=1 tx2_bench_used=1 tx2_bench_pass=1 read_used={read_used} "
        f"offline_used={offline_used} armed=NONE fault={fault} fw=17"
    ).encode()
    parsed = bridge.parse_status(line)
    if parsed is None:
        raise AssertionError(line)
    return parsed


class JoinRearmSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.source = SKETCH.read_text(encoding="utf-8")

    def test_quiet_busy_joins_read_variants_and_observe_stays_bad_idle(self) -> None:
        spec = _between(self.source, "constexpr bool joinsRunningCart", "\n}")
        self.assertIn("v <= kVariant0E", spec)
        self.assertIn("isRepeating(v)", spec)
        repeating = _between(self.source, "constexpr bool isRepeating", "\n}")
        self.assertIn("isSelfTest(v)", repeating)
        self.assertIn("isLiveVariant(v)", repeating)
        self.assertNotIn("kVariantOffline", repeating)
        self.assertNotIn("kVariantOffline", spec)
        quiet = _between(self.source, "if (stage == QUIET)", "else if (stage == ECHO_TX")
        self.assertIn("joinsRunningCart(variant)", quiet)
        self.assertLess(quiet.index("openNative()"), quiet.index("joinMode = true"))
        self.assertLess(quiet.index("joinMode = true"),
                        quiet.index("repeatDps = isRepeating(variant)"))
        self.assertLess(quiet.index("repeatDps = isRepeating(variant)"),
                        quiet.index("framePeriodUs = 0"))
        self.assertIn("stopLatched = false", quiet)
        self.assertIn("stage = CART_READ", quiet)
        self.assertIn("captureStartedMs = now", quiet)
        self.assertIn("EVENT join=running_cart no_handshake=1", quiet)
        self.assertLess(quiet.index("joinsRunningCart(variant)"),
                        quiet.index("stopEverything(BAD_IDLE)"))
        done = _between(self.source, "void IRAM_ATTR uart2ISR(void*) {", "\n}\n")
        self.assertIn("if (wordsVerified == 4 && !repeatDps) captureOnly = true;", done)

    def test_rearm_only_for_non_transmit_faults(self) -> None:
        spec = _between(self.source, "constexpr bool faultAllowsRearm", "\n}")
        for name in REARM:
            self.assertIn(f"reason == {name}", spec)
        for name in LATCHED:
            self.assertNotIn(name, spec)
        end = _between(self.source, "void reportEnd() {", "void printStatus() {")
        self.assertIn("variant != kVariantOffline && isRequestVariant(variant) &&", end)
        self.assertNotIn("offlineConsumed = false", end)
        self.assertIn("transmitConsumed = false", end)
        self.assertLess(end.index("faultAllowsRearm(failure)"), end.index("stage = IDLE"))
        self.assertNotIn("tx2BenchPassed =", end)
        arm = _between(self.source, "if (armKind != 255)", 'out.println(F("DENIED unknown_or_unsafe_command"))')
        self.assertIn("armExpiresMs = millis() + kArmMs", arm)
        self.assertIn("armedFromUSB = commandFromUSB", arm)
        self.assertNotIn("failure != NO_FAULT", arm)
        begin = _between(self.source, "void beginSession(", "bool sendReference(")
        self.assertIn("DENIED tx2_pad_bench_required", begin)
        self.assertIn("armedFromUSB != commandFromUSB", begin)
        self.assertIn("kArmMs", self.source)

    def test_report_end_and_reset_idle_keep_off_locked_for_boot(self) -> None:
        end = _between(self.source, "void reportEnd() {", "void printStatus() {")
        self.assertNotIn("offlineConsumed = false", end)
        self.assertIn("variant != kVariantOffline", end)
        self.assertIn("failure = NO_FAULT", end)
        self.assertIn("transmitConsumed = false", end)

        reset = _between(self.source, 'if (!strcmp(cmd, "RESET_IDLE"))',
                         'const uint8_t armKind =')
        self.assertNotIn("offlineConsumed = false", reset)
        self.assertIn("failure == NO_FAULT || faultAllowsRearm(failure)", reset)
        self.assertIn("transmitConsumed = false", reset)
        self.assertIn("EVENT idle_reset read_rearm_allowed=1 off_locked=1", reset)
        self.assertIn("DENIED safety_fault_latched", reset)
        self.assertLess(reset.index("faultAllowsRearm(failure)"),
                        reset.index("transmitConsumed = false"))

    def test_reset_idle_preserves_transmit_latch_for_safety_faults(self) -> None:
        reset = _between(self.source, 'if (!strcmp(cmd, "RESET_IDLE"))',
                         'const uint8_t armKind =')
        allowed = _between(reset, "else if (failure == NO_FAULT || faultAllowsRearm(failure))", "} else out.println")
        denied = reset.split('DENIED safety_fault_latched', 1)[0].rsplit("else", 1)[-1]
        self.assertIn("failure = NO_FAULT", allowed)
        self.assertIn("transmitConsumed = false", allowed)
        self.assertNotIn("transmitConsumed = false", denied)
        for fatal in ("DE_TIMEOUT", "PAD_MISMATCH", "CART_PHASE"):
            self.assertNotIn(f"reason == {fatal}", _between(self.source, "constexpr bool faultAllowsRearm", "\n}"))

    def test_reboot_only_from_idle_without_ota_or_slot(self) -> None:
        cmd = _between(self.source, 'if (!strcmp(cmd, "REBOOT"))', 'if (otaUpdating())')
        accept = cmd.index("ESP.restart()")
        deny = cmd.index('DENIED reboot_busy')
        self.assertLess(accept, deny)
        gate = cmd[:accept]
        for needle in ("commandFromUSB || tcpAuthenticated", "stage == IDLE",
                       "!otaUpdating()", "!slotInFlight",
                       "EVENT reboot=accepted DE=LOW", "out.drainUSB()",
                       "out.drainTCP(wifiClient)", "millis() + 300"):
            self.assertIn(needle, gate)
        self.assertIn("out.drainBLE()", gate)
        self.assertIn("ble_transport::poll()", gate)
        help_line = _between(self.source, 'if (!strcmp(cmd, "HELP"))', "WIFI USB_ONLY")
        self.assertIn("REBOOT", help_line)
        self.assertIn('out.print(F(" fw=")); out.println(kUsbInstalledBuildVersion);', self.source)

    def test_usb_installed_build_version_is_28(self) -> None:
        self.assertIn("constexpr uint32_t kUsbInstalledBuildVersion = 28", self.source)

    def test_ble_build_does_not_start_wifi(self) -> None:
        init = _between(self.source, "void initializeWiFi() {", "void initializeOtaBootHealth()")
        ble_init = _between(init, "#ifdef SME105_BLE", "#else")
        self.assertIn('wifiPrefs.begin("sme105wifi", false)', ble_init)
        self.assertIn("WiFi.mode(WIFI_OFF)", ble_init)
        self.assertNotIn("WiFi.mode(WIFI_STA)", ble_init)
        self.assertNotIn("WiFi.mode(WIFI_AP)", ble_init)
        self.assertNotIn("startSta()", ble_init)
        self.assertNotIn("startDirectAp()", ble_init)
        self.assertNotIn("wifiPrefs.clear", ble_init)
        self.assertNotIn('remove("ble_pin")', ble_init)
        sta_body = _between(init, "#else", "#endif")
        self.assertIn("startSta()", sta_body)
        self.assertIn("startDirectAp()", sta_body)
        poll = _between(self.source, "void pollWiFi() {", "void runCommand(")
        ble_poll = _between(poll, "#ifdef SME105_BLE", "#else")
        self.assertIn("return;", ble_poll)
        self.assertNotIn("startSta()", ble_poll)
        self.assertNotIn("WiFi.mode(WIFI_STA)", ble_poll)
        sta = _between(self.source, "void startSta() {", "void startDirectAp() {")
        ble_sta = _between(sta, "#ifdef SME105_BLE", "#else")
        self.assertIn("WiFi.mode(WIFI_OFF)", ble_sta)
        self.assertNotIn("WiFi.begin", ble_sta)
        self.assertNotIn("WIFI_STA", ble_sta)
        ap = _between(self.source, "void startDirectAp() {", "bool networkOnline()")
        ble_ap = _between(ap, "#ifdef SME105_BLE", "#else")
        self.assertIn("WiFi.mode(WIFI_OFF)", ble_ap)
        self.assertNotIn("softAP", ble_ap)
        self.assertNotIn("WIFI_AP", ble_ap)
        self.assertNotIn("UART2.conf0.txfifo_rst = 1", self.source)
        native = _between(self.source, "bool openNative() {", "\n}\n")
        self.assertIn("periph_module_reset(PERIPH_UART2_MODULE)", native)
        self.assertIn("faultISR(DE_MISSING)", self.source)

    def test_host_rearm_faults_and_reboot_command(self) -> None:
        self.assertEqual(bridge.REARM_FAULTS, ("0", "1", "2", "3", "4", "5", "15", "16"))
        self.assertIn("REBOOT", bridge.COMMANDS)
        self.assertIn("REBOOT", bridge.WIRE_COMMANDS)
        self.assertNotIn("REBOOT", bridge.CAR_TRANSMIT)
        holder = SimpleNamespace(fault=None, _session_name=None, _pending_transmit=False)
        for fault in bridge.REARM_FAULTS:
            bridge.BridgeClient._validate_idle_for_vehicle(holder, _status(fault), "A4")
            bridge.BridgeClient._validate_idle_for_vehicle(holder, _status(fault), "OFF")
        for fault in HOST_LATCHED:
            with self.assertRaises(bridge.BridgeError):
                bridge.BridgeClient._validate_idle_for_vehicle(holder, _status(fault), "A4")
        with self.assertRaises(bridge.BridgeError):
            bridge.BridgeClient._validate_idle_for_vehicle(
                holder, _status("16", read_used="1"), "A4")
        with self.assertRaises(bridge.BridgeError):
            bridge.BridgeClient._validate_idle_for_vehicle(
                holder, _status("0", offline_used="1"), "OFF")
        parsed = _status("16")
        self.assertEqual(parsed.field("fw"), "17")
        self.assertEqual(parsed.field("fault"), "16")


if __name__ == "__main__":
    unittest.main()
