#!/usr/bin/env python3
"""Build hour-meter-esp32-v4.kicad_pcb from the schematic, headless.

  1. kicad-cli exports the netlist (components, footprints, nets)
  2. every footprint is loaded and placed at the coordinates below
  3. nets are assigned to pads, board outline + mounting holes added
  4. netclasses come from the .kicad_pro (Power / Vehicle)

Usage:  python3 tools-build-pcb.py place      -> writes the placed (unrouted) board
        python3 tools-build-pcb.py check      -> report overlaps only (writes nothing)

Coordinates are millimetres on the KiCad page; the board spans
X 100..188, Y 100..171 (88 x 71 mm). Move parts by editing PLACEMENT.

Layout: vehicle zone top-left (817 module stacked on standoffs over D1-D4,
R4, R6), DevKit right with its antenna past the top edge, modules flat below.
The strip below the DevKit's USB-C end only takes low parts (USB plug above).
"""
import os
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
SCH = os.path.join(HERE, "hour-meter-esp32-v4.kicad_sch")
PCB = os.path.join(HERE, "hour-meter-esp32-v4.kicad_pcb")
SYS_FP = "/usr/share/kicad/footprints"
LOCAL_LIBS = {"hour_meter_modules": os.path.join(HERE, "hour-meter-modules.pretty")}

X0, Y0, W, H = 100.0, 100.0, 88.0, 71.0

# ref: (x, y, rotation_deg, side)  - footprint anchor = pad 1 (M1: module centre)
PLACEMENT = {
    # --- vehicle zone (top-left, no GND pour) ---
    "J1": (105.8, 110.5, 270, "F"),   # alternator; wire entry at the left edge
    "J2": (105.8, 121.85, 270, "F"),  # pulse
    "M1": (134.8, 116.0, 0, "F"),     # 817 module centre; IN pads x 113.2, OUT pads x 156.4
    "R4": (135.34, 110.5, 180, "F"),  # under the module: row A (ALT)
    "D1": (138.3, 110.5, 0, "F"),
    "D3": (122, 116.0, 0, "F"),     # row B: 15 V clamps
    "D4": (136.5, 116.0, 0, "F"),
    "R6": (135.34, 121.5, 180, "F"),  # row C (PULSE)
    "D2": (138.3, 121.5, 0, "F"),
    # --- DevKit V4: pin 1 (3V3) top-left, antenna past the top edge ---
    "U1": (160.1, 103.0, 0, "F"),
    "C4": (164.0, 106.5, 0, "F"),     # 100 nF on 3V3 right at the DevKit's 3V3 pin
    "R5": (164.0, 119.5, 90, "F"),    # under the DevKit, between its socket rows
    "C1": (164.0, 129.0, 90, "F"),
    "R7": (170.5, 119.5, 90, "F"),
    "C2": (170.5, 129.0, 90, "F"),
    "R1": (175.0, 141.1, 0, "F"),     # LED resistor next to GPIO2
    # --- modules, flat ---
    "M2": (102.5, 138.5, 0, "F"),     # DS3231, body to +X
    "M3": (102.5, 167.16, 0, "F"),    # AT24C256, pin 1 (VCC) at the bottom of its row
    "M4": (142.0, 136.0, 0, "F"),     # GY-9250, body to +X
    # --- bottom strip ---
    "J3": (142.0, 167.5, 90, "F"),    # spare GPIO 2x5
    "F1": (156.3, 169.0, 90, "F"),
    "C3": (162.5, 157.0, 0, "F"),     # 10 uF, tall: outside every module and the USB plug
    "D5": (183.0, 156.0, 0, "F"),     # status LED at the right edge
}
# H2 sits under the DevKit and H3 under the AT24C256: unplug the module to reach the screw.
MOUNTING_HOLES = [(103.5, 103.5), (166.0, 145.5), (122.0, 166.5), (184.5, 167.5)]

# Netclasses (Power / Vehicle) live in hour-meter-esp32-v4.kicad_pro.


def mm(v):
    return pcbnew.FromMM(v)


def export_netlist():
    out = os.path.join(tempfile.mkdtemp(), "hour-meter-esp32-v4.net.xml")
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


# Silkscreen labels: (text, x, y, size_mm, bold); "<" = left-aligned
J3_TOP = ["G", "RX", "13", "32", "G"]       # even pins 2..10 (upper row)
J3_BOTTOM = ["3V3", "TX", "4", "25", "33"]  # odd pins 1..9 (lower row)
LABELS = [
    ("<J1 ALT D+, V-GND   J2 PULSE, V-GND", 101.0, 132.6, 1.0, True),
] + [(t, 142.0 + i * 2.54, 162.6, 1.0, False) for i, t in enumerate(J3_TOP)] \
  + [(t, 142.0 + i * 2.54, 169.75, 1.0, False) for i, t in enumerate(J3_BOTTOM)]

# Back silkscreen (mirrored), in the pad-free area behind the DS3231 and AT24C256 bodies.
BACK_LABELS = [
    ("HOUR METER ESP32 V4  rev C", 121.0, 137.0, 1.2, True),
    ("2 layers, 1.6 mm, THT only", 121.0, 139.4, 1.0, False),
    ("J3 SPARE, 3.3 V LOGIC ONLY", 121.0, 142.6, 1.0, True),
    ("1 3V3 (F1 PTC)    2 GND", 121.0, 144.8, 1.0, False),
    ("3 TX2 IO17    4 RX2 IO16", 121.0, 147.0, 1.0, False),
    ("5 IO4   6 IO13   7 IO25", 121.0, 149.2, 1.0, False),
    ("8 IO32   9 IO33   10 GND", 121.0, 151.4, 1.0, False),
    ("817: REMOVE BOTH G JUMPERS", 121.0, 154.6, 1.0, True),
    ("ZS-042: REMOVE CHARGE RESISTOR", 121.0, 156.8, 1.0, True),
    ("POWER: USB-C ON THE DEVKIT", 121.0, 159.0, 1.0, True),
]


def add_labels(board):
    for layer, labels in ((pcbnew.F_SilkS, LABELS), (pcbnew.B_SilkS, BACK_LABELS)):
        for text, x, y, size, bold in labels:
            add_text(board, layer, text, x, y, size, bold)


def add_text(board, layer, text, x, y, size, bold):
    t = pcbnew.PCB_TEXT(board)
    t.SetText(text)
    t.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
    t.SetLayer(layer)
    t.SetMirrored(layer == pcbnew.B_SilkS)
    t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
    t.SetTextThickness(mm(max(size * (0.2 if bold else 0.15), 0.15)))
    t.SetBold(bold)
    if text.startswith("<"):  # terminal pin label: left-aligned, points at the pin
        t.SetText(text[1:])
        t.SetHorizJustify(pcbnew.GR_TEXT_H_ALIGN_LEFT)
    board.Add(t)


# Module references sit inside their outlines (set by the footprints); H* are board-only.
FIXED_REFS = ("U1", "M1", "M2", "M3", "M4")


def outline_boxes(item):
    """A silkscreen rectangle only blocks its four edges, so a reference may sit inside a part's body."""
    bb = item.GetBoundingBox()
    item = item.Cast()
    if item.GetClass() != "PCB_SHAPE" or item.GetShape() not in (pcbnew.SHAPE_T_RECT, pcbnew.SHAPE_T_RECTANGLE):
        return [bb]
    w = item.GetWidth()
    x1, y1, x2, y2 = bb.GetLeft(), bb.GetTop(), bb.GetRight(), bb.GetBottom()
    edge = lambda ax, ay, bx, by: pcbnew.BOX2I(pcbnew.VECTOR2I(ax, ay), pcbnew.VECTOR2L(bx - ax, by - ay))
    return [edge(x1, y1, x2, y1 + w), edge(x1, y2 - w, x2, y2), edge(x1, y1, x1 + w, y2), edge(x2 - w, y1, x2, y2)]


def silk_obstacles(board, skip):
    # `skip` is a reference designator: SWIG hands out a new proxy per call, so `is` can't match fields.
    """Boxes a reference text must not touch: every pad, every front silkscreen item."""
    boxes = []
    for fp in footprints_of(board):
        pads = fp.Pads()
        boxes += [pads[i].GetBoundingBox() for i in range(len(pads))]
        items = fp.GraphicalItems()
        for i in range(len(items)):
            if items[i].GetLayer() == pcbnew.F_SilkS:
                boxes += outline_boxes(items[i])
        ref = fp.Reference()
        if fp.GetReference() != skip and ref.IsVisible() and ref.GetLayer() == pcbnew.F_SilkS:
            boxes.append(ref.GetBoundingBox())
    drawings = board.GetDrawings()
    boxes += [drawings[i].GetBoundingBox() for i in range(len(drawings)) if drawings[i].GetLayer() == pcbnew.F_SilkS]
    return boxes


def place_refs(board):
    """Put each small part's reference beside it where it touches no pad or other silkscreen; hide it otherwise."""
    inner = pcbnew.BOX2I(pcbnew.VECTOR2I(mm(X0 + 0.5), mm(Y0 + 0.5)), pcbnew.VECTOR2L(mm(W - 1.0), mm(H - 1.0)))
    hidden = []
    for fp in sorted(footprints_of(board), key=lambda f: f.GetReference()):
        if fp.GetReference() in FIXED_REFS or fp.GetReference().startswith("H"):
            continue
        ref = fp.Reference()
        ref.SetTextAngle(pcbnew.EDA_ANGLE(0, pcbnew.DEGREES_T))
        ref.SetVisible(True)
        cy = fp.GetCourtyard(pcbnew.F_CrtYd).BBox()
        cx, cyc = cy.GetCenter().x, cy.GetCenter().y
        bb = ref.GetBoundingBox()
        tw, th = bb.GetWidth(), bb.GetHeight()
        gap = mm(0.25)
        spots = [(cx, cy.GetTop() - th // 2 - gap), (cx, cy.GetBottom() + th // 2 + gap),
                 (cy.GetLeft() - tw // 2 - gap, cyc), (cy.GetRight() + tw // 2 + gap, cyc), (cx, cyc)]
        obstacles = silk_obstacles(board, fp.GetReference())
        for x, y in spots:
            ref.SetPosition(pcbnew.VECTOR2I(int(x), int(y)))
            box = ref.GetBoundingBox()
            box.Inflate(mm(0.15))
            if inner.Contains(box) and not any(box.Intersects(o) for o in obstacles):
                break
        else:
            ref.SetVisible(False)
            hidden.append(fp.GetReference())
    return hidden


def build(path):
    """Build the board bound to `path`. pcbnew.NewBoard writes an empty board there at once."""
    comps, nets = export_netlist()
    board = pcbnew.NewBoard(path)

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
    # they can never hang on a thermal-relief island.
    for ref in ("U1", "M1", "M2", "M3", "M4", "J3", "C1", "C2", "C3", "C4", "D5"):
        for pad in footprints[ref].Pads():
            if pad.GetNetname() == "GND":
                pad.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)

    add_outline(board)
    add_holes(board)
    add_labels(board)
    hidden = place_refs(board)
    if hidden:
        print("references hidden (no free spot):", ", ".join(hidden))
    title = board.GetTitleBlock()
    title.SetTitle("Hour Meter ESP32 V4 module carrier")
    title.SetRevision("C")
    title.SetCompany("totalizer-hour-meter")
    board.SetTitleBlock(title)
    return board


def footprints_of(board):
    # Index-based access: SWIG iterators are broken under Python 3.14.
    fps = board.Footprints()
    return [fps[i] for i in range(len(fps))]


def fab_box(fp):
    """Bounding box of the footprint's F.Fab drawing: the module or part body."""
    box = None
    items = fp.GraphicalItems()
    for i in range(len(items)):
        item = items[i]
        if item.GetLayer() == pcbnew.F_Fab and item.GetClass() != "PCB_TEXT":
            bb = item.GetBoundingBox()
            if box is None:
                box = bb
            else:
                box.Merge(bb)
    return box


# Parts too tall to sit under a module body (module underside ~11 mm, 817 ~10 mm).
TALL = ("C3", "F1", "J1", "J2", "J3", "D5")
MODULES = ("U1", "M1", "M2", "M3", "M4")


def overlaps(board):
    fps = {fp.GetReference(): fp for fp in footprints_of(board)}
    issues = []
    refs = sorted(fps)
    crt = {r: fps[r].GetCourtyard(pcbnew.F_CrtYd) for r in refs}
    for i in range(len(refs)):
        for j in range(i + 1, len(refs)):
            a, b = crt[refs[i]], crt[refs[j]]
            if a.OutlineCount() == 0 or b.OutlineCount() == 0:
                continue
            c = a.CloneDropTriangulation()
            c.BooleanIntersection(b)
            if c.Area() > 0:
                issues.append(f"courtyard {refs[i]} / {refs[j]}")
    # Module bodies at socket height must not touch each other (U1 / M2 / M3 / M4).
    bodies = {r: fab_box(fps[r]) for r in MODULES}
    flat = ("U1", "M2", "M3", "M4")
    for i in range(len(flat)):
        for j in range(i + 1, len(flat)):
            if bodies[flat[i]].Intersects(bodies[flat[j]]):
                issues.append(f"module body {flat[i]} / {flat[j]}")
    for t in TALL:
        cy = crt[t].BBox()
        for m in MODULES:
            if bodies[m].Intersects(cy):
                issues.append(f"tall part {t} under module {m}")
    edge = pcbnew.BOX2I(pcbnew.VECTOR2I(mm(X0), mm(Y0)), pcbnew.VECTOR2L(mm(W), mm(H)))
    for r in refs:
        bb = crt[r].BBox() if crt[r].OutlineCount() else fps[r].GetBoundingBox(False)
        if not edge.Contains(bb):
            issues.append(f"{r} courtyard outside board")
    return issues


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "place"
    target = PCB if mode == "place" else os.path.join(tempfile.mkdtemp(), "throwaway.kicad_pcb")
    board = build(target)
    issues = overlaps(board)
    print("placement issues:", issues or "none")
    if mode == "place":
        pcbnew.SaveBoard(PCB, board)
        print("saved", PCB)
