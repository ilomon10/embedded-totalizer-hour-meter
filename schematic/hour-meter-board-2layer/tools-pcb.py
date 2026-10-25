#!/usr/bin/env python3
"""Build hour-meter-board-2layer.kicad_pcb: the rev-B main board on 2 copper layers, headless.

  python3 tools-pcb.py check            -> courtyard overlaps / parts off the board only
  python3 tools-pcb.py place            -> placed, unrouted 2-layer board
  python3 tools-pcb.py route [tries]    -> Freerouting (best of N tries, default 4) + GND pours
  python3 tools-pcb.py finish [passes]  -> close what Freerouting left open (exit 1 if anything still is)
  python3 tools-pcb.py production       -> production/: Gerber zip, BOM and CPL for JLCPCB

A variant of ../hour-meter-board (4 layers), copied with KiCad's File > Save As: same schematic,
same placement, and the same build/route/finish scripts, called from there. Only the layer count
differs. With no inner GND plane, Freerouting routes every net (GND and +3V3 included) on F.Cu and
B.Cu, and GND pours fill both layers afterwards.
"""
import importlib.util
import os
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, "..", "hour-meter-board")
SCH = os.path.join(HERE, "hour-meter-board-2layer.kicad_sch")
PCB = os.path.join(HERE, "hour-meter-board-2layer.kicad_pcb")
IMU = ("U601", "U602")

_spec = importlib.util.spec_from_file_location("finish", os.path.join(MAIN, "tools-finish-routing.py"))
finish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(finish)
route, build = finish.route, finish.build


def imu_keepouts(board):
    """No tracks or vias under the IMU packages, on either layer. The MPU-6500 datasheet prohibits
    routing under the package (its gyro drive runs at 24-30 kHz), and the LIS3MDL is a magnetometer;
    on 2 layers no GND plane shields them from B.Cu. The GND pours may fill in.
    F.Cu: the space inside the pad ring. B.Cu: the package plus 0.5 mm."""
    fps = board.Footprints()   # index access: SWIG iterators are unreliable under Python 3.14
    for ref in IMU:
        fp = next(fps[i] for i in range(len(fps)) if fps[i].GetReference() == ref)
        boxes = [p.GetBoundingBox() for p in fp.Pads()]
        left, right = min(b.GetLeft() for b in boxes), max(b.GetRight() for b in boxes)
        top, bottom = min(b.GetTop() for b in boxes), max(b.GetBottom() for b in boxes)

        def inner_edge(edge, value, inner, pick):   # inner end of the pad row along one side
            return pick(inner(b) for b in boxes if abs(edge(b) - value) < build.mm(0.01))

        ring = [pcbnew.ToMM(v) for v in (
            inner_edge(lambda b: b.GetLeft(), left, lambda b: b.GetRight(), max),
            inner_edge(lambda b: b.GetTop(), top, lambda b: b.GetBottom(), max),
            inner_edge(lambda b: b.GetRight(), right, lambda b: b.GetLeft(), min),
            inner_edge(lambda b: b.GetBottom(), bottom, lambda b: b.GetTop(), min))]
        x1, y1, x2, y2 = ring
        route.add_rule_area(board, (x1 + 0.05, y1 + 0.05, x2 - 0.05, y2 - 0.05), f"{ref}_KEEPOUT_F",
                            tracks=True, layers=[pcbnew.F_Cu], fills=True)
        x1, y1, x2, y2 = (pcbnew.ToMM(v) for v in (left, top, right, bottom))
        route.add_rule_area(board, (x1 - 0.5, y1 - 0.5, x2 + 0.5, y2 + 0.5), f"{ref}_KEEPOUT_B",
                            tracks=True, layers=[pcbnew.B_Cu], fills=True)


def place(pcb=PCB):
    """The main board's build on 2 layers, plus the IMU keep-outs, and named as the variant on the
    silkscreen and in the title block."""
    board = build.build(SCH, pcb, layers=2)
    imu_keepouts(board)
    build.add_labels(board, [("2-LAYER", 130.0, 189.0, 1.2, True)])   # left of the coin cell's outline
    title = board.GetTitleBlock()
    title.SetTitle("Hour Meter main board, 2 layers")
    board.SetTitleBlock(title)
    return board


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    count = int(sys.argv[2]) if len(sys.argv) > 2 else None
    if mode in ("check", "place"):
        board = place(PCB if mode == "place" else build.throwaway(PCB))
        issues = build.courtyard_overlaps(board)
        print(f"courtyard issues ({len(issues)}):", "; ".join(issues) or "none")
        if mode == "place":
            pcbnew.SaveBoard(PCB, board)
            print("saved", PCB)
    elif mode == "route":
        route.main(4 if count is None else count, PCB)
    elif mode == "finish":
        finish.main(3 if count is None else count, PCB)
    elif mode == "production":
        subprocess.run([sys.executable, os.path.join(MAIN, "tools-production.py"), PCB], check=True)
    else:
        raise SystemExit(__doc__)
