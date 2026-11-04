"""Decoupling: copper path from each capacitor's supply pad to the pin it serves, GND via near its GND pad."""
import math, pcbnew, bm
b = bm.load()
# (cap, served ref, served pin, supply-side cap pad (by net), rule)
RULES = [
    ('C601', 'U601', '13'), ('C602', 'U601', '8'), ('C603', 'U601', '10'),
    ('C604', 'U602', '5'), ('C605', 'U602', '6'), ('C606', 'U602', '4'),
    ('C201', 'U201', '2'), ('C202', 'U201', '2'), ('C204', 'U202', '16'),
    ('C205', 'U204', '3'), ('C206', 'U204', '2'), ('C207', 'U204', '2'), ('C208', 'U203', '5'),
    ('C401', 'U401', '2'), ('C402', 'U401', '6'), ('C501', 'U501', '8'), ('C802', 'U802', '5'),
    ('C701', 'U701', '8'), ('C1001', 'U1001', '3'), ('C1002', 'U1001', '5'),
    ('C1101', 'U1101', '2'), ('C1102', 'U1101', '5'), ('C1103', 'U1101', '3'), ('C1104', 'U1101', '7'),
    ('C1105', 'U1101', '19'), ('C903', 'U901', '8'), ('C904', 'U902', '5'),
    ('C103', 'U101', '1'), ('C102', 'U101', '1'), ('C104', 'L101', '2'), ('C301', 'U301', '4'), ('C302', 'U302', '4'),
    ('C203', 'U201', '3'), ('C101', 'U201', '4'), ('C902', 'U901', '4'),
]
gnd_vias = [t for t in b.GetTracks() if t.GetClass() == 'PCB_VIA' and t.GetNetname() == 'GND']
graphs = {}
def graph(net):
    if net not in graphs:
        graphs[net] = bm.Graph(b, net)
    return graphs[net]

print(f"{'cap':6} {'serves':10} {'net':16} {'pad gap':>8} {'copper':>8} {'vias':>4} {'via->GND pad':>12}  path through")
rows = []
for cap, ref, pin in RULES:
    c = bm.fp(b, cap)
    tp = [p for p in bm.fp(b, ref).Pads() if p.GetNumber() == pin][0]
    net = tp.GetNetname()
    cp = [p for p in c.Pads() if p.GetNetname() == net]
    other = [p for p in c.Pads() if p.GetNetname() != net][0]
    if not cp:
        print(cap, 'not on', net); continue
    cp = cp[0]
    gap = bm._shape_gap(cp, tp)
    g = graph(net)
    best = None
    for src in g.pad_nodes(cap, cp.GetNumber()):
        for dst in g.pad_nodes(ref, pin):
            r = g.path(src, dst)
            if r and (best is None or r['length'] < best['length']):
                best = r
    # GND side: nearest GND via (or the other pad is GND and has a via) distance from the cap's GND pad edge
    on = other.GetNetname()
    if on == 'GND':
        gv = min((max(0, math.dist(bm.P(v.GetPosition()), bm.P(other.GetPosition())) ) for v in gnd_vias), default=99)
        gtxt = f"{gv:5.1f} mm"
    else:
        gtxt = f"({on.split('/')[-1]})"
    if best is None:
        ctxt, vtxt, thr = 'NO PATH', '', ''
    else:
        ctxt = f"{best['length']:6.1f}"; vtxt = str(best['vias'])
        thr = ' '.join(sorted({f'{n[1]}.{n[2]}' for n in best['through']}))
    print(f"{cap:6} {ref+'.'+pin:10} {net.split('/')[-1][:16]:16} {gap:8.1f} {ctxt:>8} {vtxt:>4} {gtxt:>12}  {thr}")
