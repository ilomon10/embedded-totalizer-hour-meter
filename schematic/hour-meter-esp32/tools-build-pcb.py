#!/usr/bin/env python3
"""Build hour-meter-esp32.kicad_pcb from the schematic, headless.

  1. kicad-cli exports the netlist (components, footprints, nets)
  2. every footprint is loaded and placed at the coordinates below
  3. nets are assigned to pads, board outline + mounting holes added
  4. netclasses come from the .kicad_pro (Power / Vehicle)

Usage:  python3 tools-build-pcb.py place      -> writes the placed (unrouted) board
        python3 tools-build-pcb.py check      -> report courtyard overlaps only

Coordinates are millimetres on the KiCad page; the board spans
X 100..230, Y 100..200 (130 x 100 mm). Move parts by editing PLACEMENT.
"""
import os
import subprocess
import sys
import xml.etree.ElementTree as ET

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
SCH = os.path.join(HERE, "hour-meter-esp32.kicad_sch")
PCB = os.path.join(HERE, "hour-meter-esp32.kicad_pcb")
SYS_FP = "/usr/share/kicad/footprints"
LOCAL_LIBS = {"hour_meter_modules": os.path.join(HERE, "hour-meter-modules.pretty")}

X0, Y0, W, H = 100.0, 100.0, 130.0, 100.0

# ref: (x, y, rotation_deg, side)  - footprint anchor = pad 1 for most parts
PLACEMENT = {
    # --- power input (top-left) ---
    "J4": (106.0, 112.0, 270, "F"),   # 12/24V in, wire entry to left edge
    "F1": (114.0, 104.5, 0, "F"),
    "D3": (123.0, 105.5, 0, "F"),     # 1N5819 reverse protection
    "D4": (123.0, 111.0, 0, "F"),     # TVS
    "C3": (139.0, 108.0, 0, "F"),
    "M5": (152.0, 104.5, 0, "F"),     # LM2596 module (pads 38.1 x 15.24)
    # --- vehicle inputs (left, isolated) ---
    "J1": (106.0, 152.0, 270, "F"),   # alternator
    "D1": (113.0, 140.0, 0, "F"),
    "R4": (113.0, 145.0, 0, "F"),
    "J2": (106.0, 182.0, 270, "F"),   # pulse
    "D2": (113.0, 170.0, 0, "F"),
    "R6": (113.0, 175.0, 0, "F"),
    "M1": (134.0, 151.0, 0, "F"),     # 817 module: input pads x=134, output pads x=179.72
    # --- logic side ---
    "R5": (186.0, 158.0, 90, "F"),
    "C1": (190.0, 164.0, 90, "F"),
    "R7": (186.0, 176.0, 90, "F"),
    "C2": (190.0, 182.0, 90, "F"),
    "U1": (200.0, 112.0, 0, "F"),     # ESP32: pads x 200 / 225.4, antenna toward top edge
    "M2": (202.0, 166.0, 0, "F"),     # DS3231 1x6
    "M3": (202.0, 184.5, 0, "F"),     # AT24C256 1x5
    "M4": (210.0, 167.0, 0, "F"),     # MPU9250 1x10, body to +X
    "J3": (190.0, 190.0, 90, "F"),    # UART header
}
MOUNTING_HOLES = [(104.0, 196.0), (226.0, 196.0), (104.0, 126.0), (165.0, 196.0)]

# Netclasses (Power / Vehicle) live in hour-meter-esp32.kicad_pro (set with Konnect).


def mm(v):
    return pcbnew.FromMM(v)


def export_netlist():
    out = os.path.join(HERE, "hour-meter-esp32.net.xml")
    subprocess.run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", out, SCH],
                   check=True, capture_output=True)
    root = ET.parse(out).getroot()
    comps = {}
    for c in root.iter("comp"):
        fields = {f.get("name"): (f.text or "") for f in c.iter("field")}
        sheet = c.find("sheetpath").get("tstamps")
        comps[c.get("ref")] = {
            "value": c.findtext("value"),
            "footprint": c.findtext("footprint"),
            "description": c.findtext("description") or "",
            "datasheet": fields.get("Datasheet", ""),
            "path": sheet + c.findtext("tstamps"),   # links footprint <-> schematic symbol
        }
    nets = []
    for n in root.iter("net"):
        nets.append((n.get("name"), [(x.get("ref"), x.get("pin")) for x in n.iter("node")]))
    os.remove(out)
    return comps, nets


def load_fp(fpid):
    lib, name = fpid.split(":", 1)
    path = LOCAL_LIBS.get(lib, os.path.join(SYS_FP, lib + ".pretty"))
    fp = pcbnew.FootprintLoad(path, name)
    if fp is None:
        raise SystemExit(f"footprint not found: {fpid}")
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    return fp


def add_outline(board):
    pts = [(X0, Y0), (X0 + W, Y0), (X0 + W, Y0 + H), (X0, Y0 + H)]
    for i in range(4):
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetStart(pcbnew.VECTOR2I(mm(pts[i][0]), mm(pts[i][1])))
        seg.SetEnd(pcbnew.VECTOR2I(mm(pts[(i + 1) % 4][0]), mm(pts[(i + 1) % 4][1])))
        seg.SetLayer(pcbnew.Edge_Cuts)
        seg.SetWidth(mm(0.1))
        board.Add(seg)


def add_holes(board):
    for i, (x, y) in enumerate(MOUNTING_HOLES):
        fp = load_fp("MountingHole:MountingHole_3.2mm_M3")
        fp.SetReference(f"H{i + 1}")
        fp.SetBoardOnly(True)  # not in the schematic, on purpose
        fp.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
        board.Add(fp)


# Silkscreen labels: (text, x, y, size_mm, bold)
LABELS = [
    ("HOUR METER ESP32  rev A", 150.0, 198.0, 1.2, True),
    ("<12/24V", 112.0, 112.0, 1.0, True), ("<GND", 112.0, 117.1, 1.0, False),
    ("<ALT D+", 112.0, 152.0, 1.0, True), ("<V-GND", 112.0, 157.1, 1.0, False),
    ("<PULSE", 112.0, 182.0, 1.0, True), ("<V-GND", 112.0, 187.1, 1.0, False),
    ("VEHICLE SIDE - ISOLATED", 118.0, 136.0, 1.0, True),
    ("817 MODULE: REMOVE BOTH G JUMPERS", 157.0, 173.0, 1.0, True),
    ("SET BUCK TO 5.0V BEFORE FITTING ESP32", 171.0, 125.5, 1.0, True),
    ("USB", 212.7, 154.0, 1.0, True),
    ("TX RX GND", 192.5, 193.0, 0.8, False),
]


def add_labels(board):
    for text, x, y, size, bold in LABELS:
        t = pcbnew.PCB_TEXT(board)
        t.SetText(text)
        t.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
        t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
        t.SetTextThickness(mm(size * (0.2 if bold else 0.15)))
        t.SetBold(bold)
        if text.startswith("<"):  # terminal pin label: left-aligned, points at the pin
            t.SetText(text[1:])
            t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
        board.Add(t)


def build():
    comps, nets = export_netlist()
    # Always start from an empty board bound to this project (re-runs are idempotent).
    board = pcbnew.NewBoard(PCB)

    footprints = {}
    for ref, comp in sorted(comps.items()):
        fpid = comp["footprint"]
        if not fpid:
            raise SystemExit(f"{ref} has no footprint")
        if ref not in PLACEMENT:
            raise SystemExit(f"{ref} has no placement")
        fp = load_fp(fpid)
        fp.SetReference(ref)
        fp.SetValue(comp["value"])
        fp.SetPath(pcbnew.KIID_PATH(comp["path"]))
        fp.GetField(pcbnew.FIELD_T_DATASHEET).SetText(comp["datasheet"])
        fp.GetField(pcbnew.FIELD_T_DESCRIPTION).SetText(comp["description"])
        x, y, rot, side = PLACEMENT[ref]
        fp.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
        fp.SetOrientationDegrees(rot)
        board.Add(fp)
        if side == "B":
            fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
        footprints[ref] = fp

    for name, nodes in nets:
        # Pin names inside generated net names escape '/' as {slash} (matches eeschema).
        if name.startswith(("unconnected-(", "Net-(")):
            name = name.replace("/", "{slash}")
        net = pcbnew.NETINFO_ITEM(board, name)
        board.Add(net)
        for ref, pin in nodes:
            for pad in footprints[ref].Pads():
                if pad.GetNumber() == pin:
                    pad.SetNet(net)

    # Small-pitch GND pins sit inside dense fan-outs; a solid pour connection means
    # they can never hang on a thermal-relief island. Big power pads keep thermals.
    for ref in ("M2", "M3", "M4", "J3", "U1", "C1", "C2"):
        for pad in footprints[ref].Pads():
            if pad.GetNetname() == "GND":
                pad.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)

    add_outline(board)
    add_holes(board)
    add_labels(board)
    title = board.GetTitleBlock()
    title.SetTitle("Hour Meter ESP32 carrier")
    title.SetRevision("A")
    title.SetCompany("totalizer-hour-meter")
    board.SetTitleBlock(title)
    return board


def footprints_of(board):
    # Index-based access: SWIG iterators are broken under Python 3.14.
    fps = board.Footprints()
    return [fps[i] for i in range(len(fps))]


def courtyard_overlaps(board):
    boxes = []
    for fp in footprints_of(board):
        poly = fp.GetCourtyard(pcbnew.F_CrtYd)
        bb = poly.BBox() if poly.OutlineCount() else fp.GetBoundingBox(False)
        boxes.append((fp.GetReference(), bb))
    issues = []
    for i in range(len(boxes)):
        for j in range(i + 1, len(boxes)):
            a, b = boxes[i][1], boxes[j][1]
            if a.Intersects(b):
                issues.append(f"{boxes[i][0]} overlaps {boxes[j][0]}")
    edge = pcbnew.BOX2I(pcbnew.VECTOR2I(mm(X0), mm(Y0)), pcbnew.VECTOR2L(mm(W), mm(H)))
    for ref, bb in boxes:
        if not edge.Contains(bb):
            issues.append(f"{ref} outside board")
    return issues


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "place"
    board = build()
    issues = courtyard_overlaps(board)
    print("courtyard issues:", issues or "none")
    if mode == "place":
        pcbnew.SaveBoard(PCB, board)
        print("saved", PCB)
