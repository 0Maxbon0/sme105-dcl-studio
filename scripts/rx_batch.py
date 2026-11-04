"""Lossless firmware RXB byte/timestamp batches; standard-library only."""
import re

_BATCH = re.compile(rb"RXB t_us=(\d{1,10}) data=([0-9A-F]{2,32}) dt=(\d+(?:,\d+)*)")


def parse_rx_batch(line: bytes) -> list[tuple[int, int]]:
    match = _BATCH.fullmatch(line)
    if not match:
        raise ValueError("malformed RXB record")
    base, data = int(match[1]), match[2]
    offsets = [int(value) for value in match[3].split(b",")]
    if (base > 0xFFFFFFFF or len(data) % 2 or len(offsets) != len(data) // 2
            or offsets[0] != 0 or any(value > 0xFFFFFFFF for value in offsets)
            or any(a > b for a, b in zip(offsets, offsets[1:]))):
        raise ValueError("invalid RXB byte/timestamp alignment")
    return [((base + dt) & 0xFFFFFFFF, int(data[2*i:2*i+2], 16))
            for i, dt in enumerate(offsets)]
