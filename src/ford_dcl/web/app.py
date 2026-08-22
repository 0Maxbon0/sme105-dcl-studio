"""FastAPI application for the offline diagnostic studio."""

from __future__ import annotations

import asyncio
import json
import secrets
from pathlib import Path
from typing import Any

from fastapi import (
    Depends,
    FastAPI,
    Header,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ..cli import parse_dtc_code, parse_payload_hex
from ..decode import decode_payload
from ..diagnosis import (
    AirflowIsolation,
    DiagnosisThresholds,
    MixtureEvidence,
    WarmIdleEvidence,
    classify_high_idle,
)
from ..dtc import DTCSource, decode_dtcs
from ..framing import analyze_framing
from ..inspect_capture import inspect_session
from ..profile import load_profile
from ..serializers import REFERENCE_NOTICE, dtc_document, framing_document
from .capture_service import CaptureManager
from .firmware_service import FirmwareRunner
from .ports import list_serial_ports, serial_access_status
from .resources import resource_path
from .settings import SettingsStore

GUIDES = {
    "wiring-safety": ("Wiring and safety", "docs/wiring-safety.md"),
    "test-protocol": ("Guided test protocol", "docs/test-protocol.md"),
    "high-idle": ("High-idle diagnosis", "docs/high-idle-diagnosis.md"),
    "protocol-notes": ("Protocol evidence ledger", "docs/protocol-notes.md"),
    "implementation-status": ("Implementation status", "docs/implementation-status.md"),
    "firmware": ("Firmware reference", "firmware/README.md"),
}


class SettingsUpdate(BaseModel):
    values: dict[str, Any]


class CaptureStart(BaseModel):
    overrides: dict[str, Any] = Field(default_factory=dict)


class MarkerRequest(BaseModel):
    label: str = Field(min_length=1, max_length=80)
    detail: str | None = Field(default=None, max_length=500)


class PayloadRequest(BaseModel):
    payload_hex: str


class DTCRequest(BaseModel):
    codes: list[str | int]
    source: DTCSource


class DiagnosisRequest(BaseModel):
    rpm: float | None = None
    ect_deg_c: float | None = None
    tps_closed: bool | None = None
    iac_percent: float | None = None
    airflow_isolation: AirflowIsolation = AirflowIsolation.NOT_PERFORMED
    mixture: MixtureEvidence = MixtureEvidence.UNKNOWN
    repeated_sessions: int = Field(default=0, ge=0)
    source_capture_ids: list[str] = Field(default_factory=list)


class FirmwareRequest(BaseModel):
    sketch: str
    action: str
    port: str | None = None
    confirmation: str | None = None


def create_app(
    *,
    token: str | None = None,
    settings_path: Path | None = None,
) -> FastAPI:
    """Create an isolated application instance."""

    api_token = token or secrets.token_urlsafe(24)
    settings = SettingsStore(settings_path)
    manager = CaptureManager()
    firmware = FirmwareRunner(manager.publish)
    app = FastAPI(
        title="SME-105 DCL Diagnostic Studio",
        version="0.2.0",
        docs_url=None,
        redoc_url=None,
    )
    app.state.api_token = api_token
    app.state.settings = settings
    app.state.capture_manager = manager
    app.state.firmware_runner = firmware

    def authorize(x_ford_dcl_token: str | None = Header(default=None)) -> None:
        if x_ford_dcl_token is None or not secrets.compare_digest(
            x_ford_dcl_token, api_token
        ):
            raise HTTPException(status_code=403, detail="invalid application token")

    @app.exception_handler(ValueError)
    async def value_error_handler(_request: Any, exc: ValueError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(RuntimeError)
    async def runtime_error_handler(_request: Any, exc: RuntimeError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.get("/api/bootstrap", dependencies=[Depends(authorize)])
    def bootstrap() -> dict[str, Any]:
        current = settings.load()
        return {
            "application": {
                "name": "SME-105 DCL Diagnostic Studio",
                "author": "Eng. Maxim Salib",
                "version": "0.2.0",
                "offline": True,
                "active_transmission": False,
            },
            "settings": current,
            "ports": list_serial_ports(),
            "serial_access": serial_access_status(),
            "capture": manager.status(),
            "firmware": firmware.status(),
            "guides": [
                {"id": key, "title": title} for key, (title, _path) in GUIDES.items()
            ],
            "confidence_notice": REFERENCE_NOTICE,
        }

    @app.get("/api/ports", dependencies=[Depends(authorize)])
    def ports() -> list[dict[str, Any]]:
        return list_serial_ports()

    @app.get("/api/settings", dependencies=[Depends(authorize)])
    def get_settings() -> dict[str, Any]:
        return settings.load()

    @app.put("/api/settings", dependencies=[Depends(authorize)])
    def put_settings(request: SettingsUpdate) -> dict[str, Any]:
        return settings.update(request.values)

    @app.get("/api/capture/status", dependencies=[Depends(authorize)])
    def capture_status() -> dict[str, Any]:
        return manager.status()

    @app.post("/api/capture/start", dependencies=[Depends(authorize)])
    def capture_start(request: CaptureStart) -> dict[str, Any]:
        selected = settings.load()
        selected.update(request.overrides)
        return manager.start(selected)

    @app.post("/api/capture/stop", dependencies=[Depends(authorize)])
    def capture_stop() -> dict[str, Any]:
        return manager.stop()

    @app.post("/api/capture/marker", dependencies=[Depends(authorize)])
    def capture_marker(request: MarkerRequest) -> dict[str, Any]:
        return manager.marker(request.label.strip(), request.detail)

    @app.get("/api/events", dependencies=[Depends(authorize)])
    def events(sequence: int = 0) -> list[dict[str, Any]]:
        return manager.events_since(max(sequence, 0))

    @app.websocket("/ws/events")
    async def event_socket(socket: WebSocket, token: str, sequence: int = 0) -> None:
        if not secrets.compare_digest(token, api_token):
            await socket.close(code=4403)
            return
        await socket.accept()
        cursor = max(sequence, 0)
        try:
            while True:
                batch = manager.events_since(cursor)
                for record in batch:
                    await socket.send_json(record)
                    cursor = int(record["sequence"])
                await asyncio.sleep(0.2)
        except WebSocketDisconnect:
            return

    @app.get("/api/sessions", dependencies=[Depends(authorize)])
    def sessions() -> list[dict[str, Any]]:
        root = Path(settings.load()["output_dir"]).expanduser()
        return _list_sessions(root)

    @app.get(
        "/api/sessions/{session_id:path}/inspect", dependencies=[Depends(authorize)]
    )
    def inspect(session_id: str, gap_ms: float = 10.0) -> dict[str, Any]:
        return inspect_session(_session_path(settings, session_id), gap_ms=gap_ms)

    @app.post("/api/analyze/decode", dependencies=[Depends(authorize)])
    def decode(request: PayloadRequest) -> dict[str, Any]:
        current = settings.load()
        profile = load_profile(Path(current["profile_path"]).expanduser())
        result = decode_payload(parse_payload_hex(request.payload_hex), profile)
        document = result.to_dict()
        document.update(
            {
                "protocol_confidence": profile.protocol_confidence.value,
                "mapping_confidence": profile.mapping_confidence.value,
                "profile_source": profile.source,
                "confidence_notice": REFERENCE_NOTICE,
            }
        )
        return document

    @app.post("/api/analyze/frame", dependencies=[Depends(authorize)])
    def frame(request: PayloadRequest) -> dict[str, Any]:
        return framing_document(analyze_framing(parse_payload_hex(request.payload_hex)))

    @app.post("/api/analyze/dtc", dependencies=[Depends(authorize)])
    def dtc(request: DTCRequest) -> dict[str, Any]:
        values = [
            parse_dtc_code(str(value)) if not isinstance(value, int) else value
            for value in request.codes
        ]
        if any(not 0 <= value <= 0xFFF for value in values):
            raise ValueError("DTC codes must be between 0 and 0xFFF")
        return {
            "codes": [
                dtc_document(item)
                for item in decode_dtcs(values, source=request.source)
            ],
            "confidence_notice": REFERENCE_NOTICE,
        }

    @app.post("/api/diagnose", dependencies=[Depends(authorize)])
    def diagnose(request: DiagnosisRequest) -> dict[str, Any]:
        current = settings.load()
        evidence = WarmIdleEvidence(
            rpm=request.rpm,
            ect_deg_c=request.ect_deg_c,
            tps_closed=request.tps_closed,
            iac_percent=request.iac_percent,
            airflow_isolation=request.airflow_isolation,
            mixture=request.mixture,
            repeated_sessions=request.repeated_sessions,
            source_capture_ids=tuple(request.source_capture_ids),
        )
        thresholds = DiagnosisThresholds(
            high_idle_rpm=float(current["high_idle_rpm"]),
            fully_warm_ect_deg_c=float(current["fully_warm_ect_deg_c"]),
            minimum_iac_percent=float(current["minimum_iac_percent"]),
        )
        return classify_high_idle(evidence, thresholds).to_dict()

    @app.get("/api/guides/{guide_id}", dependencies=[Depends(authorize)])
    def guide(guide_id: str) -> dict[str, str]:
        if guide_id not in GUIDES:
            raise HTTPException(status_code=404, detail="guide not found")
        title, relative = GUIDES[guide_id]
        return {
            "id": guide_id,
            "title": title,
            "markdown": resource_path(*relative.split("/")).read_text(encoding="utf-8"),
        }

    @app.get("/api/firmware/status", dependencies=[Depends(authorize)])
    def firmware_status() -> dict[str, Any]:
        return firmware.status()

    @app.post("/api/firmware/run", dependencies=[Depends(authorize)])
    def firmware_run(request: FirmwareRequest) -> dict[str, Any]:
        try:
            return firmware.run(
                sketch=request.sketch,
                action=request.action,
                port=request.port,
                confirmation=request.confirmation,
            )
        except PermissionError as exc:
            raise HTTPException(status_code=423, detail=str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/api/firmware/cancel", dependencies=[Depends(authorize)])
    def firmware_cancel() -> dict[str, Any]:
        return firmware.cancel()

    @app.post("/api/commands/transmit", dependencies=[Depends(authorize)])
    def transmit_locked() -> None:
        raise HTTPException(
            status_code=423,
            detail="active DCL transmission is unverified and disabled",
        )

    static_dir = Path(__file__).resolve().parent / "static"
    app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")
    return app


def _list_sessions(root: Path) -> list[dict[str, Any]]:
    if not root.is_dir():
        return []
    output = []
    for path in _session_directories(root):
        metadata_path = path / "metadata.json"
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            metadata = {}
        output.append(
            {
                "id": path.relative_to(root).as_posix(),
                "path": str(path),
                "created_utc": metadata.get("created_utc"),
                "format": metadata.get("format"),
                "session": metadata.get("session", {}),
            }
        )
    output.sort(
        key=lambda item: str(item.get("created_utc") or item["id"]), reverse=True
    )
    return output


def _session_directories(root: Path) -> list[Path]:
    found: list[Path] = []
    for child in root.iterdir():
        if not child.is_dir():
            continue
        if (child / "metadata.json").is_file():
            found.append(child)
            continue
        for grandchild in child.iterdir():
            if grandchild.is_dir() and (grandchild / "metadata.json").is_file():
                found.append(grandchild)
    return found


def _session_path(store: SettingsStore, session_id: str) -> Path:
    if not session_id or session_id.startswith(("/", "\\")):
        raise HTTPException(status_code=400, detail="invalid session identifier")
    parts = Path(session_id).parts
    if not parts or any(part in {".", ".."} for part in parts):
        raise HTTPException(status_code=400, detail="invalid session identifier")
    root = Path(store.load()["output_dir"]).expanduser().resolve()
    candidate = root.joinpath(*parts).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise HTTPException(
            status_code=400, detail="invalid session identifier"
        ) from exc
    if not candidate.is_dir() or not (candidate / "metadata.json").is_file():
        raise HTTPException(status_code=404, detail="session not found")
    return candidate
