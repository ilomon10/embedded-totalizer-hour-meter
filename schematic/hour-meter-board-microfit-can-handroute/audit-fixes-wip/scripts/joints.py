"""Track ends that touch a via or pad without landing inside it: the copper joint is only the overlap (neck)."""
import math, pcbnew, bm
b = bm.load(fill=False)
vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
pads = [p for f in b.GetFootprints() for p in f.Pads()]
out = []
for t in b.GetTracks():
    if t.GetClass() == 'PCB_VIA':
        continue
    w = bm.mm(t.GetWidth()); L = t.GetLayer(); n = t.GetNetname()
    for end in (t.GetStart(), t.GetEnd()):
        e = bm.P(end)
        landed = False; near = []
        for v in vias:
            if v.GetNetname() != n:
                continue
            r = bm.mm(v.GetWidth(pcbnew.F_Cu)) / 2
            d = math.dist(e, bm.P(v.GetPosition()))
            if d <= r + 1e-4:
                landed = True; break
            if d < r + w / 2:
                # chord of the overlap between the track's round end (radius w/2) and the via (radius r)
                a = (d * d + r * r - (w / 2) ** 2) / (2 * d)
                h = math.sqrt(max(r * r - a * a, 0))
                near.append(('via', round(2 * h, 3), round(d - r, 3)))
        if landed:
            continue
        for p in pads:
            if p.GetNetname() != n or not p.IsOnLayer(L):
                continue
            if p.HitTest(end, 0):
                landed = True; break
            if p.GetEffectiveShape(L).Collide(end, int(pcbnew.FromMM(w / 2))):
                near.append((f"{p.GetParentFootprint().GetReference()}.{p.GetNumber()}", None, None))
        if landed or not near:
            continue
        # is this end joined to another track end or mid-track anyway?
        joined = False
        for t2 in b.GetTracks():
            if t2.m_Uuid.AsString() == t.m_Uuid.AsString() or t2.GetClass() == 'PCB_VIA' or t2.GetNetname() != n or t2.GetLayer() != L:
                continue
            d, _, _ = bm._seg_pt(e, bm.P(t2.GetStart()), bm.P(t2.GetEnd()))
            if d < 1e-3:
                joined = True; break
        if not joined:
            out.append((n.split('/')[-1], b.GetLayerName(L), (round(e[0], 2), round(e[1], 2)), w, near))
print(len(out), 'track ends that only overlap a via or pad:')
for o in sorted(out, key=lambda o: min([x[1] for x in o[4] if x[1] is not None] or [9])):
    print('   ', o)
