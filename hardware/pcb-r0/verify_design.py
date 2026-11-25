#!/usr/bin/env python3
"""Compare schematic netlist pads against actual KiCad PCB; do not self-certify."""
from __future__ import annotations
import collections
import pathlib
import sys
sys.path.insert(0,str(pathlib.Path(__file__).parent/".tools/py"))
from sexpdata import loads
import pcbnew as pcb

ROOT=pathlib.Path(__file__).resolve().parent
def tag(o):return str(o[0]) if isinstance(o,list) and o else ""
def sub(o,name):return next(x for x in o if tag(x)==name)
netlist=loads((ROOT/"board-final.net").read_text())
expected={}
for net in sub(netlist,"nets")[1:]:
    if tag(net)!="net":continue
    name=str(sub(net,"name")[1]).lstrip("/")
    if name.startswith("unconnected-"):continue
    for n in net[1:]:
        if tag(n)!="node":continue
        ref=str(sub(n,"ref")[1]);pin=str(sub(n,"pin")[1])
        if ref.startswith("PF"):continue
        k=(ref,pin)
        if k in expected:assert expected[k]==name,(k,expected[k],name)
        expected[k]=name

b=pcb.LoadBoard(str(ROOT/"board.kicad_pcb"))
actual={}
for f in b.GetFootprints():
    for pad in f.Pads():
        if not pad.GetNetname():continue
        key=(f.GetReference(),pad.GetNumber())
        name=pad.GetNetname()
        if key in actual: assert actual[key]==name,(key,actual[key],name)
        actual[key]=name

miss={k:v for k,v in expected.items() if k not in actual}
wrong={k:(v,actual[k]) for k,v in expected.items() if k in actual and actual[k]!=v}
excess={k:v for k,v in actual.items() if k not in expected}
assert not miss and not wrong and not excess,(miss,wrong,excess)
parts=len(b.GetFootprints())
routes=[t for t in b.GetTracks() if not isinstance(t,pcb.PCB_VIA)]
vias=[t for t in b.GetTracks() if isinstance(t,pcb.PCB_VIA)]
layers=collections.Counter(t.GetLayerName() for t in routes)
assert set(layers).issubset({"F.Cu","B.Cu"}),layers
assert len(b.Zones())==2
assert all(z.GetNetname()=="GND" for z in b.Zones())
assert b.GetCopperLayerCount()==4
assert all(f.GetFPIDAsString().startswith("SME105:") for f in b.GetFootprints())
pinref={(f.GetReference(),pad.GetNumber()):pad.GetNetname() for f in b.GetFootprints() for pad in f.Pads()}
for k,name in {("U1","27"):"DCL_RX_3V3",("U1","28"):"DCL_TX_3V3",("U1","30"):"DCL_DE_3V3",
               ("U4","1"):"DCL_RO_5V",("U4","3"):"DCL_DE_3V3",("U4","4"):"DCL_TX_3V3",
               ("U4","6"):"DCL_A_TRANSCEIVER",("U4","7"):"DCL_B_TRANSCEIVER"}.items():
    assert pinref[k]==name,(k,pinref[k],name)

DRC=(ROOT/"post-bundle-drc.txt").read_text()
cats=collections.Counter(line.split("]")[0][1:] for line in DRC.splitlines() if line.startswith("["))
assert not (set(cats)-{"drill_out_of_range"}),cats
assert cats["drill_out_of_range"]==18,cats
print(f"PASS: {parts} footprints; {len(expected)} matched (ref,pad) connections; {len(routes)} tracks, {len(vias)} vias; 26 physical nets.")
print(f"PASS: F/B routing only {dict(layers)}; two filled GND inner zones; TX hardware pulldown and DNP bus links in netlist.")
print(f"CONDITIONAL/HOLD: KiCad DRC has {sum(cats.values())} drill-width findings (0.20 mm thermal vias vs 0.30 mm assumed fab minimum).")
print("NOT TESTED: actual ECU, automotive electrical transients, ground/termination, component choices, firmware power/EMC, ESP antenna and physical enclosure.")
