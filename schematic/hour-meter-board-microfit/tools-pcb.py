#!/usr/bin/env python3
"""Build hour-meter-board-microfit.kicad_pcb: the I/O board re-laid out around one Molex Micro-Fit 3.0 harness
header (J1, 2 x 7), 80 x 80 mm, 2 copper layers.

  python3 tools-pcb.py check            -> placement checks only (writes nothing but a scratch board in routing/)
  python3 tools-pcb.py place            -> placed, unrouted board
  python3 tools-pcb.py reuse            -> copy the I/O board's routing of the unchanged blocks + GND pours
  python3 tools-pcb.py route [tries]    -> Freerouting (best of N tries, default 4) + GND pours
  python3 tools-pcb.py finish [passes]  -> close what Freerouting left open (exit 1 if anything still is)
  python3 tools-pcb.py silk             -> re-apply the silkscreen labels and reference positions (no re-route)
  python3 tools-pcb.py production       -> production/: Gerber zip, BOM and CPL for JLCPCB
  python3 tools-pcb.py models           -> download the JLCPCB 3D models into 3d/ and set them on the board

A variant of ../hour-meter-board-compact-lm2596-io (see README.md). The build, route and finish scripts are the
main board's, called with this board's LAYOUT. The floor plan:
  * left edge: J1 (every field wire), with the GPS (JST GH) and Qwiic (JST SH) ports below it; USB-C on the right;
  * vehicle zone beside J1: the isolated DIN island in the top-left corner (milled slots, no pour), then the
    RS485, UART, AIN1 and DOUT1 front ends, and the LM2596 stage in a strip along the bottom edge;
  * logic zone on the right: the ESP32 module (antenna past the top edge), USB, the IMU, EEPROM and RTC.
The ESP32/USB block, the IMU block and the LM2596 stage keep the I/O board's coordinates.
"""
import json
import math
import os
import subprocess
import sys
import urllib.request

import importlib.util
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, "..", "hour-meter-board")
SCH = os.path.join(HERE, "hour-meter-board-microfit.kicad_sch")
PCB = os.path.join(HERE, "hour-meter-board-microfit.kicad_pcb")
IMU = ("U601", "U602")

_spec = importlib.util.spec_from_file_location("finish", os.path.join(MAIN, "tools-finish-routing.py"))
finish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(finish)
route, build = finish.route, finish.build

X0, Y0, W, H = 100.0, 100.0, 80.0, 80.0
PSU_AREA = None                              # no plug-on PSU-B: the LM2596 stage is on the board
SUPPLY_AREA = (108.0, 158.0, 157.0, 180.0)   # the buck stage (keep it compact: hot loop, magnetometer distance)
AIN_PARTS = ("R901", "R902", "R903", "C902", "D901", "U901")   # AIN1 divider, filter, clamp and ADC: away from LM_SW
AIN_MIN_DISTANCE = 8.0                       # mm from any LM_SW pad (the LM2596 switch node)
ORDER_MARK_AT = (140.0, 140.0)               # JLCPCB order number, bottom silkscreen
BARRIER_X = 133.0                            # isolation barrier: through the optocoupler centres
ISLAND_BOTTOM = 120.5                        # the DIN island ends here, between J1 pins 5/12 and 6/13
VEHICLE_AREA = (100.0, 100.0, BARRIER_X + 2.5, ISLAND_BOTTOM + 2.9)   # no pours within 2.5 mm of the barrier,
# nor around J1's RS485 pins next to the island: the GND pour stays > 3 mm from island copper
SLOT = 1.5                                   # slot width, mm

# ESP32 module: origin at (166, 106.32) puts its antenna section (6.5 mm) past the top edge; PLACEMENT
# takes the courtyard centre, which sits 7.23 mm above the origin for this footprint
U201_ORIGIN = (166.0, 106.32)

# J1 (Micro-Fit 2 x 7, rotated 90: mating face on the left edge, pin 1 at the bottom). The courtyard centre sits
# 2.585 mm left of and 9 mm above pin 1; front row (pins 1-7) 9.42 mm in from the edge, back row (8-14) 3 mm further
J1_PIN1 = (109.5, 134.0)
J1_AT = (J1_PIN1[0] - 2.585, J1_PIN1[1] - 9.0)

PLACEMENT = {
    # --- mounting: three corners plus the right edge (the module's antenna overhangs the top-right) ---
    "H102": (104.0, 104.0, 0, "F"), "H104": (104.0, 176.0, 0, "F"), "H105": (176.0, 176.0, 0, "F"),
    "H103": (176.0, 148.4, 0, "F"),
    # --- every port on the left edge: J1 (harness), then GPS (GH) and Qwiic (SH), openings to the left ---
    "J1": J1_AT + (90, "F"),
    "J802": (103.25, 145.6, 270, "F"), "J803": (103.35, 156.45, 270, "F"),
    "TP801": (103.6, 163.4, 0, "F"),     # GPS PPS solder pad
    # --- DIN island (isolated, top-left corner): two chains of 3 x 1k, M7, zener, LED bleeder; each M7 turned so
    #     its cathode faces the zener (the Vehicle-class track cannot pass the anode pad above or below) ---
    "R306": (116.2, 102.0, 0, "F"), "R307": (121.2, 102.0, 0, "F"),   # DIN2 (J1 pin 14)
    "R308": (116.2, 105.0, 0, "F"), "R309": (121.0, 105.0, 0, "F"),
    "D303": (117.5, 108.4, 180, "F"), "D304": (123.0, 108.4, 0, "F"),
    "U302": (BARRIER_X, 105.2, 0, "F"),
    "R301": (116.2, 112.2, 0, "F"), "R302": (121.2, 112.2, 0, "F"),   # DIN1 (J1 pin 13)
    "R303": (116.2, 115.2, 0, "F"), "R304": (121.0, 115.2, 0, "F"),
    "D301": (117.5, 118.6, 180, "F"), "D302": (123.0, 118.6, 0, "F"),
    "U301": (BARRIER_X, 115.4, 0, "F"),
    # opto outputs (logic side)
    "R310": (140.6, 103.4, 90, "F"), "C302": (140.6, 107.2, 90, "F"),
    "R305": (140.6, 113.6, 90, "F"), "C301": (140.6, 117.4, 90, "F"),
    # --- IMU: top middle, away from J1, the LM2596 stage, the coin cell and the USB shell ---
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
    # --- EEPROM below the IMU ---
    "U501": (146.5, 121.2, 0, "F"), "C501": (151.4, 121.2, 90, "F"),
    "R501": (143.8, 125.6, 0, "F"), "JP501": (148.0, 125.6, 0, "F"),
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
    # --- field side, right of J1: RS485 clamps and transceiver (pins 5 / 12), 5 V fuse (pin 11), DOUT1 switch
    #     (pin 10), AIN1 pulse cap and 4-20 mA shunt (pin 9); the VIN fuse (pin 8) is below ---
    "D701": (117.6, 124.1, 0, "F"), "D702": (125.2, 124.1, 0, "F"),
    "U701": (135.4, 125.2, 180, "F"), "C701": (135.4, 129.4, 0, "F"),
    "F801": (116.9, 127.5, 0, "F"),
    "U903": (124.6, 131.0, 0, "F"),                                    # BSP75N: drain (pin 2) faces J1
    "C901": (116.9, 131.6, 0, "F"), "R904": (116.9, 134.4, 0, "F"),   # pulse cap at the pin; 4-20 mA shunt (DNP)
    "R704": (133.9, 132.2, 0, "F"), "JP702": (138.0, 132.2, 0, "F"),  # termination
    "R705": (133.6, 134.8, 0, "F"), "JP703": (138.0, 135.0, 0, "F"),  # bias A
    "R706": (133.6, 136.8, 0, "F"), "JP704": (138.0, 137.8, 0, "F"),  # bias B
    "U902": (125.0, 136.8, 0, "F"), "C904": (128.6, 136.8, 90, "F"),  # 5 V buffer for the BSP75N input
    "R905": (121.4, 136.8, 90, "F"),                                   # DOUT1 off during reset and boot
    # --- UART: ESD (also the GPS lines) between J1 and the GPS port; its pins 1-3 stay open to the right ---
    "U802": (109.4, 141.4, 90, "F"), "C802": (112.8, 145.0, 90, "F"),
    # --- logic side of the I/O: RS485 pull-ups, AIN1 divider + ADC, UART2 RX buffer ---
    "R701": (141.4, 123.0, 90, "F"), "R702": (141.4, 126.6, 90, "F"), "R703": (139.6, 129.6, 0, "F"),
    "R901": (143.6, 132.0, 0, "F"), "R902": (148.6, 132.0, 0, "F"),   # 2 x 49.9k divider top
    "R903": (152.0, 135.0, 90, "F"), "C902": (150.0, 135.0, 90, "F"), # divider foot + filter
    "D901": (146.8, 135.4, 0, "F"),                                    # BAV99 clamp
    "U901": (145.6, 139.6, 0, "F"), "C903": (150.6, 139.6, 90, "F"),  # ADS1115 + VDD decoupling
    "U801": (143.2, 145.0, 0, "F"), "C801": (146.2, 145.0, 90, "F"), "R802": (143.2, 147.6, 0, "F"),
    "R801": (148.8, 145.0, 90, "F"),
    # --- GPS: series resistors, pull-up / pull-down, supply select, beside the GH port ---
    "R803": (107.9, 145.2, 90, "F"), "R806": (110.4, 145.2, 90, "F"),
    "R804": (107.9, 148.4, 90, "F"), "R805": (110.4, 148.4, 90, "F"), "R807": (112.8, 148.4, 90, "F"),
    "JP801": (108.4, 153.0, 90, "F"), "F803": (111.9, 153.0, 90, "F"),
    # --- spare GPIO test pads under the ESP32 block ---
    "TP807": (143.0, 153.4, 0, "F"), "TP802": (145.2, 153.4, 0, "F"), "TP803": (147.4, 153.4, 0, "F"),
    "TP804": (149.6, 153.4, 0, "F"), "TP805": (151.8, 153.4, 0, "F"), "TP806": (154.0, 153.4, 0, "F"),
    "TP808": (156.2, 153.4, 0, "F"),
    # --- coin cell on the bottom side, bottom-right (its pins land at (159, 151.6) and (159, 172.4)), RTC above ---
    "BT401": (159.0, 162.0, 90, "B"),
    "U401": (166.0, 158.0, 0, "F"), "C401": (161.0, 158.0, 90, "F"),
    "C402": (170.6, 156.4, 90, "F"), "R401": (170.6, 160.0, 90, "F"),
    # --- power input: PTC, reverse block, TVS ---
    "F101": (117.0, 146.5, 0, "F"),
    "D101": (125.6, 156.0, 90, "F"), "D102": (123.0, 146.0, 0, "F"), "R101": (128.0, 146.0, 0, "F"),
    "D103": (118.0, 155.5, 0, "F"), "D104": (118.0, 160.0, 0, "F"),
    # --- LM2596 buck stage, bottom strip: Cin -> U101 (pins face Cin) -> catch diode -> L101 -> Cout ---
    "C102": (115.0, 171.0, 180, "F"), "C103": (125.0, 164.2, 0, "F"),
    "U101": (130.4, 171.0, 0, "F"),
    "D105": (140.7, 168.5, 90, "F"),
    "L101": (149.4, 172.6, 0, "F"),
    "C104": (148.5, 162.0, 0, "F"), "C105": (142.6, 163.0, 90, "F"),
    "R103": (124.0, 178.4, 0, "F"), "R104": (127.5, 178.4, 0, "F"),   # FB divider, under the U101 pins
    "R105": (117.5, 163.6, 0, "F"), "D106": (120.5, 163.6, 0, "F"),   # power LED
}

SLOTS = (
    ((BARRIER_X, 102.6), (BARRIER_X, 107.8), SLOT),        # under U302
    ((BARRIER_X, 112.8), (BARRIER_X, 120.0), SLOT),        # under U301 and below it
    ((114.8, 121.3), (128.4, 121.3), SLOT),                # between the DIN island and RS485
)

# Board material left between the slots (for strength): no copper may cross the barrier there, so the
# island is closed to every other net and only the optocouplers bridge it
BRIDGES = (
    (BARRIER_X - 2.5, 100.0, BARRIER_X + 2.5, 102.6),     # top edge to the U302 slot
    (BARRIER_X - 2.5, 107.8, BARRIER_X + 2.5, 112.8),     # between the two opto slots
    (128.4, 120.0, BARRIER_X + 2.5, 122.2),               # the corner
    (100.0, 120.0, 114.8, 121.0),                         # left edge to the bottom slot, between J1 pins 6/13 and 5/12
)

LABELS = [
    ("HOUR METER rev B", 136.0, 150.6, 1.0, True),
    ("DIN", 110.6, 108.2, 0.8, True), ("ISOLATED", 110.6, 109.6, 0.8, True),   # island corner above J1
    # the RS485 solder jumpers, stacked top to bottom beside U701 (too tight for their own references)
    ("JP702 TERM", 138.2, 140.0, 0.8, False), ("JP703 BIAS A", 138.2, 141.2, 0.8, False),
    ("JP704 BIAS B", 138.2, 142.4, 0.8, False),
]

# J1 pinout on the bottom silkscreen, behind the header, for whoever crimps the harness: (x, y) of the first line
J1_PINOUT_AT = (101.5, 162.5)
J1_PINOUT = ("J1 MICRO-FIT 3.0", "1 GND      8 VIN", "2 GND      9 AIN1", "3 TX      10 DOUT1", "4 RX      11 +5V",
             "5 485 A    12 485 B", "6 DIN COM  13 DIN1", "7 DIN COM  14 DIN2")

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
    add_pinout(board)
    set_models(board)
    build.add_order_mark(board, "B", ORDER_MARK_AT)
    title = board.GetTitleBlock()
    title.SetTitle("Hour Meter main board, Micro-Fit harness (80 x 80 mm, 2 layers)")
    board.SetTitleBlock(title)
    return board


def add_pinout(board, size=0.8, pitch=1.25):
    """The J1_PINOUT lines on the bottom silkscreen, mirrored so they read from below, left-aligned at J1_PINOUT_AT."""
    x, y = J1_PINOUT_AT
    for i, line in enumerate(J1_PINOUT):
        text = pcbnew.PCB_TEXT(board)
        text.SetText(line)
        text.SetLayer(pcbnew.B_SilkS)
        text.SetMirrored(True)
        text.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_RIGHT)   # mirrored: right-aligned reads as left-aligned from below
        text.SetTextSize(pcbnew.VECTOR2I(build.mm(size), build.mm(size)))
        text.SetTextThickness(build.mm(size * (0.2 if i == 0 else 0.15)))
        text.SetPosition(pcbnew.VECTOR2I(build.mm(x), build.mm(y + i * pitch)))
        board.Add(text)


# The blocks that keep the I/O board's placement get its routing, copied by `reuse`: (x1, y1, x2, y2)
IO_PCB = os.path.join(HERE, "..", "hour-meter-board-compact-lm2596-io", "hour-meter-board-compact-lm2596-io.kicad_pcb")
REUSE_AREAS = (
    (141.5, 104.2, 153.3, 116.9),   # IMU
    (152.3, 93.0, 180.0, 150.6),    # ESP32 module, 3V3 regulator, USB, CH340C, auto-program
    (108.0, 161.9, 157.0, 180.0),   # LM2596 stage, below the input protection (which moved)
)


def reuse_routing(pcb=PCB, source=IO_PCB):
    """Copy the I/O board's tracks and vias that lie wholly inside REUSE_AREAS onto this freshly placed board, then
    pour GND. The I/O board file is shifted from its tools-pcb.py coordinates; the shift is measured on U601. KiCad's
    DRC then judges the copy: every copied item it reports in an error (clearance to a part that moved in, a keep-out,
    this board's edges) is removed again. The stubs left where a route was cut at an area's border are pruned by
    `finish`."""
    board, src = pcbnew.LoadBoard(pcb), pcbnew.LoadBoard(source)
    if len(board.Tracks()):
        raise SystemExit("reuse needs a freshly placed board: run place first")
    here, there = board.FindFootprintByReference("U601").GetPosition(), src.FindFootprintByReference("U601").GetPosition()
    shift = pcbnew.VECTOR2I(here.x - there.x, here.y - there.y)
    areas = [pcbnew.BOX2I(pcbnew.VECTOR2I(build.mm(x1), build.mm(y1)), pcbnew.VECTOR2L(build.mm(x2 - x1), build.mm(y2 - y1)))
             for x1, y1, x2, y2 in REUSE_AREAS]
    tracks, copied = src.Tracks(), 0
    for i in range(len(tracks)):
        item = tracks[i]
        net = board.FindNet(item.GetNetname())
        box = item.GetBoundingBox()
        box.Move(shift)
        if net is None or not any(area.Contains(box) for area in areas):
            continue
        if item.GetClass() == "PCB_VIA":
            via = pcbnew.Cast_to_PCB_VIA(item)
            copy = pcbnew.PCB_VIA(board)
            copy.SetPosition(via.GetPosition() + shift)
            copy.SetWidth(via.GetWidth(pcbnew.F_Cu))
            copy.SetDrill(via.GetDrillValue())
        else:
            copy = pcbnew.PCB_TRACK(board)
            copy.SetStart(item.GetStart() + shift)
            copy.SetEnd(item.GetEnd() + shift)
            copy.SetWidth(item.GetWidth())
            copy.SetLayer(item.GetLayer())
        copy.SetNet(net)
        board.Add(copy)
        copied += 1
    route.fix_via_drills(board)
    pcbnew.SaveBoard(pcb, board)
    dropped = 0
    for _ in range(5):   # removing one item of a short can clear the others' errors
        _, errors, _ = finish.drc(pcb)
        flagged = {item["uuid"] for v in errors for item in v["items"]}
        board = pcbnew.LoadBoard(pcb)
        doomed = [t for t in finish.tracks_of(board) if t.m_Uuid.AsString() in flagged]
        if not doomed:
            break
        for track in doomed:
            finish.remove(board, track)
        dropped += len(doomed)
        pcbnew.SaveBoard(pcb, board)
    board = pcbnew.LoadBoard(pcb)
    route.pour(board)
    pcbnew.SaveBoard(pcb, board)
    print(f"copied {copied - dropped} tracks and vias from the I/O board ({dropped} more were dropped by DRC)")


# 3D models from JLCPCB's part library (EasyEDA), for parts whose KiCad 10 model is missing or generic:
# LCSC -> (offset x, y, z in mm, z rotation in degrees), lined up on the KiCad footprint's pads. The STEP files
# are downloaded into 3d/ (git-ignored) by `models`; source: JLCEDA/EasyEDA official library, https://easyeda.com
JLC_MODELS = {
    "C165948": ((0.0, -0.879, 0.0), 180),     # J201 USB-C, HRO TYPE-C-31-M-12
    "C318884": ((0.0, 0.0, 0.05), 0),         # SW201, SW202 TS-1187A
    "C2979167": ((10.588, 0.0, 0.6), 180),    # BT401 CR2032 holder
    "C19078719": ((0.0, 0.0, 0.0), 0),        # F101 1812 PTC
    "C9400": ((0.0, 0.0, 0.0), 0),            # L101 SMDRI127-330MT
    "C277677": ((9.0, -1.565, 0.0), 180),     # J1 Molex Micro-Fit 3.0 43045-1400 (KiCad 10 has no model for it)
}
# EasyEDA has no STEP file for these parts: use the model of a part with the same body and pads (LCSC -> LCSC)
MODEL_STANDINS = {}
# KiCad 10 renamed or lacks these library models
LIB_MODELS = {"U601": "Package_DFN_QFN.3dshapes/QFN-24_3x3mm_P0.4mm.step"}
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
REF_POSITIONS = {"L101": (149.4, 172.6), "U701": (135.4, 125.2), "J802": (103.0, 138.9, 0), "J803": (103.4, 161.3, 0), "JP501": (148.0, 127.9),
                 "JP801": (108.6, 157.3, 0), "SW202": (176.0, 144.6), "U302": (129.0, 109.2), "U301": (129.0, 111.4)}
HIDDEN_REFS = ("JP702", "JP703", "JP704")   # named by the legend in LABELS


def relabel(pcb=PCB):
    """Re-apply LABELS and the reference positions to the routed board, so silkscreen fixes need no re-route."""
    board = pcbnew.LoadBoard(pcb)
    drawings = board.Drawings()
    for item in [drawings[i] for i in range(len(drawings))]:
        if item.GetClass() == "PCB_TEXT" and item.GetLayer() == pcbnew.F_SilkS:
            finish.remove(board, item)
    build.add_labels(board, LABELS)
    tidy_silkscreen(board)
    pcbnew.SaveBoard(pcb, board)


def tidy_silkscreen(board):
    """The board is too dense for a silkscreen reference on every part: parts under 30 mm^2 and the
    mounting holes keep theirs on the fab layer only, while connectors, switches, jumpers, the battery
    and the larger ICs stay labelled."""
    fps = board.Footprints()
    for fp in (fps[i] for i in range(len(fps))):
        ref = fp.GetReference()
        small = build.courtyard_box(fp).GetArea() < build.mm(1) * build.mm(1) * 30
        if ref.startswith("H") or ref in HIDDEN_REFS or (small and not ref.startswith(("J", "SW", "BT"))):
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
    tht = lambda fp: [p for p in fp.Pads() if p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH)]
    # through-hole pins (and screw holes) come out on the other side: they must not land inside a part there
    for fp_a, others in [(a, bottom) for a in top] + [(b, top) for b in bottom]:
        for pad in tht(fp_a):
            for fp_b in others:
                cy = build.courtyard(fp_b)
                if cy.OutlineCount() and cy.Collide(pad.GetPosition(), build.mm(0.6)):
                    issues.append(f"{fp_a.GetReference()} pin {pad.GetNumber()} pokes into {fp_b.GetReference()} on the other side")
    # a screw head covers its hole's courtyard on both sides
    holes = [fp for fp in fps if fp.GetReference().startswith("H")]
    for hole in holes:
        for fp in bottom:
            if build.courtyard_box(hole).Intersects(build.courtyard_box(fp)):
                issues.append(f"{hole.GetReference()} screw head overlaps {fp.GetReference()} on the bottom")
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
    # island pads stay inside the island and everything else outside it
    island = pcbnew.SHAPE_RECT(build.mm(X0), build.mm(Y0), build.mm(BARRIER_X - X0), build.mm(ISLAND_BOTTOM - Y0))
    nets = island_nets(fps)
    for fp in fps:
        for pad in fp.Pads():
            if not pad.GetNetname() or fp.GetReference() in ("U301", "U302"):
                continue
            inside = pad.GetEffectiveShape(pcbnew.F_Cu).Collide(island, 0)
            if inside != (pad.GetNetname() in nets):
                where = "inside" if inside else "outside"
                issues.append(f"{fp.GetReference()} pad {pad.GetNumber()} ({pad.GetNetname()}) is {where} the DIN island")
    return issues


# the isolated side of the optocouplers: the DIN front-end parts, the opto LED pins and J1's DIN pins
ISLAND_PADS = {"J1": ("6", "7", "13", "14"), "U301": ("1", "2"), "U302": ("1", "2")}
ISLAND_PARTS = ("R301", "R302", "R303", "R304", "R306", "R307", "R308", "R309", "D301", "D302", "D303", "D304")


def island_nets(fps):
    """Names of the nets on the isolated side of the barrier."""
    nets = set()
    for fp in fps:
        ref = fp.GetReference()
        for pad in fp.Pads():
            if ref in ISLAND_PARTS or pad.GetNumber() in ISLAND_PADS.get(ref, ()):
                nets.add(pad.GetNetname())
    return nets


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
    for ref, why in (("BT401", "coin cell (steel)"), ("J1", "Micro-Fit (DOUT1 / VIN current)"),
                     ("J201", "USB-C shell"), ("L101", "buck inductor"), ("U101", "LM2596"), ("U903", "DOUT1 switch"),
                     ("U201", "ESP32 shield")):
        # the ESP32 courtyard includes the antenna keep-out wings; measure to the module's pads instead
        box = build.pads_box(by_ref[ref]) if ref == "U201" else build.courtyard_box(by_ref[ref])
        dx = max(box.GetLeft() - centre.x, 0, centre.x - box.GetRight())
        dy = max(box.GetTop() - centre.y, 0, centre.y - box.GetBottom())
        lines.append(f"{ref} {why}: {pcbnew.ToMM(math.hypot(dx, dy)):.1f} mm")
    return lines


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
        pcbnew.SaveBoard(PCB if mode == "place" else build.throwaway(PCB), board)
        if mode == "place":
            print("saved", PCB)
    elif mode == "reuse":
        reuse_routing()
        print("saved", PCB)
    elif mode == "route":
        route.main(4 if count is None else count, PCB)
    elif mode == "finish":
        finish.main(3 if count is None else count, PCB)
    elif mode == "silk":
        relabel()
        print("saved", PCB)
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
