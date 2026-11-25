#!/usr/bin/env python3
"""Validate relative Markdown/HTML image links in the public-facing guides.

External URLs and in-page anchor targets are intentionally not probed: this
tool is offline and must not fetch private content, contact the internet,
or imply that hardware/build validation was performed.
"""

from __future__ import annotations

import html
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_GUIDES = (
    "README.md",
    "app/README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "docs/README.md",
    "docs/ENGINEERING_BRIEF.md",
    "docs/ARCHITECTURE.md",
    "docs/HARDWARE_GUIDE.md",
    "docs/CODE_WALKTHROUGH.md",
    "docs/DEVELOPER_SETUP.md",
    "docs/PUBLICATION_CHECKLIST.md",
    "docs/LINKEDIN_SHOWCASE.md",
    "hardware/README.md",
    "hardware/pcb-r0/README.md",
    "hardware/pcb-r1/README.md",
)

MARKDOWN_LINK = re.compile(r"!?\[[^\]\n]*\]\(([^)\n]+)\)")
HTML_MEDIA = re.compile(r"<(?:img|source)\b[^>]*?\bsrc=[\"']([^\"']+)[\"']", re.I)


def local_target(raw: str) -> str | None:
    """Return relative file target, None for remote/inline links."""
    raw = html.unescape(raw).strip()
    if raw.startswith("<") and ">" in raw:
        raw = raw[1 : raw.find(">")]
    else:
        # Markdown may use a link title after a URL, e.g. (file.md "label").
        raw = raw.split(" \"", 1)[0].split(" '", 1)[0]
    if not raw or raw.startswith("#"):
        return None
    split = urlsplit(raw)
    if split.scheme or split.netloc or raw.startswith("//"):
        return None
    return unquote(split.path) or None


def validate(paths: tuple[str, ...]) -> list[str]:
    errors: list[str] = []
    for relative in paths:
        source = (ROOT / relative).resolve()
        if not source.is_file() or not source.is_relative_to(ROOT):
            errors.append(f"{relative}: missing or outside repository")
            continue
        content = source.read_text(encoding="utf-8")
        for pattern in (MARKDOWN_LINK, HTML_MEDIA):
            for match in pattern.finditer(content):
                target = local_target(match.group(1))
                if target is None:
                    continue
                destination = (source.parent / target).resolve()
                if not destination.is_relative_to(ROOT) or not destination.exists():
                    line = content.count("\n", 0, match.start()) + 1
                    errors.append(f"{relative}:{line}: missing link target {target}")
    return errors


if __name__ == "__main__":
    selected = tuple(sys.argv[1:]) or PUBLIC_GUIDES
    broken = validate(selected)
    for error in broken:
        print(error, file=sys.stderr)
    if broken:
        print(f"FAIL: {len(broken)} missing local link(s)", file=sys.stderr)
        raise SystemExit(1)
    print(f"PASS: local links in {len(selected)} public-facing guides")
