"""Static firmware-profile checks for the fixed SME-105 command allowlist."""

from __future__ import annotations

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "firmware/sme105_usb_bridge/sme105_usb_bridge.ino").read_text()


PROFILES = {
    "A4": (0, "kVariantA4", "26A4", False),
    "0E": (1, "kVariant0E", "260E", False),
    "LIVE": (2, "kVariantLive", "21F6", True),
    "OFF": (5, "kVariantOffline", "80CE", False),
    "LIVE2": (6, "kVariantLive2", "21F6", True),
    "KOEO": (7, "kVariantKoeo", "253E", True),
    "KOER": (8, "kVariantKoer", "253E", True),
    "CLR": (9, "kVariantClear", "0291", False),
    "MEM": (10, "kVariantMem", "42F3", True),
    "LIVE3": (11, "kVariantLive3", "21F6", True),
    "ALL": (12, "kVariantAllLive", "21F6", True),
    "ECU_STATUS": (13, "kVariantEcuStatus", "0381", False),
    "PIDMAP": (14, "kVariantPidMap", "005E", False),
    "DMRMAP": (15, "kVariantDmrMap", "242E", False),
    "DMR": (16, "kVariantDmrValues", "22C6", False),
    "BOTH": (17, "kVariantBothValues", "271E", False),
    "PIDMAP_ALT": (18, "kVariantPidMapAlt", "004E", False),
    "KOEO_ALT": (19, "kVariantKoeoAlt", "2594", True),
    "CLEAR_A1": (20, "kVariantClearA1", "01A1", False),
    "CLEAR_F4": (21, "kVariantClearF4", "01F4", False),
    "CHANGE_BAUD": (22, "kVariantChangeBaud", "8174", False),
    "DMRMAP_TX": (23, "kVariantDmrMapTx", "42A6", False),
    "STOP_PID_FLOW": (24, "kVariantStopPidFlow", "411E", False),
    "PIDMAP_TX": (25, "kVariantPidMapTx", "4196", False),
    "PID_VALUES": (26, "kVariantPidValues", "21F6", False),
    "MEM_OFF0": (27, "kVariantMemOff0", "42F3", True),
    "MEM_SINGLE": (28, "kVariantMemSingle", "42F3", False),
    "MEM_PARITY": (29, "kVariantMemGenericParity", "42F3", True),
}


class FirmwareProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.run_command = SOURCE[SOURCE.rfind("void runCommand(const char* cmd) {"):]

    def test_all_profile_ids_and_arm_read_dispatch(self) -> None:
        # IDs 3 and 4 are not CART_READ profiles; LISTEN/OBSERVE use separate
        # kinds under CART_PASSIVE. Request profile IDs span 0 through 29.
        self.assertEqual({profile[0] for profile in PROFILES.values()},
                         set(range(30)) - {3, 4})
        for name, (variant_id, variant, _word, _repeating) in PROFILES.items():
            with self.subTest(profile=name):
                self.assertRegex(SOURCE, rf"\b{variant}\s*=\s*{variant_id}\b")
                arm = f'!strcmp(cmd, "ARM_{name}") ? {variant}'
                self.assertIn(arm, self.run_command)
                read = (f'if (!strcmp(cmd, "READ_{name}")) '
                        f'{{ beginSession(CART_READ, {variant}); return; }}')
                self.assertIn(read, self.run_command)

    def test_fixed_envelopes_and_special_words_are_compile_time_checked(self) -> None:
        self.assertIn("constexpr bool hasEnvelope(uint8_t variant", SOURCE)
        for name, (_variant_id, variant, command, _repeating) in PROFILES.items():
            with self.subTest(profile=name):
                if name == "OFF":
                    self.assertIn("variant == kVariantOffline ? CmdWord{0x7F,0x20}", SOURCE)
                    continue
                byte0, byte1 = bytes.fromhex(command)
                self.assertIn(f"hasEnvelope({variant}, 0x{byte0:02X}, 0x{byte1:02X})", SOURCE)
        self.assertIn("memContinuationWord(kVariantMem).second == 0xD3", SOURCE)
        self.assertIn("memContinuationWord(kVariantMemGenericParity).second == 0x93", SOURCE)
        self.assertIn("parity(0x22,6)==0xC6", SOURCE)
        self.assertIn("parity(0x41,6)==0x96", SOURCE)

    def test_pid_map_transmit_and_pid_values_are_single_shot(self) -> None:
        self.assertIn("kVariantPidMapTx = 25", SOURCE)
        self.assertIn("kVariantPidValues = 26", SOURCE)
        self.assertIn('variant == kVariantPidMapTx ? CmdWord{0x41,0x96}', SOURCE)
        self.assertIn('variant == kVariantPidValues ? CmdWord{0x21,0xF6}', SOURCE)
        self.assertIn("variant == kVariantPidMapTx ? kPidMapTxCaptureMs", SOURCE)
        self.assertIn("kPidMapTxCaptureMs = 5000", SOURCE)
        self.assertIn("kVariantPidMapTx) && isRequestVariant(kVariantPidValues)", SOURCE)
        self.assertIn("!isRepeating(kVariantPidMapTx) && !isRepeating(kVariantPidValues)", SOURCE)

    def test_mem_profiles_select_offset_continuation_and_timeout_hypotheses(self) -> None:
        for name, variant_id, variant in (
            ("MEM", 10, "kVariantMem"),
            ("MEM_OFF0", 27, "kVariantMemOff0"),
            ("MEM_SINGLE", 28, "kVariantMemSingle"),
            ("MEM_PARITY", 29, "kVariantMemGenericParity"),
        ):
            with self.subTest(profile=name):
                self.assertRegex(SOURCE, rf"\b{variant}\s*=\s*{variant_id}\b")
                self.assertIn(f'!strcmp(cmd, "ARM_{name}") ? {variant}', self.run_command)
                self.assertIn(f'if (!strcmp(cmd, "READ_{name}")) {{ beginSession(CART_READ, {variant}); return; }}',
                              self.run_command)
        self.assertIn("dpsBlocks == 0 ? CmdWord{0x42, 0xF3} : memContinuationWord(variant)", SOURCE)
        self.assertIn("return variant == kVariantMemGenericParity ? CmdWord{0x22,0x93} : CmdWord{0x22,0xD3};", SOURCE)
        self.assertIn("frame >= 1 || variant == kVariantMemOff0", SOURCE)
        self.assertIn("index == 0 && variant == kVariantMemOff0 && memMapFrame(index)", SOURCE)
        self.assertIn("offsetWord(0).first == 0x00 && offsetWord(0).second == 0xA0", SOURCE)
        self.assertIn("isMemMapVariant(variant) ? offsetWord(frame)", SOURCE)
        self.assertIn("isMemVariant(variant) ? kMemCaptureMs", SOURCE)
        self.assertIn("kMemCaptureMs = 10000", SOURCE)
        self.assertIn("repeatDps && !isMemVariant(variant)", SOURCE)
        active_loop = SOURCE[SOURCE.index("void pollActive()"):SOURCE.index("void reportEnd()")]
        self.assertIn("repeatDps && !isMemVariant(variant)", active_loop)
        self.assertIn("elapsed < limit + 3000", active_loop)
        self.assertIn("!isRepeating(kVariantMemSingle)", SOURCE)

    def test_request_classifiers_keep_single_shot_and_repeating_modes_explicit(self) -> None:
        self.assertIn("constexpr bool isRequestVariant(uint8_t v)", SOURCE)
        self.assertIn("constexpr bool joinsRunningCart(uint8_t v)", SOURCE)
        self.assertRegex(SOURCE, r"isRepeating\(v\)\s*\|\|\s*isSingleShotCandidate\(v\)\s*\|\|\s*isDiscoveryReadVariant\(v\)")
        self.assertIn("isRepeating(kVariantMem) && isRepeating(kVariantMemOff0)", SOURCE)
        self.assertIn("isRepeating(kVariantMemGenericParity)", SOURCE)
        self.assertIn("!isRepeating(kVariantMemSingle)", SOURCE)
        self.assertIn("const bool validVariant = isRequestVariant(kind);", SOURCE)

    def test_pad_witness_faults_on_unavailable_or_wrong_bytes(self) -> None:
        self.assertIn("const CmdWord selected = dpsWord(index);", SOURCE)
        self.assertIn("b0 != expected.first || b1 != expected.second", SOURCE)
        self.assertIn("faultISR(PAD_MISMATCH)", SOURCE)
        self.assertIn("faultISR(PAD_FRAMING)", SOURCE)
        self.assertIn("record.completed && record.match", SOURCE)
        self.assertIn("padEvidence.start(dpsBlocks, index, selected.first, selected.second, now)", SOURCE)

    def test_safety_status_and_raw_capture_contract_remain(self) -> None:
        self.assertIn("constexpr bool kActiveMasterQualified = true", SOURCE)
        self.assertIn("if (target == CART_READ && !tx2BenchPassed)", SOURCE)
        self.assertIn("tx2BenchPassed = passed && completed == 4 && deLowOnPad()", SOURCE)
        self.assertIn("armedVariant != kind || armedFromUSB != commandFromUSB", SOURCE)
        self.assertIn("static_cast<int32_t>(armExpiresMs - millis()) <= 0", SOURCE)
        self.assertIn("armExpiresMs = millis() + kArmMs", SOURCE)
        self.assertIn("transmitConsumed = true; // before any 2400 TX", SOURCE)
        self.assertIn("constexpr uint32_t kArmMs = 15000", SOURCE)
        self.assertIn("DE=LOW", SOURCE)
        status = SOURCE[SOURCE.index("void printStatus()"):
                        SOURCE.index("void printPins()")]
        fields = (
            'F("STATUS SME105_USB_BRIDGE_V1 stage=")',
            'F(" DE=ACTIVE_GUARDED")',
            'F(" auto_tx=0 gate4=")',
            'F(" pad_rx=")',
            'F(" tx2_bench_used=")',
            'F(" tx2_bench_pass=")',
            'F(" read_used=")',
            'F(" observe_used=")',
            'F(" transport_lost=")',
            'F(" out_overflow=")',
            'F(" usb_skipped=")',
            'F(" offline_used=")',
            'F(" armed=")',
            'F(" fault=")',
            'F(" live_all=1 rx_batch=1 pad_evidence=2 kline_hw=0 kline_tx=0 kline_rx_backend=NONE")',
            'F(" fw=")',
        )
        positions = [status.index(field) for field in fields]
        self.assertEqual(positions, sorted(positions))
        self.assertIn("stage=0 DE=LOW auto_tx=0 gate4=1 pad_rx=1 tx2_bench_used=0 tx2_bench_pass=0 read_used=0 observe_used=0 transport_lost=0 out_overflow=0 usb_skipped=0 offline_used=0 armed=NONE fault=0 live_all=1 rx_batch=1 pad_evidence=2 kline_hw=0 kline_tx=0 kline_rx_backend=NONE fw=27",
                      (ROOT / "firmware/sme105_usb_bridge/README.md").read_text())
        self.assertIn("kUsbInstalledBuildVersion = 27", SOURCE)
        self.assertIn("void IRAM_ATTR uart1ISR(void*)", SOURCE)
        self.assertIn('"RXB t_us=%lu data="', SOURCE)
        self.assertIn('"RX t_us=%lu byte=%02X\\n"', SOURCE)
        self.assertNotRegex(SOURCE, r"(?:HEX|WRITE_RAW|TX_RAW)\s*<")
        self.assertNotIn("command_deferred_not_sendable", SOURCE)

    def test_help_lists_every_new_profile_for_usb_and_ble(self) -> None:
        help_body = SOURCE[SOURCE.index('if (!strcmp(cmd, "HELP"))'):
                           SOURCE.index('if (!strcmp(cmd, "STATUS"))')]
        for name in ("PIDMAP_TX", "PID_VALUES", "MEM_OFF0", "MEM_SINGLE", "MEM_PARITY"):
            for prefix in ("ARM", "READ"):
                command = f"{prefix}_{name}"
                with self.subTest(command=command):
                    self.assertEqual(help_body.count(command), 2)


if __name__ == "__main__":
    unittest.main()
