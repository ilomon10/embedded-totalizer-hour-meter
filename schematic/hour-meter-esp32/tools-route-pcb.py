#!/usr/bin/env python3
"""Route the placed board: keep-outs -> Specctra DSN -> Freerouting -> SES import -> GND pours.

Run after tools-build-pcb.py place:   python3 tools-route-pcb.py
"""
import os
import subprocess

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, "hour-meter-esp32.kicad_pcb")
DSN = os.path.join(HERE, "routing", "hour-meter-esp32.dsn")
SES = os.path.join(HERE, "routing", "hour-meter-esp32.ses")
FREEROUTING = os.path.expanduser("~/.local/opt/freerouting-2.5.0/freerouting-2.5.0.jar")

# Board X 100..230, Y 100..200. The isolated vehicle-input area gets NO ground pour.
VEHICLE_AREA = (100.0, 133.0, 137.5, 200.0)          # x1, y1, x2, y2
ANTENNA_KEEPOUT = (198.0, 100.0, 227.5, 110.5)        # ESP32 antenna: no copper at all


def mm(v):
    return pcbnew.FromMM(v)


def polygon(points):
    chain = pcbnew.SHAPE_LINE_CHAIN()
    for x, y in points:
        chain.Append(mm(x), mm(y))
    chain.SetClosed(True)
    return chain


def add_keepout(board, rect):
    x1, y1, x2, y2 = rect
    zone = pcbnew.ZONE(board)
    zone.SetIsRuleArea(True)
    zone.SetDoNotAllowTracks(True)
    zone.SetDoNotAllowVias(True)
    zone.SetDoNotAllowZoneFills(True)
    zone.SetDoNotAllowPads(False)
    zone.SetDoNotAllowFootprints(False)
    lset = pcbnew.LSET()
    lset.AddLayer(pcbnew.F_Cu)
    lset.AddLayer(pcbnew.B_Cu)
    zone.SetLayerSet(lset)
    zone.Outline().AddOutline(polygon([(x1, y1), (x2, y1), (x2, y2), (x1, y2)]))
    zone.SetZoneName("ANTENNA_KEEPOUT")
    board.Add(zone)


def add_gnd_pour(board, layer):
    net = board.FindNet("GND")
    vx1, vy1, vx2, vy2 = VEHICLE_AREA
    pts = [(100.5, 100.5), (229.5, 100.5), (229.5, 199.5), (vx2, 199.5), (vx2, vy1), (100.5, vy1)]
    zone = pcbnew.ZONE(board)
    zone.SetLayer(layer)
    zone.SetNet(net)
    zone.Outline().AddOutline(polygon(pts))
    zone.SetLocalClearance(mm(0.4))
    zone.SetMinThickness(mm(0.25))
    zone.SetPadConnection(pcbnew.ZONE_CONNECTION_THERMAL)
    zone.SetIslandRemovalMode(pcbnew.ISLAND_REMOVAL_MODE_ALWAYS)  # no floating copper islands
    board.Add(zone)


def main():
    os.makedirs(os.path.dirname(DSN), exist_ok=True)
    board = pcbnew.LoadBoard(PCB)
    add_keepout(board, ANTENNA_KEEPOUT)
    if not pcbnew.ExportSpecctraDSN(board, DSN):
        raise SystemExit("DSN export failed")
    if os.path.exists(SES):
        os.remove(SES)
    subprocess.run(["java", "-jar", FREEROUTING, "--gui.enabled=false", "-de", DSN, "-do", SES, "-mp", "100", "-mt", "4"],
                   check=True, timeout=900)
    if not pcbnew.ImportSpecctraSES(board, SES):
        raise SystemExit("SES import failed")
    add_gnd_pour(board, pcbnew.B_Cu)
    add_gnd_pour(board, pcbnew.F_Cu)
    zones = board.Zones()
    pcbnew.ZONE_FILLER(board).Fill(pcbnew.ZONES([zones[i] for i in range(len(zones))]))
    pcbnew.SaveBoard(PCB, board)
    print("routed and saved", PCB)


if __name__ == "__main__":
    main()
