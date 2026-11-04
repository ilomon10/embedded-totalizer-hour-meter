#!/usr/bin/env python3
"""Route the placed board: keep-outs -> Specctra DSN -> Freerouting -> SES import -> GND pours.

Run after tools-build-pcb.py place:   python3 tools-route-pcb.py

While Freerouting runs, a fence of keep-out strips lines the vehicle zone's inner
edges (the other two edges are the board edge), so no logic net wanders in.
No vehicle copper lies in the strips; they are removed before the board is saved.
"""
import os
import subprocess

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, "hour-meter-esp32-v4-compass.kicad_pcb")
DSN = os.path.join(HERE, "routing", "hour-meter-esp32-v4-compass.dsn")
SES = os.path.join(HERE, "routing", "hour-meter-esp32-v4-compass.ses")
FREEROUTING = os.path.expanduser("~/.local/opt/freerouting-2.5.0/freerouting-2.5.0.jar")

# Board X 100..188, Y 100..191. The isolated vehicle zone (top-left) gets NO ground pour.
BOARD = (100.0, 100.0, 188.0, 191.0)
VEHICLE_AREA = (100.0, 100.0, 154.3, 132.0)          # x1, y1, x2, y2
ANTENNA_KEEPOUT = (163.8, 100.0, 181.9, 103.0)        # DevKit antenna overhangs here: no copper
EDGE_STRIP = 0.6  # Freerouting ignores the board-edge clearance; keep its tracks off the edge
# Fence along the vehicle zone's right and bottom edges (inside it): no vehicle copper there
FENCES = [(150.3, 100.0, 154.3, 132.0), (100.0, 128.4, 154.3, 132.0)]


def mm(v):
    return pcbnew.FromMM(v)


def polygon(points):
    chain = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in points:
        chain.Append(mm(x), mm(y))
    chain.SetClosed(True)
    return chain


def add_keepout(board, rect, name, pours=False):
    """Rule area on both copper layers: no tracks, no vias, and (by default) no pour either."""
    x1, y1, x2, y2 = rect
    zone = pcbnew.ZONE(board)
    zone.SetIsRuleArea(True)
    zone.SetDoNotAllowTracks(True)
    zone.SetDoNotAllowVias(True)
    zone.SetDoNotAllowZoneFills(not pours)
    zone.SetDoNotAllowPads(False)
    zone.SetDoNotAllowFootprints(False)
    lset = pcbnew.LSET()
    lset.AddLayer(pcbnew.F_Cu)
    lset.AddLayer(pcbnew.B_Cu)
    zone.SetLayerSet(lset)
    zone.Outline().AddOutline(polygon([(x1, y1), (x2, y1), (x2, y2), (x1, y2)]))
    zone.SetZoneName(name)
    board.Add(zone)
    return zone


def add_edge_strips(board):
    x1, y1, x2, y2 = BOARD
    e = EDGE_STRIP
    strips = [(x1, y1, x2, y1 + e), (x1, y2 - e, x2, y2), (x1, y1, x1 + e, y2), (x2 - e, y1, x2, y2)]
    # Pours keep their own edge clearance, so these strips only stop tracks and vias.
    return [add_keepout(board, s, f"EDGE_{i}", pours=True) for i, s in enumerate(strips)]


def add_gnd_pour(board, layer):
    net = board.FindNet("GND")
    x1, y1, x2, y2 = BOARD
    vx1, vy1, vx2, vy2 = VEHICLE_AREA
    m = 0.5
    pts = [(vx2, y1 + m), (x2 - m, y1 + m), (x2 - m, y2 - m), (x1 + m, y2 - m), (x1 + m, vy2), (vx2, vy2)]
    zone = pcbnew.ZONE(board)
    zone.SetLayer(layer)
    zone.SetNet(net)
    zone.Outline().AddOutline(polygon(pts))
    zone.SetLocalClearance(mm(0.4))
    zone.SetMinThickness(mm(0.3))
    zone.SetThermalReliefSpokeWidth(mm(0.5))
    zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
    zone.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)  # no floating copper islands
    board.Add(zone)


def freeroute(board):
    if not pcbnew.ExportSpecctraDSN(board, DSN):
        raise SystemExit("DSN export failed")
    if os.path.exists(SES):
        os.remove(SES)
    env = dict(os.environ, JAVA_TOOL_OPTIONS="-Xmx1536m")  # system memory pressure killed bigger heaps
    # No neck-down at pins: every track keeps its netclass width (0.4 mm minimum, for local fabs)
    subprocess.run(["java", "-jar", FREEROUTING, "--gui.enabled=false", "--router.automatic_neckdown=false",
                    "-de", DSN, "-do", SES, "-mp", "100", "-mt", "4"], check=True, timeout=900, env=env)
    if not pcbnew.ImportSpecctraSES(board, SES):
        raise SystemExit("SES import failed")


def main():
    os.makedirs(os.path.dirname(DSN), exist_ok=True)
    board = pcbnew.LoadBoard(PCB)
    add_keepout(board, ANTENNA_KEEPOUT, "ANTENNA_KEEPOUT")
    strips = add_edge_strips(board)
    strips += [add_keepout(board, f, f"FENCE_{i}", pours=True) for i, f in enumerate(FENCES)]
    freeroute(board)
    for zone in strips:
        board.Remove(zone)
    add_gnd_pour(board, pcbnew.B_Cu)
    add_gnd_pour(board, pcbnew.F_Cu)
    zones = board.Zones()
    pcbnew.ZONE_FILLER(board).Fill(pcbnew.ZONES([zones[i] for i in range(len(zones))]))
    pcbnew.SaveBoard(PCB, board)
    print("routed and saved", PCB)


if __name__ == "__main__":
    main()
