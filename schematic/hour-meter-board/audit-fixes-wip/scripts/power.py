"""Supply copper: current tree from each rail's source to its loads; drop, narrowest loaded track, IPC-2221 rise."""
import collections, math, sys, bm
b = bm.load(fill=False)
MIL = 0.0254


def rise(i, w_mm, t_um=35.0):
    """IPC-2221 external layer temperature rise (C) for current i (A) in a w x t track."""
    a = (w_mm / MIL) * (t_um / 25.4)          # mil^2 (1 mil = 25.4 um)
    return (i / (0.048 * a ** 0.725)) ** (1 / 0.44) if i > 0 else 0.0


# max-case loads (A) per pad: datasheets + PINOUT.md budget; fuse hold currents for the fused outputs
I33 = {('U201', '2'): 0.35, ('U202', '16'): 0.02, ('U601', '13'): 0.004, ('U601', '8'): 0.001,
       ('U602', '5'): 0.001, ('U602', '6'): 0.001, ('U401', '2'): 0.001, ('U501', '8'): 0.003,
       ('U701', '8'): 0.06, ('U1001', '5'): 0.001, ('U1101', '19'): 0.03, ('U901', '8'): 0.001,
       ('J803', '2'): 0.10, ('JP801', '1'): 0.05, ('R209', '1'): 0.0015}
i33 = sum(I33.values())
I5 = {('U204', '3'): i33, ('F801', '1'): 0.20, ('U1001', '3'): 0.07, ('U902', '5'): 0.002, ('F803', '1'): 0.20,
      ('U802', '5'): 0.001}
i5 = sum(I5.values())
EFF = 0.78
PLAN = {
    '+3V3': ([('U204', '2')], I33),
    '+5V': ([('D101', '1')], I5),
    '/5V buck (U101)/+5V_PSU': ([('L101', '2')], {('D101', '2'): i5, ('R105', '1'): 0.002, ('R103', '1'): 0.001}),
    '/5V buck (U101)/LM_SW': ([('U101', '2')], {('L101', '1'): i5}),        # average inductor current
    'SENSOR_5V': ([('F801', '2')], {('J1', '4'): 0.40}),                     # F801 trip current
    '/ESP32 + USB (U201)/VBUS': ([('F201', '2')], {('D201', '2'): 0.5}),
    '/ESP32 + USB (U201)/VBUS_IN': ([('J201', 'A4')], {('F201', '1'): 0.5}),
}
for vin in (9.0,):
    iin = 5.0 * i5 / EFF / vin
    PLAN.update({
        'VIN_IN': ([('J1', '9')], {('F101', '1'): iin}),
        '/VIN input/VIN_RAW': ([('F101', '2')], {('D103', '2'): iin}),
        'VIN_LM': ([('D103', '1')], {('U101', '1'): iin}),
    })
print(f"loads: 3V3 {i33*1e3:.0f} mA, 5V {i5*1e3:.0f} mA, VIN at 9 V {5*i5/EFF/9*1e3:.0f} mA (eff {EFF})")
nets = {n.split('/')[-1]: n for n in bm.net_pads(b)}
out = []
for short, (srcs, loads) in PLAN.items():
    net = nets.get(short.split('/')[-1], short)
    g = bm.Graph(b, net)
    comps = g.components()
    src = g.pad_nodes(*srcs[0])
    if not src:
        print(net, 'no source node'); continue
    dist, prev = g.dijkstra(src[0], 'R')
    edge_i = collections.defaultdict(float); edge_info = {}
    drops = []
    for (ref, pin), i in loads.items():
        dsts = [n for n in g.pad_nodes(ref, pin) if n in dist]
        if not dsts:
            drops.append((f'{ref}.{pin}', None, i)); continue
        dst = min(dsts, key=lambda n: dist[n])
        n = dst; R = 0.0
        while n != src[0]:
            pn, e = prev[n]
            key = (pn, n) if str(pn) < str(n) else (n, pn)
            edge_i[key] += i; edge_info[key] = e; R += e[2]; n = pn
        drops.append((f'{ref}.{pin}', R, i))
    # per-edge worst rise / narrowest loaded track
    worst = max(((rise(edge_i[k], edge_info[k][4]), edge_i[k], edge_info[k][4], k) for k in edge_i if edge_info[k][3] == 'track'), default=None)
    narrow = min(((edge_info[k][4], edge_i[k], k) for k in edge_i if edge_info[k][3] == 'track'), default=None)
    vias = sum(1 for k in edge_i if edge_info[k][3] == 'via') // 2
    print(f"\n== {short.split('/')[-1]}  (components {len(comps)})")
    for ref, R, i in drops:
        if R is None:
            print(f"   {ref:9} NOT REACHED")
        else:
            print(f"   {ref:9} {i*1e3:6.0f} mA  R {R*1e3:6.1f} mOhm  drop {i*R*1e3:6.1f} mV (own current only)")
    tot = {}
    for ref, R, i in drops:
        pass
    if worst:
        r, i, w, k = worst
        print(f"   hottest track: {w:.2f} mm carrying {i*1e3:.0f} mA -> +{r:.1f} C at {k[0][1]}")
    if narrow:
        w, i, k = narrow
        print(f"   narrowest loaded track: {w:.2f} mm carrying {i*1e3:.0f} mA (+{rise(i, w):.1f} C) at {k[0][1]} {k[1][1]}")
    print(f"   vias on the supply paths: {vias}")
