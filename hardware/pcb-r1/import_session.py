#!/usr/bin/env python3
"""Import Freerouting SPECCTRA session to the local KiCad PCB.

The KiCad 7 SWIG binding's global ImportSpecctraSES function does not bind to
a BOARD instance when used outside the GUI. This script maps the documented
SES path/via records and explicitly validates every named net.
"""
from __future__ import annotations
import pathlib
import re
import sys
sys.path.insert(0,str(pathlib.Path(__file__).parent/".tools/py"))
from sexpdata import loads
import pcbnew as pcb

ROOT=pathlib.Path(__file__).resolve().parent
SES=ROOT/"board.ses"
PCB=ROOT/"board.kicad_pcb"
def tag(x):return str(x[0]) if isinstance(x,list) and x else ""
def mm(x):return pcb.FromMM(float(x)/10000.0)
def pt(x,y):return pcb.VECTOR2I(mm(x),mm(-y))
lay={"F.Cu":pcb.F_Cu,"In1.Cu":pcb.In1_Cu,"In2.Cu":pcb.In2_Cu,"B.Cu":pcb.B_Cu}

source=loads(SES.read_text())
routes=next(x for x in source if tag(x)=="routes")
networks=next(x for x in routes if tag(x)=="network_out")
board=pcb.LoadBoard(str(PCB))
existing={str(k):v for k,v in board.GetNetInfo().NetsByName().items()}
assert len(board.GetTracks())==0,"Refuse to merge on top of previous routes."
segs=vias=0
for network in networks[1:]:
    if tag(network)!="net":continue
    netname=str(network[1])
    assert netname in existing, f"Router introduced unknown net {netname}"
    net=existing[netname]
    for obj in network[2:]:
        if tag(obj)=="wire":
            path=next(x for x in obj if tag(x)=="path")
            layer=str(path[1]);width=path[2]
            assert layer in lay,(netname,layer)
            coords=path[3:]
            assert len(coords)>=2 and len(coords)%2==0,(netname,coords)
            # Freerouting can legitimately emit a single-point zero-length
            # wire at an existing SMD/pad position. No copper segment is needed.
            if len(coords)==2:
                continue
            pts=[pt(coords[i],coords[i+1]) for i in range(0,len(coords),2)]
            for a,b in zip(pts,pts[1:]):
                if a==b:continue
                track=pcb.PCB_TRACK(board)
                track.SetStart(a);track.SetEnd(b)
                track.SetWidth(mm(width));track.SetLayer(lay[layer])
                track.SetNet(net);board.Add(track);segs+=1
        elif tag(obj)=="via":
            mark=str(obj[1]);m=re.search(r"_([0-9]+):([0-9]+)_um",mark)
            assert m,mark
            via=pcb.PCB_VIA(board)
            via.SetPosition(pt(obj[2],obj[3]))
            via.SetViaType(pcb.VIATYPE_THROUGH)
            via.SetLayerPair(pcb.F_Cu,pcb.B_Cu)
            via.SetWidth(pcb.FromMM(float(m.group(1))/1000))
            via.SetDrill(pcb.FromMM(float(m.group(2))/1000))
            via.SetNet(net);board.Add(via);vias+=1
        else:raise ValueError(f"Unexpected SES route object {tag(obj)} on {netname}")

pcb.SaveBoard(str(PCB),board)
print(f"Imported {segs} copper segments, {vias} plated vias, {len(networks)-1} routed nets.")
print("KiCad geometric checks must still pass. No real-world automotive qualification performed.")
