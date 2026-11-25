#!/usr/bin/env python3
"""Make KiCad PCB project self-contained without the locally extracted libraries.

Run once on a finished board. Do not subsequently re-run gen_cad.py, which
creates an initial unrouted engineering board rather than preserving routing.
"""
from __future__ import annotations
import pathlib
import re
import pcbnew as pcb
ROOT=pathlib.Path(__file__).resolve().parent
LIB=ROOT/".tools/root/usr/share/kicad/footprints"
OUT=ROOT/"parts.pretty"
OUT.mkdir(exist_ok=True)
board=pcb.LoadBoard(str(ROOT/"board.kicad_pcb"))
sch=(ROOT/"board.kicad_sch").read_text()
mapped={}
for fp in board.GetFootprints():
    old=fp.GetFPIDAsString()
    if ":" not in old:
        raise ValueError(f"Missing legacy library ID for {fp.GetReference()}: {old}")
    lib,name=old.split(":",1)
    if lib=="SME105": continue
    new_name=lib+"__"+name
    path=LIB/(lib+".pretty")/(name+".kicad_mod")
    assert path.is_file(),str(path)
    dest=OUT/(new_name+".kicad_mod")
    content=path.read_text()
    content,n=re.subn(r'^\(footprint\s+"?'+re.escape(name)+r'"?',
                       '(footprint "'+new_name+'"',content,count=1)
    assert n==1,("footprint source format",path)
    dest.write_text(content)
    fp.SetFPIDAsString("SME105:"+new_name)
    mapped[old]="SME105:"+new_name
for original,new in mapped.items():
    old='(property "Footprint" "'+original+'"'
    count=sch.count(old)
    assert count>=1,(original,"not found in schematic properties")
    sch=sch.replace(old,'(property "Footprint" "'+new+'"')
(ROOT/"board.kicad_sch").write_text(sch)
(ROOT/"fp-lib-table").write_text(
    '(fp_lib_table\n'
    ' (lib (name "SME105")(type "KiCad")(uri "${KIPRJMOD}/parts.pretty")(options "")(descr "SME105 self-contained engineering footprint set"))\n'
    ')\n'
)
pcb.SaveBoard(str(ROOT/"board.kicad_pcb"),board)
print(f"Bundled {len(mapped)} unique original footprint libraries and {len(list(OUT.glob('*.kicad_mod')))} footprints")
