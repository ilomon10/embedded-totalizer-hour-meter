"""JLCPCB manufacturability beyond DRC: silk text size, holes, annular rings, hole spacing, slots, stackup."""
import math, collections, pcbnew, bm
b = bm.load(fill=False)
print('copper layers:', b.GetCopperLayerCount(), ' thickness:', bm.mm(b.GetDesignSettings().GetBoardThickness()), 'mm')
# silk texts
small = []
def check_text(t, owner):
    L = t.GetLayer()
    if L not in (pcbnew.F_SilkS, pcbnew.B_SilkS) or not t.IsVisible():
        return
    h, w, th = bm.mm(t.GetTextHeight()), bm.mm(t.GetTextWidth()), bm.mm(t.GetTextThickness())
    if h < 1.0 - 1e-6 or th < 0.15 - 1e-6:
        small.append((owner, t.GetShownText(True)[:30], round(h, 2), round(th, 3), b.GetLayerName(L)))
for d in b.GetDrawings():
    if isinstance(d, pcbnew.PCB_TEXT):
        check_text(d, 'board')
for f in b.GetFootprints():
    for fld in f.GetFields():
        check_text(fld, f.GetReference())
    for g in f.GraphicalItems():
        if isinstance(g, pcbnew.PCB_TEXT):
            check_text(g, f.GetReference())
print(f'silk texts under 1.0 mm high or 0.15 mm stroke: {len(small)}')
for s in small[:60]:
    print('   ', s)
# silk lines thinner than 0.15
thin = collections.Counter()
for f in b.GetFootprints():
    for g in f.GraphicalItems():
        if g.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS) and isinstance(g, pcbnew.PCB_SHAPE) and bm.mm(g.GetWidth()) < 0.15 - 1e-6:
            thin[round(bm.mm(g.GetWidth()), 3)] += 1
for d in b.GetDrawings():
    if d.GetLayer() in (pcbnew.F_SilkS, pcbnew.B_SilkS) and isinstance(d, pcbnew.PCB_SHAPE) and bm.mm(d.GetWidth()) < 0.15 - 1e-6:
        thin[round(bm.mm(d.GetWidth()), 3)] += 1
print('silk lines under 0.15 mm (width: count):', dict(thin))
# holes
holes = []
for t in b.GetTracks():
    if t.GetClass() == 'PCB_VIA':
        holes.append(('via', t.GetNetname(), bm.P(t.GetPosition()), bm.mm(t.GetDrillValue()), bm.mm(t.GetWidth(pcbnew.F_Cu))))
ring = []
for f in b.GetFootprints():
    for p in f.Pads():
        if p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH):
            dx, dy = bm.mm(p.GetDrillSizeX()), bm.mm(p.GetDrillSizeY())
            holes.append((f.GetReference() + '.' + p.GetNumber(), p.GetNetname(), bm.P(p.GetPosition()), min(dx, dy), None))
            if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH:
                sx, sy = bm.mm(p.GetSize(pcbnew.F_Cu).x), bm.mm(p.GetSize(pcbnew.F_Cu).y)
                ring.append(((min(sx - dx, sy - dy)) / 2, f.GetReference() + '.' + p.GetNumber(), (sx, sy), (dx, dy)))
print('drills (mm: count):', dict(collections.Counter(round(h[3], 3) for h in holes)))
print('smallest PTH pad annular rings:', sorted(ring)[:5])
vr = [((h[4] - h[3]) / 2, h[1]) for h in holes if h[0] == 'via']
print('via annular ring min:', min(vr)[0])
# hole-to-hole (edge to edge)
best = []
for i in range(len(holes)):
    for j in range(i + 1, len(holes)):
        d = math.dist(holes[i][2], holes[j][2]) - holes[i][3] / 2 - holes[j][3] / 2
        if d < 0.5:
            best.append((round(d, 3), holes[i][0], holes[j][0], holes[i][1] == holes[j][1]))
best.sort()
print('closest hole pairs (edge gap mm, a, b, same net):', best[:6])
