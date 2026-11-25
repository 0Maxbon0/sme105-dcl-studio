#!/usr/bin/env python3
"""Add solid GND inner planes after front/back-only routing; refill and inspect."""
import pathlib
import pcbnew as p
ROOT=pathlib.Path(__file__).resolve().parent
board=p.LoadBoard(str(ROOT/"board.kicad_pcb"))
assert board.GetCopperLayerCount()==4
assert not list(board.Zones()),"Zones already exist; refusing duplicate planes"
net=next(net for net in board.GetNetInfo().NetsByName().values() if net.GetNetname()=="GND")
def mm(x):return p.FromMM(x)
for layer in [p.In1_Cu,p.In2_Cu]:
 z=p.ZONE(board)
 z.SetLayer(layer)
 z.SetNet(net)
 z.SetLocalClearance(mm(.25))
 z.SetThermalReliefGap(mm(.25))
 z.SetThermalReliefSpokeWidth(mm(.3))
 shape=z.Outline()
 shape.NewOutline()
 for x,y in [(100.6,100.6),(214.4,100.6),(214.4,174.4),(100.6,174.4)]:
  shape.Append(mm(x),mm(y))
 board.Add(z)
 print("Inner ground zone:",board.GetLayerName(layer))
fill=p.ZONE_FILLER(board).Fill(board.Zones())
print("FILL",fill)
p.SaveBoard(str(ROOT/"board.kicad_pcb"),board)
print("Saved four-layer board with two dedicated GND planes")
