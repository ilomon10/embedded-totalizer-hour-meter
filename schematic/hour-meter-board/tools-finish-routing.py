#!/usr/bin/env python3
"""Finish the connections tools-route-pcb.py left unrouted, then re-pour.

Run after tools-route-pcb.py:   python3 tools-finish-routing.py [passes]

  1. Freerouting again, starting from the routed board: the pours come off (the In1.Cu GND plane
     and the antenna keep-out stay), existing tracks are kept, and only the missing connections
     are routed. Later passes first rip up the tracks of the nets that are still open.
  2. GND or +3V3 pads and track ends still open get a short stub and a via down to their plane
     (In1.Cu GND, In2.Cu +3V3 pour), placed where it clears all copper of other nets.
  3. A GND or +3V3 strap pin of a fine-pitch IC that is still boxed in escapes straight outward,
     away from the package, to a via. GND tracks in that corridor may be ripped out (GND can always
     be reached through the In1.Cu plane); GND pads left open by that get vias of their own.
  4. Every F.Cu / B.Cu GND pour island that has no via or through-hole GND pad gets a via inside it.

Every candidate board is checked with KiCad's DRC and kept only if it has fewer unconnected
items and no new errors. Exit status 1 if anything is still open.
"""
import importlib.util
import json
import math
import os
import shutil
import subprocess
import sys

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
PCB = os.path.join(HERE, "hour-meter-board.kicad_pcb")
WORK = os.path.join(HERE, "routing")
REPORT = os.path.join(WORK, "finish-drc.json")


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


route = _load("route", "tools-route-pcb.py")
build = route.build
mm = build.mm

VIA_SIZE, VIA_DRILL = 0.5, 0.25
STUB_WIDTH = 0.2       # fits between 0.4 mm-pitch QFN pads
CLEARANCE = 0.15       # the Default / Plane netclass clearance
COPPER = [pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]


def drc(pcb):
    """(unconnected items, error-level violations) of a saved board, by KiCad's own DRC."""
    subprocess.run(["kicad-cli", "pcb", "drc", "--format", "json", "--schematic-parity", "-o", REPORT, pcb],
                   check=True, capture_output=True)
    with open(REPORT) as f:
        report = json.load(f)
    errors = [v for v in report["violations"] if v["severity"] == "error"]
    errors += [v for v in report.get("schematic_parity", []) if v["severity"] == "error"]
    return report["unconnected_items"], errors


def net_of(item):
    """Net name from a DRC item description such as 'Pad 22 [+3V3] of U601 on F.Cu'."""
    text = item["description"]
    return text[text.index("[") + 1:text.index("]")] if "[" in text else None


def tracks_of(board):
    tracks = board.Tracks()   # index access: SWIG iterators are unreliable under Python 3.14
    return [tracks[i] for i in range(len(tracks))]


_REMOVED = []


def remove(board, item):
    """board.Remove(), keeping the Python proxy alive: if a removed item's proxy is garbage-collected,
    pcbnew's SWIG type table breaks and later calls return untyped objects."""
    board.Remove(item)
    _REMOVED.append(item)


def strip_pours(board):
    """Remove the copper pours except the In1.Cu GND plane, so Freerouting sees free space."""
    zones = board.Zones()
    for zone in [zones[i] for i in range(len(zones))]:
        if not zone.GetIsRuleArea() and not zone.IsOnLayer(pcbnew.In1_Cu):
            remove(board, zone)


def repour(board):
    route.solid_ic_grounds(board)
    route.add_pour(board, pcbnew.In2_Cu, "+3V3")
    route.add_pour(board, pcbnew.F_Cu, "GND")
    route.add_pour(board, pcbnew.B_Cu, "GND")
    route.fill_all(board)


def freeroute(rip_nets):
    """Route the open connections of the board with Freerouting, after ripping up `rip_nets`."""
    board = pcbnew.LoadBoard(PCB)
    strip_pours(board)
    for track in tracks_of(board):
        if track.GetNetname() in rip_nets:
            remove(board, track)
    if not pcbnew.ExportSpecctraDSN(board, route.DSN):
        raise SystemExit("DSN export failed")
    if os.path.exists(route.SES):
        os.remove(route.SES)
    subprocess.run(["java", "-jar", route.FREEROUTING, "--gui.enabled=false", "-de", route.DSN, "-do", route.SES,
                    "--router.autorouter.max_passes=300", "-mt", "4",
                    "--router.automatic_neckdown=true", "--router.fanout.ripup_allowed=true"],
                   check=True, timeout=3600, capture_output=True)
    if not pcbnew.ImportSpecctraSES(board, route.SES):
        raise SystemExit("SES import failed")
    repour(board)
    pcbnew.SaveBoard(PCB, board)


def other_net_copper(board, net):
    """(shape, layer set) of every pad, track and via that is not on `net`."""
    items = []
    for fp in build.footprints_of(board):
        for pad in fp.Pads():
            if pad.GetNetname() != net:
                items.append((pad, pad.GetLayerSet()))
    for track in tracks_of(board):
        if track.GetNetname() != net:
            items.append((track, track.GetLayerSet()))
    return items


def keepouts(board):
    """(outline, layer set) of every rule area that forbids tracks or vias, on the board or in footprints."""
    zones = [board.Zones()[i] for i in range(len(board.Zones()))]
    for fp in build.footprints_of(board):
        zones += [fp.Zones()[i] for i in range(len(fp.Zones()))]
    return [(z.Outline(), z.GetLayerSet()) for z in zones
            if z.GetIsRuleArea() and (z.GetDoNotAllowTracks() or z.GetDoNotAllowVias())]


def clear_of(obstacles, shape, layers, clearance, rule_areas=()):
    """No other-net copper within `clearance` (or the item's own netclass clearance, if larger)."""
    for item, item_layers in obstacles:
        for layer in layers:
            if item_layers.Contains(layer):
                gap = max(mm(clearance), item.GetOwnClearance(layer))
                if item.GetEffectiveShape(layer).Collide(shape, gap):
                    return False
    for outline, area_layers in rule_areas:
        if any(area_layers.Contains(layer) for layer in layers) and outline.Collide(shape, 0):
            return False
    return True


def inside_board(x, y, margin=1.0):
    kx1, ky1, kx2, ky2 = build.ANTENNA_KEEPOUT
    vx1, vy1, vx2, vy2 = build.VEHICLE_AREA   # no GND plane there
    on_board = build.X0 + margin < x < build.X0 + build.W - margin and build.Y0 + margin < y < build.Y0 + build.H - margin
    in_keepout = kx1 - margin < x < kx2 + margin and ky1 - margin < y < ky2 + margin
    in_vehicle = vx1 <= x <= vx2 + margin and vy1 - margin <= y <= vy2 + margin
    return on_board and not in_keepout and not in_vehicle


def add_track(board, netinfo, a, b, width, layer=pcbnew.F_Cu):
    track = pcbnew.PCB_TRACK(board)
    track.SetStart(a)
    track.SetEnd(b)
    track.SetLayer(layer)
    track.SetWidth(mm(width))
    track.SetNet(netinfo)
    board.Add(track)


def add_via(board, netinfo, at):
    via = pcbnew.PCB_VIA(board)
    via.SetPosition(at)
    via.SetWidth(mm(VIA_SIZE))
    via.SetDrill(mm(VIA_DRILL))
    via.SetNet(netinfo)
    board.Add(via)


def drop_via(board, net, x, y, layer):
    """Add a stub + via from (x, y) on `layer` down to the plane, where it clears other copper."""
    obstacles = other_net_copper(board, net)
    areas = keepouts(board)
    start = pcbnew.VECTOR2I(mm(x), mm(y))
    for radius in (0.8, 1.0, 1.2, 1.4, 1.7, 2.0, 2.5, 3.0):
        for step in range(24):
            angle = 2 * math.pi * step / 24
            vx, vy = x + radius * math.cos(angle), y + radius * math.sin(angle)
            if not inside_board(vx, vy):
                continue
            end = pcbnew.VECTOR2I(mm(vx), mm(vy))
            via_shape = pcbnew.SHAPE_CIRCLE(end, mm(VIA_SIZE / 2))
            stub_shape = pcbnew.SHAPE_SEGMENT(start, end, mm(STUB_WIDTH))
            if not clear_of(obstacles, via_shape, COPPER, CLEARANCE, areas):
                continue
            if not clear_of(obstacles, stub_shape, [layer], CLEARANCE, areas):
                continue
            netinfo = board.FindNet(net)
            add_track(board, netinfo, start, end, STUB_WIDTH, layer)
            add_via(board, netinfo, end)
            return True
    return False


def plane_drops(unconnected):
    """Give every open GND / +3V3 pad or track end its own via down to its plane."""
    board = pcbnew.LoadBoard(PCB)
    strip_pours(board)
    added = 0
    for pair in unconnected:
        for item in pair["items"]:
            text = item["description"]
            net = net_of(item)
            if net not in ("GND", "+3V3") or text.startswith("Zone"):
                continue
            layer = pcbnew.B_Cu if "on B.Cu" in text else pcbnew.F_Cu
            if drop_via(board, net, item["pos"]["x"], item["pos"]["y"], layer):
                added += 1
    repour(board)
    pcbnew.SaveBoard(PCB, board)
    return added


def pad_item(board, item):
    """The pad a DRC item such as 'Pad 22 [+3V3] of U601 on F.Cu' refers to, or None."""
    text = item["description"]
    if not text.startswith("Pad ") or " of " not in text:
        return None
    number = text.split()[1]
    ref = text.split(" of ")[1].split()[0]
    for fp in build.footprints_of(board):
        if fp.GetReference() == ref:
            return next((p for p in fp.Pads() if p.GetNumber() == number), None)
    return None


def escape_outward(board, pad):
    """Stub (straight out of the package, then a dog-leg) + via from `pad`; for a +3V3 pad, GND
    tracks in that corridor are ripped out first (GND reconnects through its plane)."""
    net = pad.GetNetname()
    centre, at = pad.GetParentFootprint().GetPosition(), pad.GetPosition()
    dx, dy = at.x - centre.x, at.y - centre.y
    out = (1 if dx > 0 else -1, 0) if abs(dx) > abs(dy) else (0, 1 if dy > 0 else -1)
    side = (out[1], out[0])
    areas = keepouts(board)

    def point(along, across):
        return pcbnew.VECTOR2I(at.x + mm(out[0] * along + side[0] * across), at.y + mm(out[1] * along + side[1] * across))

    for distance in (1.0, 1.3, 1.6, 2.0, 2.5):
        for across in (0.0, 0.6, -0.6, 0.9, -0.9, 1.2, -1.2):
            for width in (0.2, 0.15):
                elbow = point(min(0.8, distance), 0.0)
                via_at = point(distance, across)
                via_shape = pcbnew.SHAPE_CIRCLE(via_at, mm(VIA_SIZE / 2))
                legs = [pcbnew.SHAPE_SEGMENT(at, elbow, mm(width)), pcbnew.SHAPE_SEGMENT(elbow, via_at, mm(width))]
                if net != "GND":
                    for track in tracks_of(board):
                        if track.GetNetname() == "GND" and any(track.GetEffectiveShape(pcbnew.F_Cu).Collide(shape, mm(CLEARANCE))
                                                                for shape in legs + [via_shape]):
                            remove(board, track)
                obstacles = other_net_copper(board, net)
                if not clear_of(obstacles, via_shape, COPPER, CLEARANCE, areas):
                    continue
                if not all(clear_of(obstacles, leg, [pcbnew.F_Cu], CLEARANCE) for leg in legs):
                    continue
                netinfo = board.FindNet(net)
                add_track(board, netinfo, at, elbow, width)
                if elbow != via_at:
                    add_track(board, netinfo, elbow, via_at, width)
                add_via(board, netinfo, via_at)
                return True
    return False


def strap_escapes(unconnected):
    """Escape open GND / +3V3 pads of fine-pitch ICs outward, then give newly open GND pads a via."""
    board = pcbnew.LoadBoard(PCB)
    strip_pours(board)
    escaped = 0
    for pair in unconnected:
        for item in pair["items"]:
            pad = pad_item(board, item)
            if pad and pad.GetNetname() in ("GND", "+3V3") and pad.GetParentFootprint().GetReference().startswith("U"):
                escaped += escape_outward(board, pad)
    repour(board)
    pcbnew.SaveBoard(PCB, board)
    still_open, _ = drc(PCB)
    return escaped, plane_drops(still_open)


def island_vias():
    """A via inside every F.Cu / B.Cu GND pour island that has no via or through-hole GND pad."""
    board = pcbnew.LoadBoard(PCB)
    route.fill_all(board)
    gnd = board.FindNet("GND")
    anchors = [t.GetPosition() for t in tracks_of(board) if t.GetClass() == "PCB_VIA" and t.GetNetname() == "GND"]
    anchors += [p.GetPosition() for fp in build.footprints_of(board) for p in fp.Pads()
                if p.GetNetname() == "GND" and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH]
    obstacles = other_net_copper(board, "GND")
    areas = keepouts(board)
    added = 0
    zones = [board.Zones()[i] for i in range(len(board.Zones()))]
    for zone in zones:
        layer = zone.GetLayer()
        if zone.GetIsRuleArea() or zone.GetNetname() != "GND" or layer not in (pcbnew.F_Cu, pcbnew.B_Cu):
            continue
        fill = zone.GetFilledPolysList(layer)
        for i in range(fill.OutlineCount()):
            island = pcbnew.SHAPE_POLY_SET(fill.Outline(i))
            if any(island.Contains(a) for a in anchors):
                continue
            box = island.BBox()
            spot = None
            y = box.GetTop()
            while spot is None and y <= box.GetBottom():
                x = box.GetLeft()
                while x <= box.GetRight():
                    c = pcbnew.VECTOR2I(x, y)
                    ring = [pcbnew.VECTOR2I(int(x + mm(VIA_SIZE / 2 + 0.05) * math.cos(a * math.pi / 4)),
                                            int(y + mm(VIA_SIZE / 2 + 0.05) * math.sin(a * math.pi / 4))) for a in range(8)]
                    if island.Contains(c) and all(island.Contains(r) for r in ring) and \
                            clear_of(obstacles, pcbnew.SHAPE_CIRCLE(c, mm(VIA_SIZE / 2)), COPPER, CLEARANCE, areas):
                        spot = c
                        break
                    x += mm(0.2)
                y += mm(0.2)
            if spot is not None:
                add_via(board, gnd, spot)
                anchors.append(spot)
                added += 1
    route.fill_all(board)
    pcbnew.SaveBoard(PCB, board)
    return added


def judge(name, best, best_copy):
    """Keep the board just written when it has fewer open connections and no more errors, else restore."""
    unconnected, errors = drc(PCB)
    keep = len(unconnected) < len(best[0]) and len(errors) <= len(best[1])
    print(f"  {name}: {len(unconnected)} unconnected, {len(errors)} errors -> {'kept' if keep else 'dropped'}", flush=True)
    if keep:
        shutil.copyfile(PCB, best_copy)
        return unconnected, errors
    shutil.copyfile(best_copy, PCB)
    return best


def main(passes):
    """Candidates are written as the real board file, next to its .kicad_pro (netclasses, rules) and
    schematic (parity check); the best one so far is kept as a copy and restored when a try is worse."""
    os.makedirs(WORK, exist_ok=True)
    best_copy = os.path.join(WORK, "finish-best.kicad_pcb")
    shutil.copyfile(PCB, best_copy)
    best = drc(PCB)
    print(f"start: {len(best[0])} unconnected, {len(best[1])} errors", flush=True)

    for i in range(passes):
        if not best[0]:
            break
        rip = set() if i == 0 else {net_of(item) for pair in best[0] for item in pair["items"]} - {"GND", "+3V3", None}
        freeroute(rip)
        best = judge(f"Freerouting pass {i + 1}" + (f" (ripped up {len(rip)} nets)" if rip else ""), best, best_copy)

    if best[0]:
        print(f"  {plane_drops(best[0])} plane vias added", flush=True)
        best = judge("plane vias", best, best_copy)
    if best[0]:
        escaped, dropped = strap_escapes(best[0])
        print(f"  {escaped} strap pins escaped, {dropped} GND vias added", flush=True)
        best = judge("strap escapes", best, best_copy)
    if best[0]:
        print(f"  {island_vias()} GND island vias added", flush=True)
        best = judge("GND island vias", best, best_copy)

    print(f"saved {PCB}: {len(best[0])} unconnected, {len(best[1])} errors")
    for pair in best[0]:
        print("  open:", " <-> ".join(item["description"] for item in pair["items"]))
    sys.exit(1 if best[0] or best[1] else 0)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 3)
