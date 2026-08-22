"""Ford EEC-IV DCL host capture and transport primitives."""

from .capture import CaptureConfig, ParsedToken, TextTokenParser
from .transport import (
    DIRECTION_BUS_TO_MCU,
    DIRECTION_MCU_TO_BUS,
    DIRECTION_UNKNOWN,
    RECORD_SIZE,
    RECORD_TYPE_DATA,
    RECORD_TYPE_UART_STATUS,
    DecodeBatch,
    Direction,
    RecordType,
    TransportDecodeError,
    TransportRecord,
    TransportStreamDecoder,
    decode_record_frame,
    encode_record,
    record_bytes,
)

__all__ = [
    "DIRECTION_BUS_TO_MCU",
    "DIRECTION_MCU_TO_BUS",
    "DIRECTION_UNKNOWN",
    "RECORD_SIZE",
    "RECORD_TYPE_DATA",
    "RECORD_TYPE_UART_STATUS",
    "CaptureConfig",
    "DecodeBatch",
    "Direction",
    "ParsedToken",
    "RecordType",
    "TextTokenParser",
    "TransportDecodeError",
    "TransportRecord",
    "TransportStreamDecoder",
    "decode_record_frame",
    "encode_record",
    "record_bytes",
]

__version__ = "0.1.0"
