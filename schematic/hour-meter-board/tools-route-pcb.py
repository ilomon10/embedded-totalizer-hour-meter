#!/usr/bin/env python3
"""Route the placed rev-B board: planes + keep-outs -> Specctra DSN -> Freerouting -> SES -> pours.

Run after tools-build-pcb.py place:   python3 tools-route-pcb.py [tries]
Freerouting gives a different result each run; with tries > 1 the board with the fewest
connections left unrouted (by KiCad's DRC) is kept. Every try reads the placed board, so
re-run tools-build-pcb.py place before routing again.

In1.Cu is a solid GND plane (a 'power' layer), so Freerouting routes on F.Cu, In2.Cu and B.Cu
and reaches GND through vias. After routing, a +3V3 pour fills the free space on In2.Cu and GND
pours fill F.Cu and B.Cu. A 2-layer board (../hour-meter-board-2layer) has no plane: Freerouting
routes every net, GND and +3V3 included, and only the GND pours follow.
Every plane and pour skips the opto input side (VEHICLE_AREA,
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
FREEROUTING = os.path.expanduser("~/.local/opt/freerouting-2.5.0/freerouting-2.5.0.jar")

_spec = importlib.util.spec_from_file_location("build", os.path.join(HERE, "tools-build-pcb.py"))
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)


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


def copper_layers(board):
    return [layer for layer in (pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu) if board.IsLayerEnabled(layer)]


def add_rule_area(board, rect, name, tracks, layers=None, fills=False):
    """A keep-out on `layers` (default: every copper layer). Freerouting gets it as a routing keep-out."""
    zone = pcbnew.ZONE(board)
    zone.SetIsRuleArea(True)
    zone.SetDoNotAllowTracks(tracks)
    zone.SetDoNotAllowVias(tracks)
    zone.SetDoNotAllowZoneFills(not fills)
    zone.SetDoNotAllowPads(False)
    zone.SetDoNotAllowFootprints(False)
    zone.SetLayerSet(layer_set(*(layers or copper_layers(board))))
    zone.Outline().AddOutline(polygon(rect_points(rect)))
    zone.SetZoneName(name)
    board.Add(zone)


def pour_outline():
    """Board outline (0.5 mm inset) minus the vehicle area, which gets no pour."""
    inset = 0.5
    x0, y0, w, h = build.LAYOUT.outline
    area = pcbnew.SHAPE_POLY_SET()
    area.AddOutline(polygon(rect_points((x0 + inset, y0 + inset, x0 + w - inset, y0 + h - inset))))
    vehicle = pcbnew.SHAPE_POLY_SET()
    vehicle.AddOutline(polygon(rect_points(build.LAYOUT.vehicle_area)))
    area.BooleanSubtract(vehicle)
    return area


def add_pour(board, layer, net_name, clearance=0.3):
    zone = pcbnew.ZONE(board)
    zone.SetLayer(layer)
    zone.SetNet(board.FindNet(net_name))
    outline = pour_outline()
    for i in range(outline.OutlineCount()):
        zone.Outline().AddOutline(outline.Outline(i))
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


def pour(board):
    """The pours that follow routing: +3V3 on In2.Cu (4 layers only), GND on F.Cu and B.Cu."""
    solid_ic_grounds(board)
    if board.IsLayerEnabled(pcbnew.In2_Cu):
        add_pour(board, pcbnew.In2_Cu, "+3V3")
    add_pour(board, pcbnew.F_Cu, "GND")
    add_pour(board, pcbnew.B_Cu, "GND")
    fill_all(board)


def autoroute(board, pcb):
    """Route the open connections of `board` (loaded from `pcb`) with Freerouting, through DSN/SES files."""
    stem = os.path.join(build.routing_dir(pcb), os.path.splitext(os.path.basename(pcb))[0])
    dsn, ses = stem + ".dsn", stem + ".ses"
    if not pcbnew.ExportSpecctraDSN(board, dsn):
        raise SystemExit("DSN export failed")
    if os.path.exists(ses):
        os.remove(ses)
    subprocess.run(["java", "-jar", FREEROUTING, "--gui.enabled=false", "-de", dsn, "-do", ses,
                    "--router.autorouter.max_passes=300", "-mt", "4",
                    "--router.automatic_neckdown=true", "--router.fanout.ripup_allowed=true"],
                   check=True, timeout=3600, capture_output=True)
    if not pcbnew.ImportSpecctraSES(board, ses):
        raise SystemExit("SES import failed")
    fix_via_drills(board)


def fix_via_drills(board):
    """KiCad's SES import drills a via with its net's netclass drill, not with the drill of the via
    size Freerouting picked (a 0.5 mm via on a Vehicle net came back with a 0.4 mm drill). Every via
    size here is drilled at half its diameter, so restore that."""
    tracks = board.Tracks()
    for i in range(len(tracks)):
        if tracks[i].GetClass() == "PCB_VIA":
            via = pcbnew.Cast_to_PCB_VIA(tracks[i])
            via.SetDrill(via.GetWidth(pcbnew.F_Cu) // 2)


def unconnected_count(pcb):
    report = os.path.splitext(pcb)[0] + "-drc.json"
    subprocess.run(["kicad-cli", "pcb", "drc", "--format", "json", "-o", report, pcb], check=True, capture_output=True)
    with open(report) as f:
        return len(json.load(f).get("unconnected_items", []))


def route_once(pcb, try_pcb):
    """Route the placed board once and save the result (with pours) as try_pcb."""
    board = pcbnew.LoadBoard(pcb)
    if build.LAYOUT.antenna_keepout:   # none when the antenna overhangs the board edge
        add_rule_area(board, build.LAYOUT.antenna_keepout, "ANTENNA_KEEPOUT", tracks=True)
    if board.IsLayerEnabled(pcbnew.In1_Cu):
        add_pour(board, pcbnew.In1_Cu, "GND")
    autoroute(board, pcb)
    pour(board)
    pcbnew.SaveBoard(try_pcb, board)


def main(tries, pcb=PCB):
    """Freerouting gives a different result every run, so keep the best of `tries` runs."""
    best = None
    for i in range(tries):
        try_pcb = os.path.join(build.routing_dir(pcb), f"try-{i + 1}.kicad_pcb")
        route_once(pcb, try_pcb)
        count = unconnected_count(try_pcb)
        print(f"try {i + 1}: {count} unconnected", flush=True)
        if best is None or count < best[0]:
            best = (count, try_pcb)
        if count == 0:
            break
    shutil.copyfile(best[1], pcb)
    print(f"routed and saved {pcb} ({best[0]} unconnected)")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 1)
