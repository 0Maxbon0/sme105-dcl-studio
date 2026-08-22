# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_submodules

ROOT = Path(SPECPATH).parent
SRC = ROOT / "src"
SKIP_PARTS = {".pio", "__pycache__", ".git"}


def collect_tree(source: Path, destination: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for path in source.rglob("*"):
        if not path.is_file() or SKIP_PARTS.intersection(path.parts):
            continue
        relative = path.relative_to(source)
        entries.append((str(path), str(Path(destination) / relative.parent)))
    return entries


datas = [
    (str(SRC / "ford_dcl" / "web" / "static"), "ford_dcl/web/static"),
    *collect_tree(ROOT / "docs", "docs"),
    *collect_tree(ROOT / "profiles", "profiles"),
    *collect_tree(ROOT / "firmware", "firmware"),
    *collect_tree(ROOT / "examples", "examples"),
]

analysis = Analysis(
    [str(ROOT / "packaging" / "launcher.py")],
    pathex=[str(SRC)],
    binaries=[],
    datas=datas,
    hiddenimports=collect_submodules("uvicorn"),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter"],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(analysis.pure)

exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="SME105-DCL-Studio",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
)

bundle = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="SME105-DCL-Studio",
)
