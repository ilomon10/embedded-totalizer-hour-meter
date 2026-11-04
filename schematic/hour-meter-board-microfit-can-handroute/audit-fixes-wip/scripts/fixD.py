"""Fix D: GND vias at D104/D105/U101/R104, GND stitching on a 5 mm grid (2.5 mm by the ESP32), VBUS_IN joint."""
import math, os, pcbnew, edit as E
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'fix', 'after-C.kicad_pcb')
VIA_D, VIA_DRILL = 0.6, 0.3
b = pcbnew.LoadBoard(SRC)
E.fill(b)
gnd = E.net(b, 'GND')
x0, y0, x1, y1 = 51.5, 43.72, 151.5, 143.72
fills = {}
for z in b.Zones():
    if not z.GetIsRuleArea() and z.GetNetname() == 'GND':
        for L in (pcbnew.F_Cu, pcbnew.B_Cu):
            if z.IsOnLayer(L):
                poly = z.GetFilledPolysList(L).CloneDropTriangulation()
                poly.Deflate(E.FM(VIA_D / 2 + 0.05), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS, E.FM(0.01))
                fills[L] = poly
keepouts = [z for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowVias()]
courtyards = []
for f in b.GetFootprints():
    c = f.GetCourtyard(pcbnew.F_CrtYd if f.GetLayer() == pcbnew.F_Cu else pcbnew.B_CrtYd)
    courtyards.append(c)
drilled = [E.P(t.GetPosition()) for t in b.GetTracks() if t.GetClass() == 'PCB_VIA']
drilled += [E.P(p.GetPosition()) for f in b.GetFootprints() for p in f.Pads() if p.GetDrillSize().x > 0]


def solid(x, y):
    v = E.V(x, y)
    return all(L in fills and fills[L].Contains(v) for L in (pcbnew.F_Cu, pcbnew.B_Cu))


def free(x, y, spacing=1.2, in_courtyard_ok=False):
    v = E.V(x, y)
    if any(k.Outline().Contains(v) for k in keepouts):
        return False
    if not in_courtyard_ok and any(c.OutlineCount() and c.Contains(v) for c in courtyards):
        return False
    return all(math.dist((x, y), d) >= spacing for d in drilled)


added = []
def via(x, y):
    E.add_via(b, 'GND', x, y, VIA_D, VIA_DRILL)
    drilled.append((x, y)); added.append((round(x, 2), round(y, 2)))

# 1) vias beside GND pads that carry surge / switching current: first solid spot on rings around the pad
for ref, num, want in (('D104', '1', 2), ('D105', '2', 2), ('U101', '3', 4), ('C102', '2', 2), ('C103', '2', 1), ('R104', '2', 1)):
    pads = [p for p in E.pads_of(b, ref).values()] if False else [p for p in E.fp(b, ref).Pads() if p.GetNumber() == num]
    pad = max(pads, key=lambda p: p.GetSize(pcbnew.F_Cu).x * p.GetSize(pcbnew.F_Cu).y)
    bb = pad.GetBoundingBox()
    l, t, r, bt = E.mm(bb.GetLeft()), E.mm(bb.GetTop()), E.mm(bb.GetRight()), E.mm(bb.GetBottom())
    got = 0
    for gap in (0.55, 0.75, 1.0, 1.3):
        if got >= want:
            break
        cands = []
        n = 24
        for k in range(n):
            # points around the pad box at distance `gap` from its edge
            s = k / n
            per = 2 * (r - l) + 2 * (bt - t)
            d = s * per
            if d < r - l:
                x, y = l + d, t - gap
            elif d < (r - l) + (bt - t):
                x, y = r + gap, t + d - (r - l)
            elif d < 2 * (r - l) + (bt - t):
                x, y = r - (d - (r - l) - (bt - t)), bt + gap
            else:
                x, y = l - gap, bt - (d - 2 * (r - l) - (bt - t))
            cands.append((x, y))
        for x, y in cands:
            if got >= want:
                break
            if solid(x, y) and free(x, y, 1.0, in_courtyard_ok=True):
                via(x, y); got += 1
    print(f'{ref}.{num}: {got} vias')
# 2) stitching grid
pts = set()
for pitch in (5.0, 2.5):
    nx, ny = int((x1 - x0) / pitch), int((y1 - y0) / pitch)
    for i in range(nx + 1):
        for j in range(ny + 1):
            x, y = x0 + i * pitch, y0 + j * pitch
            if pitch == 2.5:
                near_edge = min(x - x0, x1 - x, y - y0, y1 - y) < 3.5
                if not (near_edge and x >= 111.5):
                    continue
            pts.add((round(x, 3), round(y, 3)))
n0 = len(added)
for x, y in sorted(pts):
    if solid(x, y) and free(x, y):
        via(x, y)
print('stitching vias', len(added) - n0)
# 3) VBUS_IN track that ended 0.35 mm off its via
for t in b.GetTracks():
    if t.GetClass() == 'PCB_TRACK' and t.GetNetname().endswith('VBUS_IN') and t.GetLayer() == pcbnew.B_Cu:
        if E.P(t.GetStart()) == (140.2, 72.9):
            t.SetStart(E.V(140.2, 72.55)); print('VBUS_IN joint centred')
        if E.P(t.GetEnd()) == (140.2, 77.2):
            t.SetEnd(E.V(140.2, 77.45))
E.save(b)
d = E.drc()
print(E.summary(d))
bad = [p for p in E.problems(d)]
for p in bad[:30]:
    print('  ', p)
import json
json.dump(added, open(os.path.join(HERE, '..', 'fix', 'fixD-vias.json'), 'w'))
