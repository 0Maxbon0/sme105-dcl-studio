"""Evidence-scored framing for Ford DCL captures.

No preamble or checksum is assumed.  Candidates are scored from parity,
timing, direction, an optional count field, and the observed 32-byte response
size hypothesis.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from enum import Enum
from statistics import median

from .words import WordStream, decode_pairs

LIKELY_UART_BAUD = 9600
LIKELY_UART_FORMAT = "8N2"
KNOWN_RESPONSE_BYTES = 32


class Direction(str, Enum):
    REQUEST = "request"
    RESPONSE = "response"
    UNKNOWN = "unknown"


class CountUnit(str, Enum):
    WIRE_BYTES = "wire_bytes"
    WORDS = "words"


@dataclass(frozen=True, slots=True)
class ByteSample:
    timestamp: float | None
    value: int
    direction: Direction = Direction.UNKNOWN

    def __post_init__(self) -> None:
        if self.timestamp is not None and self.timestamp < 0:
            raise ValueError("timestamp must be non-negative")
        if not isinstance(self.value, int) or isinstance(self.value, bool):
            raise TypeError("sample value must be an integer")
        if not 0 <= self.value <= 0xFF:
            raise ValueError("sample value must be between 0x00 and 0xFF")
        object.__setattr__(self, "direction", Direction(self.direction))


@dataclass(frozen=True, slots=True)
class PairOffsetScore:
    offset: int
    stream: WordStream
    valid_words: int
    invalid_words: int
    crossed_gap_pairs: int
    orphan_bytes: int
    score: float

    @property
    def validity_ratio(self) -> float:
        total = self.valid_words + self.invalid_words
        return self.valid_words / total if total else 0.0


@dataclass(frozen=True, slots=True)
class CountEvidence:
    field_index: int
    declared_count: int | None
    actual_count: int
    unit: CountUnit
    bias: int
    valid: bool
    issue: str | None = None


@dataclass(frozen=True, slots=True)
class FramingOptions:
    """Explicit framing hypotheses; ``None`` disables a hypothesis."""

    inter_frame_gap: float | None = None
    infer_gap_multiplier: float = 8.0
    expected_response_bytes: int | None = KNOWN_RESPONSE_BYTES
    count_field_index: int | None = None
    count_unit: CountUnit = CountUnit.WIRE_BYTES
    count_bias: int = 0
    count_includes_field: bool = True
    split_on_direction_change: bool = True

    def __post_init__(self) -> None:
        if self.inter_frame_gap is not None and self.inter_frame_gap <= 0:
            raise ValueError("inter_frame_gap must be positive")
        if self.infer_gap_multiplier <= 1:
            raise ValueError("infer_gap_multiplier must be greater than 1")
        if (
            self.expected_response_bytes is not None
            and self.expected_response_bytes <= 0
        ):
            raise ValueError("expected_response_bytes must be positive")
        if self.count_field_index is not None and self.count_field_index < 0:
            raise ValueError("count_field_index must be non-negative")
        object.__setattr__(self, "count_unit", CountUnit(self.count_unit))


@dataclass(frozen=True, slots=True)
class FrameCandidate:
    samples: tuple[ByteSample, ...]
    payload: bytes
    direction: Direction
    pair_offsets: tuple[PairOffsetScore, PairOffsetScore]
    preferred_offsets: tuple[int, ...]
    count_evidence: CountEvidence | None
    response_size_matches: bool | None
    score: float

    @property
    def start_time(self) -> float | None:
        return self.samples[0].timestamp if self.samples else None

    @property
    def end_time(self) -> float | None:
        return self.samples[-1].timestamp if self.samples else None


@dataclass(frozen=True, slots=True)
class FramingResult:
    frames: tuple[FrameCandidate, ...]
    pair_offset_scores: tuple[PairOffsetScore, PairOffsetScore]
    gap_threshold: float | None
    gap_indices: tuple[int, ...]
    hypotheses: tuple[str, ...]


def coerce_samples(
    samples: bytes
    | bytearray
    | Iterable[int]
    | Iterable[ByteSample]
    | Iterable[tuple[float | None, int]]
    | Iterable[tuple[float | None, int, Direction | str]],
) -> tuple[ByteSample, ...]:
    """Normalize bytes or timestamped values into immutable samples."""

    if isinstance(samples, (bytes, bytearray)):
        return tuple(ByteSample(None, value) for value in samples)
    normalized: list[ByteSample] = []
    for item in samples:
        if isinstance(item, ByteSample):
            normalized.append(item)
        elif isinstance(item, int):
            normalized.append(ByteSample(None, item))
        elif len(item) == 2:
            timestamp, value = item
            normalized.append(ByteSample(timestamp, value))
        elif len(item) == 3:
            timestamp, value, direction = item
            normalized.append(ByteSample(timestamp, value, Direction(direction)))
        else:
            raise ValueError("sample tuples must have two or three items")
    return tuple(normalized)


def infer_inter_frame_gap(
    samples: Sequence[ByteSample],
    multiplier: float = 8.0,
) -> float | None:
    """Infer a conservative gap threshold from positive adjacent intervals."""

    if multiplier <= 1:
        raise ValueError("multiplier must be greater than 1")
    deltas = [
        current.timestamp - previous.timestamp
        for previous, current in zip(samples, samples[1:])
        if previous.timestamp is not None
        and current.timestamp is not None
        and current.timestamp > previous.timestamp
    ]
    return median(deltas) * multiplier if deltas else None


def gap_indices(
    samples: Sequence[ByteSample],
    threshold: float | None,
) -> tuple[int, ...]:
    """Return indices whose sample starts after a qualifying gap."""

    if threshold is None:
        return ()
    return tuple(
        index
        for index in range(1, len(samples))
        if samples[index - 1].timestamp is not None
        and samples[index].timestamp is not None
        and samples[index].timestamp - samples[index - 1].timestamp > threshold
    )


def score_pair_offsets(
    samples: Sequence[ByteSample] | bytes | bytearray | Iterable[int],
    inter_frame_gap: float | None = None,
) -> tuple[PairOffsetScore, PairOffsetScore]:
    """Score both possible pair offsets and retain every decoded word."""

    normalized = coerce_samples(samples)
    raw = bytes(sample.value for sample in normalized)
    gaps = set(gap_indices(normalized, inter_frame_gap))
    results: list[PairOffsetScore] = []
    for offset in (0, 1):
        stream = decode_pairs(raw, offset)
        crossed = sum(
            1
            for index in range(offset, offset + len(stream.words) * 2, 2)
            if index + 1 in gaps
        )
        orphan_count = len(stream.leading_bytes) + len(stream.trailing_bytes)
        total = len(stream.words)
        validity = stream.valid_count / total if total else 0.0
        crossing_penalty = crossed / total if total else 0.0
        orphan_penalty = orphan_count / len(raw) if raw else 0.0
        score = validity - (0.5 * crossing_penalty) - (0.1 * orphan_penalty)
        results.append(
            PairOffsetScore(
                offset=offset,
                stream=stream,
                valid_words=stream.valid_count,
                invalid_words=stream.invalid_count,
                crossed_gap_pairs=crossed,
                orphan_bytes=orphan_count,
                score=score,
            )
        )
    return results[0], results[1]


def analyze_framing(
    samples: bytes
    | bytearray
    | Iterable[int]
    | Iterable[ByteSample]
    | Iterable[tuple[float | None, int]]
    | Iterable[tuple[float | None, int, Direction | str]],
    options: FramingOptions | None = None,
) -> FramingResult:
    """Split and score candidate frames without asserting packet structure."""

    selected = options or FramingOptions()
    normalized = coerce_samples(samples)
    threshold = selected.inter_frame_gap
    if threshold is None:
        threshold = infer_inter_frame_gap(
            normalized,
            multiplier=selected.infer_gap_multiplier,
        )
    gaps = gap_indices(normalized, threshold)
    overall_scores = score_pair_offsets(normalized, threshold)
    chunks = _split_samples(
        normalized,
        gaps,
        split_on_direction_change=selected.split_on_direction_change,
    )
    frames = tuple(_build_frame(chunk, selected) for chunk in chunks if chunk)
    hypotheses = (
        f"UART likely {LIKELY_UART_BAUD} {LIKELY_UART_FORMAT}; not proven",
        "wire bytes likely form parity-protected pairs",
        "no preamble or checksum asserted",
        (
            f"response size candidate: {selected.expected_response_bytes} bytes"
            if selected.expected_response_bytes is not None
            else "response size scoring disabled"
        ),
    )
    return FramingResult(
        frames=frames,
        pair_offset_scores=overall_scores,
        gap_threshold=threshold,
        gap_indices=gaps,
        hypotheses=hypotheses,
    )


def _split_samples(
    samples: tuple[ByteSample, ...],
    gaps: tuple[int, ...],
    split_on_direction_change: bool,
) -> tuple[tuple[ByteSample, ...], ...]:
    if not samples:
        return ()
    boundaries = set(gaps)
    if split_on_direction_change:
        for index in range(1, len(samples)):
            previous = samples[index - 1].direction
            current = samples[index].direction
            if (
                previous is not Direction.UNKNOWN
                and current is not Direction.UNKNOWN
                and previous is not current
            ):
                boundaries.add(index)
    ordered = sorted(boundaries)
    starts = [0, *ordered]
    ends = [*ordered, len(samples)]
    return tuple(tuple(samples[start:end]) for start, end in zip(starts, ends))


def _build_frame(
    samples: tuple[ByteSample, ...],
    options: FramingOptions,
) -> FrameCandidate:
    payload = bytes(sample.value for sample in samples)
    known_directions = {
        sample.direction
        for sample in samples
        if sample.direction is not Direction.UNKNOWN
    }
    direction = (
        next(iter(known_directions))
        if len(known_directions) == 1
        else Direction.UNKNOWN
    )
    offsets = score_pair_offsets(samples, options.inter_frame_gap)
    best_score = max(item.score for item in offsets)
    preferred = tuple(
        item.offset for item in offsets if abs(item.score - best_score) <= 1e-12
    )
    count = _count_evidence(payload, options)
    response_match: bool | None = None
    size_adjustment = 0.0
    if direction is Direction.RESPONSE and options.expected_response_bytes is not None:
        response_match = len(payload) == options.expected_response_bytes
        size_adjustment = 0.15 if response_match else -0.05
    count_adjustment = 0.0
    if count is not None:
        count_adjustment = 0.1 if count.valid else -0.1
    return FrameCandidate(
        samples=samples,
        payload=payload,
        direction=direction,
        pair_offsets=offsets,
        preferred_offsets=preferred,
        count_evidence=count,
        response_size_matches=response_match,
        score=best_score + size_adjustment + count_adjustment,
    )


def _count_evidence(
    payload: bytes,
    options: FramingOptions,
) -> CountEvidence | None:
    index = options.count_field_index
    if index is None:
        return None
    if index >= len(payload):
        return CountEvidence(
            field_index=index,
            declared_count=None,
            actual_count=0,
            unit=options.count_unit,
            bias=options.count_bias,
            valid=False,
            issue="count field lies outside candidate frame",
        )
    declared = payload[index] + options.count_bias
    counted_bytes = len(payload) if options.count_includes_field else len(payload) - 1
    actual = (
        counted_bytes
        if options.count_unit is CountUnit.WIRE_BYTES
        else counted_bytes // 2
    )
    return CountEvidence(
        field_index=index,
        declared_count=declared,
        actual_count=actual,
        unit=options.count_unit,
        bias=options.count_bias,
        valid=declared == actual,
    )
