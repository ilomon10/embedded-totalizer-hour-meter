"""Board model for the audit: load the snapshot (never saved), copper graph per net, Dijkstra paths."""
import heapq, math, os, collections
import pcbnew

SNAP = os.environ.get('BOARD') or os.path.join(os.path.dirname(__file__), '..', 'board', 'hour-meter-board-microfit-can-handroute.kicad_pcb')
RHO = 1.72e-8          # copper, ohm m at 20 C
T_CU = 35e-6           # 1 oz finished outer copper
VIA_R = 1.6e-3         # 0.3 mm drill, ~18 um wall, 1.6 mm board
mm = pcbnew.ToMM
_board = None


def load(fill=True):
    global _board
    if _board is None:
        _board = pcbnew.LoadBoard(SNAP)
        if fill:
            pcbnew.ZONE_FILLER(_board).Fill(_board.Zones())
    return _board


def P(v):
    return (mm(v.x), mm(v.y))


def outline(b):
    bb = b.GetBoardEdgesBoundingBox()
    return mm(bb.GetLeft()), mm(bb.GetTop()), mm(bb.GetRight()), mm(bb.GetBottom())


def fp(b, ref):
    return b.FindFootprintByReference(ref)


def pad(b, ref, num):
    f = fp(b, ref)
    ps = [p for p in f.Pads() if p.GetNumber() == str(num)]
    return ps


def net_pads(b):
    d = collections.defaultdict(list)
    for f in b.GetFootprints():
        for p in f.Pads():
            if p.GetNetname():
                d[p.GetNetname()].append(p)
    return d


def pad_gap(p1, p2):
    """edge-to-edge distance between two pads (mm), same side assumed"""
    s1 = p1.GetEffectiveShape(p1.GetLayerSet().Seq()[0] if False else pcbnew.F_Cu if p1.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu)
    s2 = p2.GetEffectiveShape(pcbnew.F_Cu if p2.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu)
    # brute: polygon distance via sampling of outlines
    return _shape_gap(p1, p2)


def _poly(pad_, layer=None):
    layer = layer if layer is not None else (pcbnew.F_Cu if pad_.IsOnLayer(pcbnew.F_Cu) else pcbnew.B_Cu)
    ps = pcbnew.SHAPE_POLY_SET()
    pad_.TransformShapeToPolygon(ps, layer, 0, 5000, pcbnew.ERROR_INSIDE)
    pts = []
    for i in range(ps.OutlineCount()):
        o = ps.Outline(i)
        for k in range(o.PointCount()):
            pts.append(P(o.CPoint(k)))
    return pts


def _seg_pt(p, a, b):
    ax, ay = a; bx, by = b; px, py = p
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0 if L2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - ax - t * dx, py - ay - t * dy), (ax + t * dx, ay + t * dy), t


def _shape_gap(p1, p2):
    a, c = _poly(p1), _poly(p2)
    best = 1e9
    for poly, other in ((a, c), (c, a)):
        n = len(other)
        for p in poly:
            for i in range(n):
                d, _, _ = _seg_pt(p, other[i], other[(i + 1) % n])
                best = min(best, d)
    return best


def _seg_seg(a, b, c, d):
    """closest distance between segments ab and cd: (dist, t on ab, t on cd, midpoint)"""
    best = None
    for p, (s0, s1), first in ((a, (c, d), False), (b, (c, d), False), (c, (a, b), True), (d, (a, b), True)):
        dist, q, t = _seg_pt(p, s0, s1)
        if first:
            # p is an end of cd; t is along ab
            tab, tcd = t, (0.0 if p is c else 1.0)
        else:
            tab, tcd = (0.0 if p is a else 1.0), t
        if best is None or dist < best[0]:
            best = (dist, tab, tcd, ((p[0] + q[0]) / 2, (p[1] + q[1]) / 2))
    # proper crossing
    def cross(o, p, q):
        return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0])
    d1, d2, d3, d4 = cross(c, d, a), cross(c, d, b), cross(a, b, c), cross(a, b, d)
    if (d1 > 0) != (d2 > 0) and (d3 > 0) != (d4 > 0) and d1 != d2 and d3 != d4:
        t = d1 / (d1 - d2)
        x = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
        u = d3 / (d3 - d4)
        best = (0.0, t, u, x)
    return best


class Graph:
    """Copper graph of one net from tracks, arcs, vias and pads (no zones)."""

    def __init__(self, b, net):
        self.b, self.net = b, net
        self.adj = collections.defaultdict(list)   # node -> [(node, length_mm, R_ohm, kind, width)]
        self.segs = []
        self.vias = []
        self.pads = [p for f in b.GetFootprints() for p in f.Pads() if p.GetNetname() == net]
        for t in b.GetTracks():
            if t.GetNetname() != net:
                continue
            if t.GetClass() == 'PCB_VIA':
                self.vias.append(t)
            elif t.GetClass() == 'PCB_ARC':
                s, m, e = P(t.GetStart()), P(t.GetMid()), P(t.GetEnd())
                w = mm(t.GetWidth())
                self.segs += [(s, m, w, t.GetLayer(), t), (m, e, w, t.GetLayer(), t)]
            else:
                self.segs.append((P(t.GetStart()), P(t.GetEnd()), mm(t.GetWidth()), t.GetLayer(), t))
        self._build()

    def _node_pt(self, n):
        return n[1]

    def _build(self):
        """Join items whose copper overlaps on a shared layer (fabricated copper merges), not only at anchors."""
        nodes_at = collections.defaultdict(list)   # seg index -> [(t, node)]
        def add(si, t, node):
            nodes_at[si].append((t, node))
        def pt(xy, L):
            return ('pt', (round(xy[0], 4), round(xy[1], 4)), L)
        segs = self.segs
        for si, (a, c, w, L, _) in enumerate(segs):
            add(si, 0.0, pt(a, L)); add(si, 1.0, pt(c, L))
        # segment-segment overlap on the same layer: join at the closest points
        for si in range(len(segs)):
            a, c, w, L, _ = segs[si]
            for sj in range(si + 1, len(segs)):
                a2, c2, w2, L2, _ = segs[sj]
                if L2 != L:
                    continue
                d, t1, t2, q = _seg_seg(a, c, a2, c2)
                if d <= (w + w2) / 2 + 1e-4:
                    n = pt(q, L)
                    add(si, t1, n); add(sj, t2, n)
        # vias: join a segment whose copper overlaps the via pad
        self.via_nodes = []
        for v in self.vias:
            vp = P(v.GetPosition()); rad = mm(v.GetWidth(pcbnew.F_Cu)) / 2
            vn = ('via', (round(vp[0], 4), round(vp[1], 4)))
            self.via_nodes.append(vn)
            self.adj[vn]
            for si, (a, c, w, L, _) in enumerate(segs):
                d, q, t = _seg_pt(vp, a, c)
                if d <= w / 2 + rad + 1e-4:
                    n = pt(q, L)
                    add(si, t, n)
                    self.adj[vn].append((n, 0.0, VIA_R / 2, 'via', 0))
                    self.adj[n].append((vn, 0.0, VIA_R / 2, 'via', 0))
        # pads: join a segment whose copper overlaps the pad on that layer, and vias inside the pad
        for p in self.pads:
            pn = ('pad', p.GetParentFootprint().GetReference(), p.GetNumber(), P(p.GetPosition()))
            self.adj[pn]
            pc = P(p.GetPosition())
            for si, (a, c, w, L, _) in enumerate(segs):
                if not p.IsOnLayer(L):
                    continue
                shape = p.GetEffectiveShape(L)
                seg = pcbnew.SEG(pcbnew.VECTOR2I(pcbnew.FromMM(a[0]), pcbnew.FromMM(a[1])),
                                 pcbnew.VECTOR2I(pcbnew.FromMM(c[0]), pcbnew.FromMM(c[1])))
                if shape.Collide(seg, int(pcbnew.FromMM(w / 2)) + 100):
                    d, q, t = _seg_pt(pc, a, c)
                    n = pt(q, L)
                    add(si, t, n)
                    self.adj[pn].append((n, 0.0, 0.0, 'pad', 0))
                    self.adj[n].append((pn, 0.0, 0.0, 'pad', 0))
            for v, vn in zip(self.vias, self.via_nodes):
                rad = mm(v.GetWidth(pcbnew.F_Cu)) / 2
                if any(p.IsOnLayer(L) and p.GetEffectiveShape(L).Collide(v.GetPosition(), int(pcbnew.FromMM(rad)))
                       for L in (pcbnew.F_Cu, pcbnew.B_Cu)):
                    self.adj[pn].append((vn, 0.0, 0.0, 'pad', 0))
                    self.adj[vn].append((pn, 0.0, 0.0, 'pad', 0))
        for si, lst in nodes_at.items():
            a, c, w, L, _ = segs[si]
            length = math.hypot(c[0] - a[0], c[1] - a[1])
            lst.sort()
            for (t1, n1), (t2, n2) in zip(lst, lst[1:]):
                if n1 == n2:
                    continue
                l = (t2 - t1) * length
                r = RHO * l * 1e-3 / (w * 1e-3 * T_CU)
                self.adj[n1].append((n2, l, r, 'track', w))
                self.adj[n2].append((n1, l, r, 'track', w))
        # pads that overlap each other (same net, e.g. a tab and its pin)
        for i, p in enumerate(self.pads):
            for q in self.pads[i + 1:]:
                for L in (pcbnew.F_Cu, pcbnew.B_Cu):
                    if p.IsOnLayer(L) and q.IsOnLayer(L) and p.GetEffectiveShape(L).Collide(q.GetEffectiveShape(L), 0):
                        pn = ('pad', p.GetParentFootprint().GetReference(), p.GetNumber(), P(p.GetPosition()))
                        qn = ('pad', q.GetParentFootprint().GetReference(), q.GetNumber(), P(q.GetPosition()))
                        self.adj[pn].append((qn, 0.0, 0.0, 'pad', 0))
                        self.adj[qn].append((pn, 0.0, 0.0, 'pad', 0))
                        break

    def pad_node(self, ref, num):
        for n in self.adj:
            if n[0] == 'pad' and n[1] == ref and n[2] == str(num):
                return n
        return None

    def pad_nodes(self, ref, num):
        return [n for n in self.adj if n[0] == 'pad' and n[1] == ref and n[2] == str(num)]

    def dijkstra(self, src, weight='len'):
        k = 1 if weight == 'len' else 2
        dist = {src: 0.0}; prev = {}
        pq = [(0.0, id(src), src)]
        seen = set()
        while pq:
            d, _, n = heapq.heappop(pq)
            if n in seen:
                continue
            seen.add(n)
            for e in self.adj[n]:
                m = e[0]
                nd = d + e[k]
                if nd < dist.get(m, 1e18):
                    dist[m] = nd; prev[m] = (n, e)
                    heapq.heappush(pq, (nd, id(m), m))
        return dist, prev

    def path(self, src, dst, weight='len'):
        dist, prev = self.dijkstra(src, weight)
        if dst not in dist:
            return None
        edges = []; n = dst
        while n != src:
            pn, e = prev[n]
            edges.append((pn, n, e)); n = pn
        edges.reverse()
        length = sum(e[1] for _, _, e in edges)
        res = sum(e[2] for _, _, e in edges)
        nvia = sum(1 for _, _, e in edges if e[3] == 'via') // 2
        wmin = min([e[4] for _, _, e in edges if e[3] == 'track'] or [0])
        through = [n for _, n, _ in edges if n[0] == 'pad' and n != dst]
        return dict(length=length, R=res, vias=nvia, wmin=wmin, through=through, edges=edges)

    def components(self):
        seen = set(); comps = []
        for n in list(self.adj):
            if n in seen:
                continue
            stack = [n]; comp = set()
            while stack:
                x = stack.pop()
                if x in seen:
                    continue
                seen.add(x); comp.add(x)
                stack.extend(e[0] for e in self.adj[x])
            comps.append(comp)
        return comps
