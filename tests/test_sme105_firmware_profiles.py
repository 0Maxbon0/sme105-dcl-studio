"""Static firmware-profile checks for the fixed SME-105 command allowlist."""

from __future__ import annotations

import re
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


MEM_PROFILES = {
    "MEM": (10, "kVariantMem", True, 0xD3),
    "MEM_OFF0": (27, "kVariantMemOff0", True, 0xD3),
    "MEM_SINGLE": (28, "kVariantMemSingle", False, None),
    "MEM_PARITY": (29, "kVariantMemGenericParity", True, 0x93),
}


def synthetic_mem_map_frame(profile: str, dps_blocks: int, frame: int,
                            frame_period_us: int) -> bool:
    """Model the bounded MEM map-frame gate for synthetic transition cases."""
    if profile not in ("MEM", "MEM_OFF0", "MEM_PARITY"):
        return False
    if dps_blocks != 1 or frame > 15 or (frame == 0 and profile != "MEM_OFF0"):
        return False
    if frame == 0:
        return frame_period_us == 0 or abs(frame_period_us - 15000) <= 1200
    return abs(frame_period_us - 15000) <= 1200


def synthetic_offset_word(offset: int) -> tuple[int, int]:
    parity_nibble = ((offset >> 4) ^ (offset & 15) ^ 0x0A) << 4
    return offset, parity_nibble


def synthetic_extra_slot(profile: str, dps_blocks: int, frame: int,
                         frame_period_us: int) -> tuple[str, tuple[int, int]] | None:
    """Model the extra-word arm point: one offset word in frame IW2."""
    if not synthetic_mem_map_frame(profile, dps_blocks, frame, frame_period_us):
        return None
    return "IW2", synthetic_offset_word(frame)


def source_function(signature: str) -> str:
    """Return one C++ function body, including its outer braces."""
    start = SOURCE.index(signature)
    opening = SOURCE.index("{", start)
    depth = 0
    for index in range(opening, len(SOURCE)):
        if SOURCE[index] == "{":
            depth += 1
        elif SOURCE[index] == "}":
            depth -= 1
            if depth == 0:
                return SOURCE[opening:index + 1]
    raise AssertionError(f"unclosed function body for {signature}")


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

    def test_mem_off0_is_explicitly_bench_tested_and_preserves_v28(self) -> None:
        self.assertIn("kUsbInstalledBuildVersion = 28", SOURCE)
        self.assertRegex(SOURCE, r"\bkVariantMemOff0\s*=\s*27\b")
        self.assertEqual(SOURCE.count("MEM_OFF0 adds offset 0 (bench-tested only)"), 2)


class MemMapSyntheticTests(unittest.TestCase):
    def test_mem_profile_frame_and_continuation_matrix(self) -> None:
        for name in ("MEM", "MEM_PARITY"):
            with self.subTest(profile=name):
                self.assertTrue(MEM_PROFILES[name][2])
                self.assertFalse(synthetic_mem_map_frame(name, 1, 0, 15000))
                self.assertEqual(
                    [frame for frame in range(16)
                     if synthetic_mem_map_frame(name, 1, frame, 15000)],
                    list(range(1, 16)),
                )
                self.assertEqual(MEM_PROFILES[name][3],
                                 0x93 if name == "MEM_PARITY" else 0xD3)

        self.assertFalse(MEM_PROFILES["MEM_SINGLE"][2])
        self.assertIsNone(MEM_PROFILES["MEM_SINGLE"][3])
        self.assertFalse(any(synthetic_mem_map_frame("MEM_SINGLE", 1, frame, 15000)
                             for frame in range(16)))
        self.assertIn("!isRepeating(kVariantMemSingle)", SOURCE)

    def test_mem_off0_arms_offset_zero_during_zero_period_transition(self) -> None:
        self.assertTrue(synthetic_mem_map_frame("MEM_OFF0", 1, 0, 0))
        self.assertEqual(synthetic_extra_slot("MEM_OFF0", 1, 0, 0),
                         ("IW2", (0x00, 0xA0)))
        self.assertEqual(synthetic_extra_slot("MEM_OFF0", 1, 0, 15000),
                         ("IW2", (0x00, 0xA0)))
        self.assertEqual(synthetic_extra_slot("MEM_OFF0", 1, 1, 15000),
                         ("IW2", (0x01, 0xB0)))
        self.assertEqual(
            [frame for frame in range(16)
             if synthetic_mem_map_frame("MEM_OFF0", 1, frame,
                                        0 if frame == 0 else 15000)],
            list(range(16)),
        )
        self.assertIn("(frame == 0 ? (framePeriodUs == 0 || nearUs(framePeriodUs, 15000, 1200))",
                      SOURCE)
        self.assertIn("(index == 0 && variant == kVariantMemOff0 && memMapFrame(index))",
                      SOURCE)
        self.assertIn("offsetWord(0).first == 0x00 && offsetWord(0).second == 0xA0",
                      SOURCE)

    def test_frame_zero_never_arms_for_mem_or_parity_profiles(self) -> None:
        for name in ("MEM", "MEM_PARITY"):
            with self.subTest(profile=name):
                self.assertIsNone(synthetic_extra_slot(name, 1, 0, 0))
                self.assertIsNone(synthetic_extra_slot(name, 1, 0, 15000))
        self.assertIn("(frame >= 1 || variant == kVariantMemOff0)", SOURCE)

    def test_period_gate_and_map_block_bounds_remain_strict(self) -> None:
        for name in ("MEM", "MEM_OFF0", "MEM_PARITY"):
            with self.subTest(profile=name):
                self.assertFalse(synthetic_mem_map_frame(name, 0, 1, 15000))
                self.assertFalse(synthetic_mem_map_frame(name, 1, 16, 15000))
                self.assertFalse(synthetic_mem_map_frame(name, 1, 1, 13799))
                self.assertFalse(synthetic_mem_map_frame(name, 1, 1, 16201))
        self.assertIn("dpsBlocks == 1 && frame <= 15", SOURCE)

    def test_framing_and_fixed_control_words_are_unchanged_across_mem_profiles(self) -> None:
        envelope = ((0x01, 0xB0), (0xFF, 0x5F), (0x42, 0xF3), (0x00, 0xA0))
        for name, (_variant_id, variant, repeating, continuation) in MEM_PROFILES.items():
            with self.subTest(profile=name):
                self.assertIn(f"hasEnvelope({variant}, 0x42, 0xF3)", SOURCE)
                self.assertEqual(envelope[2], (0x42, 0xF3))
                self.assertEqual(envelope[3], (0x00, 0xA0))
                self.assertEqual(repeating, continuation is not None)
        self.assertIn("dpsBlocks == 0 ? CmdWord{0x42, 0xF3} : memContinuationWord(variant)",
                      SOURCE)
        self.assertIn("CmdWord{0x22,0xD3}", SOURCE)
        self.assertIn("CmdWord{0x22,0x93}", SOURCE)
        self.assertIn("armExtra(index, txStartUs[index] + 2500)", SOURCE)
        self.assertIn("armExtra(id, sync + 2917 + 2500)", SOURCE)
        self.assertIn("constexpr uint32_t kJoinMinPeriodUs = 9500, kJoinMaxPeriodUs = 46000",
                      SOURCE)

    def test_extra_words_keep_the_same_hardware_and_pad_safety_gates(self) -> None:
        slot_isr = source_function("void IRAM_ATTR slotISR()")
        tx_isr = source_function("void IRAM_ATTR uart2ISR(void*)")
        begin_session = source_function("void beginSession(Stage target, uint8_t kind)")

        for gate in (
            "stage != CART_READ", "stopLatched", "slotArmed", "slotInFlight",
            "!gateReady", "!nearUs(now, extraTargetUs)",
            "UART2.status.txfifo_cnt != 0", "UART2.status.rxfifo_cnt != 0",
            "UART2.mem_rx_status.rd_addr != UART2.mem_rx_status.wr_addr",
            "!(GPIO.in & (1UL << kRO))", "armTimer(0, kSlotWatchdogUs)",
            "startDeGate(extraGate)", "extraWord.first", "extraWord.second",
        ):
            with self.subTest(gate=gate):
                self.assertIn(gate, slot_isr)

        for gate in (
            "const bool deWasHigh = (GPIO.in & (1UL << kDE)) != 0",
            "deOff();", "disableDeTimer();", "extra ? extraWord :",
            "count != 2 || countMid != 1 || countAfter != 0",
            "flags & ((1UL << 2) | (1UL << 3) | (1UL << 4))",
            "b0 != expected.first || b1 != expected.second",
            "faultISR(DE_MISSING)", "faultISR(PAD_FRAMING)",
            "faultISR(PAD_MISMATCH)",
        ):
            with self.subTest(gate=gate):
                self.assertIn(gate, tx_isr)
        self.assertLess(tx_isr.index("const CmdWord expected = extra ? extraWord :"),
                        tx_isr.index("b0 != expected.first || b1 != expected.second"))
        pad_validation = tx_isr[
            tx_isr.index("if (!extra) padEvidence.complete"):
            tx_isr.index("} else if (extra) {")
        ]
        for check in ("if (!deWasHigh)", "count != 2 || countMid != 1 || countAfter != 0",
                      "b0 != expected.first || b1 != expected.second"):
            with self.subTest(pad_check=check):
                self.assertIn(check, pad_validation)

        self.assertIn("if (target == CART_READ && !tx2BenchPassed)", begin_session)
        self.assertIn("stopLatched = false", begin_session)
        self.assertIn("if (stage != CART_READ || stopLatched || slotArmed || slotInFlight || !gateReady",
                      slot_isr)

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
            'F(" live_all=1 rx_batch=1 pad_evidence=2 mem_off0=1 kline_hw=0 kline_tx=0 kline_rx_backend=NONE")',
            'F(" fw=")',
        )
        positions = [status.index(field) for field in fields]
        self.assertEqual(positions, sorted(positions))
        self.assertIn(
            'out.print(F(" live_all=1 rx_batch=1 pad_evidence=2 mem_off0=1 '
            'kline_hw=0 kline_tx=0 kline_rx_backend=NONE"));', status
        )
        self.assertIn(
            'out.print(F(" fw=")); out.println(kUsbInstalledBuildVersion);', status
        )
        installed_version = re.search(
            r"constexpr uint32_t kUsbInstalledBuildVersion = (\d+)", SOURCE
        )
        self.assertIsNotNone(installed_version)
        self.assertEqual(f"fw={installed_version.group(1)}", "fw=28")
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
