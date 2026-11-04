"""Board edit helpers for the audit fixes (scratch copy only; save with skip-settings)."""
import math, subprocess, json, collections, os, pcbnew
mm, FM = pcbnew.ToMM, pcbnew.FromMM
FIX = os.path.join(os.path.dirname(__file__), '..', 'fix', 'hour-meter-board-microfit-can-handroute.kicad_pcb')


def V(x, y):
    return pcbnew.VECTOR2I(FM(x), FM(y))


def P(v):
    return (round(mm(v.x), 4), round(mm(v.y), 4))


def net(b, name):
    for n, ni in b.GetNetInfo().NetsByName().items():
        if str(n) == name or str(n).split('/')[-1] == name:
            return ni
    raise KeyError(name)


def fp(b, ref):
    for f in b.GetFootprints():
        if f.GetReference() == ref:
            return f
    raise KeyError(ref)


def pads_of(b, ref):
    return {p.GetNumber(): p for p in fp(b, ref).Pads()}


def move_fp(b, ref, x, y, rot=None, drag=True):
    """move a footprint; track ends that sat on one of its pad centres follow that pad"""
    f = fp(b, ref)
    old = {(p.GetNumber(), i): P(p.GetPosition()) for i, p in enumerate(f.Pads())}
    f.SetPosition(V(x, y))
    if rot is not None:
        f.SetOrientationDegrees(rot)
    new = {(p.GetNumber(), i): P(p.GetPosition()) for i, p in enumerate(f.Pads())}
    moved = 0
    if drag:
        for t in b.GetTracks():
            if t.GetClass() == 'PCB_VIA':
                continue
            for k, o in old.items():
                for end, setter in ((t.GetStart(), t.SetStart), (t.GetEnd(), t.SetEnd)):
                    if math.dist(P(end), o) < 1e-3 and t.GetNetname() == f.Pads()[k[1]].GetNetname():
                        setter(V(*new[k])); moved += 1
    return moved


def add_track(b, netname, pts, w, layer=pcbnew.F_Cu):
    n = net(b, netname)
    out = []
    for a, c in zip(pts, pts[1:]):
        t = pcbnew.PCB_TRACK(b)
        t.SetStart(V(*a)); t.SetEnd(V(*c)); t.SetWidth(FM(w)); t.SetLayer(layer); t.SetNet(n)
        b.Add(t); out.append(t)
    return out


def add_via(b, netname, x, y, d=0.6, drill=0.3):
    v = pcbnew.PCB_VIA(b)
    v.SetPosition(V(x, y)); v.SetWidth(FM(d)); v.SetDrill(FM(drill)); v.SetNet(net(b, netname))
    b.Add(v)
    return v


def delete_tracks(b, pred):
    dead = [t for t in b.GetTracks() if pred(t)]
    for t in dead:
        b.Delete(t)
    return len(dead)


def fill(b):
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())


def save(b, path=FIX):
    fill(b)
    pcbnew.SaveBoard(path, b, True)


def drc(path=FIX, out=None):
    out = out or path.replace('.kicad_pcb', '-drc.json')
    subprocess.run(['kicad-cli', 'pcb', 'drc', '--severity-all', '--schematic-parity', '--refill-zones', '--format', 'json',
                    '-o', out, path], capture_output=True)
    d = json.load(open(out))
    return d


def summary(d):
    c = collections.Counter((v['type'], v['severity']) for v in d['violations'])
    return dict(c), len(d['unconnected_items']), len(d['schematic_parity'])


def problems(d, ignore=('silk_edge_clearance',)):
    return [(v['type'], v['description'], [i['description'] for i in v['items']], [i.get('pos') for i in v['items']])
            for v in d['violations'] if v['type'] not in ignore] + \
           [('unconnected', '', [i['description'] for i in v['items']], [i.get('pos') for i in v['items']]) for v in d['unconnected_items']]
