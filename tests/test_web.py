from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from ford_dcl.capture import CaptureConfig, CaptureSession, utc_now
from ford_dcl.transport import RecordType
from ford_dcl.web.app import _session_path, create_app
from ford_dcl.web.capture_service import CaptureManager
from ford_dcl.web.ports import serial_access_status
from ford_dcl.web.settings import SettingsStore, validate_settings


class _FakeSerialCapture:
    def __init__(self, config, event_sink=None) -> None:
        self.config = config
        self.event_sink = event_sink
        self.session_path = None
        self.stop_event = threading.Event()

    def stop(self) -> None:
        self.stop_event.set()

    def run(self) -> Path:
        self.session_path = self.config.output_dir / "live-session"
        self.session_path.mkdir(parents=True, exist_ok=True)
        (self.session_path / "metadata.json").write_text("{}", encoding="utf-8")
        if self.event_sink is not None:
            self.event_sink({"event": "connected", "utc": utc_now()})
        self.stop_event.wait(5)
        return self.session_path


class WebApplicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temporary = tempfile.TemporaryDirectory()
        self.root = Path(self._temporary.name)
        self.settings_path = self.root / "settings.json"
        store = SettingsStore(self.settings_path)
        store.update(
            {
                "output_dir": str(self.root / "captures"),
                "analysis_dir": str(self.root / "analysis"),
                "port": "/dev/ttyUSB0",
            }
        )
        self.app = create_app(token="secret-token", settings_path=self.settings_path)
        self.client = TestClient(self.app)
        self.headers = {"X-Ford-DCL-Token": "secret-token"}

    def tearDown(self) -> None:
        self.app.state.capture_manager.stop()
        self.app.state.capture_manager.wait(1)
        self.client.close()
        self._temporary.cleanup()

    def test_missing_token_is_rejected(self) -> None:
        response = self.client.get("/api/bootstrap")
        self.assertEqual(response.status_code, 403)

    def test_bootstrap_and_static_assets(self) -> None:
        bootstrap = self.client.get("/api/bootstrap", headers=self.headers)
        self.assertEqual(bootstrap.status_code, 200)
        body = bootstrap.json()
        self.assertEqual(body["application"]["author"], "Eng. Maxim Salib")
        self.assertFalse(body["application"]["active_transmission"])
        self.assertIn("serial_access", body)
        self.assertIn("hint", body["serial_access"])
        home = self.client.get("/")
        self.assertEqual(home.status_code, 200)
        self.assertIn("SME-105 DCL Diagnostic Studio", home.text)
        favicon = self.client.get("/favicon.svg")
        self.assertEqual(favicon.status_code, 200)

    def test_unknown_settings_and_invalid_duration_are_rejected(self) -> None:
        unknown = self.client.put(
            "/api/settings",
            headers=self.headers,
            json={"values": {"not_a_setting": True}},
        )
        self.assertEqual(unknown.status_code, 422)
        duration = self.client.put(
            "/api/settings",
            headers=self.headers,
            json={"values": {"duration_seconds": 0}},
        )
        self.assertEqual(duration.status_code, 422)

    def test_nested_session_listing_and_path_traversal_rejection(self) -> None:
        nested = self.root / "captures" / "group" / "session-a"
        nested.mkdir(parents=True)
        (nested / "metadata.json").write_text(
            json.dumps({"created_utc": "2026-08-22T00:00:00Z", "format": "binary"}),
            encoding="utf-8",
        )
        listed = self.client.get("/api/sessions", headers=self.headers)
        self.assertEqual(listed.status_code, 200)
        self.assertEqual(listed.json()[0]["id"], "group/session-a")
        traversal = self.client.get(
            "/api/sessions/..%2Fsettings.json/inspect",
            headers=self.headers,
        )
        self.assertIn(traversal.status_code, {400, 404})
        with self.assertRaises(HTTPException) as context:
            _session_path(self.app.state.settings, "../secret")
        self.assertEqual(context.exception.status_code, 400)

    def test_inspect_reads_a_real_session(self) -> None:
        config = CaptureConfig(
            port="fixture",
            output_dir=self.root / "captures",
            rotate_size=64,
            format="ascii",
            session_metadata={"label": "gui-test"},
        )
        session = CaptureSession(config)
        session.write_raw(b"FF 00", utc=utc_now(), monotonic_ns=1)
        session.close("stopped")
        response = self.client.get(
            f"/api/sessions/{session.path.name}/inspect",
            headers=self.headers,
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["session"], str(session.path))

    def test_active_transmission_and_master_upload_remain_locked(self) -> None:
        transmit = self.client.post("/api/commands/transmit", headers=self.headers)
        self.assertEqual(transmit.status_code, 423)
        upload = self.client.post(
            "/api/firmware/run",
            headers=self.headers,
            json={"sketch": "dcl_master", "action": "upload", "port": "/dev/ttyUSB0"},
        )
        self.assertEqual(upload.status_code, 423)

    def test_dtc_and_diagnosis_endpoints(self) -> None:
        dtc = self.client.post(
            "/api/analyze/dtc",
            headers=self.headers,
            json={"codes": ["111"], "source": "continuous_memory"},
        )
        self.assertEqual(dtc.status_code, 200)
        self.assertEqual(dtc.json()["codes"][0]["kind"], "pass")
        diagnosis = self.client.post(
            "/api/diagnose",
            headers=self.headers,
            json={"repeated_sessions": 0},
        )
        self.assertEqual(diagnosis.status_code, 200)
        self.assertEqual(diagnosis.json()["branch"], "insufficient_evidence")

    def test_capture_manager_rejects_a_second_owner(self) -> None:
        with patch("ford_dcl.web.capture_service.SerialCapture", _FakeSerialCapture):
            first = self.client.post(
                "/api/capture/start",
                headers=self.headers,
                json={"overrides": {}},
            )
            self.assertEqual(first.status_code, 200)
            second = self.client.post(
                "/api/capture/start",
                headers=self.headers,
                json={"overrides": {}},
            )
            self.assertEqual(second.status_code, 409)
            stop = self.client.post("/api/capture/stop", headers=self.headers)
            self.assertEqual(stop.status_code, 200)
            self.assertTrue(self.app.state.capture_manager.wait(2))

    def test_websocket_requires_token_and_forwards_events(self) -> None:
        with self.assertRaises(Exception):
            with self.client.websocket_connect("/ws/events?token=wrong") as socket:
                socket.receive_json()
        with self.client.websocket_connect("/ws/events?token=secret-token") as socket:
            self.app.state.capture_manager.publish({"event": "unit_test_event"})
            payload = socket.receive_json()
            self.assertEqual(payload["event"], "unit_test_event")


class CaptureManagerAndSettingsTests(unittest.TestCase):
    def test_high_volume_events_are_coalesced_except_uart_status(self) -> None:
        manager = CaptureManager()
        manager.publish(
            {
                "event": "transport_record",
                "type": int(RecordType.UART_STATUS),
                "status": 0x10,
            }
        )
        for _ in range(12):
            manager.publish({"event": "raw_usb", "length": 1})
        events = manager.events_since(0)
        kinds = [item["event"] for item in events]
        self.assertIn("transport_record", kinds)
        self.assertIn("capture_throughput", kinds)
        self.assertNotIn("raw_usb", kinds)

    def test_settings_validation_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            document = SettingsStore(Path(temporary) / "settings.json").load()
        self.assertEqual(document["capture_format"], "binary")
        self.assertGreater(document["duration_seconds"], 0)
        with self.assertRaises(ValueError):
            validate_settings({**document, "usb_baudrate": 0})

    def test_serial_access_status_reports_process_groups(self) -> None:
        status = serial_access_status()
        self.assertIn("ok", status)
        self.assertIn("hint", status)


if __name__ == "__main__":
    unittest.main()
