"""Connector short circuits: the current each output's fuse or limiter lets through, along this board's copper."""
import pcbnew, bm
from power import rise
b = bm.load(fill=False)
full = {n.split('/')[-1]: n for n in bm.net_pads(b)}
CASES = [  # (label, [(net, from pad, to pad)], fault current A, what limits it)
    ('J1.4 sensor 5 V shorted', [('+5V', ('D101', '1'), ('F801', '1')), ('SENSOR_5V', ('F801', '2'), ('J1', '4'))], 3.0,
     'LM2596 current limit (about 3 A out) until F801 (0.2 A PTC) trips, well under 1 s'),
    ('Qwiic 3V3 shorted', [('+3V3', ('U204', '2'), ('J803', '2'))], 1.5, "AMS1117 limit (1.5 A), then its thermal shutdown cycles"),
    ('GPS VCC shorted (JP801 1-2, 3V3)', [('+3V3', ('U204', '2'), ('JP801', '1')), ('GPS_VCC', ('JP801', '2'), ('J802', '1'))], 1.5,
     'AMS1117 limit (1.5 A)'),
    ('GPS VCC shorted (JP801 2-3, 5 V)', [('+5V', ('D101', '1'), ('F803', '1')), ('GPS_5V', ('F803', '2'), ('JP801', '3'))], 3.0,
     'LM2596 limit until F803 (0.2 A PTC) trips'),
    ('J1.10 DOUT1 shorted to VIN while on', [('DOUT1', ('J1', '10'), ('U903', '2'))], 1.5, 'BSP75N current limit (0.7-1.5 A), thermal cycling'),
    ('VIN input at the F101 trip edge', [('VIN_IN', ('J1', '9'), ('F101', '1')), ('VIN_RAW', ('F101', '2'), ('D103', '2')), ('VIN_LM', ('D103', '1'), ('U101', '1'))], 1.0,
     'F101 0.5 A hold / 1 A trip'),
]
for label, legs, amps, why in CASES:
    worst = None; total_len = 0; vias = 0
    for net, a, c in legs:
        g = bm.Graph(b, full[net])
        best = None
        for s in g.pad_nodes(*a):
            for d in g.pad_nodes(*c):
                r = g.path(s, d, 'R')
                if r and (best is None or r['R'] < best['R']):
                    best = r
        if best is None:
            print(label, net, 'NO PATH'); continue
        total_len += best['length']; vias += best['vias']
        for (n1, n2, e) in best['edges']:
            if e[3] == 'track':
                t = rise(amps, e[4])
                if worst is None or t > worst[0]:
                    worst = (t, e[4], net, n1[1])
    t, w, net, where = worst
    print(f"{label}: {amps} A ({why}); path {total_len:.0f} mm, {vias} vias; narrowest {w:.2f} mm on {net} at {where}: +{t:.0f} C steady")
