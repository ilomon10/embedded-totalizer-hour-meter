#!/usr/bin/env python3
"""Build and route hour-meter-psu-b.kicad_pcb (40 x 30 mm, 2 layers), headless.

  python3 tools-pcb.py check   -> courtyard overlaps / parts off the board only
  python3 tools-pcb.py place   -> placed, unrouted board
  python3 tools-pcb.py route   -> place + Freerouting + GND pours on both layers

The board sits on the main board's PSU area (X 113..153, Y 101..131 there). Local coordinates are
X 100..140, Y 100..130, i.e. main = local + (13, 1). H1 lines up with H101.

P1 is the 2x3 pin header that plugs into the main board's socket J102, so it is mounted on the
BOTTOM of this board and placed on B.Cu. That matters: KiCad's PinSocket footprint is the mirror
image of its PinHeader footprint (seen from the top, socket pin 2 is LEFT of pin 1, header pin 2 is
right of it). Only a header flipped to the bottom has the socket's pad layout, so that pin n lands
on pin n. P1 is positioned by its pad 1 (not its courtyard, which differs from the socket's), and
the build stops if any P1 pad misses the matching J102 pad.
"""
import importlib.util
import os
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
SCH = os.path.join(HERE, "hour-meter-psu-b.kicad_sch")
PCB = os.path.join(HERE, "hour-meter-psu-b.kicad_pcb")
DSN = os.path.join(HERE, "routing", "hour-meter-psu-b.dsn")
SES = os.path.join(HERE, "routing", "hour-meter-psu-b.ses")
FREEROUTING = os.path.expanduser("~/.local/opt/freerouting-2.5.0/freerouting-2.5.0.jar")

_spec = importlib.util.spec_from_file_location(
    "main_build", os.path.join(HERE, "..", "hour-meter-board", "tools-build-pcb.py"))
lib = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lib)
mm = lib.mm

X0, Y0, W, H = 100.0, 100.0, 40.0, 30.0
MAIN_OFFSET = (13.0, 1.0)   # main-board coordinates = local + offset


def from_main(ref):
    x, y, rot, side = lib.PLACEMENT[ref]
    return (x - MAIN_OFFSET[0], y - MAIN_OFFSET[1], rot, side)


def main_pads(ref):
    """Pad positions (local coordinates) of a main-board footprint, placed as the main board does."""
    comps, _ = lib.export_netlist(lib.SCH)
    fp = lib.load_fp(comps[ref]["footprint"])
    lib.place(fp, *lib.PLACEMENT[ref])
    return {p.GetNumber(): (pcbnew.ToMM(p.GetPosition().x) - MAIN_OFFSET[0], pcbnew.ToMM(p.GetPosition().y) - MAIN_OFFSET[1])
            for p in fp.Pads()}


def mate_with_socket(fp, socket):
    """Flip the header to B.Cu and move it so each of its pads sits on the socket pad of the same number."""
    if fp.GetLayer() != pcbnew.B_Cu:
        fp.Flip(fp.GetPosition(), pcbnew.FLIP_DIRECTION_LEFT_RIGHT)
    pad1 = next(p for p in fp.Pads() if p.GetNumber() == "1").GetPosition()
    x1, y1 = socket["1"]
    fp.Move(pcbnew.VECTOR2I(mm(x1) - pad1.x, mm(y1) - pad1.y))
    for p in fp.Pads():
        x, y = socket[p.GetNumber()]
        dx, dy = pcbnew.ToMM(p.GetPosition().x) - x, pcbnew.ToMM(p.GetPosition().y) - y
        if abs(dx) > 0.01 or abs(dy) > 0.01:
            raise SystemExit(f"P1 pad {p.GetNumber()} misses J102 pad {p.GetNumber()} by ({dx:.2f}, {dy:.2f}) mm")


# ref: (x, y, rotation_deg, side) - x, y = courtyard centre
PLACEMENT = {
    "P1": from_main("J102"),
    "H1": from_main("H101"),
    # input: TVS -> reverse diode -> bulk + ceramics
    "D1": (104.0, 105.0, 90, "F"), "D2": (109.0, 105.0, 90, "F"),
    "C1": (116.0, 106.0, 0, "F"),
    "C2": (123.0, 103.8, 90, "F"), "C3": (126.5, 103.8, 90, "F"), "C4": (129.5, 103.8, 90, "F"),
    # converter
    "U1": (125.0, 112.0, 0, "F"),
    "R1": (119.5, 113.0, 90, "F"), "R2": (119.5, 117.5, 90, "F"), "R3": (121.5, 118.5, 90, "F"),
    "C5": (125.0, 107.6, 0, "F"),   # BOOT (pin 1) to SW (pin 8), across the top of U1
    "L1": (135.0, 106.0, 0, "F"),
    "D3": (133.0, 116.0, 90, "F"),
    "C6": (138.0, 114.0, 90, "F"), "C7": (138.0, 119.0, 90, "F"),
    # feedback, compensation, LED
    "R5": (126.0, 119.0, 0, "F"), "R6": (126.0, 121.5, 0, "F"),
    "R4": (130.0, 123.0, 0, "F"), "C8": (130.0, 125.5, 0, "F"), "C9": (126.0, 124.5, 0, "F"),
    "R7": (113.0, 127.0, 0, "F"), "D4": (117.0, 127.0, 0, "F"),
}

LABELS = [
    ("PSU-B 9-36V>5.3V", 112.0, 129.0, 0.9, True),
    ("P1 header on the BOTTOM side", 110.0, 121.5, 0.8, False),
]


def build():
    comps, nets = lib.export_netlist(SCH)
    board = pcbnew.NewBoard(PCB)
    ds = board.GetDesignSettings()
    ds.m_TrackMinWidth = mm(0.15)
    ds.m_MinClearance = mm(0.15)
    ds.m_ViasMinSize = mm(0.5)
    ds.m_MinThroughDrill = mm(0.3)
    ds.m_CopperEdgeClearance = mm(0.3)
    footprints = lib.add_footprints_and_nets(board, comps, nets, PLACEMENT)
    mate_with_socket(footprints["P1"], main_pads("J102"))
    # The power path's GND pads carry the switching return current (TI: solid GND under U1); a solid
    # pour connection also means they can never hang on a thermal-relief island after a re-route.
    for ref in ("P1", "U1", "D1", "D3", "C1", "C2", "C3", "C4", "C6", "C7"):
        for pad in footprints[ref].Pads():
            if pad.GetNetname() == "GND":
                pad.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)
    lib.rect_shape(board, pcbnew.Edge_Cuts, (X0, Y0, X0 + W, Y0 + H))
    lib.add_labels(board, LABELS)
    title = board.GetTitleBlock()
    title.SetTitle("Hour Meter PSU-B (9-36 V -> 5.3 V)")
    title.SetRevision("B")
    title.SetCompany("totalizer-hour-meter")
    board.SetTitleBlock(title)
    return board


def add_gnd_pour(board, layer):
    zone = pcbnew.ZONE(board)
    zone.SetLayer(layer)
    zone.SetNet(board.FindNet("GND"))
    inset = 0.5
    pts = [(X0 + inset, Y0 + inset), (X0 + W - inset, Y0 + inset), (X0 + W - inset, Y0 + H - inset), (X0 + inset, Y0 + H - inset)]
    chain = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in pts:
        chain.Append(mm(x), mm(y))
    chain.SetClosed(True)
    zone.Outline().AddOutline(chain)
    zone.SetLocalClearance(mm(0.3))
    zone.SetMinThickness(mm(0.25))
    zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
    zone.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)
    board.Add(zone)


def route(board):
    os.makedirs(os.path.dirname(DSN), exist_ok=True)
    if not pcbnew.ExportSpecctraDSN(board, DSN):
        raise SystemExit("DSN export failed")
    if os.path.exists(SES):
        os.remove(SES)
    subprocess.run(["java", "-jar", FREEROUTING, "--gui.enabled=false", "-de", DSN, "-do", SES, "-mp", "100", "-mt", "4"],
                   check=True, timeout=900)
    if not pcbnew.ImportSpecctraSES(board, SES):
        raise SystemExit("SES import failed")
    add_gnd_pour(board, pcbnew.F_Cu)
    add_gnd_pour(board, pcbnew.B_Cu)
    zones = board.Zones()
    pcbnew.ZONE_FILLER(board).Fill(pcbnew.ZONES([zones[i] for i in range(len(zones))]))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    board = build()
    issues = lib.courtyard_overlaps(board, (X0, Y0, W, H))
    print(f"courtyard issues ({len(issues)}):", "; ".join(issues) or "none")
    if mode in ("place", "route"):
        pcbnew.SaveBoard(PCB, board)
        if mode == "route":
            board = pcbnew.LoadBoard(PCB)
            route(board)
            pcbnew.SaveBoard(PCB, board)
        print("saved", PCB)
