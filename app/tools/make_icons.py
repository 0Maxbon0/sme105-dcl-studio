#!/usr/bin/env python3
"""Write app/icons PNG icons using only the Python standard library."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "icons"


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def png(width: int, height: int, pixels: bytes) -> bytes:
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        raw.extend(pixels[y * stride:(y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def draw(size: int) -> bytes:
    bg = (14, 17, 22, 255)
    card = (28, 36, 48, 255)
    amber = (245, 185, 66, 255)
    green = (61, 214, 140, 255)
    ink = (14, 17, 22, 255)
    buf = bytearray(bg * size * size)
    def put(x: int, y: int, color: tuple[int, int, int, int]) -> None:
        if 0 <= x < size and 0 <= y < size:
            i = (y * size + x) * 4
            buf[i:i + 4] = bytes(color)

    margin = size // 8
    radius = size // 7
    for y in range(margin, size - margin):
        for x in range(margin, size - margin):
            dx = min(x - margin, size - margin - 1 - x)
            dy = min(y - margin, size - margin - 1 - y)
            if dx < radius and dy < radius:
                if (radius - dx) ** 2 + (radius - dy) ** 2 > radius ** 2:
                    continue
            put(x, y, card)
    # Diagnostic plug body and amber face.
    body_top = int(size * 0.30)
    body_bot = int(size * 0.72)
    body_left = int(size * 0.28)
    body_right = int(size * 0.72)
    for y in range(body_top, body_bot):
        for x in range(body_left, body_right):
            put(x, y, amber)
    hole_r = max(2, size // 28)
    for cx, cy in ((int(size * 0.40), int(size * 0.46)), (int(size * 0.60), int(size * 0.46)),
                   (int(size * 0.40), int(size * 0.60)), (int(size * 0.60), int(size * 0.60))):
        for y in range(cy - hole_r, cy + hole_r + 1):
            for x in range(cx - hole_r, cx + hole_r + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= hole_r ** 2:
                    put(x, y, ink)
    # Status lamp.
    lamp = max(3, size // 18)
    lcx, lcy = int(size * 0.72), int(size * 0.30)
    for y in range(lcy - lamp, lcy + lamp + 1):
        for x in range(lcx - lamp, lcx + lamp + 1):
            if (x - lcx) ** 2 + (y - lcy) ** 2 <= lamp ** 2:
                put(x, y, green)
    return bytes(buf)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (192, 512):
        path = OUT / f"icon-{size}.png"
        path.write_bytes(png(size, size, draw(size)))
        print(path, path.stat().st_size)


if __name__ == "__main__":
    main()
