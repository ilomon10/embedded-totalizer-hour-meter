"""Virtual power-up on the real copper: every supply net's tracks and vias become resistors (from the board),
regulators and diodes are DC models, loads are current sources at the pins. ngspice operating point per case."""
import os, subprocess, collections, pcbnew, bm
b = bm.load(fill=False)
WORK = os.path.join(os.path.dirname(__file__), '..', 'smoke'); os.makedirs(WORK, exist_ok=True)
NETS = ['VIN_IN', 'VIN_RAW', 'VIN_LM', 'LM_SW', '+5V_PSU', 'LM_FB', '+5V', '+3V3', 'SENSOR_5V', 'VBUS_IN', 'VBUS',
        'GPS_5V', 'GPS_VCC']
full = {n.split('/')[-1]: n for n in bm.net_pads(b)}
pin_node = {}
lines = []
for k, short in enumerate(NETS):
    g = bm.Graph(b, full[short])
    names = {}
    def nm(n):
        if n not in names:
            names[n] = f"n{k}_{len(names)}"
        return names[n]
    seen = set()
    for n, edges in g.adj.items():
        for e in edges:
            m = e[0]
            key = tuple(sorted((nm(n), nm(m)))) + (round(e[2], 9),)
            if key in seen or nm(n) == nm(m):
                continue
            seen.add(key)
            lines.append(f"R{len(lines)} {nm(n)} {nm(m)} {max(e[2], 1e-6):.6g}")
    for n in g.adj:
        if n[0] == 'pad':
            pin_node.setdefault((n[1], n[2]), nm(n))
    # pads on the net without any copper (shouldn't happen) -> their own node
    for p in g.pads:
        key = (p.GetParentFootprint().GetReference(), p.GetNumber())
        if key not in pin_node:
            pin_node[key] = nm(('pad', key[0], key[1], 'lone'))
def N(ref, pin):
    return pin_node[(ref, str(pin))]
MODELS = """
.model SS54 D(Is=1e-5 N=1.1 Rs=0.03 BV=50 IBV=1m)
.model SS34 D(Is=1e-5 N=1.05 Rs=0.04 BV=40)
.model B5819 D(Is=3e-6 N=1.05 Rs=0.08 BV=40)
"""
CORE = f"""
* F101 0.5 A PTC (about 0.7 ohm), D103 SS54 reverse-polarity diode
RF101 {N('F101',1)} {N('F101',2)} 0.7
D103 {N('D103',2)} {N('D103',1)} SS54
* LM2596-ADJ, averaged: output at pin 2 regulated so FB (R103/R104 divider) sits at 1.23 V; saturation about 1.2 V
RR103 {N('R103',1)} {N('R103',2)} 3.3k
RR104 {N('R104',1)} 0 1k
BBUCK sw_int 0 V=max(min(max(2000*(1.23-V({N('U101',4)})),0), V({N('U101',1)})-1.2),0)
VSW sw_int {N('U101',2)} 0
* efficiency 80 %: the input draws Pout/0.8 plus 5 mA quiescent
BIN {N('U101',1)} 0 I=V({N('U101',2)})*I(VSW)/(0.8*max(V({N('U101',1)}),1))+0.005
* L101 DCR, D101 SS34 (5 V OR diode)
RL101 {N('L101',1)} {N('L101',2)} 0.035
D101 {N('D101',2)} {N('D101',1)} SS34
* AMS1117-3.3: 3.3 V or VIN - dropout (1.0 V + 0.25 ohm), 5 mA ground current
BLDO ldo_int 0 V=min(3.3, V({N('U204',3)})-1.0-0.25*I(VLDO))
VLDO ldo_int {N('U204',2)} 0
BLDOIN {N('U204',3)} 0 I=I(VLDO)+0.005
* fuses on the outputs: F801 (J1 sensor 5 V) and F803 (GPS 5 V) 0.2 A PTCs, about 2 ohm; F201 USB 0.5 A PTC
RF801 {N('F801',1)} {N('F801',2)} 2
RF803 {N('F803',1)} {N('F803',2)} 2
RF201 {N('F201',1)} {N('F201',2)} 0.35
D201 {N('D201',2)} {N('D201',1)} B5819
* JP801 bridged 1-2 (GPS from +3V3)
RJP801 {N('JP801',1)} {N('JP801',2)} 0.001
* keep isolated nodes defined
"""
SPEC = {  # pin: (label, min, max)
    ('U201', '2'): ('ESP32 3V3', 3.0, 3.6), ('U202', '16'): ('CH340C VCC', 3.0, 3.6), ('U601', '13'): ('MPU-6500 VDD', 1.71, 3.6),
    ('U602', '5'): ('LIS3MDL Vdd', 1.9, 3.6), ('U401', '2'): ('DS3231M VCC', 2.3, 5.5), ('U501', '8'): ('AT24C256 VCC', 1.7, 5.5),
    ('U701', '8'): ('THVD2410 VCC', 3.0, 5.5), ('U1001', '3'): ('TJA1051 VCC', 4.5, 5.5), ('U1001', '5'): ('TJA1051 VIO', 2.8, 5.5),
    ('U1101', '19'): ('MAX13223E VCC', 3.0, 5.5), ('U901', '8'): ('ADS1115 VDD', 2.0, 5.5), ('U902', '5'): ('74AHCT1G125 VCC', 4.5, 5.5),
    ('U204', '3'): ('AMS1117 in', 4.6, 15), ('U101', '1'): ('LM2596 in', 4.5, 40), ('J1', '4'): ('J1 sensor 5V', 4.5, 5.5),
    ('J802', '1'): ('GPS VCC', 3.0, 3.6), ('J803', '2'): ('Qwiic 3V3', 3.0, 3.6),
}
LOADS = {
    'idle':    {('U201', '2'): 0.040, ('U202', '16'): 0.005, ('U601', '13'): 0.004, ('U602', '5'): 0.001, ('U401', '2'): 0.0002,
                ('U501', '8'): 0.0001, ('U701', '8'): 0.001, ('U1001', '3'): 0.005, ('U1001', '5'): 0.0001, ('U1101', '19'): 0.008,
                ('U901', '8'): 0.0003, ('U902', '5'): 0.001, ('J802', '1'): 0.030, ('R209', '1'): 0.0013, ('R105', '1'): 0.0015},
    'typical': {('U201', '2'): 0.080, ('U202', '16'): 0.010, ('U601', '13'): 0.004, ('U602', '5'): 0.001, ('U401', '2'): 0.0002,
                ('U501', '8'): 0.001, ('U701', '8'): 0.005, ('U1001', '3'): 0.020, ('U1001', '5'): 0.0005, ('U1101', '19'): 0.015,
                ('U901', '8'): 0.0003, ('U902', '5'): 0.001, ('J802', '1'): 0.040, ('J803', '2'): 0.010, ('J1', '4'): 0.050,
                ('R209', '1'): 0.0013, ('R105', '1'): 0.0015},
    'maximum': {('U201', '2'): 0.350, ('U202', '16'): 0.020, ('U601', '13'): 0.004, ('U602', '5'): 0.001, ('U401', '2'): 0.0002,
                ('U501', '8'): 0.003, ('U701', '8'): 0.060, ('U1001', '3'): 0.070, ('U1001', '5'): 0.001, ('U1101', '19'): 0.030,
                ('U901', '8'): 0.0003, ('U902', '5'): 0.002, ('J802', '1'): 0.050, ('J803', '2'): 0.100, ('J1', '4'): 0.200,
                ('R209', '1'): 0.0013, ('R105', '1'): 0.0015},
}
CASES = [('VIN', v, l) for v in (9, 12, 24, 30) for l in ('idle', 'typical', 'maximum')] + \
        [('USB', v, l) for v in (4.75, 5.0, 5.25) for l in ('idle', 'typical')]
rows = []
for src, v, load in CASES:
    deck = [f"* smoke {src} {v} {load}", MODELS, *lines, CORE]
    if src == 'VIN':
        deck.append(f"VIN {N('J1', 9)} 0 {v}")
    else:
        for p in ('A4', 'B9', 'A9', 'B4'):
            if ('J201', p) in pin_node:
                deck.append(f"VUSB{p} {N('J201', p)} 0 {v}"); break
    for i, ((r, p), a) in enumerate(LOADS[load].items()):
        deck.append(f"IL{i} {N(r, p)} 0 {a}")
    # tiny leak to ground on every node so floating stubs solve
    nodes = sorted({w for l in lines for w in l.split()[1:3]} | {N(r, p) for (r, p) in SPEC})
    deck += [f"RLEAK{i} {n} 0 1e9" for i, n in enumerate(nodes)]
    probes = [N(r, p) for (r, p) in SPEC]
    deck.append(".control\nop\n" + "\n".join(f"print v({n})" for n in probes) +
                "\nprint i(VSW) i(VLDO)\n" + (f"print i(VIN)\n" if src == 'VIN' else '') + "quit\n.endc\n.end")
    path = os.path.join(WORK, f"smoke_{src}_{v}_{load}.cir")
    open(path, 'w').write("\n".join(deck))
    out = subprocess.run(['ngspice', '-b', path], capture_output=True, text=True, timeout=120).stdout
    vals = {}
    for line in out.splitlines():
        if '=' in line:
            k, _, r = line.partition('=')
            try:
                vals[k.strip().lower()] = float(r.split()[0])
            except Exception:
                pass
    res = {}
    bad = []
    for (r, p), (label, lo, hi) in SPEC.items():
        x = vals.get(f"v({N(r, p)})".lower())
        res[label] = x
        if x is None or not (lo <= x <= hi):
            if not (src == 'USB' and label in ('LM2596 in',)):
                bad.append(f"{label} {x if x is None else round(x, 3)} (spec {lo}-{hi})")
    rows.append((src, v, load, res, bad, vals.get('i(vsw)'), vals.get('i(vldo)'), vals.get('i(vin)')))
for src, v, load, res, bad, isw, ildo, iin in rows:
    head = f"{src} {v:5} V {load:8}"
    core = f"5V_PSU-out {abs(isw or 0)*1e3:6.0f} mA, 3V3 {abs(ildo or 0)*1e3:5.0f} mA" + (f", VIN {abs(iin)*1e3:5.0f} mA" if iin else '')
    res = {k: (v if v is not None else float('nan')) for k, v in res.items()}
    key = f"ESP32 {res['ESP32 3V3']:.3f} V, AMS1117 in {res['AMS1117 in']:.3f} V, TJA1051 {res['TJA1051 VCC']:.3f} V, J1.4 {res['J1 sensor 5V']:.3f} V"
    print(f"{head} | {core} | {key}")
    for x in bad:
        print(f"        OUT OF SPEC: {x}")
