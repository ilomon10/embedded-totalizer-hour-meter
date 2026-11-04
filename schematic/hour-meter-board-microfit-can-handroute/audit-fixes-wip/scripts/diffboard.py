"""diffboard.py OLD.kicad_pcb NEW.kicad_pcb : footprints moved, tracks/vias added/removed, texts, zones, outline."""
import sys, collections, pcbnew
mm = pcbnew.ToMM
A, B = pcbnew.LoadBoard(sys.argv[1]), pcbnew.LoadBoard(sys.argv[2])
def fps(b):
    return {f.GetReference(): (round(mm(f.GetPosition().x), 3), round(mm(f.GetPosition().y), 3), round(f.GetOrientationDegrees(), 1),
                               f.GetLayerName(), f.GetValue(), str(f.GetFPID().GetLibItemName())) for f in b.GetFootprints()}
fa, fb = fps(A), fps(B)
print('footprints only in old:', set(fa) - set(fb), ' only in new:', set(fb) - set(fa))
moved = [(r, fa[r], fb[r]) for r in sorted(set(fa) & set(fb)) if fa[r] != fb[r]]
print('footprints changed:', len(moved))
for r, a, b_ in moved:
    print('  ', r, a, '->', b_)
def items(b):
    out = collections.Counter()
    for t in b.GetTracks():
        n = t.GetNetname().split('/')[-1]
        if t.GetClass() == 'PCB_VIA':
            out[('via', n, (round(mm(t.GetPosition().x), 3), round(mm(t.GetPosition().y), 3)), round(mm(t.GetWidth(pcbnew.F_Cu)), 3), round(mm(t.GetDrillValue()), 3))] += 1
        else:
            a, c = (round(mm(t.GetStart().x), 3), round(mm(t.GetStart().y), 3)), (round(mm(t.GetEnd().x), 3), round(mm(t.GetEnd().y), 3))
            out[('trk', n, b.GetLayerName(t.GetLayer()), tuple(sorted([a, c])), round(mm(t.GetWidth()), 3))] += 1
    return out
ia, ib = items(A), items(B)
rem, add = ia - ib, ib - ia
print('tracks/vias removed:', sum(rem.values()), ' added:', sum(add.values()))
by = collections.Counter()
for k in rem: by[('-', k[0], k[1])] += rem[k]
for k in add: by[('+', k[0], k[1])] += add[k]
for k, v in sorted(by.items(), key=lambda kv: (kv[0][2], kv[0][0])):
    print('   ', k, v)
if '-v' in sys.argv:
    for k in sorted(rem, key=str): print('  -', k)
    for k in sorted(add, key=str): print('  +', k)
def texts(b):
    return sorted((b.GetLayerName(d.GetLayer()), d.GetText(), round(mm(d.GetPosition().x), 2), round(mm(d.GetPosition().y), 2)) for d in b.GetDrawings() if isinstance(d, pcbnew.PCB_TEXT))
ta, tb = texts(A), texts(B)
print('texts added/moved:', [t for t in tb if t not in ta], ' removed/moved:', [t for t in ta if t not in tb])
def zones(b):
    return sorted((z.GetNetname(), z.GetIsRuleArea(), b.GetLayerName(z.GetLayerSet().Seq()[0]), z.GetNumCorners(),
                   tuple(round(mm(v), 2) for v in (z.Outline().BBox().GetLeft(), z.GetBoundingBox().GetTop()))) for z in b.Zones())
print('zones same:', zones(A) == zones(B), len(zones(A)), len(zones(B)))
if zones(A) != zones(B):
    print('   old only', [z for z in zones(A) if z not in zones(B)]); print('   new only', [z for z in zones(B) if z not in zones(A)])
edge = lambda b: sorted((d.GetShapeStr(), round(mm(d.GetStart().x), 2), round(mm(d.GetStart().y), 2), round(mm(d.GetEnd().x), 2), round(mm(d.GetEnd().y), 2)) for d in b.GetDrawings() if d.GetLayer() == pcbnew.Edge_Cuts)
print('outline same:', edge(A) == edge(B), ' copper layers', A.GetCopperLayerCount(), B.GetCopperLayerCount())
