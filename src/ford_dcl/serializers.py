"""JSON serializers shared by the CLI and local web application."""

from __future__ import annotations

from dataclasses import asdict
from typing import Any

from .dtc import DecodedDTC
from .framing import FramingResult

REFERENCE_NOTICE = (
    "Reference and unverified results are hypotheses, not vehicle-validated facts."
)


def framing_document(result: FramingResult) -> dict[str, Any]:
    """Serialize framing evidence without asserting a protocol structure."""

    pair_scores = [
        {
            "offset": score.offset,
            "valid_words": score.valid_words,
            "invalid_words": score.invalid_words,
            "vertical_nibble_parity_valid_rate": score.validity_ratio,
            "crossed_gap_pairs": score.crossed_gap_pairs,
            "orphan_bytes": score.orphan_bytes,
            "score": score.score,
        }
        for score in result.pair_offset_scores
    ]
    frames = []
    for index, frame in enumerate(result.frames):
        count = asdict(frame.count_evidence) if frame.count_evidence else None
        if count is not None and frame.count_evidence is not None:
            count["unit"] = frame.count_evidence.unit.value
        frames.append(
            {
                "index": index,
                "payload_hex": frame.payload.hex().upper(),
                "direction": frame.direction.value,
                "preferred_offsets": list(frame.preferred_offsets),
                "score": frame.score,
                "response_size_matches": frame.response_size_matches,
                "count_evidence": count,
            }
        )
    return {
        "confidence": "unverified",
        "confidence_notice": REFERENCE_NOTICE,
        "gap_threshold_seconds": result.gap_threshold,
        "gap_indices": list(result.gap_indices),
        "pair_offsets": pair_scores,
        "candidates": frames,
        "hypotheses": list(result.hypotheses),
    }


def dtc_document(decoded: DecodedDTC) -> dict[str, Any]:
    """Serialize one catalog lookup."""

    return {
        "raw_code": decoded.raw_code,
        "raw_hex": decoded.raw_hex,
        "source": decoded.source.value,
        "kind": decoded.kind.value,
        "class": decoded.code_class.value,
        "display_code": decoded.display_code,
        "summary": decoded.summary,
        "known": decoded.known,
        "catalog_confidence": decoded.catalog_confidence,
    }
