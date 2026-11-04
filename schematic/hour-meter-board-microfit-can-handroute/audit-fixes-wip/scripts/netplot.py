"""netplot.py NAME X1 Y1 X2 Y2 NET[,NET...] : draw pads/tracks/vias in the window, chosen nets in colour."""
import sys, os, math
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon, Circle
import pcbnew, bm
name, x1, y1, x2, y2 = sys.argv[1], *map(float, sys.argv[2:6])
want = [n for n in (sys.argv[6].split(',') if len(sys.argv) > 6 else []) if n]
b = bm.load(fill='--fill' in sys.argv)
COL = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#000075', '#808000']
def netcol(n):
    for i, w in enumerate(want):
        if n == w or n.split('/')[-1] == w:
            return COL[i % len(COL)]
    return None
fig, ax = plt.subplots(figsize=(14, 14 * (y2 - y1) / (x2 - x1)))
inside = lambda p: x1 - 2 <= p[0] <= x2 + 2 and y1 - 2 <= p[1] <= y2 + 2
if '--fill' in sys.argv:
    for z in b.Zones():
        if z.GetIsRuleArea():
            continue
        for L, col in ((pcbnew.B_Cu, '#c8d4ee'), (pcbnew.F_Cu, '#f2d4d4')):
            if not z.IsOnLayer(L):
                continue
            ps = z.GetFilledPolysList(L)
            for i in range(ps.OutlineCount()):
                o = ps.Outline(i)
                pts = [bm.P(o.CPoint(k)) for k in range(o.PointCount())]
                ax.add_patch(Polygon(pts, closed=True, fc=col, ec='none', alpha=0.6 if L == pcbnew.F_Cu else 0.9))
for t in b.GetTracks():
    c = netcol(t.GetNetname())
    if t.GetClass() == 'PCB_VIA':
        p = bm.P(t.GetPosition())
        if inside(p):
            ax.add_patch(Circle(p, bm.mm(t.GetWidth(pcbnew.F_Cu)) / 2, fc=c or '#999999', ec='k', lw=0.3, zorder=5))
            ax.add_patch(Circle(p, bm.mm(t.GetDrillValue()) / 2, fc='white', ec='none', zorder=6))
        continue
    a, e = bm.P(t.GetStart()), bm.P(t.GetEnd())
    if not (inside(a) or inside(e)):
        continue
    lw = bm.mm(t.GetWidth()) * 72 / 25.4 * (14 / ((x2 - x1) / 25.4))
    ax.plot([a[0], e[0]], [a[1], e[1]], color=c or '#bbbbbb', lw=lw, solid_capstyle='round',
            ls='-' if t.GetLayer() == pcbnew.F_Cu else (0, (1, 1)), alpha=0.9 if t.GetLayer() == pcbnew.F_Cu else 0.6, zorder=3)
for f in b.GetFootprints():
    fpp = bm.P(f.GetPosition())
    for p in f.Pads():
        pp = bm.P(p.GetPosition())
        if not inside(pp):
            continue
        L = pcbnew.F_Cu if p.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu
        pts = bm._poly(p, L)
        c = netcol(p.GetNetname())
        ax.add_patch(Polygon(pts, closed=True, fc=c or '#dddddd', ec='k', lw=0.3, alpha=0.85, zorder=4))
        ax.text(pp[0], pp[1], p.GetNumber(), fontsize=5, ha='center', va='center', zorder=7)
    if inside(fpp):
        bb = f.GetBoundingBox(False)
        ax.text(bm.mm(bb.GetCenter().x), bm.mm(bb.GetTop()) - 0.3, f.GetReference(), fontsize=8, ha='center', color='#333', zorder=8)
for i, w in enumerate(want):
    ax.plot([], [], color=COL[i % len(COL)], lw=4, label=w)
ax.legend(loc='upper right', fontsize=8)
ax.set_xlim(x1, x2); ax.set_ylim(y2, y1); ax.set_aspect('equal'); ax.grid(alpha=0.3)
ax.set_title(f'{name}: solid = F.Cu, dotted = B.Cu')
out = os.path.join(os.path.dirname(__file__), '..', 'render', name + '.png')
fig.savefig(out, dpi=110, bbox_inches='tight'); print(out)
