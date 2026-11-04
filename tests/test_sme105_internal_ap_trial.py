"""Offline checks for the internal-only Realtek concurrent AP experiment.

No WLAN configuration, root privileges, USB access or RF transmissions.
"""
from __future__ import annotations

import unittest
from unittest import mock

from scripts import sme105_internal_wifi_ap_trial as trial


class InternalWifiApTrialTests(unittest.TestCase):
    def test_derived_ap_mac_is_unicast_local_and_distinct(self) -> None:
        primary = "24:b2:b9:d6:ac:0d"
        target = trial.distinct_ap_mac(primary)
        self.assertEqual(target, "26:b2:b9:d6:ac:0c")
        self.assertEqual(int(target.split(":")[0], 16) & 3, 2)
        self.assertNotEqual(primary, target)

    def test_derived_ap_mac_fails_closed_on_invalid_input(self) -> None:
        for bad in ("bad", "a0:ff:ff:ff:ff", "01:02:03:04:05:06",
                    "24:b2:b9:d6:ac:zz"):
            with self.subTest(bad=bad), self.assertRaises(trial.SetupError):
                trial.distinct_ap_mac(bad)

    def test_interface_created_with_distinct_mac_only(self) -> None:
        with (mock.patch.object(trial.os.path, "exists", return_value=False),
              mock.patch.object(trial.Path, "read_text",
                                return_value="24:b2:b9:d6:ac:0d\n"),
              mock.patch.object(trial, "run", return_value="") as run):
            self.assertTrue(trial.ensure_virtual())
        run.assert_called_once_with(
            "iw", "phy", "phy0", "interface", "add", "sme105ap",
            "type", "__ap", "addr", "26:b2:b9:d6:ac:0c",
        )

    def test_kernel_link_failure_triggers_ap_only_rollback(self) -> None:
        calls = []
        def fake_run(*args: str, **kwargs: object) -> str:
            calls.append(args)
            if args == ("ip", "link", "set", "dev", "sme105ap", "up"):
                raise trial.SetupError("Name not unique on network")
            return ""
        with (mock.patch.object(trial.os, "geteuid", return_value=0),
              mock.patch.object(trial, "verify_main_connected"),
              mock.patch.object(trial, "ensure_virtual", return_value=True),
              mock.patch.object(trial.Path, "exists", return_value=True),
              mock.patch.object(trial.os.path, "exists", return_value=True),
              mock.patch.object(trial, "run", side_effect=fake_run),
              self.assertRaisesRegex(trial.SetupError, "Name not unique")):
            trial.activate()
        self.assertIn(("nmcli", "connection", "down", trial.PROFILE), calls)
        self.assertIn(("iw", "dev", trial.VIRTUAL, "del"), calls)
        self.assertNotIn(("nmcli", "device", "disconnect", "wlp9s0"), calls)


if __name__ == "__main__":
    unittest.main()
