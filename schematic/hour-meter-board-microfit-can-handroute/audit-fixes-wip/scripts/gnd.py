"""GND: pour islands and their vias, stitching gaps, GND vias at IC ground pins, B.Cu plane under key signals."""
import math, collections, pcbnew, bm
b = bm.load(fill=True)
x0, y0, x1, y1 = bm.outline(b)
vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA' and t.GetNetname() == 'GND']
print('GND vias:', len(vias))
zones = [z for z in b.Zones() if not z.GetIsRuleArea() and z.GetNetname() == 'GND']
for z in zones:
    print('zone', b.GetLayerName(z.GetFirstLayer()), 'island removal mode', z.GetIslandRemovalMode(), 'min width', bm.mm(z.GetMinThickness()),
          'thermal gap', bm.mm(z.GetThermalReliefGap()), 'spoke', bm.mm(z.GetThermalReliefSpokeWidth()), 'pad conn', z.GetPadConnection())
area = {}
polys = {}
for z in zones:
    for L in (pcbnew.F_Cu, pcbnew.B_Cu):
        if not z.IsOnLayer(L):
            continue
        ps = z.GetFilledPolysList(L)
        polys[L] = ps
        area[L] = ps.Area() / 1e12
        isl = []
        for i in range(ps.OutlineCount()):
            one = pcbnew.SHAPE_POLY_SET(); one.AddOutline(ps.Outline(i))
            for h in range(ps.HoleCount(i)):
                one.AddHole(ps.Hole(i, h))
            a = one.Area() / 1e12
            nv = sum(1 for v in vias if one.Contains(v.GetPosition()))
            # pads (GND) inside this island on this layer
            np_ = 0
            for f in b.GetFootprints():
                for p in f.Pads():
                    if p.GetNetname() == 'GND' and p.IsOnLayer(L) and one.Contains(p.GetPosition()):
                        np_ += 1
            bb = one.BBox()
            isl.append((a, nv, np_, (round(bm.mm(bb.GetCenter().x), 1), round(bm.mm(bb.GetCenter().y), 1)), round(bm.mm(max(bb.GetWidth(), bb.GetHeight())), 1)))
        isl.sort()
        print(f"{b.GetLayerName(L)}: GND fill {area[L]:.0f} mm2 = {100*area[L]/((x1-x0)*(y1-y0)):.0f} % of the board, islands {len(isl)}")
        for a, nv, np_, c, span in isl:
            if nv + np_ <= 1 or a < 30:
                print(f"    island {a:7.1f} mm2 span {span:5.1f} mm at {c}: {nv} vias, {np_} GND pads")
        print(f"    biggest: {isl[-1][0]:.0f} mm2 with {isl[-1][1]} vias")
# stitching: distance from points on the top GND fill to the nearest GND via (or THT GND pad)
anchors = [bm.P(v.GetPosition()) for v in vias]
for f in b.GetFootprints():
    for p in f.Pads():
        if p.GetNetname() == 'GND' and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
            anchors.append(bm.P(p.GetPosition()))
far = []
step = 1.0
y = y0 + 0.5
while y < y1:
    x = x0 + 0.5
    while x < x1:
        v = pcbnew.VECTOR2I(pcbnew.FromMM(x), pcbnew.FromMM(y))
        if polys[pcbnew.F_Cu].Contains(v) and polys[pcbnew.B_Cu].Contains(v):
            d = min(math.dist((x, y), a) for a in anchors)
            far.append((d, (round(x, 1), round(y, 1))))
        x += step
    y += step
far.sort(reverse=True)
print('points of the top GND pour farthest from any GND via/THT pin:', far[:8])
hist = collections.Counter(int(d // 2.5) * 2.5 for d, _ in far)
print('distance histogram (mm: share of top pour points):', {k: f'{100*v/len(far):.0f}%' for k, v in sorted(hist.items())})
# IC ground pins: nearest GND via to the pad
print('IC / connector ground pins: distance from the pad centre to the nearest GND via')
rows = []
for f in b.GetFootprints():
    r = f.GetReference()
    if not r.startswith(('U', 'J', 'D1', 'Q')):
        continue
    for p in f.Pads():
        if p.GetNetname() != 'GND' or p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
            continue
        pp = bm.P(p.GetPosition())
        d = min(math.dist(pp, bm.P(v.GetPosition())) for v in vias)
        rows.append((d, f'{r}.{p.GetNumber()}'))
rows.sort(reverse=True)
print('   worst:', [(round(d, 1), n) for d, n in rows[:14]])
