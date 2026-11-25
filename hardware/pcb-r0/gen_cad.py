#!/usr/bin/env python3
"""Generate an inspectable SME105 preliminary KiCad schematic and board.

Reference netlist from firmware/sme105_usb_bridge and vendor symbols. This is
NOT an automotive-qualified, fabrication-authorized hardware design.

Run via ./build-local.sh. The design data below is the single source for both
schematic and PCB pad nets.
"""
from __future__ import annotations
import json
import pathlib
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parent
LIBROOT = ROOT / ".tools/root/usr/share/kicad"
sys.path.insert(0, str(ROOT / ".tools/py"))
from sexpdata import loads, dumps, Symbol

def sym(x): return str(x[0]) if isinstance(x, list) and x else ""
def node(obj, k): return next((v for v in obj[1:] if isinstance(v, list) and sym(v) == k), None)
def nodes(obj,k): return [v for v in obj[1:] if isinstance(v,list) and sym(v)==k]
def ident(): return str(uuid.uuid4())
def q(s): return json.dumps(str(s),ensure_ascii=False)

F_R = "Resistor_SMD:R_0603_1608Metric"
F_C = "Capacitor_SMD:C_0603_1608Metric"
F_L = "Inductor_SMD:L_Taiyo-Yuden_NR-50xx"
F_J = "Connector_PinHeader_2.54mm:PinHeader_1x06_P2.54mm_Vertical"
F_TP = "TestPoint:TestPoint_Pad_D1.5mm"
parts=[]

def add(ref, library, name, val, fp, pins, x, y, mpn="", dnp=False):
    assert not any(p["ref"]==ref for p in parts),ref
    # All schematic pins and net labels must align to KiCad's 50 mil grid.
    # The prior revision used whole-millimetre origins and generated off-grid ERC warnings.
    grid=1.27
    x=round(round(float(x)/grid)*grid,3)
    y=round(round(float(y)/grid)*grid,3)
    parts.append(dict(ref=ref,library=library,name=name,value=val,footprint=fp,pins={str(k):str(v) for k,v in pins.items()},x=x,y=y,mpn=mpn,dnp=dnp))

# The OBD cable remains an externally supplied VERIFIED pigtail.
# No direct plug footprint is invented before its supplier/mechanical choice.
add("J1","Connector_Generic","Conn_01x06","OBD2_PIGTAIL_VERIFY_PINOUT",F_J,
    {1:"VBAT_OBD16",2:"GND",3:"SIGNAL_GND_UNVERIFIED",4:"DCL_PIN3_CANDIDATE",5:"DCL_PIN11_CANDIDATE"},39,60)
add("F1","Device","Fuse","1A_125V_VERIFY", "Fuse:Fuse_2512_6332Metric",
    {1:"VBAT_OBD16",2:"VBAT_FUSED"},88,65)
add("D1","Device","D","MURS160_600V_VERIFY","Diode_SMD:D_SMB",
    {1:"VIN_PROT",2:"VBAT_FUSED"},109,65)
add("D2","Device","D_Zener","SMCJ33A","Diode_SMD:D_SMC",
    {1:"VIN_PROT",2:"GND"},126,95)
for ref,val,fp,a,b,x,y in [
    ("C1","2.2uF_100V","Capacitor_SMD:C_1210_3225Metric","VIN_PROT","GND",134,114),
    ("C2","2.2uF_100V","Capacitor_SMD:C_1210_3225Metric","VIN_PROT","GND",145,114),
    ("C3","100nF_100V","Capacitor_SMD:C_0805_2012Metric","VIN_PROT","GND",156,114),
]:
    add(ref,"Device","C",val,fp,{1:a,2:b},x,y)
# LM5164-Q1 actual DDA pins verified against TI's official datasheet.
add("U2","Regulator_Switching","LM5164DDA","LM5164QDDARQ1",
    "Package_SO:HSOP-8-1EP_3.9x4.9mm_P1.27mm_EP2.41x3.1mm_ThermalVias",
    {1:"GND",2:"VIN_PROT",3:"BUCK5_EN",4:"BUCK5_RON",5:"BUCK5_FB",7:"BUCK5_BST",8:"BUCK5_SW",9:"GND"},188,82,mpn="LM5164QDDARQ1")
add("R1","Device","R","820k",F_R,{1:"VIN_PROT",2:"BUCK5_EN"},167,112)
add("R2","Device","R","150k",F_R,{1:"BUCK5_EN",2:"GND"},178,112)
add("R3","Device","R","42.2k",F_R,{1:"BUCK5_RON",2:"GND"},189,112)
add("C4","Device","C","2.2nF_50V",F_C,{1:"BUCK5_BST",2:"BUCK5_SW"},200,112)
add("L1","Device","L","47uH_1.5A_MIN","Inductor_SMD:L_10.4x10.4_H4.8",
    {1:"BUCK5_SW",2:"+5V"},224,62)
add("C5","Device","C","22uF_16V","Capacitor_SMD:C_1206_3216Metric",{1:"+5V",2:"GND"},213,112)
add("C6","Device","C","22uF_16V","Capacitor_SMD:C_1206_3216Metric",{1:"+5V",2:"GND"},224,112)
add("R4","Device","R","158k",F_R,{1:"+5V",2:"BUCK5_FB"},236,85)
add("R5","Device","R","49.9k",F_R,{1:"BUCK5_FB",2:"GND"},248,85)

# Independent efficient 3.3-V buck (avoids >0.5W LDO heat at RF peaks).
add("U3","Regulator_Switching","TPS62160DGK","TPS62160DGKR",
    "Package_SO:MSOP-8_3x3mm_P0.65mm",
    {1:"GND",2:"+5V",3:"+5V",4:"GND",5:"BUCK3_FB",6:"+3V3",7:"BUCK3_SW"},340,77,mpn="TPS62160DGKR")
add("C7","Device","C","10uF_10V","Capacitor_SMD:C_1206_3216Metric",{1:"+5V",2:"GND"},300,107)
add("L2","Device","L","2.2uH_1.5A_MIN",F_L,{1:"BUCK3_SW",2:"+3V3"},366,67)
add("C8","Device","C","22uF_6.3V","Capacitor_SMD:C_1206_3216Metric",{1:"+3V3",2:"GND"},311,107)
add("C9","Device","C","22uF_6.3V","Capacitor_SMD:C_1206_3216Metric",{1:"+3V3",2:"GND"},322,107)
add("R6","Device","R","316k",F_R,{1:"+3V3",2:"BUCK3_FB"},365,107)
add("R7","Device","R","100k",F_R,{1:"BUCK3_FB",2:"GND"},376,107)

# Built-in RF and BLE. The E schematic pinout matches UE; footprint is UE.
add("U1","RF_Module","ESP32-WROOM-32E","ESP32-WROOM-32UE-N4",
    "RF_Module:ESP32-WROOM-32UE",
    {1:"GND",2:"+3V3",3:"ESP_EN",15:"GND",25:"ESP_BOOT",
     27:"DCL_RX_3V3",28:"DCL_TX_3V3",30:"DCL_DE_3V3",
     34:"UART0_RXD",35:"UART0_TXD",38:"GND",39:"GND"},340,244,
    mpn="ESP32-WROOM-32UE-N4")
add("R8","Device","R","10k",F_R,{1:"+3V3",2:"ESP_EN"},395,175)
add("C10","Device","C","1uF",F_C,{1:"ESP_EN",2:"GND"},406,175)
add("R9","Device","R","10k",F_R,{1:"+3V3",2:"ESP_BOOT"},417,175)
add("SW1","Switch","SW_Push","RESET","Button_Switch_SMD:SW_SPST_B3U-1000P",
    {1:"ESP_EN",2:"GND"},393,198)
add("SW2","Switch","SW_Push","BOOT","Button_Switch_SMD:SW_SPST_B3U-1000P",
    {1:"ESP_BOOT",2:"GND"},412,198)
add("C11","Device","C","100nF",F_C,{1:"+3V3",2:"GND"},428,175)
add("C12","Device","C","10uF_6.3V","Capacitor_SMD:C_1206_3216Metric",
    {1:"+3V3",2:"GND"},439,175)
add("J2","Connector_Generic","Conn_01x06","UART_FLASH_SERVICE",F_J,
    {1:"+3V3",2:"GND",3:"UART0_TXD",4:"UART0_RXD",5:"ESP_EN",6:"ESP_BOOT"},451,237)

# Existing 5 V transceiver preserved. 1%-tolerance divider 10k:20k
# gives RX<=3.54V at MAX487 high 5.25V; bench logic check remains required.
add("U4","Interface_UART","MAX481E","MAX487ESA+T",
    "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    {1:"DCL_RO_5V",2:"GND",3:"DCL_DE_3V3",4:"DCL_TX_3V3",
     5:"GND",6:"DCL_A_TRANSCEIVER",7:"DCL_B_TRANSCEIVER",8:"+5V"},170,230,
    mpn="MAX487ESA+T")
add("C13","Device","C","100nF",F_C,{1:"+5V",2:"GND"},204,244)
add("R10","Device","R","12k_1pct",F_R,{1:"DCL_RO_5V",2:"DCL_RX_3V3"},216,244)
add("R11","Device","R","20k_1pct",F_R,{1:"DCL_RX_3V3",2:"GND"},227,244)
add("R12","Device","R","10k",F_R,{1:"DCL_DE_3V3",2:"GND"},238,244)
add("R13","Device","R","0R_DNP","Resistor_SMD:R_0805_2012Metric",
    {1:"DCL_A_TRANSCEIVER",2:"DCL_PIN3_CANDIDATE"},251,244,dnp=True)
add("R14","Device","R","0R_DNP","Resistor_SMD:R_0805_2012Metric",
    {1:"DCL_B_TRANSCEIVER",2:"DCL_PIN11_CANDIDATE"},264,244,dnp=True)
add("R15","Device","R","0R_DNP","Resistor_SMD:R_0805_2012Metric",
    {1:"SIGNAL_GND_UNVERIFIED",2:"GND"},275,244,dnp=True)

# 1-pin PWR_FLAG symbols only for nets with upstream passive connections.
for idx,(net,x,y) in enumerate([("GND",64,132),("VIN_PROT",95,118),("+5V",268,132),("+3V3",398,132)],1):
    add("PF"+str(idx),"power","PWR_FLAG","PWR_FLAG","",{1:net},x,y)

LIBFILE={
  "Connector_Generic":"Connector_Generic.kicad_sym",
  "Device":"Device.kicad_sym",
  "Regulator_Switching":"Regulator_Switching.kicad_sym",
  "RF_Module":"RF_Module.kicad_sym",
  "Interface_UART":"Interface_UART.kicad_sym",
  "Switch":"Switch.kicad_sym",
  "power":"power.kicad_sym",
}
loaded={}
for lib,path in LIBFILE.items():
    src=loads((LIBROOT/"symbols"/path).read_text())
    loaded[lib]={str(ch[1]):ch for ch in src[1:] if isinstance(ch,list) and sym(ch)=="symbol"}

def library_symbol(p):
    base=loaded[p["library"]][p["name"]]
    # No extends symbols here: for the UE module we use the E symbol's identical
    # physical pin mapping while assigning the actual UE footprint and MPN.
    ls=loads(dumps(base))
    ls[1]=p["library"]+":"+p["name"]
    return ls

def pins_for(p):
    src=loaded[p["library"]][p["name"]]
    answer={}
    for unit in nodes(src,"symbol"):
        for pin in nodes(unit,"pin"):
            n=node(pin,"number")
            at=node(pin,"at")
            if n is not None and at is not None:
                answer[str(n[1])]=[float(at[1]),float(at[2])]
    return answer

SHEET="(sheet_instances (path \"/\" (page \"1\")))"
SYMBOLS={p["library"]+":"+p["name"]:library_symbol(p) for p in parts}
def effects(size=1.0,hidden=False):
    # KiCad 7's effects grammar uses bare 'hide', not KiCad 9's (hide yes).
    return f'(effects (font (size {size} {size}) (thickness 0.15))'+(" hide" if hidden else "")+")"

contents=[
 '(kicad_sch (version 20230121) (generator "eeschema")',
 f'  (uuid {q(ident())}) (paper "A2")',
 '  (title_block (title "SME105 ESP32 OBD Engineering Interface") (date "2026-11-22") (rev "R0")',
 '    (comment 1 "ENGINEERING PROTOTYPE - NOT VEHICLE QUALIFIED")',
 '    (comment 2 "OBD pigtail, DCL polarity, transient protection pending validation"))',
 '  (lib_symbols '+ " ".join(dumps(s) for s in SYMBOLS.values()) +')',
]
for p in parts:
    pn=pins_for(p)
    if not p["ref"].startswith("PF"):
        for num in p["pins"]:
            if num not in pn:
                raise ValueError(f"Unexpected symbol pin: {p['ref']} {num} known {list(pn)}")
    x,y=p["x"],p["y"]
    r=p["ref"]
    fp_value=p["footprint"]
    if "--schematic-only" in sys.argv and fp_value:
        # Only change the INSTANCE footprint, not the official library-symbol
        # default: changing lib_symbols causes spurious "symbol modified" ERC.
        fp_lib,fp_name=fp_value.split(":",1)
        fp_value=f"SME105:{fp_lib}__{fp_name}"
    prop= [
        f'(property "Reference" {q(r)} (at {x+3} {y-14} 0) {effects(1.1)})',
        f'(property "Value" {q(p["value"])} (at {x+3} {y-10} 0) {effects(1)})',
        f'(property "Footprint" {q(fp_value)} (at {x} {y+14} 0) {effects(hidden=True)})',
        f'(property "Datasheet" "" (at {x} {y+18} 0) {effects(hidden=True)})'
    ]
    if p["mpn"]:
        prop.append(f'(property "MPN" {q(p["mpn"])} (at {x} {y+22} 0) {effects(hidden=True)})')
    contents.append('  (symbol '
     +f'(lib_id {q(p["library"]+":"+p["name"])}) (at {x} {y} 0) (unit 1) '
     +f'(in_bom {"no" if r.startswith("PF") else "yes"}) (on_board {"no" if r.startswith("PF") else "yes"}) '
     +f'(dnp {"yes" if p["dnp"] else "no"}) (uuid {q(ident())}) '
     +" ".join(prop)
     + "".join(f' (pin {q(num)} (uuid {q(ident())}))' for num in pn)
     + f' (instances (project "board" (path "/" (reference {q(r)}) (unit 1))))'
     +')')
    for num,coords in pn.items():
        px=round(x+coords[0],3)
        py=round(y-coords[1],3)
        if num in p["pins"]:
            net=p["pins"][num]
            contents.append(f'  (label {q(net)} (at {px} {py} 0) {effects(0.9)} (uuid {q(ident())}))')
        elif r=="U1" and num in {"17","18","19","20","21","22","32"}:
            # These WROOM pads have pin type no_connect in the library already.
            # Adding explicit NC flags is redundant and triggers seven ERC warnings.
            continue
        else:
            contents.append(f'  (no_connect (at {px} {py}) (uuid {q(ident())}))')
contents.append('  '+SHEET)
contents.append(')')
(ROOT/"board.kicad_sch").write_text("\n".join(contents)+"\n")
if "--schematic-only" in sys.argv:
    print(f"Rebuilt snap-to-grid schematic with {len(parts)} symbols; routed PCB untouched.")
    sys.exit(0)

# net assignments for pcbnew. The schematic and board derive from 'parts'.
import pcbnew as pcb
board=pcb.BOARD()
board.SetCopperLayerCount(4)
nettable={}
for p in parts:
    for net in p["pins"].values():
        if net not in nettable:
            z=pcb.NETINFO_ITEM(board,net)
            board.Add(z)
            nettable[net]=z

def mm(n):return pcb.FromMM(float(n))
def p2(x,y):return pcb.VECTOR2I(mm(x),mm(y))

placement={
 "J1":(104,137,0),"F1":(115,120,0),"D1":(125,120,0),"D2":(127,129,90),
 "U2":(145,113,0),"L1":(156,107,0),"U3":(172,120,0),"L2":(180,120,0),
 "U1":(200,138,0),"U4":(145,154,0),"J2":(180,157,0),
 "C1":(134,109,0),"C2":(134,115,0),"C3":(138,107,0),
 "R1":(139,126,0),"R2":(146,126,0),"R3":(153,126,0),"C4":(151.5,116,90),
 "C5":(165,105,0),"C6":(168,112,0),"R4":(161,125,0),"R5":(167,129,0),
 "C7":(164,120,0),"C8":(185.5,125,0),"C9":(185.5,131,0),
 "R6":(174,129,0),"R7":(181,133,0),
 "R8":(190,153,0),"C10":(196,154,0),"R9":(190,159,0),
 "SW1":(191,168,0),"SW2":(203,168,0),
 "C11":(184,143,0),"C12":(184,148,0),
 "C13":(152,153,0),"R10":(135,155,0),"R11":(135,162,0),
 "R12":(139,165,0),"R13":(123,146,0),"R14":(128,146,0),"R15":(133,146,0)
}

FPROOT=LIBROOT/"footprints"
for p in parts:
    if p["ref"].startswith("PF"):continue
    if ":" not in p["footprint"]: raise ValueError("No FP for "+p["ref"])
    fplib,fpname=p["footprint"].split(":",1)
    fp=pcb.FootprintLoad(str(FPROOT/(fplib+".pretty")),fpname)
    if fp is None:raise RuntimeError("Missing footprint "+p["footprint"])
    fp.SetReference(p["ref"]);fp.SetValue(p["value"]);fp.SetPosition(p2(*placement[p["ref"]][:2]))
    fp.SetOrientationDegrees(placement[p["ref"]][2]);board.Add(fp)
    # Assign by iterating every pad, including duplicate numbered exposed-pad
    # thermal vias on the ESP32 and regulator. A dict would silently drop them.
    fp.SetFPIDAsString(p["footprint"])
    pinmap=p["pins"];pads={pad.GetNumber():pad for pad in fp.Pads()}
    for n in pinmap:
        if n not in pads: raise RuntimeError(f"Footprint {p['ref']} {p['footprint']} missing pad {n}")
    for pad in fp.Pads():
        number=pad.GetNumber()
        if number in pinmap:pad.SetNet(nettable[pinmap[number]])
    if p["dnp"]:
        # DNP is always explicit in production BOM, not physically fitted.
        fp.SetAttributes(fp.GetAttributes() | pcb.FP_EXCLUDE_FROM_BOM)

def edge(x1,y1,x2,y2):
    sh=pcb.PCB_SHAPE(board)
    sh.SetShape(pcb.SHAPE_T_SEGMENT);sh.SetStart(p2(x1,y1));sh.SetEnd(p2(x2,y2))
    sh.SetLayer(pcb.Edge_Cuts);sh.SetWidth(mm(.10));board.Add(sh)
edge(100,100,215,100);edge(215,100,215,175);edge(215,175,100,175);edge(100,175,100,100)
for s,x,y in [("SME105 DCL R0 - NOT VEHICLE QUALIFIED",148,170)]:
    t=pcb.PCB_TEXT(board);t.SetText(s);t.SetPosition(p2(x,y));t.SetTextSize(p2(.85,.85))
    t.SetTextThickness(mm(.15));t.SetLayer(pcb.F_SilkS);board.Add(t)
pcb.SaveBoard(str(ROOT/"board.kicad_pcb"),board)
print(f"Generated {len(parts)} schematic symbols, {len(parts)-4} physical footprints, {len(nettable)} nets.")
print("NON-QUALIFIED REVISION: UNROUTED. Do NOT manufacture or connect to vehicle.")
