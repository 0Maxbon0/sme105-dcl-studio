#!/usr/bin/env python3
"""Rasterize the EscortScope SVG master for web and Android using librsvg + Pillow.
Requires system Python GI/Rsvg, cairo and Pillow; no external artwork.
"""
from pathlib import Path
import io
import gi
gi.require_version("Rsvg", "2.0")
from gi.repository import Rsvg
import cairo
from PIL import Image, ImageDraw
ROOT = Path(__file__).resolve().parents[1]
ANDROID = ROOT.parent / "android/app/src/main/res"
BG = "#203B50"
SVG = Rsvg.Handle.new_from_file(str(ROOT / "icons/icon.svg"))
def render(size):
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    cr = cairo.Context(surface)
    viewport = Rsvg.Rectangle()
    viewport.x = viewport.y = 0
    viewport.width = viewport.height = size
    SVG.render_document(cr, viewport)
    data = io.BytesIO()
    surface.write_to_png(data)
    data.seek(0)
    return Image.open(data).convert("RGBA")
def square(size):
    im=Image.new("RGBA",(size,size),BG)
    im.alpha_composite(render(size))
    return im
for size in (192,512):
    square(size).save(ROOT/f"icons/icon-{size}.png")
for density,size in {"mdpi":48,"hdpi":72,"xhdpi":96,"xxhdpi":144,"xxxhdpi":192}.items():
    folder=ANDROID/f"mipmap-{density}"
    square(size).save(folder/"ic_launcher.png")
    im=square(size);mask=Image.new("L",(size,size));ImageDraw.Draw(mask).ellipse((0,0,size-1,size-1),fill=255);im.putalpha(mask);im.save(folder/"ic_launcher_round.png")
    n=round(size*2.25);im=Image.new("RGBA",(n,n));m=round(n*.61);im.alpha_composite(render(m),((n-m)//2,(n-m)//2));im.save(folder/"ic_launcher_foreground.png")
# Existing splash assets: preserve exact dimensions, replace old product art.
for path in ANDROID.glob("drawable*/splash.png"):
    with Image.open(path) as old: w,h=old.size
    im=Image.new("RGBA",(w,h),BG);m=round(min(w,h)*.22);im.alpha_composite(render(m),((w-m)//2,(h-m)//2));im.save(path)
