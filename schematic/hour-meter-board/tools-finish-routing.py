#!/usr/bin/env python3
"""Finish the connections tools-route-pcb.py left unrouted, then re-pour.

Run after tools-route-pcb.py:   python3 tools-finish-routing.py [passes]
(the 2-layer variant runs the same steps with ../hour-meter-board-2layer/tools-pcb.py finish)

  1. Freerouting again, starting from the routed board: the pours come off (the In1.Cu GND plane
     and the antenna keep-out stay), existing tracks are kept, and only the missing connections
     are routed. Later passes first rip up the tracks of the nets that are still open.
  2. Pads and track ends of a plane net that are still open get a short stub and a via down to
     their plane, placed where it clears all copper of other nets. Plane nets: GND (In1.Cu) and
     +3V3 (In2.Cu pour) on 4 layers; on 2 layers only GND, through the pour on the other side.
  3. A plane-net strap pin of a fine-pitch IC that is still boxed in escapes straight outward,
     away from the package, to a via. For a +3V3 pin, GND tracks in that corridor may be ripped out
     (GND can always be reached through the In1.Cu plane); GND pads left open by that get vias of their own.
  4. Any other IC pad still open escapes the same way, and Freerouting connects its via from either layer.
  5. Every F.Cu / B.Cu GND pour island that has no via or through-hole GND pad gets a via inside it.
  6. A pad whose thermal relief into a pour came out starved (too few spokes) gets a solid connection.
  7. Vias and track stubs that DRC reports as dangling are removed.

Every candidate board is checked with KiCad's DRC and kept only if it has fewer unconnected items
or errors and no more of either (step 7: no more of either). Exit status 1 if anything is still
open or wrong.
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


def drc(pcb):
    """(unconnected items, errors, warnings) of a saved board, by KiCad's own DRC."""
    report_file = os.path.join(build.routing_dir(pcb), "finish-drc.json")
    subprocess.run(["kicad-cli", "pcb", "drc", "--format", "json", "--schematic-parity", "-o", report_file, pcb],
                   check=True, capture_output=True)
    with open(report_file) as f:
        report = json.load(f)
    errors = [v for v in report["violations"] if v["severity"] == "error"]
    errors += [v for v in report.get("schematic_parity", []) if v["severity"] == "error"]
    warnings = [v for v in report["violations"] if v["severity"] == "warning"]
    return report["unconnected_items"], errors, warnings


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


def plane_nets(board):
    """Nets a via can always drop into: In1.Cu GND and the In2.Cu +3V3 pour, or on 2 layers the GND pours."""
    return ("GND", "+3V3") if board.IsLayerEnabled(pcbnew.In2_Cu) else ("GND",)


def freeroute(pcb, rip_nets):
    """Route the open connections of the board with Freerouting, after ripping up `rip_nets`."""
    board = pcbnew.LoadBoard(pcb)
    strip_pours(board)
    for track in tracks_of(board):
        if track.GetNetname() in rip_nets:
            remove(board, track)
    route.autoroute(board, pcb)
    route.pour(board)
    pcbnew.SaveBoard(pcb, board)


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
    """Clear of the board edge, the antenna band, the vehicle area (no GND plane there) and the slots."""
    x0, y0, w, h = build.LAYOUT.outline
    vx1, vy1, vx2, vy2 = build.LAYOUT.vehicle_area
    on_board = x0 + margin < x < x0 + w - margin and y0 + margin < y < y0 + h - margin
    in_keepout = False
    if build.LAYOUT.antenna_keepout:
        kx1, ky1, kx2, ky2 = build.LAYOUT.antenna_keepout
        in_keepout = kx1 - margin < x < kx2 + margin and ky1 - margin < y < ky2 + margin
    in_vehicle = vx1 - margin <= x <= vx2 + margin and vy1 - margin <= y <= vy2 + margin
    in_slot = any(min(sx1, sx2) - sw / 2 - margin < x < max(sx1, sx2) + sw / 2 + margin
                  and min(sy1, sy2) - sw / 2 - margin < y < max(sy1, sy2) + sw / 2 + margin
                  for (sx1, sy1), (sx2, sy2), sw in build.LAYOUT.slots)
    return on_board and not in_keepout and not in_vehicle and not in_slot


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
    copper = route.copper_layers(board)
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
            if not clear_of(obstacles, via_shape, copper, CLEARANCE, areas):
                continue
            if not clear_of(obstacles, stub_shape, [layer], CLEARANCE, areas):
                continue
            netinfo = board.FindNet(net)
            add_track(board, netinfo, start, end, STUB_WIDTH, layer)
            add_via(board, netinfo, end)
            return True
    return False


def plane_drops(pcb, unconnected):
    """Give every open pad or track end of a plane net its own via down to its plane."""
    board = pcbnew.LoadBoard(pcb)
    strip_pours(board)
    planes = plane_nets(board)
    added = 0
    for pair in unconnected:
        for item in pair["items"]:
            text = item["description"]
            net = net_of(item)
            if net not in planes or text.startswith("Zone"):
                continue
            layer = pcbnew.B_Cu if "on B.Cu" in text else pcbnew.F_Cu
            if drop_via(board, net, item["pos"]["x"], item["pos"]["y"], layer):
                added += 1
    route.pour(board)
    pcbnew.SaveBoard(pcb, board)
    return added


def pad_item(board, item):
    """The pad a DRC item such as 'Pad 22 [+3V3] of U601 on F.Cu' or 'PTH pad 4 [GND] of J801' refers to, or None."""
    text = item["description"]
    if not text.startswith(("Pad ", "PTH pad ")) or " of " not in text:
        return None
    number = text.split()[1 if text.startswith("Pad ") else 2]
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
    copper = route.copper_layers(board)

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
                if not clear_of(obstacles, via_shape, copper, CLEARANCE, areas):
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


def strap_escapes(pcb, unconnected):
    """Escape open plane-net pads of fine-pitch ICs outward, then give newly open GND pads a via."""
    board = pcbnew.LoadBoard(pcb)
    strip_pours(board)
    planes = plane_nets(board)
    escaped = 0
    for pair in unconnected:
        for item in pair["items"]:
            pad = pad_item(board, item)
            if pad and pad.GetNetname() in planes and pad.GetParentFootprint().GetReference().startswith("U"):
                escaped += escape_outward(board, pad)
    route.pour(board)
    pcbnew.SaveBoard(pcb, board)
    still_open, _, _ = drc(pcb)
    return escaped, plane_drops(pcb, still_open)


def pad_escapes(pcb, unconnected):
    """Open IC pads of any net escape outward to a via in the same way, then Freerouting connects the
    via from either layer (on 2 layers, +3V3 has no plane to drop into)."""
    board = pcbnew.LoadBoard(pcb)
    strip_pours(board)
    escaped = 0
    for pair in unconnected:
        for item in pair["items"]:
            pad = pad_item(board, item)
            if pad and pad.GetParentFootprint().GetReference().startswith("U"):
                escaped += escape_outward(board, pad)
    if escaped:
        route.autoroute(board, pcb)
    route.pour(board)
    pcbnew.SaveBoard(pcb, board)
    return escaped


def island_vias(pcb):
    """A via inside every F.Cu / B.Cu GND pour island that has no via or through-hole GND pad."""
    board = pcbnew.LoadBoard(pcb)
    route.fill_all(board)
    gnd = board.FindNet("GND")
    anchors = [t.GetPosition() for t in tracks_of(board) if t.GetClass() == "PCB_VIA" and t.GetNetname() == "GND"]
    anchors += [p.GetPosition() for fp in build.footprints_of(board) for p in fp.Pads()
                if p.GetNetname() == "GND" and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH]
    obstacles = other_net_copper(board, "GND")
    areas = keepouts(board)
    copper = route.copper_layers(board)
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
                            clear_of(obstacles, pcbnew.SHAPE_CIRCLE(c, mm(VIA_SIZE / 2)), copper, CLEARANCE, areas):
                        spot = c
                        break
                    x += mm(0.2)
                y += mm(0.2)
            if spot is not None:
                add_via(board, gnd, spot)
                anchors.append(spot)
                added += 1
    route.fill_all(board)
    pcbnew.SaveBoard(pcb, board)
    return added


def solid_starved_thermals(pcb, errors):
    """Pads whose thermal relief into a pour came out with too few spokes (on 2 layers the pours are
    cut up by tracks) get a solid connection instead."""
    board = pcbnew.LoadBoard(pcb)
    solid = 0
    for violation in errors:
        if violation["type"] == "starved_thermal":
            for item in violation["items"]:
                pad = pad_item(board, item)
                if pad:
                    pad.SetLocalZoneConnection(pcbnew.ZONE_CONNECTION_FULL)
                    solid += 1
    route.fill_all(board)
    pcbnew.SaveBoard(pcb, board)
    return solid


def prune_dangling(pcb):
    """Remove the vias and track stubs DRC reports as dangling: Freerouting leaves vias where a route
    comes back to the layer it left. They carry no connection."""
    pruned = 0
    for _ in range(5):   # a via's removal can leave its stub dangling
        _, _, warnings = drc(pcb)
        dangling = {item["uuid"] for v in warnings if v["type"] in ("via_dangling", "track_dangling") for item in v["items"]}
        board = pcbnew.LoadBoard(pcb)
        doomed = [t for t in tracks_of(board) if t.m_Uuid.AsString() in dangling]
        if not doomed:
            break
        for track in doomed:
            remove(board, track)
        pruned += len(doomed)
        route.fill_all(board)
        pcbnew.SaveBoard(pcb, board)
    return pruned


def judge(pcb, name, best, best_copy, gain=True):
    """Keep the board just written when it has fewer open connections or errors and no more of either
    (with gain=False, also when it is just no worse); otherwise restore the best board so far."""
    unconnected, errors, _ = drc(pcb)
    worse = len(unconnected) > len(best[0]) or len(errors) > len(best[1])
    better = len(unconnected) < len(best[0]) or len(errors) < len(best[1])
    keep = not worse and (better or not gain)
    print(f"  {name}: {len(unconnected)} unconnected, {len(errors)} errors -> {'kept' if keep else 'dropped'}", flush=True)
    if keep:
        shutil.copyfile(pcb, best_copy)
        return unconnected, errors
    shutil.copyfile(best_copy, pcb)
    return best


def main(passes, pcb=PCB):
    """Candidates are written as the real board file, next to its .kicad_pro (netclasses, rules) and
    schematic (parity check); the best one so far is kept as a copy and restored when a try is worse."""
    board = pcbnew.LoadBoard(pcb)
    planes = set(plane_nets(board))
    route.fix_via_drills(board)   # boards routed before that fix existed
    pcbnew.SaveBoard(pcb, board)
    best_copy = os.path.join(build.routing_dir(pcb), "finish-best.kicad_pcb")
    shutil.copyfile(pcb, best_copy)
    best = drc(pcb)[:2]
    print(f"start: {len(best[0])} unconnected, {len(best[1])} errors", flush=True)

    for i in range(passes):
        if not best[0]:
            break
        rip = set() if i == 0 else {net_of(item) for pair in best[0] for item in pair["items"]} - planes - {None}
        freeroute(pcb, rip)
        best = judge(pcb, f"Freerouting pass {i + 1}" + (f" (ripped up {len(rip)} nets)" if rip else ""), best, best_copy)

    if best[0]:
        print(f"  {plane_drops(pcb, best[0])} plane vias added", flush=True)
        best = judge(pcb, "plane vias", best, best_copy)
    if best[0]:
        escaped, dropped = strap_escapes(pcb, best[0])
        print(f"  {escaped} strap pins escaped, {dropped} GND vias added", flush=True)
        best = judge(pcb, "strap escapes", best, best_copy)
    if best[0]:
        print(f"  {pad_escapes(pcb, best[0])} IC pads escaped to a via, then re-routed", flush=True)
        best = judge(pcb, "pad escapes", best, best_copy)
    if best[0]:
        print(f"  {island_vias(pcb)} GND island vias added", flush=True)
        best = judge(pcb, "GND island vias", best, best_copy)
    for _ in range(2):   # pruning re-pours, which can starve a thermal relief again
        if any(v["type"] == "starved_thermal" for v in best[1]):
            print(f"  {solid_starved_thermals(pcb, best[1])} starved thermal reliefs made solid", flush=True)
            best = judge(pcb, "solid thermals", best, best_copy)
        print(f"  {prune_dangling(pcb)} dangling vias and stubs removed", flush=True)
        best = judge(pcb, "dangling vias", best, best_copy, gain=False)

    print(f"saved {pcb}: {len(best[0])} unconnected, {len(best[1])} errors")
    for pair in best[0]:
        print("  open:", " <-> ".join(item["description"] for item in pair["items"]))
    sys.exit(1 if best[0] or best[1] else 0)


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 3)
