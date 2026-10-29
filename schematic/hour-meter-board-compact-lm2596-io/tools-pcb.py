#!/usr/bin/env python3
"""Build hour-meter-board-compact-lm2596-io.kicad_pcb: the LM2596 compact board grown to 80 x 92 mm (2 copper
layers) for a general-purpose I/O port, J902: AIN1 (0-30 V, ADS1115), DOUT1 (0.5 A low-side switch) and +5 V out.
The isolated vehicle inputs stay as they are, renamed DIN1 and DIN2.

  python3 tools-pcb.py check            -> placement checks only (writes nothing but a scratch board in routing/)
  python3 tools-pcb.py place            -> placed, unrouted board
  python3 tools-pcb.py reuse            -> copy the LM2596 board's routing onto the placed board + GND pours
  python3 tools-pcb.py route [tries]    -> Freerouting (best of N tries, default 4) + GND pours
  python3 tools-pcb.py finish [passes]  -> close what Freerouting left open (exit 1 if anything still is)
  python3 tools-pcb.py production       -> production/: Gerber zip, BOM and CPL for JLCPCB
  python3 tools-pcb.py models           -> download the JLCPCB 3D models into 3d/ and set them on the board

A variant of ../hour-meter-board-compact-lm2596 (see README.md). The build, route and finish scripts
are the main board's, called with this board's LAYOUT. Compared with the 100 x 90 mm boards:
  * the ESP32 antenna overhangs the top edge (Espressif's preferred placement), so the board needs
    no copper-free band beside it;
  * the CR2032 holder (BT401) sits on the bottom side, under the RTC / RS485 area;
  * the LM2596 buck stage fills a 10 mm strip added along the bottom edge (no PSU-B socket or standoff);
  * milled slots separate the isolated vehicle inputs (top-left corner) from the rest;
  * a 12 mm strip along the bottom edge holds J902 (centre), the AIN1 front end and ADS1115 (left of it)
    and the DOUT1 driver (right of it).
"""
import importlib.util
import json
import math
import os
import subprocess
import sys
import urllib.request

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, "..", "hour-meter-board")
SCH = os.path.join(HERE, "hour-meter-board-compact-lm2596-io.kicad_sch")
PCB = os.path.join(HERE, "hour-meter-board-compact-lm2596-io.kicad_pcb")
LM2596_PCB = os.path.join(HERE, "..", "hour-meter-board-compact-lm2596", "hour-meter-board-compact-lm2596.kicad_pcb")
IMU = ("U601", "U602")

_spec = importlib.util.spec_from_file_location("finish", os.path.join(MAIN, "tools-finish-routing.py"))
finish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(finish)
route, build = finish.route, finish.build

X0, Y0, W, H = 100.0, 100.0, 80.0, 92.0
PSU_AREA = None                              # no plug-on PSU-B: the LM2596 stage is on the board
SUPPLY_AREA = (108.0, 158.0, 157.0, 180.0)   # the buck stage (keep it compact: hot loop, magnetometer distance)
AIN_PARTS = ("R901", "R902", "R903", "C902", "D901", "U901")   # AIN1 divider, filter, clamp and ADC: away from LM_SW
AIN_MIN_DISTANCE = 8.0                       # mm from any LM_SW pad (the LM2596 switch node)
ORDER_MARK_AT = (140.0, 160.0)               # JLCPCB order number, bottom silkscreen
BARRIER_X = 131.0                            # isolation barrier: through the optocoupler centres
VEHICLE_AREA = (100.0, 100.0, BARRIER_X + 2.5, 126.0)   # no pours within 2.5 mm of the barrier
SLOT = 1.5                                   # slot width, mm

# ESP32 module: origin at (166, 106.32) puts its antenna section (6.5 mm) past the top edge; PLACEMENT
# takes the courtyard centre, which sits 7.23 mm above the origin for this footprint
U201_ORIGIN = (166.0, 106.32)

# J902 (JST VH 5-pin, courtyard centre 7.92 mm right of and 0.55 mm below pin 1): pins along the bottom edge
J902_AT = (141.5, 186.6)
J902_PINS = ("5V", "AIN1", "GND", "DOUT1", "GND")

PLACEMENT = {
    # --- mounting: three corners plus the right edge (the module's antenna overhangs the top-right) ---
    "H102": (104.0, 104.0, 0, "F"), "H104": (104.0, 188.0, 0, "F"), "H105": (176.4, 188.4, 0, "F"),
    "H103": (176.0, 148.4, 0, "F"),
    # --- field wiring, left edge (wires enter from the left) ---
    "J301": (105.95, 116.5, 270, "F"),   # DIN1 / DIN2 / COM = VEH_GND (isolated)
    "J701": (105.95, 135.0, 270, "F"),   # RS485 A / B / GND
    "J101": (105.95, 151.0, 270, "F"),   # VIN 9-36 V
    # VIN and GND solder pads on the back, above and below J101, for wiring without the JST plug
    "TP101": (103.45, 144.36, 0, "B"), "TP102": (103.45, 157.61, 0, "B"),
    # --- vehicle inputs (isolated corner): two chains of 3 x 1k, M7, zener, LED bleeder ---
    "R301": (114.5, 101.8, 0, "F"), "R302": (119.5, 101.8, 0, "F"),
    "R303": (114.5, 104.8, 0, "F"), "R304": (120.0, 104.8, 0, "F"),
    "D301": (115.7, 108.2, 0, "F"), "D302": (121.6, 108.2, 0, "F"),
    "R306": (114.5, 113.3, 0, "F"), "R307": (119.5, 113.3, 0, "F"),
    "R308": (114.5, 116.3, 0, "F"), "R309": (120.0, 116.3, 0, "F"),
    "D303": (115.7, 119.8, 0, "F"), "D304": (121.6, 119.8, 0, "F"),
    "U301": (BARRIER_X, 105.6, 0, "F"), "U302": (BARRIER_X, 117.2, 0, "F"),
    # opto outputs (logic side)
    "R305": (138.6, 103.0, 90, "F"), "C301": (138.6, 107.0, 90, "F"),
    "R310": (138.6, 111.6, 90, "F"), "C302": (138.6, 115.6, 90, "F"),
    # --- IMU: top middle, away from PSU-B, the terminals and the USB shell ---
    "U601": (147.0, 107.6, 0, "F"), "U602": (147.0, 114.6, 0, "F"),
    "C603": (147.2, 111.5, 0, "F"),                                     # REGOUT, next to pin 10
    "C606": (143.6, 115.8, 0, "F"),                                     # LIS3MDL C1, next to pin 4
    "C601": (142.8, 106.2, 90, "F"), "C604": (142.8, 110.0, 90, "F"),
    "C602": (151.2, 106.2, 90, "F"), "C605": (151.2, 110.0, 90, "F"),
    "R211": (151.6, 113.4, 0, "F"), "R212": (151.6, 115.2, 0, "F"),    # I2C pull-ups
    # --- ESP32 module, antenna past the top edge ---
    "U201": (U201_ORIGIN[0], U201_ORIGIN[1] - 7.23, 0, "F"),
    "R201": (154.2, 101.8, 0, "F"), "C203": (154.2, 103.6, 0, "F"),    # EN RC, at pin 3
    "R102": (154.4, 107.8, 90, "F"), "C101": (154.4, 111.2, 90, "F"),  # VIN_SENSE foot + filter at GPIO34
    # --- EEPROM socket below the IMU ---
    "U501": (147.5, 123.6, 0, "F"), "C501": (153.9, 119.8, 90, "F"),
    "J501": (139.6, 124.6, 0, "F"), "R501": (139.6, 129.6, 0, "F"),
    # --- 3V3 regulator, USB, CH340C, auto-program (right) ---
    "U204": (158.6, 125.0, 0, "F"),
    "D203": (165.6, 121.0, 0, "F"), "R210": (168.6, 121.0, 0, "F"),   # STATUS LED, at GPIO2 (pin 24)
    "D202": (165.6, 122.8, 0, "F"), "R209": (168.6, 122.8, 0, "F"),   # PWR LED, at the 3V3 regulator
    "C205": (156.9, 130.4, 0, "F"), "C201": (161.2, 130.4, 0, "F"), "C206": (161.2, 132.6, 0, "F"),
    "C202": (156.9, 132.4, 0, "F"), "C207": (156.9, 134.2, 0, "F"),
    "J201": (175.0, 125.6, 90, "F"),
    "U203": (167.3, 126.1, 90, "F"), "R207": (167.3, 129.9, 0, "F"), "R208": (167.3, 131.7, 0, "F"),
    "F201": (167.0, 134.0, 0, "F"), "D201": (167.0, 136.6, 0, "F"), "C208": (167.0, 139.0, 0, "F"),
    "SW201": (176.0, 135.0, 0, "F"), "SW202": (176.0, 141.2, 0, "F"),
    "U202": (158.2, 140.5, 90, "F"),
    "C204": (153.9, 146.2, 0, "F"), "R213": (156.9, 146.2, 0, "F"),
    "R203": (159.9, 146.2, 0, "F"), "R204": (162.9, 146.2, 0, "F"),
    "Q201": (167.2, 141.6, 0, "F"), "Q202": (167.2, 145.4, 0, "F"),
    "R205": (170.6, 141.6, 90, "F"), "R206": (170.6, 145.4, 90, "F"), "R202": (170.6, 148.9, 90, "F"),
    # --- RS485: jumpers left of the coin cell, the rest above it ---
    "J702": (113.9, 130.0, 0, "F"), "J703": (119.0, 130.0, 0, "F"),
    "D701": (115.9, 135.6, 0, "F"), "D702": (115.9, 139.4, 0, "F"),
    "U701": (126.5, 131.5, 0, "F"), "C701": (126.5, 127.6, 0, "F"),
    "R701": (132.5, 129.6, 0, "F"), "R702": (132.5, 131.4, 0, "F"), "R703": (132.5, 133.2, 0, "F"),
    "R704": (121.6, 136.6, 0, "F"), "R705": (127.6, 136.4, 0, "F"), "R706": (131.2, 136.4, 0, "F"),
    # --- coin cell under the RTC / RS485 area (bottom side), RTC above it ---
    "BT401": (135.15, 139.9, 0, "B"),
    "U401": (141.0, 147.0, 0, "F"), "C401": (135.6, 147.0, 90, "F"), "C402": (146.5, 144.2, 90, "F"),
    "R401": (146.5, 148.0, 90, "F"),
    # --- power input: PTC, reverse block, TVS ---
    "F101": (115.5, 146.5, 0, "F"),
    "D101": (125.6, 156.0, 90, "F"), "D102": (123.0, 146.0, 0, "F"), "R101": (128.0, 146.0, 0, "F"),
    "D103": (116.5, 155.5, 0, "F"), "D104": (116.5, 160.0, 0, "F"),
    # --- LM2596 buck stage, bottom strip: Cin -> U101 (pins face Cin) -> catch diode -> L101 -> Cout ---
    "C102": (115.0, 171.0, 180, "F"), "C103": (125.0, 164.2, 0, "F"),
    "U101": (130.4, 171.0, 0, "F"),
    "D105": (140.7, 168.5, 90, "F"),
    "L101": (149.4, 172.6, 0, "F"),
    "C104": (148.5, 162.0, 0, "F"), "C105": (142.6, 163.0, 90, "F"),
    "R103": (124.0, 178.4, 0, "F"), "R104": (127.5, 178.4, 0, "F"),   # FB divider, under the U101 pins
    "R105": (117.5, 163.6, 0, "F"), "D106": (120.5, 163.6, 0, "F"),   # power LED
    # --- ports: connectors bottom right, their passives under PSU-B ---
    "J801": (165.0, 169.65, 0, "F"), "J803": (176.4, 156.5, 90, "F"),
    "J802": (154.6, 154.0, 0, "F"), "J804": (160.4, 154.4, 0, "F"),
    "U801": (167.0, 152.0, 0, "F"), "C801": (170.6, 152.0, 90, "F"), "R802": (167.0, 154.6, 0, "F"),
    "U802": (167.0, 158.0, 0, "F"), "C802": (170.6, 158.0, 90, "F"),
    "F801": (139.0, 153.6, 0, "F"), "R801": (139.0, 156.0, 0, "F"),
    "F802": (139.0, 158.4, 0, "F"), "F803": (139.0, 160.8, 0, "F"), "JP801": (134.0, 160.8, 0, "F"),
    "R803": (133.6, 153.6, 0, "F"), "R804": (133.6, 155.4, 0, "F"), "R805": (133.6, 157.2, 0, "F"),
    "R806": (144.4, 154.0, 0, "F"), "R807": (144.4, 155.8, 0, "F"),
    # --- I/O port, bottom strip: J902 in the middle (pin 1 left), AIN1 to its left, DOUT1 to its right ---
    "J902": J902_AT + (0, "F"),
    "F902": (129.4, 183.0, 90, "F"), "C901": (129.4, 188.4, 90, "F"),        # +5V_OUT fuse; AIN1 ESD cap
    "R904": (126.6, 188.0, 90, "F"),                                          # 4-20 mA shunt (not fitted)
    "R901": (123.6, 188.0, 90, "F"), "R902": (120.6, 188.0, 90, "F"),        # 2 x 49.9k divider top
    "R903": (117.6, 189.4, 90, "F"), "C902": (115.6, 189.4, 90, "F"),        # divider foot + filter, at the ADC
    "D901": (117.0, 184.4, 0, "F"),                                           # BAT54S clamp
    "U901": (111.8, 184.6, 0, "F"), "C903": (111.8, 188.6, 0, "F"),          # ADS1115 + VDD decoupling
    "U902": (158.4, 179.2, 0, "F"), "C904": (161.8, 179.2, 90, "F"),         # 5 V buffer for the HITFET input
    "R905": (165.0, 179.2, 90, "F"),                                          # DOUT1 off during reset and boot
    "U903": (157.6, 186.2, 0, "F"),                                           # BSP75N, drain (pin 2) faces J902
}

SLOTS = (
    ((BARRIER_X, 103.4), (BARRIER_X, 109.0), SLOT),   # under U301
    ((BARRIER_X, 113.8), (BARRIER_X, 121.8), SLOT),   # under U302 and below it
    ((103.8, 125.75), (127.0, 125.75), SLOT),         # between the vehicle inputs and RS485
)

# Board material left between the slots (for strength): no copper may cross the barrier there, so the
# vehicle corner is closed to every other net and only the optocouplers bridge it
BRIDGES = (
    (BARRIER_X - 2.5, 100.0, BARRIER_X + 2.5, 103.4),   # top edge to the U301 slot
    (BARRIER_X - 2.5, 109.0, BARRIER_X + 2.5, 113.8),   # between the two opto slots
    (125.5, 121.8, BARRIER_X + 2.5, 126.9),             # the corner
    (100.0, 124.2, 104.6, 127.2),                       # left edge to the bottom slot
)

LABELS = [
    ("HOUR METER rev B", 142.0, 135.4, 1.0, True),
    ("VEHICLE - ISOLATED", 119.0, 123.3, 0.8, True),
] + [(name, J902_AT[0] - 7.92 + 3.96 * i, J902_AT[1] - 5.7, 0.8, False) for i, name in enumerate(J902_PINS)]   # pin names

LAYOUT = build.Layout((X0, Y0, W, H), PSU_AREA, VEHICLE_AREA, None, frozenset({"U201", "J201"}),
                      PLACEMENT, LABELS, SLOTS)
build.LAYOUT = LAYOUT


def place(pcb=PCB):
    """The main board's build with this layout on 2 layers, plus the IMU keep-outs."""
    board = build.build(SCH, pcb, layers=2)
    imu_keepouts(board)
    for i, rect in enumerate(BRIDGES):
        route.add_rule_area(board, rect, f"BARRIER_{i + 1}", tracks=True)
    edge_keepouts(board)
    tidy_silkscreen(board)
    set_models(board)
    # TP102 joins the GND pour solid: its 0.2 mm thermal spokes are under the pour's 0.25 mm minimum and would be dropped
    board.FindFootprintByReference("TP102").Pads()[0].SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)
    build.add_order_mark(board, "B", ORDER_MARK_AT)
    title = board.GetTitleBlock()
    title.SetTitle("Hour Meter main board, compact + LM2596 + I/O (80 x 92 mm, 2 layers)")
    board.SetTitleBlock(title)
    return board


# 3D models from JLCPCB's part library (EasyEDA), for parts whose KiCad 10 model is missing or generic:
# LCSC -> (offset x, y, z in mm, z rotation in degrees), lined up on the KiCad footprint's pads. The STEP files
# are downloaded into 3d/ (git-ignored) by `models`; source: JLCEDA/EasyEDA official library, https://easyeda.com
JLC_MODELS = {
    "C165948": ((0.0, -0.879, 0.0), 180),     # J201 USB-C, HRO TYPE-C-31-M-12
    "C318884": ((0.0, 0.0, 0.05), 0),         # SW201, SW202 TS-1187A
    "C2979167": ((10.588, 0.0, 0.6), 180),    # BT401 CR2032 holder
    "C19078719": ((0.0, 0.0, 0.0), 0),        # F101 1812 PTC
    "C9400": ((0.0, 0.0, 0.0), 0),            # L101 SMDRI127-330MT
    "C160315": ((0.0, -4.025, 2.95), 0),      # J101 JST B2P-VH
    "C160316": ((3.959, -1.1, 0.2), 0),       # J301, J701 JST B3P-VH
    "C160317": ((0.0, 0.0, 0.0), 0),          # J801 JST B4P-VH
    "C160318": ((7.919, -6.299, 3.8), 0),     # J902 JST B5P-VH, shown with the CJT A3963WV-5P model (below)
}
# EasyEDA has no STEP file for these parts: use the model of a part with the same body and pads (LCSC -> LCSC)
MODEL_STANDINS = {"C160318": "C239412"}
# KiCad 10 renamed or lacks these library models
LIB_MODELS = {"U601": "Package_DFN_QFN.3dshapes/QFN-24_3x3mm_P0.4mm.step",
              "U501": "Package_DIP.3dshapes/DIP-8_W7.62mm.step"}   # soldered in, no socket
MODEL_DIR = os.path.join(HERE, "3d")


def fetch_models():
    """Download each JLC_MODELS STEP file that is not in 3d/ yet (EasyEDA part data -> model uuid -> STEP)."""
    os.makedirs(MODEL_DIR, exist_ok=True)
    for lcsc in JLC_MODELS:
        path = os.path.join(MODEL_DIR, f"{lcsc}.step")
        if os.path.exists(path):
            continue
        req = lambda url: urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "tools-pcb.py"}), timeout=60).read()
        source = MODEL_STANDINS.get(lcsc, lcsc)
        shapes = json.loads(req(f"https://easyeda.com/api/products/{source}/components?version=6.4.19.5"))[
            "result"]["packageDetail"]["dataStr"]["shape"]
        uuid = next(json.loads(s.split("~", 1)[1])["attrs"]["uuid"] for s in shapes if s.startswith("SVGNODE"))
        step = req(f"https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/{uuid}")
        if not step.startswith(b"ISO-10303-21"):
            raise SystemExit(f"{lcsc}: EasyEDA did not return a STEP file")
        with open(path, "wb") as f:
            f.write(step)
        print("downloaded", path)


def set_models(board):
    """Point the footprints at the JLCPCB models (by LCSC field) and the renamed KiCad library models."""
    fps = board.Footprints()
    for fp in (fps[i] for i in range(len(fps))):
        lcsc = {f.GetName(): f.GetText() for f in fp.GetFields()}.get("LCSC", "")
        ref = fp.GetReference()
        if lcsc in JLC_MODELS:
            (x, y, z), rz = JLC_MODELS[lcsc]
            name, offset, rotation = f"${{KIPRJMOD}}/3d/{lcsc}.step", pcbnew.VECTOR3D(x, y, z), pcbnew.VECTOR3D(0, 0, rz)
        elif ref in LIB_MODELS:
            name, offset, rotation = f"${{KICAD10_3DMODEL_DIR}}/{LIB_MODELS[ref]}", pcbnew.VECTOR3D(0, 0, 0), pcbnew.VECTOR3D(0, 0, 0)
        else:
            continue
        models = fp.Models()
        while len(models):
            models.pop()
        model = pcbnew.FP_3DMODEL()
        model.m_Filename, model.m_Offset, model.m_Rotation = name, offset, rotation
        models.append(model)


def edge_keepouts(board, width=0.45):
    """Strips along the outline and around each slot where no track or via may go. Freerouting is not told
    KiCad's 0.3 mm copper-to-edge clearance and would otherwise route right against the edge."""
    strips = [(X0, Y0, X0 + W, Y0 + width), (X0, Y0 + H - width, X0 + W, Y0 + H),
              (X0, Y0, X0 + width, Y0 + H), (X0 + W - width, Y0, X0 + W, Y0 + H)]
    for (x1, y1), (x2, y2), slot in SLOTS:
        r = slot / 2 + width
        strips.append((min(x1, x2) - r, min(y1, y2) - r, max(x1, x2) + r, max(y1, y2) + r))
    for i, rect in enumerate(strips):
        route.add_rule_area(board, rect, f"EDGE_{i + 1}", tracks=True, fills=True)


# reference text moved clear of its neighbours on this dense board: ref -> (x, y[, angle])
REF_POSITIONS = {"U701": (126.5, 134.9), "SW202": (176.0, 144.6), "J802": (154.6, 161.7), "J804": (160.4, 161.9),
                 "J801": (165.0, 174.6), "J701": (106.0, 144.25, 0), "L101": (149.4, 172.6),
                 "J902": (J902_AT[0] + 12.0, J902_AT[1] - 5.7)}


def tidy_silkscreen(board):
    """The board is too dense for a silkscreen reference on every part: parts under 30 mm^2 and the
    mounting holes keep theirs on the fab layer only, while connectors, switches, jumpers, the battery
    and the larger ICs stay labelled."""
    fps = board.Footprints()
    for fp in (fps[i] for i in range(len(fps))):
        ref = fp.GetReference()
        small = build.courtyard_box(fp).GetArea() < build.mm(1) * build.mm(1) * 30
        if ref.startswith("H") or (small and not ref.startswith(("J", "SW", "BT"))):
            fp.Reference().SetVisible(False)
        if ref in REF_POSITIONS:
            x, y, *angle = REF_POSITIONS[ref]
            fp.Reference().SetPosition(pcbnew.VECTOR2I(build.mm(x), build.mm(y)))
            if angle:
                fp.Reference().SetTextAngleDegrees(angle[0])


def imu_keepouts(board):
    """No tracks or vias under the IMU packages (MPU-6500: no routing under the package; LIS3MDL is a
    magnetometer), on either layer; the GND pours may fill in. F.Cu: inside the pad ring; B.Cu: package + 0.5 mm."""
    fps = board.Footprints()   # index access: SWIG iterators are unreliable under Python 3.14
    for ref in IMU:
        fp = next(fps[i] for i in range(len(fps)) if fps[i].GetReference() == ref)
        boxes = [p.GetBoundingBox() for p in fp.Pads()]
        left, right = min(b.GetLeft() for b in boxes), max(b.GetRight() for b in boxes)
        top, bottom = min(b.GetTop() for b in boxes), max(b.GetBottom() for b in boxes)

        def inner_edge(edge, value, inner, pick):   # inner end of the pad row along one side
            return pick(inner(b) for b in boxes if abs(edge(b) - value) < build.mm(0.01))

        x1, y1, x2, y2 = (pcbnew.ToMM(v) for v in (
            inner_edge(lambda b: b.GetLeft(), left, lambda b: b.GetRight(), max),
            inner_edge(lambda b: b.GetTop(), top, lambda b: b.GetBottom(), max),
            inner_edge(lambda b: b.GetRight(), right, lambda b: b.GetLeft(), min),
            inner_edge(lambda b: b.GetBottom(), bottom, lambda b: b.GetTop(), min)))
        route.add_rule_area(board, (x1 + 0.05, y1 + 0.05, x2 - 0.05, y2 - 0.05), f"{ref}_KEEPOUT_F",
                            tracks=True, layers=[pcbnew.F_Cu], fills=True)
        x1, y1, x2, y2 = (pcbnew.ToMM(v) for v in (left, top, right, bottom))
        route.add_rule_area(board, (x1 - 0.5, y1 - 0.5, x2 + 0.5, y2 + 0.5), f"{ref}_KEEPOUT_B",
                            tracks=True, layers=[pcbnew.B_Cu], fills=True)


def placement_issues(board):
    """Checks a compact, two-sided board needs beyond courtyard overlaps."""
    issues = []
    fps = board.Footprints()
    fps = [fps[i] for i in range(len(fps))]
    top = [fp for fp in fps if fp.GetLayer() == pcbnew.F_Cu]
    bottom = [fp for fp in fps if fp.GetLayer() == pcbnew.B_Cu]
    tht = lambda fp: [p for p in fp.Pads() if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH]
    # through-hole pins come out on the other side: they must not land inside a part there
    for fp_a, others in [(a, bottom) for a in top] + [(b, top) for b in bottom]:
        for pad in tht(fp_a):
            for fp_b in others:
                cy = build.courtyard(fp_b)
                if cy.OutlineCount() and cy.Collide(pad.GetPosition(), build.mm(0.6)):
                    issues.append(f"{fp_a.GetReference()} pin {pad.GetNumber()} pokes into {fp_b.GetReference()} on the other side")
    # the buck stage stays in its strip (short hot loop, far from the magnetometer)
    x1, y1, x2, y2 = (build.mm(v) for v in SUPPLY_AREA)
    by_ref = {fp.GetReference(): fp for fp in fps}
    for ref in ("U101", "L101", "C102", "C104", "D105"):
        box = build.courtyard_box(by_ref[ref])
        if not (box.GetLeft() >= x1 and box.GetRight() <= x2 and box.GetTop() >= y1 and box.GetBottom() <= y2):
            issues.append(f"{ref} is outside SUPPLY_AREA")
    # the AIN1 front end keeps its distance from the LM2596 switch node
    gap, near = ain_switch_distance(fps)
    if gap < AIN_MIN_DISTANCE:
        issues.append(f"{near} is {gap:.1f} mm from LM_SW (want >= {AIN_MIN_DISTANCE} mm)")
    # slots must not cut pads
    for (sx1, sy1), (sx2, sy2), width in SLOTS:
        seg = pcbnew.SHAPE_SEGMENT(pcbnew.VECTOR2I(build.mm(sx1), build.mm(sy1)), pcbnew.VECTOR2I(build.mm(sx2), build.mm(sy2)),
                                   build.mm(width))
        for fp in fps:
            for pad in fp.Pads():
                if pad.GetEffectiveShape(pcbnew.F_Cu).Collide(seg, build.mm(0.3)):
                    issues.append(f"slot at ({sx1},{sy1}) cuts {fp.GetReference()} pad {pad.GetNumber()}")
    # a pad inside a barrier bridge could never be reached
    for bx1, by1, bx2, by2 in BRIDGES:
        rect = pcbnew.SHAPE_RECT(build.mm(bx1), build.mm(by1), build.mm(bx2 - bx1), build.mm(by2 - by1))
        for fp in fps:
            for pad in fp.Pads():
                if pad.GetNetname() and pad.GetEffectiveShape(pcbnew.F_Cu).Collide(rect, 0):
                    issues.append(f"{fp.GetReference()} pad {pad.GetNumber()} is inside the barrier bridge at ({bx1},{by1})")
    return issues


def ain_switch_distance(fps):
    """Shortest pad-to-pad distance (mm) from the AIN1 front end to the LM_SW net, and the part it is from."""
    switch = [p for fp in fps for p in fp.Pads() if p.GetNetname().endswith("/LM_SW")]
    best = (float("inf"), "")
    for fp in (fp for fp in fps if fp.GetReference() in AIN_PARTS):
        for pad in fp.Pads():
            for sw in switch:
                d = pad.GetEffectiveShape(pcbnew.F_Cu).GetClearance(sw.GetEffectiveShape(pcbnew.F_Cu))
                best = min(best, (pcbnew.ToMM(d), fp.GetReference()))
    return best


def magnetometer_report(board):
    """Distance from the LIS3MDL to the parts that disturb a compass (rule of thumb: 20 mm)."""
    fps = board.Footprints()
    by_ref = {fps[i].GetReference(): fps[i] for i in range(len(fps))}
    centre = by_ref["U602"].GetPosition()
    lines = []
    for ref, why in (("BT401", "coin cell (steel)"), ("J101", "JST VH"), ("J301", "JST VH"), ("J902", "JST VH"),
                     ("J701", "JST VH"), ("J201", "USB-C shell"), ("L101", "buck inductor"), ("U101", "LM2596"),
                     ("U201", "ESP32 shield")):
        # the ESP32 courtyard includes the antenna keep-out wings; measure to the module's pads instead
        box = build.pads_box(by_ref[ref]) if ref == "U201" else build.courtyard_box(by_ref[ref])
        dx = max(box.GetLeft() - centre.x, 0, centre.x - box.GetRight())
        dy = max(box.GetTop() - centre.y, 0, centre.y - box.GetBottom())
        lines.append(f"{ref} {why}: {pcbnew.ToMM(math.hypot(dx, dy)):.1f} mm")
    return lines


# the LM2596 board's net names that this board renamed (old -> new). Dropped: its GPIO23 route (EXP_IO23 to J804)
# and its B.Cu route from J101 pin 1 to the two-hole TP101, which would cross TP102 here
NET_RENAMES = (("/ALT_IN_N", "/DIN1_IN_N"), ("/PULSE_IN_N", "/DIN2_IN_N"),
               ("2ch)/ALT_", "2ch)/DIN1_"), ("2ch)/PULSE_", "2ch)/DIN2_"))


def reuse_routing(pcb=PCB, source=LM2596_PCB):
    """Copy the LM2596 board's tracks and vias onto this freshly placed board. The parts the two boards share sit
    at the same PLACEMENT, so its finished routing fits as it is, and `finish` only has the I/O strip left to route
    (Freerouting on the whole board kept leaving the IMU's +3V3 pins boxed in). The LM2596 board file is shifted
    from tools-pcb.py coordinates; the shift is measured on U601."""
    board, src = pcbnew.LoadBoard(pcb), pcbnew.LoadBoard(source)
    if len(board.Tracks()):
        raise SystemExit("reuse needs a freshly placed board: run place first")
    here, there = board.FindFootprintByReference("U601").GetPosition(), src.FindFootprintByReference("U601").GetPosition()
    shift = pcbnew.VECTOR2I(here.x - there.x, here.y - there.y)
    tracks = src.Tracks()
    for item in (tracks[i] for i in range(len(tracks))):
        name = item.GetNetname()
        if name.endswith("/EXP_IO23") or (name == "Net-(J101-Pin_1)" and item.GetLayer() == pcbnew.B_Cu):
            continue
        for old, new in NET_RENAMES:
            name = name.replace(old, new)
        net = board.FindNet(name)
        if net is None:
            raise SystemExit(f"{source}: net {name} is not on this board")
        if item.GetClass() == "PCB_VIA":
            via = pcbnew.Cast_to_PCB_VIA(item)
            copy = pcbnew.PCB_VIA(board)
            copy.SetPosition(via.GetPosition() + shift)
            copy.SetWidth(via.GetWidth(pcbnew.F_Cu))
            copy.SetDrill(via.GetDrillValue())
        elif item.GetClass() == "PCB_TRACK":
            copy = pcbnew.PCB_TRACK(board)
            copy.SetStart(item.GetStart() + shift)
            copy.SetEnd(item.GetEnd() + shift)
            copy.SetWidth(item.GetWidth())
            copy.SetLayer(item.GetLayer())
        else:
            raise SystemExit(f"{source}: cannot copy a {item.GetClass()}")
        copy.SetNet(net)
        board.Add(copy)
    route.pour(board)
    route.fix_via_drills(board)
    pcbnew.SaveBoard(pcb, board)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    count = int(sys.argv[2]) if len(sys.argv) > 2 else None
    if mode in ("check", "place"):
        board = place(PCB if mode == "place" else build.throwaway(PCB))
        issues = build.courtyard_overlaps(board) + placement_issues(board)
        print(f"placement issues ({len(issues)}):", "; ".join(issues) or "none")
        print("magnetometer U602 to:", "; ".join(magnetometer_report(board)))
        gap, near = ain_switch_distance(build.footprints_of(board))
        print(f"AIN1 front end to LM_SW: {gap:.1f} mm ({near})")
        if mode == "place":
            pcbnew.SaveBoard(PCB, board)
            print("saved", PCB)
    elif mode == "reuse":
        reuse_routing()
        print("saved", PCB)
    elif mode == "route":
        route.main(4 if count is None else count, PCB)
    elif mode == "finish":
        finish.main(3 if count is None else count, PCB)
    elif mode == "models":
        fetch_models()
        board = pcbnew.LoadBoard(PCB)
        set_models(board)
        pcbnew.SaveBoard(PCB, board)
        print("saved", PCB)
    elif mode == "production":
        subprocess.run([sys.executable, os.path.join(MAIN, "tools-production.py"), PCB], check=True)
    else:
        raise SystemExit(__doc__)
