"""Executable launcher for the local diagnostic studio."""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import secrets
import socket
import sys
import threading
import webbrowser
from collections.abc import Sequence

import uvicorn

from .app import create_app


def _require_websocket_library() -> None:
    """Live capture logs use FastAPI WebSockets; uvicorn needs an implementation."""

    if importlib.util.find_spec("websockets") or importlib.util.find_spec("wsproto"):
        return
    raise SystemExit(
        "No WebSocket library found. From the project folder run:\n"
        "  .venv\\Scripts\\python.exe -m pip install -e .\n"
        "or: .venv/bin/python -m pip install -e ."
    )


def _configure_event_loop() -> None:
    """Avoid Windows Proactor connection-reset noise on browser refresh."""

    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def _available_port(preferred: int) -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", preferred))
        except OSError:
            probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def main(argv: Sequence[str] | None = None) -> int:
    """Launch the server and optionally open the system browser."""

    parser = argparse.ArgumentParser(prog="ford-dcl-gui")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args(argv)
    _require_websocket_library()
    _configure_event_loop()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    token = secrets.token_urlsafe(24)
    port = _available_port(args.port)
    url = f"http://127.0.0.1:{port}/?token={token}"
    app = create_app(token=token)
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            access_log=False,
        )
    )
    print(f"SME-105 DCL Diagnostic Studio: {url}", flush=True)
    if not args.no_browser:
        opener = threading.Timer(0.8, webbrowser.open, args=(url,))
        opener.daemon = True
        opener.start()
    try:
        server.run()
    finally:
        app.state.capture_manager.stop()
        app.state.capture_manager.wait()
        app.state.firmware_runner.cancel()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
