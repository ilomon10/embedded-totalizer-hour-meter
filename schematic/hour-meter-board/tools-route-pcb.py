#!/usr/bin/env python3
"""Route the placed rev-B board: planes + keep-outs -> Specctra DSN -> Freerouting -> SES -> pours.

Run after tools-build-pcb.py place:   python3 tools-route-pcb.py [tries]
Freerouting gives a different result each run; with tries > 1 the board with the fewest
connections left unrouted (by KiCad's DRC) is kept. Every try reads the placed board, so
re-run tools-build-pcb.py place before routing again.

In1.Cu is a solid GND plane (a 'power' layer), so Freerouting routes on F.Cu, In2.Cu and B.Cu
and reaches GND through vias. After routing, a +3V3 pour fills the free space on In2.Cu and GND
pours fill F.Cu and B.Cu. Every plane and pour skips the opto input side (VEHICLE_AREA,
a notch in the outline, so Freerouting sees the real copper), and the ESP32 antenna area gets no
copper at all. (A rule area would not do for the vehicle side: KiCad exports every rule area to
Freerouting as a routing keep-out.)
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, "hour-meter-board.kicad_pcb")
DSN = os.path.join(HERE, "routing", "hour-meter-board.dsn")
SES = os.path.join(HERE, "routing", "hour-meter-board.ses")
FREEROUTING = os.path.expanduser("~/.local/opt/freerouting-2.5.0/freerouting-2.5.0.jar")

_spec = importlib.util.spec_from_file_location("build", os.path.join(HERE, "tools-build-pcb.py"))
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)
X0, Y0, W, H = build.X0, build.Y0, build.W, build.H


def mm(v):
    return pcbnew.FromMM(v)


def polygon(points):
    chain = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in points:
        chain.Append(mm(x), mm(y))
    chain.SetClosed(True)
    return chain


def rect_points(rect):
    x1, y1, x2, y2 = rect
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]


def layer_set(*layers):
    lset = pcbnew.LSET()
    for layer in layers:
        lset.AddLayer(layer)
    return lset


def add_rule_area(board, rect, name, tracks):
    zone = pcbnew.ZONE(board)
    zone.SetIsRuleArea(True)
    zone.SetDoNotAllowTracks(tracks)
    zone.SetDoNotAllowVias(tracks)
    zone.SetDoNotAllowZoneFills(True)
    zone.SetDoNotAllowPads(False)
    zone.SetDoNotAllowFootprints(False)
    zone.SetLayerSet(layer_set(pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu))
    zone.Outline().AddOutline(polygon(rect_points(rect)))
    zone.SetZoneName(name)
    board.Add(zone)


def pour_outline():
    """Board outline (0.5 mm inset) with a notch for the vehicle area on the left edge."""
    inset = 0.5
    x1, y1, x2, y2 = X0 + inset, Y0 + inset, X0 + W - inset, Y0 + H - inset
    _, vy1, vx2, vy2 = build.VEHICLE_AREA
    return [(x1, y1), (x2, y1), (x2, y2), (x1, y2), (x1, vy2), (vx2, vy2), (vx2, vy1), (x1, vy1)]


def add_pour(board, layer, net_name, clearance=0.3):
    zone = pcbnew.ZONE(board)
    zone.SetLayer(layer)
    zone.SetNet(board.FindNet(net_name))
    zone.Outline().AddOutline(polygon(pour_outline()))
    zone.SetLocalClearance(mm(clearance))
    zone.SetMinThickness(mm(0.25))
    zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
    zone.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)   # no floating copper islands
    board.Add(zone)
    return zone


def solid_ic_grounds(board):
    """IC GND pads get a solid pour connection: on fine-pitch parts a thermal relief can be starved."""
    for fp in build.footprints_of(board):
        if fp.GetReference().startswith("U"):
            for pad in fp.Pads():
                if pad.GetNetname() == "GND":
                    pad.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)


def fill_all(board):
    zones = board.Zones()
    pcbnew.ZONE_FILLER(board).Fill(pcbnew.ZONES([zones[i] for i in range(len(zones))]))


def unconnected_count(pcb):
    report = os.path.join(os.path.dirname(DSN), "drc.json")
    subprocess.run(["kicad-cli", "pcb", "drc", "--format", "json", "-o", report, pcb], check=True, capture_output=True)
    with open(report) as f:
        return len(json.load(f).get("unconnected_items", []))


def route_once(try_pcb):
    """Route the placed board once and save the result (with pours) as try_pcb."""
    board = pcbnew.LoadBoard(PCB)
    add_rule_area(board, build.ANTENNA_KEEPOUT, "ANTENNA_KEEPOUT", tracks=True)
    add_pour(board, pcbnew.In1_Cu, "GND")
    if not pcbnew.ExportSpecctraDSN(board, DSN):
        raise SystemExit("DSN export failed")
    if os.path.exists(SES):
        os.remove(SES)
    subprocess.run(["java", "-jar", FREEROUTING, "--gui.enabled=false", "-de", DSN, "-do", SES,
                    "--router.autorouter.max_passes=300", "-mt", "4",
                    "--router.automatic_neckdown=true", "--router.fanout.ripup_allowed=true"],
                   check=True, timeout=3600, capture_output=True)
    if not pcbnew.ImportSpecctraSES(board, SES):
        raise SystemExit("SES import failed")
    solid_ic_grounds(board)
    add_pour(board, pcbnew.In2_Cu, "+3V3")
    add_pour(board, pcbnew.F_Cu, "GND")
    add_pour(board, pcbnew.B_Cu, "GND")
    fill_all(board)
    pcbnew.SaveBoard(try_pcb, board)


def main(tries):
    """Freerouting gives a different result every run, so keep the best of `tries` runs."""
    os.makedirs(os.path.dirname(DSN), exist_ok=True)
    best = None
    for i in range(tries):
        try_pcb = os.path.join(os.path.dirname(DSN), f"try-{i + 1}.kicad_pcb")
        route_once(try_pcb)
        count = unconnected_count(try_pcb)
        print(f"try {i + 1}: {count} unconnected", flush=True)
        if best is None or count < best[0]:
            best = (count, try_pcb)
        if count == 0:
            break
    shutil.copyfile(best[1], PCB)
    print(f"routed and saved {PCB} ({best[0]} unconnected)")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
