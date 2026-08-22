"""Unknown-safe Ford EEC-IV diagnostic trouble-code decoding."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from enum import Enum
from types import MappingProxyType


class DTCSource(str, Enum):
    KOEO = "koeo"
    KOER = "koer"
    CONTINUOUS_MEMORY = "continuous_memory"
    UNKNOWN = "unknown"


class DTCKind(str, Enum):
    PASS = "pass"
    OPERATOR_PROMPT = "operator_prompt"
    FAULT = "fault"
    UNKNOWN = "unknown"


class DTCClass(str, Enum):
    COOLANT_TEMPERATURE = "coolant_temperature"
    THROTTLE_POSITION = "throttle_position"
    OXYGEN_SENSOR = "oxygen_sensor"
    FUEL_TRIM = "fuel_trim"
    IDLE_AIR_CONTROL = "idle_air_control"
    INTAKE_AIR_TEMPERATURE = "intake_air_temperature"
    MASS_AIR_FLOW = "mass_air_flow"
    INJECTOR = "injector"
    MULTI_SENSOR = "multi_sensor"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class KnownDTC:
    display_code: int
    code_class: DTCClass
    summary: str
    kind: DTCKind = DTCKind.FAULT


@dataclass(frozen=True, slots=True)
class DecodedDTC:
    """Decoded view that always preserves the original 12-bit value."""

    raw_code: int
    source: DTCSource
    code_class: DTCClass
    display_code: int | None
    summary: str | None
    known: bool
    kind: DTCKind
    catalog_confidence: str

    @property
    def raw_hex(self) -> str:
        return f"{self.raw_code:03X}"

    @property
    def display_text(self) -> str | None:
        return f"{self.display_code:03d}" if self.display_code is not None else None


def _catalog_faults(
    code_class: DTCClass,
    label: str,
    codes: Iterable[int],
) -> dict[int, KnownDTC]:
    return {code: KnownDTC(code, code_class, f"{label} fault") for code in codes}


_catalog: dict[int, KnownDTC] = {
    111: KnownDTC(
        111,
        DTCClass.UNKNOWN,
        "pass",
        kind=DTCKind.PASS,
    ),
    10: KnownDTC(
        10,
        DTCClass.UNKNOWN,
        "separator/operator prompt",
        kind=DTCKind.OPERATOR_PROMPT,
    ),
    20: KnownDTC(
        20,
        DTCClass.UNKNOWN,
        "separator/operator prompt",
        kind=DTCKind.OPERATOR_PROMPT,
    ),
    30: KnownDTC(
        30,
        DTCClass.UNKNOWN,
        "separator/operator prompt",
        kind=DTCKind.OPERATOR_PROMPT,
    ),
}
_catalog.update(
    _catalog_faults(
        DTCClass.INTAKE_AIR_TEMPERATURE,
        "IAT",
        (112, 113, 114),
    )
)
_catalog.update(
    _catalog_faults(
        DTCClass.COOLANT_TEMPERATURE,
        "ECT",
        (116, 117, 118, 338, 339),
    )
)
_catalog.update(
    _catalog_faults(
        DTCClass.THROTTLE_POSITION,
        "TPS",
        (121, 122, 123, 124, 125, 167),
    )
)
_catalog.update(
    _catalog_faults(
        DTCClass.OXYGEN_SENSOR,
        "O2",
        (
            136,
            137,
            139,
            144,
            171,
            172,
            173,
            174,
            175,
            176,
            177,
            178,
            188,
            189,
            191,
            192,
            193,
            194,
            195,
        ),
    )
)
_catalog.update(
    _catalog_faults(
        DTCClass.FUEL_TRIM,
        "fuel trim",
        (179, 181, 182, 183),
    )
)
_catalog.update(
    _catalog_faults(
        DTCClass.MASS_AIR_FLOW,
        "MAF",
        (129, 157, 158, 159, 184, 185),
    )
)
_catalog.update(
    _catalog_faults(
        DTCClass.INJECTOR,
        "injector",
        (186, 187),
    )
)
_catalog.update(
    _catalog_faults(
        DTCClass.IDLE_AIR_CONTROL,
        "IAC",
        (411, 412, 413, 414, 415, 416, 551),
    )
)
_catalog.update(
    _catalog_faults(
        DTCClass.MULTI_SENSOR,
        "multi-sensor",
        (998,),
    )
)


_COMMON_CODES: Mapping[int, KnownDTC] = MappingProxyType(_catalog)
del _catalog


COMMON_CODES: Mapping[int, KnownDTC] = _COMMON_CODES


def packed_bcd_display(raw_code: int) -> int | None:
    """Interpret three nibbles as decimal digits when all are valid BCD."""

    raw = _require_raw(raw_code)
    digits = ((raw >> 8) & 0xF, (raw >> 4) & 0xF, raw & 0xF)
    if any(digit > 9 for digit in digits):
        return None
    return (digits[0] * 100) + (digits[1] * 10) + digits[2]


def decode_dtc(
    raw_code: int,
    *,
    source: DTCSource | str = DTCSource.UNKNOWN,
    code_class: DTCClass | str | None = None,
    display_code: int | None = None,
) -> DecodedDTC:
    """Decode a code conservatively.

    The catalog uses familiar printed Ford codes.  A caller may provide that
    printed value explicitly.  Otherwise an exact numeric match is attempted
    first, followed by packed-BCD interpretation of the raw 12 bits.
    """

    raw = _require_raw(raw_code)
    selected_source = DTCSource(source)
    candidate_display = display_code
    if candidate_display is None:
        if raw in COMMON_CODES:
            candidate_display = raw
        else:
            candidate_display = packed_bcd_display(raw)
    known = (
        COMMON_CODES.get(candidate_display) if candidate_display is not None else None
    )
    selected_class = (
        DTCClass(code_class)
        if code_class is not None
        else known.code_class
        if known is not None
        else DTCClass.UNKNOWN
    )
    return DecodedDTC(
        raw_code=raw,
        source=selected_source,
        code_class=selected_class,
        display_code=candidate_display,
        summary=known.summary if known is not None else None,
        known=known is not None,
        kind=known.kind if known is not None else DTCKind.UNKNOWN,
        catalog_confidence=("published_reference" if known is not None else "unknown"),
    )


def decode_dtcs(
    raw_codes: Iterable[int],
    *,
    source: DTCSource | str = DTCSource.UNKNOWN,
) -> tuple[DecodedDTC, ...]:
    return tuple(decode_dtc(raw, source=source) for raw in raw_codes)


def _require_raw(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("raw_code must be an integer")
    if not 0 <= value <= 0xFFF:
        raise ValueError("raw_code must be a 12-bit value")
    return value
