"""Standard-library event alignment and exploratory signal analysis."""

from __future__ import annotations

from bisect import bisect_left
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from math import isfinite, sqrt
from types import MappingProxyType

Numeric = int | float


@dataclass(frozen=True, slots=True)
class Event:
    timestamp: float
    values: Mapping[str, Numeric | None]
    valid: bool = True

    def __post_init__(self) -> None:
        timestamp = float(self.timestamp)
        if not isfinite(timestamp):
            raise ValueError("event timestamp must be finite")
        object.__setattr__(self, "timestamp", timestamp)
        object.__setattr__(self, "values", MappingProxyType(dict(self.values)))


@dataclass(frozen=True, slots=True)
class AlignedEvent:
    reference: Event
    candidate: Event | None
    time_delta: float | None
    matched: bool


@dataclass(frozen=True, slots=True)
class ChangeDelta:
    previous_timestamp: float
    timestamp: float
    elapsed: float
    changes: Mapping[str, float]
    valid: bool


@dataclass(frozen=True, slots=True)
class CorrelationRank:
    field: str
    target: str
    coefficient: float | None
    absolute_coefficient: float | None
    sample_count: int
    lag: int
    valid: bool
    issue: str | None = None


def align_events(
    reference: Sequence[Event] | Iterable[Event],
    candidate: Sequence[Event] | Iterable[Event],
    *,
    max_time_delta: float | None = None,
    unique_matches: bool = False,
) -> tuple[AlignedEvent, ...]:
    """Align each reference event to the nearest candidate in time.

    Unmatched references remain in the result.  A positive lag means the
    candidate occurred after the reference.
    """

    if max_time_delta is not None and max_time_delta < 0:
        raise ValueError("max_time_delta must be non-negative")
    references = sorted(reference, key=lambda event: event.timestamp)
    candidates = sorted(candidate, key=lambda event: event.timestamp)
    timestamps = [event.timestamp for event in candidates]
    used: set[int] = set()
    aligned = []
    for event in references:
        insertion = bisect_left(timestamps, event.timestamp)
        possible = []
        for index in (insertion - 1, insertion):
            available = not unique_matches or index not in used
            if 0 <= index < len(candidates) and available:
                possible.append(index)
        if unique_matches and not possible:
            possible = [index for index in range(len(candidates)) if index not in used]
        if not possible:
            aligned.append(AlignedEvent(event, None, None, False))
            continue
        nearest = min(
            possible,
            key=lambda index: (
                abs(candidates[index].timestamp - event.timestamp),
                candidates[index].timestamp,
            ),
        )
        delta = candidates[nearest].timestamp - event.timestamp
        matched = max_time_delta is None or abs(delta) <= max_time_delta
        if matched:
            if unique_matches:
                used.add(nearest)
            aligned.append(AlignedEvent(event, candidates[nearest], delta, True))
        else:
            aligned.append(AlignedEvent(event, None, delta, False))
    return tuple(aligned)


def change_deltas(
    events: Sequence[Event] | Iterable[Event],
    *,
    include_unchanged: bool = False,
) -> tuple[ChangeDelta, ...]:
    """Calculate numeric field changes between adjacent timestamped events."""

    ordered = sorted(events, key=lambda event: event.timestamp)
    results = []
    for previous, current in zip(ordered, ordered[1:]):
        keys = previous.values.keys() & current.values.keys()
        changes: dict[str, float] = {}
        values_valid = previous.valid and current.valid
        for key in sorted(keys):
            before = _finite_number(previous.values[key])
            after = _finite_number(current.values[key])
            if before is None or after is None:
                values_valid = False
                continue
            delta = after - before
            if include_unchanged or delta != 0:
                changes[key] = delta
        results.append(
            ChangeDelta(
                previous_timestamp=previous.timestamp,
                timestamp=current.timestamp,
                elapsed=current.timestamp - previous.timestamp,
                changes=MappingProxyType(changes),
                valid=values_valid,
            )
        )
    return tuple(results)


def deltas_as_events(deltas: Iterable[ChangeDelta]) -> tuple[Event, ...]:
    """Convert change results into events suitable for correlation ranking."""

    return tuple(
        Event(delta.timestamp, delta.changes, valid=delta.valid) for delta in deltas
    )


def pearson_correlation(
    left: Sequence[Numeric] | Iterable[Numeric],
    right: Sequence[Numeric] | Iterable[Numeric],
) -> float | None:
    """Return Pearson's r, or ``None`` for insufficient/constant data."""

    x = [float(value) for value in left]
    y = [float(value) for value in right]
    if len(x) != len(y):
        raise ValueError("correlation inputs must have equal lengths")
    if len(x) < 2 or any(not isfinite(value) for value in (*x, *y)):
        return None
    mean_x = sum(x) / len(x)
    mean_y = sum(y) / len(y)
    centered_x = [value - mean_x for value in x]
    centered_y = [value - mean_y for value in y]
    variance_x = sum(value * value for value in centered_x)
    variance_y = sum(value * value for value in centered_y)
    if variance_x == 0 or variance_y == 0:
        return None
    covariance = sum(a * b for a, b in zip(centered_x, centered_y))
    return covariance / sqrt(variance_x * variance_y)


def rank_correlations(
    events: Sequence[Event] | Iterable[Event],
    target: str,
    *,
    fields: Iterable[str] | None = None,
    min_samples: int = 3,
    max_lag: int = 0,
) -> tuple[CorrelationRank, ...]:
    """Rank fields by strongest absolute Pearson correlation with a target.

    Lags are measured in event positions.  Positive lag compares an earlier
    field value with a later target value; this is exploratory, not causal.
    """

    if min_samples < 2:
        raise ValueError("min_samples must be at least 2")
    if max_lag < 0:
        raise ValueError("max_lag must be non-negative")
    ordered = sorted(events, key=lambda event: event.timestamp)
    selected_fields = (
        sorted(set(fields))
        if fields is not None
        else sorted({key for event in ordered for key in event.values if key != target})
    )
    results = []
    for field in selected_fields:
        candidates = [
            _correlation_at_lag(ordered, field, target, lag, min_samples)
            for lag in range(-max_lag, max_lag + 1)
        ]
        valid = [item for item in candidates if item.valid]
        if valid:
            best = max(
                valid,
                key=lambda item: (
                    item.absolute_coefficient or 0.0,
                    item.sample_count,
                    -abs(item.lag),
                ),
            )
            results.append(best)
        else:
            best_sample_count = max(
                (item.sample_count for item in candidates),
                default=0,
            )
            results.append(
                CorrelationRank(
                    field=field,
                    target=target,
                    coefficient=None,
                    absolute_coefficient=None,
                    sample_count=best_sample_count,
                    lag=0,
                    valid=False,
                    issue="insufficient samples or constant signal",
                )
            )
    return tuple(
        sorted(
            results,
            key=lambda item: (
                not item.valid,
                -(item.absolute_coefficient or 0.0),
                item.field,
            ),
        )
    )


def _correlation_at_lag(
    events: Sequence[Event],
    field: str,
    target: str,
    lag: int,
    min_samples: int,
) -> CorrelationRank:
    left: list[float] = []
    right: list[float] = []
    for index, event in enumerate(events):
        target_index = index + lag
        if not 0 <= target_index < len(events):
            continue
        target_event = events[target_index]
        if not event.valid or not target_event.valid:
            continue
        field_value = _finite_number(event.values.get(field))
        target_value = _finite_number(target_event.values.get(target))
        if field_value is None or target_value is None:
            continue
        left.append(field_value)
        right.append(target_value)
    coefficient = pearson_correlation(left, right) if len(left) >= min_samples else None
    return CorrelationRank(
        field=field,
        target=target,
        coefficient=coefficient,
        absolute_coefficient=abs(coefficient) if coefficient is not None else None,
        sample_count=len(left),
        lag=lag,
        valid=coefficient is not None,
        issue=None if coefficient is not None else "insufficient or constant data",
    )


def _finite_number(value: Numeric | None) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    numeric = float(value)
    return numeric if isfinite(numeric) else None
