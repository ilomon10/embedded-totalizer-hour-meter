"""Placement and routing rules from the sheets: protectors at J1, AIN1 front end, EN RC, USB pair, antenna,
magnetometer distances, IMU orientation, feedback divider, track lengths of field lines."""
import math, pcbnew, bm
b = bm.load(fill=False)
x0, y0, x1, y1 = bm.outline(b)
G = {}
def g(net):
    if net not in G:
        G[net] = bm.Graph(b, net)
    return G[net]
def full(short):
    for n in bm.net_pads(b):
        if n == short or n.split('/')[-1] == short:
            return n
def path(net, a, b_):
    gr = g(full(net))
    best = None
    for s in gr.pad_nodes(*a):
        for d in gr.pad_nodes(*b_):
            r = gr.path(s, d)
            if r and (best is None or r['length'] < best['length']):
                best = r
    return best
def pl(net, a, b_):
    r = path(net, a, b_)
    return f"{r['length']:.1f} mm ({r['vias']} vias)" if r else 'no path'

print('== protectors and field lines (copper from J1 pin)')
for net, j, prot, chip in [('CAN_H', '13', ('D1001', '2'), ('U1001', '7')), ('CAN_L', '5', ('D1001', '1'), ('U1001', '6')),
                           ('RS485_A', '14', ('D701', '1'), ('U701', '6')), ('RS485_B', '6', ('D701', '2'), ('U701', '7')),
                           ('AIN1_RAW', '11', ('C901', '1'), ('R901', '1')), ('RS232_TXD', '3', None, ('U1101', '17')),
                           ('RS232_RXD', '12', None, ('U1101', '16')), ('DOUT1', '10', None, ('U903', '2')),
                           ('VIN_IN', '9', None, ('F101', '1')), ('SENSOR_5V', '4', None, ('F801', '2'))]:
    s = f"   {net:10} J1.{j:3}"
    if prot:
        s += f" -> {prot[0]}: {pl(net, ('J1', j), prot)};"
    s += f" -> {chip[0]}.{chip[1]}: {pl(net, ('J1', j), chip)}"
    print(s)
for a, c in (('CAN_H', 'CAN_L'), ('RS485_A', 'RS485_B')):
    ra = path(a, ('J1', '13' if a == 'CAN_H' else '14'), ('U1001', '7') if a == 'CAN_H' else ('U701', '6'))
    rc = path(c, ('J1', '5' if c == 'CAN_L' else '6'), ('U1001', '6') if c == 'CAN_L' else ('U701', '7'))
    print(f"   pair {a}/{c}: {ra['length']:.1f} / {rc['length']:.1f} mm, mismatch {abs(ra['length'] - rc['length']):.1f} mm")
dp = path('USB_DP', ('J201', 'A6'), ('U202', '5')); dm = path('USB_DM', ('J201', 'A7'), ('U202', '6'))
print(f"   USB D+/D-: {dp['length']:.1f} / {dm['length']:.1f} mm, mismatch {abs(dp['length']-dm['length']):.1f} mm, vias {dp['vias']}/{dm['vias']}")
print(f"   U203 (USB ESD) from J201: D+ {pl('USB_DP', ('J201','A6'), ('U203','1'))}, D- {pl('USB_DM', ('J201','A7'), ('U203','3'))}")

print('== AIN1 front end')
print(f"   J1.11 -> C901: {pl('AIN1_RAW', ('J1','11'), ('C901','1'))}; AIN1_ADC R902 -> U901.4: {pl('AIN1_ADC', ('R902','2'), ('U901','4'))}")
def min_gap(netA, netB):
    """closest copper (track/pad edge) between two nets, mm"""
    def items(n):
        out = []
        for t in b.GetTracks():
            if t.GetNetname() == n and t.GetClass() != 'PCB_VIA':
                out.append(('s', bm.P(t.GetStart()), bm.P(t.GetEnd()), bm.mm(t.GetWidth()) / 2))
            elif t.GetNetname() == n:
                p = bm.P(t.GetPosition()); out.append(('s', p, p, bm.mm(t.GetWidth(pcbnew.F_Cu)) / 2))
        for f in b.GetFootprints():
            for p in f.Pads():
                if p.GetNetname() == n:
                    pp = bm.P(p.GetPosition()); r = min(bm.mm(p.GetSize(pcbnew.F_Cu).x), bm.mm(p.GetSize(pcbnew.F_Cu).y)) / 2
                    out.append(('s', pp, pp, r))
        return out
    A, B = items(full(netA)), items(full(netB))
    best = 1e9
    for _, a1, a2, ra in A:
        for _, b1, b2, rb in B:
            d = bm._seg_seg(a1, a2, b1, b2)[0] - ra - rb
            best = min(best, d)
    return best
for n in ('AIN1_RAW', 'AIN1_MID', 'AIN1_ADC'):
    print(f"   {n} to LM_SW copper: {min_gap(n, 'LM_SW'):.1f} mm (rule >= 8)")
print(f"   LM_FB to LM_SW copper: {min_gap('LM_FB', 'LM_SW'):.2f} mm")
fb = path('LM_FB', ('U101', '4'), ('R103', '2'))
print(f"   LM_FB U101.4 -> R103/R104: {fb['length']:.1f} mm (rule: divider next to pin 4)")
print(f"   R104 centre to U101.4: {math.dist(bm.P(bm.fp(b,'R104').GetPosition()), bm.P(bm.pad(b,'U101','4')[0].GetPosition())):.1f} mm")
print(f"   LM_SW copper U101.2 -> D105.1: {pl('LM_SW', ('U101','2'), ('D105','1'))}; -> L101.1: {pl('LM_SW', ('U101','2'), ('L101','1'))}")

print('== ESP32')
print(f"   EN: U201.3 -> C203: {pl('ESP_EN', ('U201','3'), ('C203','1'))}, -> R201: {pl('ESP_EN', ('U201','3'), ('R201','2'))}, -> SW201: {pl('ESP_EN', ('U201','3'), ('SW201','1'))}")
print(f"   IO0: U201.25 -> SW202: {pl('ESP_IO0', ('U201','25'), ('SW202','1'))}")
u = bm.fp(b, 'U201')
cy = u.GetCourtyard(pcbnew.F_CrtYd).BBox()
print(f"   U201 courtyard y {bm.mm(cy.GetTop()):.2f}..{bm.mm(cy.GetBottom()):.2f}, board top {y0+0.05:.2f}: module sticks out {y0 + 0.05 - bm.mm(cy.GetTop()):.2f} mm")
# copper in the antenna area: the module's top 7.0 mm? report copper items above the first pin row minus margin
pin1 = bm.P(bm.pad(b, 'U201', '1')[0].GetPosition())
print(f"   U201 pin 1 at y {pin1[1]:.2f}; copper (other than U201) with y < {pin1[1]-1.0:.2f} within the module's width:")
xl, xr = bm.mm(cy.GetLeft()), bm.mm(cy.GetRight())
hits = []
for t in b.GetTracks():
    p1, p2 = bm.P(t.GetStart()), bm.P(t.GetEnd())
    for p in (p1, p2):
        if xl <= p[0] <= xr and p[1] < pin1[1] - 1.0:
            hits.append((t.GetNetname().split('/')[-1], b.GetLayerName(t.GetLayer()), p))
print('   ', hits[:10] or 'none')

print('== IMU and magnetometer')
for r in ('U601', 'U602'):
    f = bm.fp(b, r); print(f"   {r} at {bm.P(f.GetPosition())} rot {f.GetOrientationDegrees():.0f}")
m = bm.P(bm.fp(b, 'U602').GetPosition())
for r in ('L101', 'U101', 'D105', 'BT401', 'J1', 'F101', 'D103', 'U903', 'C102', 'C104'):
    f = bm.fp(b, r)
    bb = f.GetCourtyard(pcbnew.F_CrtYd if f.GetLayer() == pcbnew.F_Cu else pcbnew.B_CrtYd).BBox()
    dx = max(bm.mm(bb.GetLeft()) - m[0], 0, m[0] - bm.mm(bb.GetRight())); dy = max(bm.mm(bb.GetTop()) - m[1], 0, m[1] - bm.mm(bb.GetBottom()))
    print(f"   U602 to {r} courtyard: {math.hypot(dx, dy):.1f} mm")
# nearest supply-current track to U602
for n in ('VIN_IN', 'VIN_RAW', 'VIN_LM', 'LM_SW', '+5V_PSU', '+5V', 'SENSOR_5V', 'DOUT1', 'VBUS'):
    best = 1e9
    for t in b.GetTracks():
        if t.GetNetname() == full(n) and t.GetClass() != 'PCB_VIA':
            best = min(best, bm._seg_pt(m, bm.P(t.GetStart()), bm.P(t.GetEnd()))[0])
    print(f"   U602 to nearest {n} track: {best:.1f} mm")
