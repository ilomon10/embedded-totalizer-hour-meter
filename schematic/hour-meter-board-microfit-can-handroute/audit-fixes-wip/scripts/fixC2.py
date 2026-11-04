"""Fix C (hand-designed): protectors D701/D1001 and the AIN1 front end at J1, fan-out tracks drawn in lanes."""
import os, shutil, pcbnew, edit as E
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', 'fix', 'after-B.kicad_pcb')
T = ['RS485_A', 'RS485_B', 'CAN_H', 'CAN_L', 'RS232_TXD', 'RS232_RXD', 'AIN1_RAW', 'AIN1_MID', 'AIN1_ADC']
AIN = {'AIN1_RAW', 'AIN1_MID', 'AIN1_ADC'}
R1 = (62.0, 62.0, 81.0, 101.0)
R2 = (66.0, 97.0, 81.0, 110.0)
inside = lambda p, r: r[0] <= p[0] <= r[2] and r[1] <= p[1] <= r[3]
short = lambda t: t.GetNetname().split('/')[-1]
b = pcbnew.LoadBoard(SRC)
# --- parts
PLACE = {'D701': (68.6, 67.4, 0), 'D1001': (72.8, 70.0, 180),
         'C901': (67.7, 78.8, 0), 'R904': (67.7, 81.5, 0), 'R901': (67.7, 84.2, 0), 'R902': (67.7, 86.9, 180)}
for ref, (x, y, r) in PLACE.items():
    E.move_fp(b, ref, x, y, r, drag=False)
pp = {ref: {k: E.P(p.GetPosition()) for k, p in E.pads_of(b, ref).items()} for ref in PLACE}
print({r: v for r, v in pp.items()})
# --- rip the fan-out nets inside the J1 area, and GND vias in the new lanes
def rip(t):
    n = short(t)
    if n not in T:
        return False
    pts = [E.P(t.GetPosition())] if t.GetClass() == 'PCB_VIA' else [E.P(t.GetStart()), E.P(t.GetEnd())]
    return any(inside(p, R1) for p in pts) or (n in AIN and any(inside(p, R2) for p in pts))
print('ripped', E.delete_tracks(b, rip))
DEAD_VIAS = [(74.2, 85.3), (72.2, 68.3)]
print('GND vias removed', E.delete_tracks(b, lambda t: t.GetClass() == 'PCB_VIA' and t.GetNetname() == 'GND'
                                         and any(abs(E.P(t.GetPosition())[0] - x) < 0.01 and abs(E.P(t.GetPosition())[1] - y) < 0.01 for x, y in DEAD_VIAS)))
J = {n: E.P(p.GetPosition()) for n, p in E.pads_of(b, 'J1').items()}
W = 0.3   # bus lanes in the fan-out
# --- RS485
A = [J['14'], (64.73, 66.45), (76.3, 66.45), (76.3, 78.7187)]
E.add_track(b, 'RS485_A', A, W)
E.add_track(b, 'RS485_A', [(76.3, 78.7187), (90.8, 78.7187)], 0.6)
B = [J['6'], (62.5, 67.22), (65.5, 67.22), (66.63, 68.35), (70.9, 68.35), (71.35, 67.9), (75.6, 67.9), (75.6, 86.7187)]
E.add_track(b, 'RS485_B', B, W)
E.add_track(b, 'RS485_B', [(75.6, 86.7187), (89.1, 86.7187)], 0.6)
# --- CAN (L hops under H on B.Cu)
H = [J['13'], (64.33, 69.05), (74.9, 69.05), (74.9, 93.9125), (82.8, 93.9125)]
E.add_track(b, 'CAN_H', H, W)
L1 = [J['5'], (62.5, 70.22), (65.3, 70.22), (66.03, 70.95), (73.7375, 70.95), (73.7375, 90.0)]
E.add_track(b, 'CAN_L', L1, W)
E.add_via(b, 'CAN_L', 73.7375, 90.0)
E.add_track(b, 'CAN_L', [(73.7375, 90.0), (74.5375, 90.8), (76.2, 90.8)], W, pcbnew.B_Cu)
E.add_via(b, 'CAN_L', 76.2, 90.8)
E.add_track(b, 'CAN_L', [(76.2, 90.8), (85.5, 90.8)], 0.6)
# --- RS232
E.add_track(b, 'RS232_RXD', [J['12'], (72.15, 71.7187), (72.15, 99.5), (86.8, 99.5)], W)
E.add_track(b, 'RS232_TXD', [J['3'], (62.8, 72.92), (71.45, 72.92), (71.45, 100.2), (86.5, 100.2)], W)
# --- AIN1 front end column
c1, r4, r1, r2 = pp['C901'], pp['R904'], pp['R901'], pp['R902']
E.add_track(b, 'AIN1_RAW', [J['11'], (65.6, 76.3187), (c1['1'][0], 76.3187 + (c1['1'][0] - 65.6)), c1['1'], r4['1'], r1['1']], 0.4)
E.add_track(b, 'AIN1_MID', [r1['2'], r2['1']], 0.4)
E.add_track(b, 'AIN1_ADC', [r2['2'], (r2['2'][0], 88.5), (68.95, 88.5 + 68.95 - r2['2'][0]), (68.95, 111.525), (68.9, 111.575)], 0.3)
# --- GND vias at the protector and shunt GND pads
for ref, via in (('D701', (70.5, 67.4)), ('D1001', (70.8, 70.0)), ('C901', (70.6, 78.8)), ('R904', (70.6, 81.5))):
    E.add_via(b, 'GND', *via)
    E.add_track(b, 'GND', [pp[ref]['3' if ref.startswith('D') else '2'], via], 0.4)
for d in b.GetDrawings():
    if isinstance(d, pcbnew.PCB_TEXT) and d.GetText() == 'DOUT1':
        d.SetPosition(E.V(83.0, 77.2))
E.save(b)
d = E.drc()
print(E.summary(d))
for p in E.problems(d)[:40]:
    print('  ', p)
