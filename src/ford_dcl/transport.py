"""Fixed MCU-to-host binary record transport.

Every record is SLIP framed. After SLIP unescaping, a record is exactly 15
bytes and uses little-endian multibyte fields::

    offset  size  field
       0      1   version (currently 1)
       1      1   type (1=data, 2=UART status)
       2      1   direction (0=unknown, 1=MCU_TO_BUS, 2=BUS_TO_MCU)
       3      1   status
       4      8   timestamp_us, little-endian
      12      1   value
      13      2   CRC-16/CCITT-FALSE, little-endian

The CRC covers bytes 0 through 12. A leading and trailing SLIP END byte is
emitted. Corrupt or oversized records are discarded nonfatally at the next END.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum

PROTOCOL_VERSION = 1
UNESCAPED_RECORD_SIZE = 15
CRC_INPUT_SIZE = 13
RECORD_SIZE = UNESCAPED_RECORD_SIZE

RECORD_TYPE_DATA = 1
RECORD_TYPE_UART_STATUS = 2
DIRECTION_UNKNOWN = 0
DIRECTION_MCU_TO_BUS = 1
DIRECTION_BUS_TO_MCU = 2

SLIP_END = 0xC0
SLIP_ESC = 0xDB
SLIP_ESC_END = 0xDC
SLIP_ESC_ESC = 0xDD

_BODY = struct.Struct("<BBBBQB")
_CRC = struct.Struct("<H")


class RecordType(IntEnum):
    """MCU record type constants."""

    DATA = RECORD_TYPE_DATA
    UART_STATUS = RECORD_TYPE_UART_STATUS


class Direction(IntEnum):
    """Observed DCL byte direction."""

    UNKNOWN = DIRECTION_UNKNOWN
    MCU_TO_BUS = DIRECTION_MCU_TO_BUS
    BUS_TO_MCU = DIRECTION_BUS_TO_MCU


@dataclass(frozen=True, slots=True)
class TransportRecord:
    """One CRC-validated fixed MCU record."""

    record_type: int
    timestamp_us: int
    value: int
    status: int = 0
    direction: int = Direction.UNKNOWN
    version: int = PROTOCOL_VERSION

    def __post_init__(self) -> None:
        ranges = {
            "version": (self.version, 0xFF),
            "record_type": (self.record_type, 0xFF),
            "direction": (self.direction, 0xFF),
            "status": (self.status, 0xFF),
            "timestamp_us": (self.timestamp_us, 0xFFFFFFFFFFFFFFFF),
            "value": (self.value, 0xFF),
        }
        for name, (value, maximum) in ranges.items():
            if not isinstance(value, int) or isinstance(value, bool):
                raise TypeError(f"{name} must be an integer")
            if not 0 <= value <= maximum:
                raise ValueError(f"{name} is outside 0..{maximum}")


@dataclass(frozen=True, slots=True)
class TransportDecodeError:
    """Nonfatal transport stream error."""

    code: str
    detail: str
    frame_hex: str = ""


@dataclass(frozen=True, slots=True)
class DecodeBatch:
    """Records and errors emitted by one decoder operation."""

    records: tuple[TransportRecord, ...] = ()
    errors: tuple[TransportDecodeError, ...] = ()


class RecordDecodeError(ValueError):
    """Structured error raised for one complete invalid record."""

    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def crc16_ccitt(data: bytes, initial: int = 0xFFFF) -> int:
    """Return CRC-16/CCITT-FALSE for *data*."""

    crc = initial & 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = (
                ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
            )
    return crc


def record_bytes(record: TransportRecord) -> bytes:
    """Return the exact 15-byte unescaped representation."""

    body = _BODY.pack(
        record.version,
        int(record.record_type),
        int(record.direction),
        record.status,
        record.timestamp_us,
        record.value,
    )
    return body + _CRC.pack(crc16_ccitt(body))


def encode_record(record: TransportRecord) -> bytes:
    """Encode one fixed record with CRC and standard SLIP escaping."""

    framed = bytearray([SLIP_END])
    for byte in record_bytes(record):
        if byte == SLIP_END:
            framed.extend((SLIP_ESC, SLIP_ESC_END))
        elif byte == SLIP_ESC:
            framed.extend((SLIP_ESC, SLIP_ESC_ESC))
        else:
            framed.append(byte)
    framed.append(SLIP_END)
    return bytes(framed)


def decode_record_frame(frame: bytes) -> TransportRecord:
    """Decode one unescaped 15-byte record.

    ``RecordDecodeError.code`` distinguishes size, CRC, and version failures.
    Unknown type, direction, and status values remain available to callers.
    """

    if len(frame) != UNESCAPED_RECORD_SIZE:
        raise RecordDecodeError(
            "length_error",
            f"record is {len(frame)} bytes; expected {UNESCAPED_RECORD_SIZE}",
        )
    body = frame[:CRC_INPUT_SIZE]
    received_crc = _CRC.unpack(frame[CRC_INPUT_SIZE:])[0]
    calculated_crc = crc16_ccitt(body)
    if received_crc != calculated_crc:
        raise RecordDecodeError(
            "crc_mismatch",
            f"received 0x{received_crc:04X}; calculated 0x{calculated_crc:04X}",
        )
    version, record_type, direction, status, timestamp_us, value = _BODY.unpack(body)
    if version != PROTOCOL_VERSION:
        raise RecordDecodeError(
            "version_error",
            f"unsupported version {version}; expected {PROTOCOL_VERSION}",
        )
    return TransportRecord(
        version=version,
        record_type=record_type,
        direction=direction,
        status=status,
        timestamp_us=timestamp_us,
        value=value,
    )


class TransportStreamDecoder:
    """Incrementally recover fixed records from arbitrary USB chunks."""

    def __init__(self) -> None:
        self._frame = bytearray()
        self._escaped = False
        self._discarding = False
        self._synchronized = False

    def feed(self, data: bytes) -> DecodeBatch:
        """Consume bytes and return complete records plus nonfatal errors."""

        records: list[TransportRecord] = []
        errors: list[TransportDecodeError] = []
        for byte in data:
            if byte == SLIP_END:
                if not self._synchronized:
                    self._reset()
                    self._synchronized = True
                    continue
                if self._discarding:
                    self._reset()
                    continue
                if self._escaped:
                    errors.append(
                        TransportDecodeError(
                            "invalid_escape",
                            "END encountered immediately after ESC",
                            bytes(self._frame).hex().upper(),
                        )
                    )
                    self._reset()
                    continue
                if self._frame:
                    frame = bytes(self._frame)
                    try:
                        records.append(decode_record_frame(frame))
                    except RecordDecodeError as exc:
                        errors.append(
                            TransportDecodeError(
                                exc.code,
                                exc.detail,
                                frame.hex().upper(),
                            )
                        )
                self._reset()
                continue

            if not self._synchronized:
                continue
            if self._discarding:
                continue
            if self._escaped:
                if byte == SLIP_ESC_END:
                    self._frame.append(SLIP_END)
                elif byte == SLIP_ESC_ESC:
                    self._frame.append(SLIP_ESC)
                else:
                    errors.append(
                        TransportDecodeError(
                            "invalid_escape",
                            f"invalid escaped byte 0x{byte:02X}",
                            bytes(self._frame).hex().upper(),
                        )
                    )
                    self._frame.clear()
                    self._discarding = True
                self._escaped = False
                continue
            if byte == SLIP_ESC:
                self._escaped = True
                continue
            self._frame.append(byte)
            if len(self._frame) > UNESCAPED_RECORD_SIZE:
                errors.append(
                    TransportDecodeError(
                        "length_overflow",
                        f"record exceeded {UNESCAPED_RECORD_SIZE} unescaped bytes",
                        bytes(self._frame).hex().upper(),
                    )
                )
                self._frame.clear()
                self._discarding = True
        return DecodeBatch(tuple(records), tuple(errors))

    def finish(self) -> DecodeBatch:
        """Report a truncated record at end-of-stream and reset."""

        errors: list[TransportDecodeError] = []
        if self._discarding:
            errors.append(
                TransportDecodeError(
                    "truncated_discard",
                    "stream ended while discarding an invalid record",
                )
            )
        elif self._escaped or self._frame:
            errors.append(
                TransportDecodeError(
                    "truncated_record",
                    "stream ended before SLIP END",
                    bytes(self._frame).hex().upper(),
                )
            )
        self._reset()
        return DecodeBatch(errors=tuple(errors))

    def _reset(self) -> None:
        self._frame.clear()
        self._escaped = False
        self._discarding = False
