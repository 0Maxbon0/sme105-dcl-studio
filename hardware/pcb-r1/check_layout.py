#!/usr/bin/env python3
"""Static manufacturability sanity checks: footprints inside board, no courtyard overlap.

These checks do NOT substitute for soldering, thermal, RF, EMI or automotive review.
"""
import pathlib
import pcbnew as pcb
BASE=pathlib.Path(__file__).resolve().parent
b=pcb.LoadBoard(str(BASE/"board.kicad_pcb"))
rect=b.GetBoardEdgesBoundingBox()
x0=pcb.ToMM(rect.GetX())
y0=pcb.ToMM(rect.GetY())
x1=x0+pcb.ToMM(rect.GetWidth())
y1=y0+pcb.ToMM(rect.GetHeight())
assert abs((x1-x0)-95)<.2 and abs((y1-y0)-60)<.2,(x0,y0,x1,y1)
coords=[]
for fp in b.GetFootprints():
    bounds=fp.GetCourtyard(pcb.F_CrtYd).BBox()
    xx=pcb.ToMM(bounds.GetX());yy=pcb.ToMM(bounds.GetY())
    ex=xx+pcb.ToMM(bounds.GetWidth());ey=yy+pcb.ToMM(bounds.GetHeight())
    coords.append((fp.GetReference(),(xx,yy,ex,ey)))
    assert (xx>=x0+.95 and yy>=y0+.95 and
            ex<=x1-.95 and ey<=y1-.95),(fp.GetReference(),(xx,yy,ex,ey))
for i,(r,a) in enumerate(coords):
    for rr,b in coords[i+1:]:
        if (min(a[2],b[2])-max(a[0],b[0])>.02
            and min(a[3],b[3])-max(a[1],b[1])>.02):
            raise AssertionError(f"Overlapping courtyards: {r} and {rr}")
print(f"PASS: {len(coords)} footprints wholly inside 95x60mm engineering outline; no overlapping courtyards.")
