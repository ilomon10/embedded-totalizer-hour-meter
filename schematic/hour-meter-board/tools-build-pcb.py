#!/usr/bin/env python3
"""Build hour-meter-board.kicad_pcb (rev B) from the schematic, headless.

  1. kicad-cli exports the netlist of the whole hierarchy
  2. every footprint is loaded and placed so its courtyard centre lands on PLACEMENT
  3. nets are assigned to pads; outline, stackup and silkscreen are added

Usage:  python3 tools-build-pcb.py place   -> writes the placed (unrouted) board
        python3 tools-build-pcb.py check   -> only report courtyard overlaps / parts off the board

Coordinates are millimetres on the KiCad page; the board spans X 100..200, Y 100..190
(100 x 90 mm, 4 layers: F.Cu signal, In1.Cu GND plane, In2.Cu signal + 3V3 pour, B.Cu signal).
Move parts by editing PLACEMENT (x, y = courtyard centre, rotation, side). Netclasses live in
hour-meter-board.kicad_pro (set with Konnect create_netclass / assign_net_to_class).
The 2-layer variant (../hour-meter-board-2layer) is built by build(..., layers=2) from its own copy
of the schematic, with the same PLACEMENT.
"""
import math
import os
import subprocess
import sys
import xml.etree.ElementTree as ET
from typing import NamedTuple

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
SCH = os.path.join(HERE, "hour-meter-board.kicad_sch")
PCB = os.path.join(HERE, "hour-meter-board.kicad_pcb")
SYS_FP = "/usr/share/kicad/footprints"

X0, Y0, W, H = 100.0, 100.0, 100.0, 90.0

# Areas shared with tools-route-pcb.py: (x1, y1, x2, y2)
PSU_AREA = (112.0, 101.0, 152.0, 131.0)          # plug-on PSU-B board outline (parts below stay <= 5 mm tall)
VEHICLE_AREA = (100.0, 131.0, 135.5, 155.0)      # opto input side, up to the middle of the optos: no pours
ANTENNA_KEEPOUT = (151.75, 100.0, 200.0, 106.6)  # ESP32 antenna band (its courtyard): no copper on any layer

# Parts whose courtyard may leave the board: the ESP32 antenna keep-out and the USB-C lip.
OVERHANG = {"U201", "J201"}

# ref: (x, y, rotation_deg, side) - x, y = courtyard centre
PLACEMENT = {
    # --- mechanical: corner holes (top-right corner is the antenna band, so H103 sits lower) ---
    "H102": (104.0, 104.0, 0, "F"), "H103": (196.0, 124.5, 0, "F"),
    "H104": (104.0, 186.0, 0, "F"), "H105": (196.0, 186.0, 0, "F"),
    # --- field wiring, left edge (wires enter from the left) ---
    "J101": (106.5, 114.0, 270, "F"),   # VIN 9-36 V
    "J301": (106.5, 141.0, 270, "F"),   # ALT / PULSE / VEH_GND
    "J701": (106.5, 168.0, 270, "F"),   # RS485 A / B / GND
    # --- power input, under the PSU-B board ---
    "F101": (116.0, 105.0, 0, "F"),
    "J102": (119.0, 117.0, 0, "F"),     # PSU-B socket
    "D101": (126.0, 117.0, 90, "F"),
    "D102": (124.5, 105.5, 0, "F"), "R101": (130.5, 105.5, 0, "F"),
    "R102": (134.5, 106.0, 90, "F"), "C101": (137.0, 106.0, 90, "F"),
    "H101": (148.0, 127.0, 0, "F"),     # PSU-B standoff
    # --- ESP32 core: module on the top edge, antenna up (courtyard band hangs over the edge) ---
    "U201": (176.0, 105.52, 0, "F"),    # courtyard centre; module top edge = board edge
    "U204": (156.5, 113.0, 0, "F"),
    "C201": (162.3, 109.5, 90, "F"), "C202": (162.3, 113.5, 90, "F"),   # leave an escape channel left of the module
    "C205": (154.0, 120.0, 90, "F"), "C206": (157.5, 120.0, 90, "F"), "C207": (160.5, 120.0, 90, "F"),
    "D202": (156.0, 124.5, 0, "F"), "R209": (160.0, 124.5, 0, "F"),
    "D203": (156.0, 127.5, 0, "F"), "R210": (160.0, 127.5, 0, "F"),
    "R201": (157.0, 130.5, 0, "F"), "C203": (161.0, 130.5, 0, "F"),
    # the module's right-hand pins need an escape channel, so their resistors sit with the circuits they serve
    "R211": (157.5, 152.5, 0, "F"), "R212": (161.5, 152.5, 0, "F"),   # I2C pull-ups, next to the RTC
    "R202": (171.0, 148.5, 0, "F"),                                     # IO0 pull-up, next to Q202
    "R203": (176.5, 146.5, 0, "F"), "R204": (180.5, 146.5, 0, "F"),   # UART0 series, next to the CH340C
    # USB-C, ESD, CH340C and auto-program, right edge
    "J201": (195.0, 136.0, 90, "F"),
    "U203": (187.0, 133.0, 90, "F"), "R207": (187.0, 129.0, 0, "F"), "R208": (187.0, 138.0, 0, "F"),
    "F201": (191.0, 144.5, 0, "F"), "D201": (186.0, 145.0, 0, "F"),
    "U202": (179.0, 139.0, 0, "F"), "C204": (179.0, 131.8, 0, "F"), "R213": (174.0, 131.8, 0, "F"),
    "Q201": (171.0, 139.0, 0, "F"), "Q202": (171.0, 144.5, 0, "F"),
    "R205": (166.5, 139.0, 0, "F"), "R206": (166.5, 144.5, 0, "F"),
    "SW201": (194.5, 149.0, 0, "F"), "SW202": (194.5, 155.5, 0, "F"),
    # --- opto inputs (vehicle side left of the optos) ---
    "R301": (116.0, 135.0, 0, "F"), "R302": (121.0, 135.0, 0, "F"), "R303": (126.0, 135.0, 0, "F"),
    "D301": (117.5, 139.0, 0, "F"), "D302": (124.0, 139.0, 0, "F"), "R304": (127.5, 139.0, 90, "F"),
    "U301": (135.5, 137.0, 0, "F"),
    "R305": (145.0, 135.5, 0, "F"), "C301": (145.0, 138.5, 0, "F"),
    "R306": (116.0, 145.0, 0, "F"), "R307": (121.0, 145.0, 0, "F"), "R308": (126.0, 145.0, 0, "F"),
    "D303": (117.5, 149.0, 0, "F"), "D304": (124.0, 149.0, 0, "F"), "R309": (127.5, 149.0, 90, "F"),
    "U302": (135.5, 147.0, 0, "F"),
    "R310": (145.0, 145.5, 0, "F"), "C302": (145.0, 148.5, 0, "F"),
    "JP301": (116.0, 156.3, 0, "F"),   # just outside VEHICLE_AREA: its GND pad needs the plane
    # --- RS485 ---
    "D701": (116.0, 160.0, 0, "F"),
    "U701": (125.0, 162.0, 0, "F"), "C701": (125.0, 157.5, 0, "F"),
    "R701": (133.0, 159.5, 0, "F"), "R702": (133.0, 162.0, 0, "F"), "R703": (133.0, 164.5, 0, "F"),
    "R704": (117.0, 168.0, 0, "F"), "J702": (117.0, 173.5, 0, "F"),
    "J703": (126.0, 171.0, 0, "F"),
    "R705": (133.0, 169.0, 0, "F"), "R706": (133.0, 172.0, 0, "F"),
    # --- RTC + coin cell, EEPROM socket ---
    "BT401": (154.0, 176.5, 0, "F"),
    "U401": (152.0, 157.0, 0, "F"), "C401": (152.0, 152.5, 0, "F"), "C402": (147.0, 157.0, 90, "F"),
    "R401": (157.0, 157.0, 90, "F"),
    "U501": (159.3, 143.0, 0, "F"), "C501": (161.0, 135.5, 0, "F"),
    "J501": (151.0, 142.0, 0, "F"), "R501": (151.0, 148.0, 0, "F"),
    # --- IMU: away from the PSU, the coin cell, the terminals and the USB shell ---
    "U601": (186.0, 163.0, 0, "F"), "U602": (186.0, 169.5, 0, "F"),
    "C601": (180.5, 162.0, 90, "F"), "C603": (180.5, 165.5, 90, "F"), "C604": (180.5, 169.0, 90, "F"),
    "C602": (191.5, 162.0, 90, "F"), "C605": (191.5, 165.5, 90, "F"), "C606": (191.5, 168.5, 90, "F"),
    # --- ports, bottom-right ---
    "J804": (192.0, 113.6, 0, "F"),   # expansion header right next to the module pins it serves
    "U801": (172.0, 168.0, 0, "F"), "C801": (175.5, 168.0, 90, "F"), "R802": (171.0, 171.5, 0, "F"),
    "F801": (171.0, 175.5, 0, "F"), "R801": (171.0, 179.0, 0, "F"),
    "J801": (176.0, 185.5, 0, "F"),
    "J803": (178.0, 176.0, 0, "F"),
    "U802": (185.0, 176.0, 0, "F"),
    "R806": (184.0, 172.5, 0, "F"), "R807": (187.5, 188.3, 0, "F"),
    "R803": (185.0, 180.5, 0, "F"), "R804": (185.0, 183.0, 0, "F"), "R805": (185.0, 185.5, 0, "F"),
    "J802": (190.0, 179.0, 0, "F"),
    "JP801": (194.5, 175.0, 0, "F"),
}

# Silkscreen labels: (text, x, y, size_mm, bold)
LABELS = [
    ("HOUR METER  rev B", 150.0, 189.0, 1.2, True),
    ("PSU-B 9-36V -> 5.3V (plug-on)", 132.0, 102.5, 1.0, True),
    ("VEHICLE SIDE - ISOLATED", 120.0, 132.3, 0.9, True),
]

class Layout(NamedTuple):
    """Everything about a board's geometry that the build, route and finish scripts use. A variant
    with its own outline and placement (../hour-meter-board-compact) sets LAYOUT to its own."""
    outline: tuple            # (x0, y0, w, h)
    psu_area: tuple           # (x1, y1, x2, y2): where PSU-B sits; parts below it stay <= 5 mm tall
    vehicle_area: tuple       # (x1, y1, x2, y2): isolated opto input side, no pours
    antenna_keepout: tuple    # (x1, y1, x2, y2): ESP32 antenna band, no copper on any layer
    overhang: frozenset       # parts whose courtyard may leave the board
    placement: dict           # ref: (x, y, rotation_deg, side), x, y = courtyard centre
    labels: list              # silkscreen labels: (text, x, y, size_mm, bold)
    slots: tuple = ()         # milled slots: ((x1, y1), (x2, y2), width) centre line, rounded ends


LAYOUT = Layout((X0, Y0, W, H), PSU_AREA, VEHICLE_AREA, ANTENNA_KEEPOUT, frozenset(OVERHANG), PLACEMENT, LABELS)

STANDARD_FIELDS = {"Reference", "Value", "Footprint", "Datasheet", "Description"}
REF_TEXT_MM = 0.8   # small reference designators keep the dense areas readable


def mm(v):
    return pcbnew.FromMM(v)


def routing_dir(pcb):
    """The git-ignored work folder next to a board: DSN/SES files, routing tries, DRC reports."""
    work = os.path.join(os.path.dirname(pcb), "routing")
    os.makedirs(work, exist_ok=True)
    return work


def throwaway(pcb):
    """Where a dry run builds instead of `pcb`: pcbnew.NewBoard() writes an empty board to its path at once."""
    return os.path.join(routing_dir(pcb), "check-" + os.path.basename(pcb))


def export_netlist(sch=SCH):
    out = os.path.splitext(sch)[0] + ".net.xml"
    subprocess.run(["kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", out, sch],
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
            "extra": {k: v for k, v in fields.items() if k not in STANDARD_FIELDS},   # LCSC, MPN, ...
            "in_bom": not any(p.get("name") == "exclude_from_bom" for p in c.iter("property")),
            "path": sheet + c.findtext("tstamps"),   # links footprint <-> schematic symbol
        }
    nets = []
    for n in root.iter("net"):
        nets.append((n.get("name"), [(x.get("ref"), x.get("pin")) for x in n.iter("node")]))
    os.remove(out)
    return comps, nets


def load_fp(fpid):
    lib, name = fpid.split(":", 1)
    fp = pcbnew.FootprintLoad(os.path.join(SYS_FP, lib + ".pretty"), name)
    if fp is None:
        raise SystemExit(f"footprint not found: {fpid}")
    fp.SetFPID(pcbnew.LIB_ID(lib, name))
    return fp


def courtyard(fp):
    """The footprint's courtyard polygon set (empty if it has none)."""
    return fp.GetCourtyard(pcbnew.F_Cu if fp.GetLayer() == pcbnew.F_Cu else pcbnew.B_Cu)


def courtyard_box(fp):
    poly = courtyard(fp)
    return poly.BBox() if poly.OutlineCount() else fp.GetBoundingBox(False)


def place(fp, x, y, rot, side):
    fp.SetOrientationDegrees(rot)
    fp.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
    if side == "B":
        fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
    box = courtyard_box(fp)
    centre = box.GetCenter()
    fp.Move(pcbnew.VECTOR2I(mm(x) - centre.x, mm(y) - centre.y))


def rect_shape(board, layer, rect, width=0.1):
    x1, y1, x2, y2 = rect
    pts = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
    for i in range(4):
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetStart(pcbnew.VECTOR2I(mm(pts[i][0]), mm(pts[i][1])))
        seg.SetEnd(pcbnew.VECTOR2I(mm(pts[(i + 1) % 4][0]), mm(pts[(i + 1) % 4][1])))
        seg.SetLayer(layer)
        seg.SetWidth(mm(width))
        board.Add(seg)


def add_slot(board, slot):
    """A milled slot on Edge.Cuts: two straight sides and two rounded ends around the centre line."""
    (x1, y1), (x2, y2), width = slot
    length = math.hypot(x2 - x1, y2 - y1)
    dx, dy = (x2 - x1) / length, (y2 - y1) / length
    nx, ny, r = -dy, dx, width / 2

    def pt(x, y):
        return pcbnew.VECTOR2I(mm(x), mm(y))

    for (ax, ay), (bx, by) in (((x1 + nx * r, y1 + ny * r), (x2 + nx * r, y2 + ny * r)),
                               ((x2 - nx * r, y2 - ny * r), (x1 - nx * r, y1 - ny * r))):
        seg = pcbnew.PCB_SHAPE(board)
        seg.SetShape(pcbnew.SHAPE_T_SEGMENT)
        seg.SetStart(pt(ax, ay))
        seg.SetEnd(pt(bx, by))
        seg.SetLayer(pcbnew.Edge_Cuts)
        seg.SetWidth(mm(0.1))
        board.Add(seg)
    for (cx, cy), sign in (((x2, y2), 1), ((x1, y1), -1)):
        arc = pcbnew.PCB_SHAPE(board)
        arc.SetShape(pcbnew.SHAPE_T_ARC)
        arc.SetArcGeometry(pt(cx + sign * nx * r, cy + sign * ny * r), pt(cx + sign * dx * r, cy + sign * dy * r),
                           pt(cx - sign * nx * r, cy - sign * ny * r))
        arc.SetLayer(pcbnew.Edge_Cuts)
        arc.SetWidth(mm(0.1))
        board.Add(arc)


def add_labels(board, labels=LABELS):
    for text, x, y, size, bold in labels:
        t = pcbnew.PCB_TEXT(board)
        t.SetText(text)
        t.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
        t.SetLayer(pcbnew.F_SilkS)
        t.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
        t.SetTextThickness(mm(size * (0.2 if bold else 0.15)))
        t.SetBold(bold)
        board.Add(t)


ORDER_MARK = "JLCJLCJLCJLC"   # JLCPCB prints its order number here when the order says "Specify Position"


def add_order_mark(board, side, near, size=1.0, thickness=0.15, clearance=0.3, search=30.0):
    """JLCPCB's order-number placeholder on the top ("F") or bottom ("B") silkscreen, at the free spot nearest
    `near` (x, y). Free: clear of pads, holes, courtyards and silkscreen on that side, and inside the board
    outline by `clearance` (slots included). JLCPCB wants the text alone, >= 0.8 mm high and 0.15 mm thick;
    1.0 mm is its silkscreen minimum. An existing mark is replaced. Returns (x, y), or raises if nothing fits."""
    layer = pcbnew.F_SilkS if side == "F" else pcbnew.B_SilkS
    drawings = board.Drawings()
    for item in [drawings[i] for i in range(len(drawings))]:
        if item.GetClass() == "PCB_TEXT" and item.Cast().GetText() == ORDER_MARK:
            board.Remove(item)
    text = pcbnew.PCB_TEXT(board)
    text.SetText(ORDER_MARK)
    text.SetLayer(layer)
    text.SetMirrored(side == "B")
    text.SetTextSize(pcbnew.VECTOR2I(mm(size), mm(size)))
    text.SetTextThickness(mm(thickness))
    gap = mm(clearance)

    obstacles = []   # boxes in board units
    fps = board.Footprints()
    copper = pcbnew.F_Cu if side == "F" else pcbnew.B_Cu
    court = pcbnew.F_CrtYd if side == "F" else pcbnew.B_CrtYd
    for fp in (fps[i] for i in range(len(fps))):
        for p in fp.Pads():
            if p.IsOnLayer(copper) or p.GetDrillSizeX() > 0:
                obstacles.append(p.GetBoundingBox())
        if fp.GetLayer() == copper:
            obstacles.append(courtyard_box(fp))
        for g in fp.GraphicalItems():
            if g.GetLayer() == layer:
                obstacles.append(g.GetBoundingBox())
        for t in (fp.Reference(), fp.Value()):
            if t.IsVisible() and t.GetLayer() == layer:
                obstacles.append(t.GetBoundingBox())
    for item in (drawings[i] for i in range(len(drawings))):
        if item.GetLayer() == layer:
            obstacles.append(item.GetBoundingBox())
    edges = [d for d in (drawings[i] for i in range(len(drawings))) if d.GetLayer() == pcbnew.Edge_Cuts]
    outline = board.GetBoardEdgesBoundingBox()

    def fits(x, y):
        text.SetPosition(pcbnew.VECTOR2I(mm(x), mm(y)))
        box = text.GetBoundingBox()
        box.Inflate(gap)
        if not (outline.Contains(box.GetOrigin()) and outline.Contains(box.GetEnd())):
            return False
        return not any(box.Intersects(o) for o in obstacles) and not any(box.Intersects(e.GetBoundingBox()) and
                                                                         _crosses_edge(e, box) for e in edges)

    x0, y0 = near
    step = 0.5
    for ring in range(int(search / step) + 1):          # square spiral outwards from `near`
        r = ring * step
        candidates = [(x0, y0)] if ring == 0 else [(x0 + dx * step, y0 + dy * step)
                                                     for dx in range(-ring, ring + 1) for dy in (-ring, ring)] + \
            [(x0 + dx * step, y0 + dy * step) for dy in range(-ring + 1, ring) for dx in (-ring, ring)]
        for x, y in sorted(candidates, key=lambda c: math.hypot(c[0] - x0, c[1] - y0)):
            if fits(x, y):
                board.Add(text)
                return (x, y)
    raise RuntimeError(f"no free {size} mm spot for {ORDER_MARK} within {search} mm of {near}")


def _crosses_edge(shape, box):
    """True if an Edge.Cuts shape (outline segment, slot side or arc) passes through `box`."""
    poly = pcbnew.SHAPE_RECT(box.GetX(), box.GetY(), box.GetWidth(), box.GetHeight())
    return shape.GetEffectiveShape().Collide(poly, 0)


def setup_board(board, layers=4):
    board.SetCopperLayerCount(layers)
    if layers == 4:
        board.SetLayerName(pcbnew.In1_Cu, "In1.Cu")
        board.SetLayerName(pcbnew.In2_Cu, "In2.Cu")
        board.SetLayerType(pcbnew.In1_Cu, pcbnew.LT_POWER)
        board.SetLayerType(pcbnew.In2_Cu, pcbnew.LT_SIGNAL)   # routed, then poured with +3V3
    # JLCPCB minimums (2026-10): track 0.09 mm on 4 layers, 0.10 mm on 2; via hole 0.15 mm on both,
    # and holes of 0.2-0.25 mm cost nothing extra while the via diameter is >= 0.45 mm
    ds = board.GetDesignSettings()
    ds.m_TrackMinWidth = mm(0.1)    # Freerouting necks down to 0.1 mm at fine-pitch pads
    ds.m_MinClearance = mm(0.15)
    ds.m_ViasMinSize = mm(0.45)
    ds.m_MinThroughDrill = mm(0.2)   # ESP32 thermal-pad vias are 0.2 mm
    ds.m_HoleToHoleMin = mm(0.25)
    ds.m_CopperEdgeClearance = mm(0.3)


def add_footprints_and_nets(board, comps, nets, placement):
    """Load every netlist footprint, place it from `placement`, and give each pad its net."""
    footprints = {}
    missing = [ref for ref in comps if ref not in placement]
    if missing:
        raise SystemExit(f"no placement for: {', '.join(sorted(missing))}")
    for ref, comp in sorted(comps.items()):
        fpid = comp["footprint"]
        if not fpid:
            raise SystemExit(f"{ref} has no footprint")
        fp = load_fp(fpid)
        fp.SetReference(ref)
        fp.SetValue(comp["value"])
        fp.SetPath(pcbnew.KIID_PATH(comp["path"]))
        fp.GetField(pcbnew.FIELD_T_DATASHEET).SetText(comp["datasheet"])
        fp.GetField(pcbnew.FIELD_T_DESCRIPTION).SetText(comp["description"])
        fp.SetExcludedFromBOM(not comp["in_bom"])   # the symbol decides, as DRC's parity check expects
        for name, text in comp["extra"].items():   # keeps DRC's schematic-parity check quiet
            fp.SetField(name, text)
            fp.GetField(name).SetVisible(False)
        ref_text = fp.Reference()
        ref_text.SetTextSize(pcbnew.VECTOR2I(mm(REF_TEXT_MM), mm(REF_TEXT_MM)))
        ref_text.SetTextThickness(mm(REF_TEXT_MM * 0.15))
        board.Add(fp)
        place(fp, *placement[ref])
        footprints[ref] = fp

    for name, nodes in nets:
        if name.startswith(("unconnected-(", "Net-(")):
            name = name.replace("/", "{slash}")   # matches eeschema's escaping of pin names
        net = pcbnew.NETINFO_ITEM(board, name)
        board.Add(net)
        for ref, pin in nodes:
            for pad in footprints[ref].Pads():
                if pad.GetNumber() == pin:
                    pad.SetNet(net)
    return footprints


def add_track(board, footprints, ref, pad_a, pad_b, layer, width):
    """A straight pre-route between two pads of one footprint (Freerouting keeps it)."""
    pads = {p.GetNumber(): p for p in footprints[ref].Pads()}
    track = pcbnew.PCB_TRACK(board)
    track.SetStart(pads[pad_a].GetPosition())
    track.SetEnd(pads[pad_b].GetPosition())
    track.SetLayer(layer)
    track.SetWidth(mm(width))
    track.SetNet(pads[pad_a].GetNet())
    board.Add(track)


def build(sch=SCH, pcb=PCB, layers=4):
    comps, nets = export_netlist(sch)
    board = pcbnew.NewBoard(pcb)   # an empty board bound to this project, written to `pcb` at once
    setup_board(board, layers)
    footprints = add_footprints_and_nets(board, comps, nets, LAYOUT.placement)
    if "J102" in footprints:   # boards with the PSU-B socket (the LM2596 variant has none)
        add_track(board, footprints, "J102", "3", "4", pcbnew.B_Cu, 0.8)   # the two +5V_PSU pins
    x0, y0, w, h = LAYOUT.outline
    rect_shape(board, pcbnew.Edge_Cuts, (x0, y0, x0 + w, y0 + h))
    for slot in LAYOUT.slots:
        add_slot(board, slot)
    if LAYOUT.psu_area:
        rect_shape(board, pcbnew.F_SilkS, LAYOUT.psu_area, 0.15)     # where the PSU-B board sits
    add_labels(board, LAYOUT.labels)
    title = board.GetTitleBlock()
    title.SetTitle("Hour Meter main board")
    title.SetRevision("B")
    title.SetCompany("totalizer-hour-meter")
    board.SetTitleBlock(title)
    return board


def footprints_of(board):
    fps = board.Footprints()   # index access: SWIG iterators are unreliable under Python 3.14
    return [fps[i] for i in range(len(fps))]


def pads_box(fp):
    pads = fp.Pads()
    box = pads[0].GetBoundingBox()
    for i in range(1, len(pads)):
        box.Merge(pads[i].GetBoundingBox())
    return box


def courtyard_overlaps(board, outline=None, overhang=None):
    """Courtyard polygons that intersect, and parts whose courtyard (or pads) leave the board."""
    x0, y0, w, h = outline or LAYOUT.outline
    overhang = LAYOUT.overhang if overhang is None else overhang
    items = [(fp.GetReference(), fp, courtyard(fp), courtyard_box(fp)) for fp in footprints_of(board)]
    issues = []
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            (ra, fa, pa, ba), (rb, fb, pb, bb) = items[i], items[j]
            if fa.GetLayer() != fb.GetLayer() or not ba.Intersects(bb):
                continue
            if not (pa.OutlineCount() and pb.OutlineCount()):
                issues.append(f"{ra} overlaps {rb}")
                continue
            common = pcbnew.SHAPE_POLY_SET(pa)
            common.BooleanIntersection(pb)
            if common.OutlineCount() and common.Area() > 0:
                issues.append(f"{ra} overlaps {rb}")
    edge = pcbnew.BOX2I(pcbnew.VECTOR2I(mm(x0), mm(y0)), pcbnew.VECTOR2L(mm(w), mm(h)))
    for ref, fp, _, box in items:
        inside = edge.Contains(pads_box(fp)) if ref in overhang else edge.Contains(box)
        if not inside:
            issues.append(f"{ref} outside board")
    return issues


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "place"
    board = build(pcb=PCB if mode == "place" else throwaway(PCB))
    issues = courtyard_overlaps(board)
    print(f"courtyard issues ({len(issues)}):", "; ".join(issues) or "none")
    if mode == "place":
        pcbnew.SaveBoard(PCB, board)
        print("saved", PCB)
