"""Profile-driven payload decoding with explicit validity and confidence."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import asdict, dataclass
from types import MappingProxyType

from .framing import FrameCandidate
from .profile import (
    Confidence,
    DecoderProfile,
    EngineeringTransform,
    FieldProfile,
    load_profile,
)


@dataclass(frozen=True, slots=True)
class DecodedField:
    name: str
    raw_value: int | None
    raw_hex: str | None
    bit_width: int
    source_bytes: tuple[int, ...]
    source_chars: str
    source_hex: str | None
    engineering_value: int | float | str | None
    unit: str | None
    raw_valid: bool
    engineering_valid: bool
    confidence: Confidence
    verification: Confidence
    engineering_confidence: Confidence | None
    issues: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class DecodedPayload:
    profile_id: str
    payload: bytes
    expected_bytes: int
    length_valid: bool
    fields: Mapping[str, DecodedField]
    valid: bool
    confidence: Confidence
    issues: tuple[str, ...]

    def field(self, name: str) -> DecodedField:
        try:
            return self.fields[name]
        except KeyError as exc:
            raise KeyError(f"decoded field not found: {name}") from exc

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible representation."""

        return {
            "profile_id": self.profile_id,
            "payload_hex": self.payload.hex().upper(),
            "expected_bytes": self.expected_bytes,
            "length_valid": self.length_valid,
            "valid": self.valid,
            "confidence": self.confidence.value,
            "issues": list(self.issues),
            "fields": {
                name: {
                    **asdict(field),
                    "confidence": field.confidence.value,
                    "verification": field.verification.value,
                    "engineering_confidence": (
                        field.engineering_confidence.value
                        if field.engineering_confidence is not None
                        else None
                    ),
                    "issues": list(field.issues),
                }
                for name, field in self.fields.items()
            },
        }


def decode_payload(
    payload: bytes | bytearray | Sequence[int],
    profile: DecoderProfile | str | None = None,
    *,
    byte_validity: Sequence[bool] | None = None,
    engineering_overrides: Mapping[str, EngineeringTransform] | None = None,
) -> DecodedPayload:
    """Decode all profile fields, retaining invalid and unavailable results."""

    raw = bytes(payload)
    selected = profile if isinstance(profile, DecoderProfile) else load_profile(profile)
    if byte_validity is not None and len(byte_validity) != len(raw):
        raise ValueError("byte_validity length must match payload length")
    length_valid = len(raw) == selected.response_bytes
    payload_issues = []
    if not length_valid:
        payload_issues.append(
            f"expected {selected.response_bytes} bytes; received {len(raw)}"
        )
    decoded: dict[str, DecodedField] = {}
    for name, field in selected.fields.items():
        transform = (
            engineering_overrides.get(name, field.engineering)
            if engineering_overrides is not None
            else field.engineering
        )
        decoded[name] = _decode_field(raw, field, byte_validity, transform)
    fields_valid = all(field.raw_valid for field in decoded.values())
    return DecodedPayload(
        profile_id=selected.profile_id,
        payload=raw,
        expected_bytes=selected.response_bytes,
        length_valid=length_valid,
        fields=MappingProxyType(decoded),
        valid=length_valid and fields_valid,
        confidence=selected.mapping_confidence,
        issues=tuple(payload_issues),
    )


def decode_hex_payload(
    payload_hex: str,
    profile: DecoderProfile | str | None = None,
    **kwargs: object,
) -> DecodedPayload:
    """Decode a hexadecimal payload after strict whitespace normalization."""

    compact = "".join(payload_hex.split())
    if len(compact) % 2:
        raise ValueError("hex payload must contain complete bytes")
    try:
        payload = bytes.fromhex(compact)
    except ValueError as exc:
        raise ValueError("payload contains non-hexadecimal characters") from exc
    return decode_payload(payload, profile, **kwargs)


def decode_frame(
    frame: FrameCandidate,
    profile: DecoderProfile | str | None = None,
    *,
    engineering_overrides: Mapping[str, EngineeringTransform] | None = None,
) -> DecodedPayload:
    """Decode the candidate frame payload without treating its score as proof."""

    return decode_payload(
        frame.payload,
        profile,
        engineering_overrides=engineering_overrides,
    )


def _decode_field(
    payload: bytes,
    field: FieldProfile,
    byte_validity: Sequence[bool] | None,
    transform: EngineeringTransform | None,
) -> DecodedField:
    issues: list[str] = []
    raw_value: int | None = None
    structurally_valid = len(payload) >= field.required_payload_bytes
    if not structurally_valid:
        issues.append(
            f"requires {field.required_payload_bytes} bytes; received {len(payload)}"
        )
    selected_bytes_valid = True
    if structurally_valid and byte_validity is not None:
        invalid_offsets = sorted(
            {
                selector.byte
                for selector in field.selectors
                if not byte_validity[selector.byte]
            }
        )
        if invalid_offsets:
            selected_bytes_valid = False
            issues.append(
                "invalid source byte(s): "
                + ", ".join(str(offset) for offset in invalid_offsets)
            )
    raw_valid = structurally_valid and selected_bytes_valid
    if structurally_valid:
        raw_value = field.extract_raw(payload)
    engineering_value: int | float | str | None = None
    unit: str | None = None
    engineering_valid = False
    if transform is None:
        issues.append("engineering transform is not established")
    elif raw_value is not None:
        engineering_value = transform.apply(raw_value)
        unit = transform.unit
        engineering_valid = raw_valid and engineering_value is not None
        if engineering_value is None:
            issues.append("raw value is not present in engineering lookup")
    width = field.bit_width
    digits = (width + 3) // 4
    source_bytes = tuple(sorted({selector.byte for selector in field.selectors}))
    source_hex = (
        bytes(payload[offset] for offset in source_bytes).hex().upper()
        if structurally_valid
        else None
    )
    return DecodedField(
        name=field.name,
        raw_value=raw_value,
        raw_hex=f"{raw_value:0{digits}X}" if raw_value is not None else None,
        bit_width=width,
        source_bytes=source_bytes,
        source_chars=field.source_chars,
        source_hex=source_hex,
        engineering_value=engineering_value,
        unit=unit,
        raw_valid=raw_valid,
        engineering_valid=engineering_valid,
        confidence=field.confidence,
        verification=field.verification,
        engineering_confidence=(
            transform.confidence if transform is not None else None
        ),
        issues=tuple(issues),
    )
