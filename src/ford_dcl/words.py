"""12-bit Ford DCL word hypotheses.

The observed wire representation is two bytes containing three data nibbles and
one parity nibble.  The data-nibble order is not yet proven, so every decoded
word retains both plausible alignments.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from enum import Enum

DATA_MASK = 0x0FFF
PARITY_MASK = 0x0F
VERTICAL_PARITY_SEED = 0x0A


class ByteAlignment(str, Enum):
    """Candidate ordering of the three data nibbles."""

    FIRST_BYTE_HIGH = "first_byte_high"
    SECOND_LOW_HIGH = "second_low_high"


@dataclass(frozen=True, slots=True)
class WordCandidate:
    """One interpretation of a two-byte wire word."""

    alignment: ByteAlignment
    data: int
    observed_parity: int
    expected_parity: int
    valid: bool

    @property
    def combined(self) -> int:
        """Canonical parity-high, data-low representation."""

        return (self.observed_parity << 12) | self.data


@dataclass(frozen=True, slots=True)
class DecodedWord:
    """A wire pair and all currently plausible interpretations."""

    first_byte: int
    second_byte: int
    candidates: tuple[WordCandidate, WordCandidate]

    @property
    def observed_parity(self) -> int:
        return self.second_byte >> 4

    @property
    def valid(self) -> bool:
        """True when at least one candidate passes parity.

        Vertical nibble parity is invariant under nibble permutation, so the
        candidates normally share validity.  ``any`` keeps that fact explicit
        instead of baking it into the API.
        """

        return any(candidate.valid for candidate in self.candidates)

    def candidate(self, alignment: ByteAlignment | str) -> WordCandidate:
        selected = ByteAlignment(alignment)
        for candidate in self.candidates:
            if candidate.alignment is selected:
                return candidate
        raise KeyError(selected)


@dataclass(frozen=True, slots=True)
class WordStream:
    """Pair decoding result that preserves unpaired bytes."""

    offset: int
    words: tuple[DecodedWord, ...]
    leading_bytes: bytes
    trailing_bytes: bytes

    @property
    def valid_count(self) -> int:
        return sum(word.valid for word in self.words)

    @property
    def invalid_count(self) -> int:
        return len(self.words) - self.valid_count


@dataclass(frozen=True, slots=True)
class ObservedVector:
    first_byte: int
    second_byte: int
    expected_data: int
    expected_parity: int


OBSERVED_VECTORS: tuple[ObservedVector, ...] = (
    ObservedVector(0xFF, 0x5F, 0xFFF, 0x5),
    ObservedVector(0x00, 0xA0, 0x000, 0xA),
    ObservedVector(0x00, 0xB1, 0x001, 0xB),
    ObservedVector(0x18, 0x21, 0x118, 0x2),
)


def vertical_nibble_parity(data: int) -> int:
    """Return the parity nibble supported by all supplied observations.

    The hypothesis is a vertical XOR over the three data nibbles with the
    alternating-bit seed ``0xA``.
    """

    _require_data(data)
    return (
        VERTICAL_PARITY_SEED
        ^ ((data >> 8) & PARITY_MASK)
        ^ ((data >> 4) & PARITY_MASK)
        ^ (data & PARITY_MASK)
    )


def combine_data(
    first_byte: int,
    second_byte: int,
    alignment: ByteAlignment | str,
) -> int:
    """Combine a wire pair according to one explicit alignment."""

    first = _require_byte(first_byte, "first_byte")
    second = _require_byte(second_byte, "second_byte")
    selected = ByteAlignment(alignment)
    low_nibble = second & PARITY_MASK
    if selected is ByteAlignment.FIRST_BYTE_HIGH:
        return (first << 4) | low_nibble
    return (low_nibble << 8) | first


def decode_word(first_byte: int, second_byte: int) -> DecodedWord:
    """Decode a pair without choosing or discarding an alignment."""

    first = _require_byte(first_byte, "first_byte")
    second = _require_byte(second_byte, "second_byte")
    observed = second >> 4
    candidates = []
    for alignment in ByteAlignment:
        data = combine_data(first, second, alignment)
        expected = vertical_nibble_parity(data)
        candidates.append(
            WordCandidate(
                alignment=alignment,
                data=data,
                observed_parity=observed,
                expected_parity=expected,
                valid=observed == expected,
            )
        )
    return DecodedWord(first, second, (candidates[0], candidates[1]))


def encode_word(
    data: int,
    alignment: ByteAlignment | str = ByteAlignment.FIRST_BYTE_HIGH,
) -> bytes:
    """Encode a 12-bit word under an explicitly selected alignment."""

    value = _require_data(data)
    selected = ByteAlignment(alignment)
    parity = vertical_nibble_parity(value)
    if selected is ByteAlignment.FIRST_BYTE_HIGH:
        return bytes((value >> 4, (parity << 4) | (value & PARITY_MASK)))
    return bytes((value & 0xFF, (parity << 4) | (value >> 8)))


def decode_pairs(
    data: bytes | bytearray | Iterable[int],
    offset: int = 0,
) -> WordStream:
    """Decode adjacent pairs while preserving leading and trailing bytes."""

    raw = bytes(data)
    if offset not in (0, 1):
        raise ValueError("offset must be 0 or 1")
    leading = raw[:offset]
    paired_end = offset + ((len(raw) - offset) // 2) * 2
    words = tuple(
        decode_word(raw[index], raw[index + 1])
        for index in range(offset, paired_end, 2)
    )
    return WordStream(
        offset=offset,
        words=words,
        leading_bytes=leading,
        trailing_bytes=raw[paired_end:],
    )


def iter_candidate_data(
    stream: WordStream,
    alignment: ByteAlignment | str,
) -> Iterator[int]:
    """Yield candidate values, including values from invalid words."""

    selected = ByteAlignment(alignment)
    for word in stream.words:
        yield word.candidate(selected).data


def observed_vector_evidence() -> dict[str, bool]:
    """Report which observations support parity and each data alignment."""

    parity_supported = True
    first_alignment_supported = False
    second_alignment_supported = False
    for vector in OBSERVED_VECTORS:
        word = decode_word(vector.first_byte, vector.second_byte)
        parity_supported &= (
            vector.expected_parity == vertical_nibble_parity(vector.expected_data)
            and word.observed_parity == vector.expected_parity
        )
        first_alignment_supported |= (
            word.candidate(ByteAlignment.FIRST_BYTE_HIGH).data == vector.expected_data
        )
        second_alignment_supported |= (
            word.candidate(ByteAlignment.SECOND_LOW_HIGH).data == vector.expected_data
        )
    return {
        "vertical_nibble_parity": parity_supported,
        "first_byte_high": first_alignment_supported,
        "second_low_high": second_alignment_supported,
        "single_alignment_proven": False,
    }


def _require_byte(value: int, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"{name} must be an integer")
    if not 0 <= value <= 0xFF:
        raise ValueError(f"{name} must be between 0x00 and 0xFF")
    return value


def _require_data(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("data must be an integer")
    if not 0 <= value <= DATA_MASK:
        raise ValueError("data must be a 12-bit value")
    return value
