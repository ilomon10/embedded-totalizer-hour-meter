"""DIN island: slots, which copper sits on which side, and the closest island-to-logic copper."""
import math, pcbnew, bm
b = bm.load(fill=True)
ISL_NETS = {'DIN1_RAW', 'DIN2_RAW', 'DIN1_R', 'DIN2_R', 'DIN1_D', 'DIN2_D', 'DIN1_LED', 'DIN2_LED', 'VEH_GND',
            'Net-(R301-Pad2)', 'Net-(R302-Pad2)', 'Net-(R306-Pad2)', 'Net-(R307-Pad2)'}
isl = lambda n: n.split('/')[-1] in ISL_NETS
# slots / cutouts: Edge.Cuts shapes inside the outline
x0, y0, x1, y1 = bm.outline(b)
for d in b.GetDrawings():
    if d.GetLayer() == pcbnew.Edge_Cuts:
        bb = d.GetBoundingBox()
        if bm.mm(bb.GetWidth()) < 95 and bm.mm(bb.GetHeight()) < 95:
            print('cutout piece', d.GetShapeStr(), [round(v, 2) for v in (bm.mm(bb.GetLeft()), bm.mm(bb.GetTop()), bm.mm(bb.GetRight()), bm.mm(bb.GetBottom()))])
# copper items with their nets: closest island copper to non-island copper
items = []
for t in b.GetTracks():
    if t.GetClass() == 'PCB_VIA':
        p = bm.P(t.GetPosition()); items.append((t.GetNetname(), 'via', p, p, bm.mm(t.GetWidth(pcbnew.F_Cu)) / 2, {pcbnew.F_Cu, pcbnew.B_Cu}))
    else:
        items.append((t.GetNetname(), 'trk', bm.P(t.GetStart()), bm.P(t.GetEnd()), bm.mm(t.GetWidth()) / 2, {t.GetLayer()}))
for f in b.GetFootprints():
    for p in f.Pads():
        pts = bm._poly(p)
        if not pts:
            continue
        c = bm.P(p.GetPosition())
        r = min(bm.mm(p.GetSize(pcbnew.F_Cu).x), bm.mm(p.GetSize(pcbnew.F_Cu).y)) / 2
        L = {l for l in (pcbnew.F_Cu, pcbnew.B_Cu) if p.IsOnLayer(l)}
        items.append((p.GetNetname(), f'{f.GetReference()}.{p.GetNumber()}', c, c, r, L))
A = [i for i in items if isl(i[0])]
B = [i for i in items if not isl(i[0]) and i[0] != '']
print('island copper items:', len(A))
best = []
for a in A:
    for c in B:
        if not (a[5] & c[5]):
            continue
        d = bm._seg_seg(a[2], a[3], c[2], c[3])[0] - a[4] - c[4]
        if d < 2.0:
            best.append((round(d, 2), a[0].split('/')[-1], a[1], c[0].split('/')[-1], c[1]))
best.sort()
print('island <-> other copper closer than 2 mm (approx., pad as inscribed circle):')
for r in best[:12]:
    print('   ', r)
# zone fill near island
for z in b.Zones():
    if z.GetIsRuleArea() or z.GetNetname() != 'GND':
        continue
    for L in (pcbnew.F_Cu, pcbnew.B_Cu):
        if not z.IsOnLayer(L):
            continue
        ps = z.GetFilledPolysList(L)
        dmin = 1e9; where = None
        for a in A:
            if L not in a[5]:
                continue
            for p in (a[2], a[3]):
                v = pcbnew.VECTOR2I(pcbnew.FromMM(p[0]), pcbnew.FromMM(p[1]))
                d = math.sqrt(ps.SquaredDistance(v)) / 1e6 - a[4] if hasattr(ps, 'SquaredDistance') else None
                if d is not None and d < dmin:
                    dmin, where = d, (a[1], a[0].split('/')[-1], p)
        print(f'   GND pour {b.GetLayerName(L)} to island copper: {dmin:.2f} mm at {where}')
