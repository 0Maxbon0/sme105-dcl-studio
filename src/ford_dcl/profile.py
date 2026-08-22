"""JSON-backed decoder profiles."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from types import MappingProxyType
from typing import Any

DEFAULT_PROFILE_PATH = Path(__file__).resolve().parents[2] / "profiles" / "sme_105.json"


class SelectorPart(str, Enum):
    BYTE = "byte"
    HIGH_NIBBLE = "high_nibble"
    LOW_NIBBLE = "low_nibble"


class Confidence(str, Enum):
    REFERENCE = "reference"
    UNVERIFIED = "unverified"


class EngineeringKind(str, Enum):
    LINEAR = "linear"
    REFERENCE_FORMULA = "reference_formula"
    LOOKUP = "lookup"


@dataclass(frozen=True, slots=True)
class Selector:
    byte: int
    part: SelectorPart

    def __post_init__(self) -> None:
        if self.byte < 0:
            raise ValueError("selector byte must be non-negative")
        object.__setattr__(self, "part", SelectorPart(self.part))

    @property
    def width(self) -> int:
        return 8 if self.part is SelectorPart.BYTE else 4

    def extract(self, payload: bytes) -> int:
        value = payload[self.byte]
        if self.part is SelectorPart.BYTE:
            return value
        if self.part is SelectorPart.HIGH_NIBBLE:
            return value >> 4
        return value & 0x0F


@dataclass(frozen=True, slots=True)
class EngineeringTransform:
    kind: EngineeringKind
    unit: str
    confidence: Confidence
    scale: float = 1.0
    offset: float = 0.0
    formula: str | None = None
    lookup: Mapping[int, str] | None = None

    def apply(self, raw_value: int) -> int | float | str | None:
        if self.kind is EngineeringKind.LINEAR:
            return (raw_value * self.scale) + self.offset
        if self.kind is EngineeringKind.LOOKUP:
            return self.lookup.get(raw_value) if self.lookup is not None else None
        if self.formula is None:
            return None
        return _REFERENCE_FORMULAS[self.formula](raw_value)


@dataclass(frozen=True, slots=True)
class FieldProfile:
    name: str
    selectors: tuple[Selector, ...]
    source_chars: str
    confidence: Confidence
    verification: Confidence
    engineering: EngineeringTransform | None = None
    notes: str | None = None

    @property
    def bit_width(self) -> int:
        return sum(selector.width for selector in self.selectors)

    @property
    def required_payload_bytes(self) -> int:
        return max(selector.byte for selector in self.selectors) + 1

    def extract_raw(self, payload: bytes | bytearray | Sequence[int]) -> int:
        raw = bytes(payload)
        if len(raw) < self.required_payload_bytes:
            raise ValueError(
                f"{self.name} requires {self.required_payload_bytes} payload bytes; "
                f"received {len(raw)}"
            )
        result = 0
        for selector in self.selectors:
            result = (result << selector.width) | selector.extract(raw)
        return result


@dataclass(frozen=True, slots=True)
class DecoderProfile:
    profile_id: str
    description: str
    response_bytes: int
    fields: Mapping[str, FieldProfile]
    protocol_confidence: Confidence
    mapping_confidence: Confidence
    source: str

    def field(self, name: str) -> FieldProfile:
        try:
            return self.fields[name]
        except KeyError as exc:
            raise KeyError(f"unknown profile field: {name}") from exc


def load_profile(path: str | Path | None = None) -> DecoderProfile:
    """Load and validate a JSON decoder profile."""

    selected = Path(path) if path is not None else DEFAULT_PROFILE_PATH
    with selected.open("r", encoding="utf-8") as handle:
        document = json.load(handle)
    if not isinstance(document, dict):
        raise ValueError("profile root must be a JSON object")
    return profile_from_mapping(document)


def profile_from_mapping(document: Mapping[str, Any]) -> DecoderProfile:
    required = (
        "profile_id",
        "description",
        "response_bytes",
        "protocol_confidence",
        "mapping_confidence",
        "source",
        "fields",
    )
    missing = [key for key in required if key not in document]
    if missing:
        raise ValueError(f"profile missing keys: {', '.join(missing)}")
    response_bytes = document["response_bytes"]
    if not isinstance(response_bytes, int) or isinstance(response_bytes, bool):
        raise TypeError("response_bytes must be an integer")
    if response_bytes <= 0:
        raise ValueError("response_bytes must be positive")
    raw_fields = document["fields"]
    if not isinstance(raw_fields, list) or not raw_fields:
        raise ValueError("fields must be a non-empty array")
    parsed_fields: dict[str, FieldProfile] = {}
    for item in raw_fields:
        field = _parse_field(item)
        if field.name in parsed_fields:
            raise ValueError(f"duplicate field name: {field.name}")
        if field.required_payload_bytes > response_bytes:
            raise ValueError(
                f"{field.name} exceeds {response_bytes}-byte response boundary"
            )
        parsed_fields[field.name] = field
    return DecoderProfile(
        profile_id=str(document["profile_id"]),
        description=str(document["description"]),
        response_bytes=response_bytes,
        fields=MappingProxyType(parsed_fields),
        protocol_confidence=Confidence(document["protocol_confidence"]),
        mapping_confidence=Confidence(document["mapping_confidence"]),
        source=str(document["source"]),
    )


def _parse_field(item: Any) -> FieldProfile:
    if not isinstance(item, dict):
        raise ValueError("each field must be a JSON object")
    name = item.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError("field name must be a non-empty string")
    raw_selectors = item.get("selectors")
    if not isinstance(raw_selectors, list) or not raw_selectors:
        raise ValueError(f"{name} selectors must be a non-empty array")
    selectors = []
    for raw_selector in raw_selectors:
        if not isinstance(raw_selector, dict):
            raise ValueError(f"{name} selector must be an object")
        byte = raw_selector.get("byte")
        if not isinstance(byte, int) or isinstance(byte, bool):
            raise TypeError(f"{name} selector byte must be an integer")
        selectors.append(Selector(byte, SelectorPart(raw_selector.get("part"))))
    engineering = _parse_engineering(name, item.get("engineering"))
    return FieldProfile(
        name=name,
        selectors=tuple(selectors),
        source_chars=str(item.get("source_chars", "")),
        confidence=Confidence(item.get("confidence", Confidence.UNVERIFIED.value)),
        verification=Confidence(item.get("verification", Confidence.UNVERIFIED.value)),
        engineering=engineering,
        notes=str(item["notes"]) if item.get("notes") is not None else None,
    )


def _parse_engineering(
    field_name: str,
    item: Any,
) -> EngineeringTransform | None:
    if item is None:
        return None
    if not isinstance(item, dict):
        raise ValueError(f"{field_name} engineering must be an object or null")
    kind = EngineeringKind(item.get("kind", EngineeringKind.LINEAR.value))
    scale = item.get("scale", 1.0)
    offset = item.get("offset", 0.0)
    unit = item.get("unit")
    if not isinstance(scale, (int, float)) or isinstance(scale, bool):
        raise TypeError(f"{field_name} engineering scale must be numeric")
    if not isinstance(offset, (int, float)) or isinstance(offset, bool):
        raise TypeError(f"{field_name} engineering offset must be numeric")
    if not isinstance(unit, str) or not unit:
        raise ValueError(f"{field_name} engineering unit is required")
    formula = item.get("formula")
    if kind is EngineeringKind.REFERENCE_FORMULA:
        if not isinstance(formula, str) or formula not in _REFERENCE_FORMULAS:
            raise ValueError(f"{field_name} has an unknown reference formula")
    elif formula is not None:
        raise ValueError(f"{field_name} formula requires reference_formula kind")
    raw_lookup = item.get("values")
    lookup: Mapping[int, str] | None = None
    if kind is EngineeringKind.LOOKUP:
        if not isinstance(raw_lookup, dict) or not raw_lookup:
            raise ValueError(f"{field_name} lookup requires non-empty values")
        parsed_lookup: dict[int, str] = {}
        for raw_key, raw_value in raw_lookup.items():
            try:
                key = int(str(raw_key), 0)
            except ValueError as exc:
                raise ValueError(f"{field_name} lookup key is not numeric") from exc
            if key < 0:
                raise ValueError(f"{field_name} lookup key must be non-negative")
            if not isinstance(raw_value, str) or not raw_value:
                raise ValueError(f"{field_name} lookup values must be strings")
            parsed_lookup[key] = raw_value
        lookup = MappingProxyType(parsed_lookup)
    elif raw_lookup is not None:
        raise ValueError(f"{field_name} values require lookup kind")
    return EngineeringTransform(
        kind=kind,
        unit=unit,
        confidence=Confidence(item.get("confidence", Confidence.UNVERIFIED.value)),
        scale=float(scale),
        offset=float(offset),
        formula=formula,
        lookup=lookup,
    )


def _java_div(numerator: int, denominator: int) -> int:
    """Integer division with Java's truncation toward zero."""

    sign = -1 if (numerator < 0) != (denominator < 0) else 1
    return sign * (abs(numerator) // abs(denominator))


def _reference_rpm(raw: int) -> int:
    return _java_div((raw * 4) + 5, 10) * 10


def _reference_fuel_correction(raw: int) -> int:
    return 128 - raw


def _reference_o2(raw: int) -> int:
    return _java_div((1024 - raw) * 2675, 1000)


def _reference_maf(raw: int) -> int:
    high_nibble = raw >> 8
    low_byte_digit = ((raw & 0xFF) * 10) // 256
    return ((high_nibble * 10) + low_byte_digit) * 100


def _reference_injection(raw: int) -> int:
    return (raw - _java_div(raw, 24)) * 80


def _reference_tps(raw: int) -> int:
    correction = _java_div(raw * 5, 200)
    return (raw - correction) * 5


def _reference_ignition(raw: int) -> int:
    return _java_div(raw, 4)


def _reference_voltage(raw: int) -> float:
    whole = raw >> 4
    tenths = ((raw & 0x0F) * 10) // 16
    return whole + (tenths / 10)


def _reference_temperature(raw: int) -> int:
    return _java_div(raw - 16, 10) + raw - 15


def _reference_iac(raw: int) -> int:
    high_nibble = raw >> 4
    low_nibble = raw & 0x0F
    return _java_div(
        (((15 * high_nibble) + low_nibble) * 80) + (45 * high_nibble),
        100,
    )


_REFERENCE_FORMULAS = MappingProxyType(
    {
        "java_rpm": _reference_rpm,
        "java_fuel_correction": _reference_fuel_correction,
        "java_o2": _reference_o2,
        "java_maf": _reference_maf,
        "java_injection": _reference_injection,
        "java_tps": _reference_tps,
        "java_ignition": _reference_ignition,
        "java_voltage": _reference_voltage,
        "java_temperature": _reference_temperature,
        "java_iac": _reference_iac,
    }
)
