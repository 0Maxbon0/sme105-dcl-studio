#!/usr/bin/env python3
"""Generate review BOM from KiCad's own schematic export, no invented part IDs."""
import csv
import pathlib
import sys
sys.path.insert(0,str(pathlib.Path(__file__).parent/".tools/py"))
from sexpdata import loads
BASE=pathlib.Path(__file__).resolve().parent
def tag(x):return str(x[0]) if isinstance(x,list) and x else ""
def child(x,key):return next((a for a in x if tag(a)==key),None)
data=loads((BASE/"board-final.net").read_text())
records=[]
for c in child(data,"components")[1:]:
    if tag(c)!="comp":continue
    ref=str(child(c,"ref")[1])
    if ref.startswith("PF"):continue
    value=str(child(c,"value")[1])
    footprint=str(child(c,"footprint")[1])
    fields=child(c,"fields")
    mpn=""
    if fields:
        for f in fields[1:]:
            if tag(f)=="field" and str(child(f,"name")[1])=="MPN":
                mpn=str(f[2])
    dnp=(child(c,"property") and False) or "DNP" in value or any(
        tag(p)=="property" and (len(p)>=2 and tag(p[1])=="dnp")
        for p in c
    )
    records.append({"Ref":ref,"Qty":1,"Value":value,"Footprint":footprint,
                    "MPN":mpn,"Assembly":"DO NOT POPULATE" if dnp else "PROVISIONAL / VERIFY",
                    "Status":"EXACT MPN RECORDED; VERIFY AVAILABILITY" if mpn else "ENGINEERING CHOICE - ORDERABLE PART NOT SELECTED"})
with (BASE/"BOM_REVIEW_ONLY.csv").open("w",newline="") as h:
    w=csv.DictWriter(h,fieldnames=list(records[0]))
    w.writeheader();w.writerows(sorted(records,key=lambda r:r["Ref"]))
print(f"BOM: {len(records)} rows, {sum(r['Assembly']=='DO NOT POPULATE' for r in records)} DNP, {sum(bool(r['MPN']) for r in records)} explicit MPNs")
