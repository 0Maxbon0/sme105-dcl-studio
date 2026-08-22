"""Append-only operator markers for synchronized vehicle experiments."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from .capture import utc_now


def append_marker(
    path: str | Path, label: str, detail: str | None = None
) -> dict[str, object]:
    """Append one host-clock marker using a single append-only OS write."""

    normalized = label.strip()
    if not normalized:
        raise ValueError("marker label cannot be empty")
    selected = Path(path)
    selected.parent.mkdir(parents=True, exist_ok=True)
    record: dict[str, object] = {
        "event": "operator_marker",
        "utc": utc_now(),
        "monotonic_ns": time.monotonic_ns(),
        "label": normalized,
    }
    if detail:
        record["detail"] = detail
    payload = (
        json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n"
    ).encode()
    descriptor = os.open(selected, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)
    try:
        written = os.write(descriptor, payload)
        if written != len(payload):
            raise OSError(f"short marker write: {written} of {len(payload)} bytes")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return record
