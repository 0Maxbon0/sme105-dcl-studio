"""Power-cut regressions for the signed OTA boot/NVS acceptance boundary.

Source contract plus hostile host-only state simulation. No USB, Wi-Fi,
firmware flashing or ECU activity is performed by these tests.
"""

from __future__ import annotations

import hashlib
import unittest
from dataclasses import dataclass
from pathlib import Path

SOURCE = (Path(__file__).resolve().parents[1] /
          "firmware/sme105_usb_bridge/sme105_usb_bridge.ino")


@dataclass(frozen=True)
class Pending:
    version: int
    slot: str
    subtype: int
    address: int
    size: int
    image: bytes
    sha256: bytes


class BootHarness:
    """NVS/otadata durability model with a crash at every commit boundary."""

    def __init__(self, accepted: int = 2):
        self.accepted = accepted
        self.running = "ota_0"
        self.image_state = "VALID"
        self.pending: Pending | None = None
        self.flash: dict[str, bytes] = {"ota_0": b"previous application"}
        self.running_subtype = 16
        self.running_address = 0x10000
        self.running_size = 0x140000
        self.inert = False

    def stage(self, new: Pending) -> None:
        self.flash[new.slot] = new.image
        # Atomic NVS pending blob committed before otadata boot switch.
        self.pending = new

    def boot_new(self) -> None:
        assert self.pending is not None
        self.running = self.pending.slot
        self.running_subtype = self.pending.subtype
        self.running_address = self.pending.address
        self.running_size = self.pending.size
        self.image_state = "PENDING_VERIFY"

    def match(self) -> bool:
        pending = self.pending
        return bool(
            pending and self.running == pending.slot
            and self.running_subtype == pending.subtype
            and self.running_address == pending.address
            and self.running_size == pending.size
            and hashlib.sha256(self.flash[self.running][:len(pending.image)]).digest()
            == pending.sha256
        )

    def reset(self) -> None:
        if self.image_state == "PENDING_VERIFY":
            # IDF rollback on reset prior to mark_app_valid.
            self.running = "ota_0"
            self.running_subtype = 16
            self.running_address = 0x10000
            self.image_state = "VALID"
        self.reconcile()

    def reconcile(self, allow_nvs: bool = True) -> None:
        if not self.pending:
            return
        if self.image_state == "VALID" and self.match():
            if not allow_nvs:
                self.inert = True
                return
            self.accepted = max(self.accepted, self.pending.version)
            self.pending = None
            self.inert = False
        elif self.image_state == "VALID" and self.running != self.pending.slot:
            # Rolled back old app: erase stale pending, never promote version.
            self.pending = None
        else:
            self.inert = True


class LedgerCrashTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.code = SOURCE.read_text(encoding="utf-8")

    @staticmethod
    def candidate() -> Pending:
        image = b"\xe9" + b"signed image data" * 60000
        return Pending(3, "ota_1", 17, 0x150000, 0x140000, image,
                       hashlib.sha256(image).digest())

    def test_source_orders_atomic_pending_before_switch_and_valid_before_nvs(self) -> None:
        source = self.code
        finish = source.split("void finishSignedOta() {", 1)[1].split(
            "void pollSignedOtaBody()", 1)[0]
        boot = source.split("void serviceOtaHealthAndRestart() {", 1)[1].split(
            "void printWiFiStatus()", 1)[0]
        accepted = source.split("bool acceptValidPendingOta() {", 1)[1].split(
            "void runCommand(", 1)[0]
        self.assertLess(finish.index('wifiPrefs.putBytes("ota_ledger"'),
                        finish.index("esp_ota_set_boot_partition("))
        self.assertLess(boot.index("esp_ota_mark_app_valid_cancel_rollback()"),
                        boot.rindex("(void)acceptValidPendingOta();"))
        self.assertIn('wifiPrefs.putUInt("ota_ver", otaTrustedLedger.version)', accepted)
        self.assertIn("otaLedgerRetryAfterMs = millis() + 2000", accepted)
        self.assertIn("millis() - otaLedgerRetryAfterMs", boot)

    def test_source_recovery_requires_slot_subtype_address_and_full_image_hash(self) -> None:
        source = self.code
        matching = source.split("bool ledgerTargetsRunningApp(", 2)[2].split(
            "bool runningAppMatchesSignedHash(", 1)[0]
        digest = source.split("bool runningAppMatchesSignedHash(", 2)[2].split(
            "bool acceptValidPendingOta()", 1)[0]
        boot = source.split("void initializeOtaBootHealth() {", 1)[1].split(
            "void serviceOtaHealthAndRestart() {", 1)[0]
        for requirement in ("running->subtype", "running->address", "running->size",
                            "running->label"):
            self.assertIn(requirement, matching)
        self.assertIn("offset < ledger.imageSize", digest)
        self.assertIn("esp_partition_read(running, offset, block, count)", digest)
        self.assertIn("constantTimeEqual(calculated, ledger.sha256", digest)
        self.assertIn("imageState == ESP_OTA_IMG_VALID", boot)
        self.assertIn("runningAppMatchesSignedHash(otaTrustedLedger, running)", boot)
        self.assertIn("otaBootHealthFailed = !otaLedgerTrusted", boot)

    def test_power_cut_after_pending_commit_before_boot_switch_keeps_old_version(self) -> None:
        unit = BootHarness()
        unit.stage(self.candidate())
        unit.reset()
        self.assertEqual(unit.accepted, 2)
        self.assertIsNone(unit.pending)

    def test_power_cut_before_validation_rolls_back_without_phantom_version(self) -> None:
        unit = BootHarness()
        unit.stage(self.candidate())
        unit.boot_new()
        unit.reset()
        self.assertEqual(unit.running, "ota_0")
        self.assertEqual(unit.accepted, 2)
        self.assertIsNone(unit.pending)

    def test_power_cut_after_valid_before_version_nvs_recovers_signed_target(self) -> None:
        unit = BootHarness()
        unit.stage(self.candidate())
        unit.boot_new()
        unit.image_state = "VALID"  # mark_app_valid has durably committed
        unit.reset()  # power is cut BEFORE ota_ver is written
        self.assertEqual(unit.accepted, 3)
        self.assertIsNone(unit.pending)

    def test_power_cut_after_version_commit_before_cleanup_keeps_version(self) -> None:
        unit = BootHarness()
        unit.stage(self.candidate())
        unit.boot_new()
        unit.image_state = "VALID"
        unit.accepted = 3  # ota_ver committed; deletion not yet performed
        unit.reset()
        self.assertEqual(unit.accepted, 3)
        self.assertIsNone(unit.pending)

    def test_post_valid_nvs_failure_blocks_until_recoverable(self) -> None:
        unit = BootHarness()
        unit.stage(self.candidate())
        unit.boot_new()
        unit.image_state = "VALID"
        unit.reconcile(allow_nvs=False)
        self.assertTrue(unit.inert)
        self.assertEqual(unit.accepted, 2)
        unit.reset()
        self.assertEqual(unit.accepted, 3)
        self.assertFalse(unit.inert)

    def test_wrong_partition_or_modified_firmware_never_promotes(self) -> None:
        for mutation in ("slot", "subtype", "address", "size", "sha"):
            with self.subTest(mutation=mutation):
                unit = BootHarness()
                unit.stage(self.candidate())
                unit.boot_new()
                unit.image_state = "VALID"
                if mutation == "slot":
                    unit.running = "forged_ota"
                    unit.flash[unit.running] = self.candidate().image
                elif mutation == "subtype":
                    unit.running_subtype = 16
                elif mutation == "address":
                    unit.running_address = 0x250000
                elif mutation == "size":
                    unit.running_size = 0x100000
                else:
                    unit.flash[unit.running] += b"bad"
                    unit.flash[unit.running] = b"BAD" + unit.flash[unit.running][3:]
                unit.reconcile()
                self.assertEqual(unit.accepted, 2)
                if mutation == "slot":
                    # A different running app is a rolled-back survivor;
                    # stale metadata can be cleared safely.
                    self.assertIsNone(unit.pending)
                else:
                    self.assertTrue(unit.inert)

    def test_existing_v2_accepted_version_without_pending_survives(self) -> None:
        unit = BootHarness(accepted=2)
        unit.reset()
        self.assertEqual(unit.accepted, 2)
        self.assertFalse(unit.inert)


if __name__ == "__main__":
    unittest.main()
