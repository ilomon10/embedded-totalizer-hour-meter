"""Fix A: +5V feed to F801 widened, buck feedback divider at U101 pin 4, C206 at U204's tab."""
import math, pcbnew, edit as E
b = pcbnew.LoadBoard(E.FIX)
# A1: widen the narrow +5V / GPS_5V supply segments (DRC decides below)
widened = []
for t in b.GetTracks():
    if t.GetClass() == 'PCB_TRACK' and t.GetNetname() in ('+5V', '/GPS + Qwiic/GPS_5V') and E.mm(t.GetWidth()) < 0.5 and E.mm(t.GetLength()) > 0.5:
        widened.append((t.m_Uuid.AsString(), E.mm(t.GetWidth())))
        t.SetWidth(E.FM(0.6))
print('widened', len(widened))
# A2: feedback divider next to U101 pin 4
n = E.delete_tracks(b, lambda t: t.GetNetname() == '/5V buck (U101)/LM_FB')
print('removed LM_FB tracks', n)
E.move_fp(b, 'R103', 86.2, 125.6, 180, drag=False)
E.move_fp(b, 'R104', 86.2, 127.6, 0, drag=False)
p103, p104 = E.pads_of(b, 'R103'), E.pads_of(b, 'R104')
print('R103', {k: E.P(p.GetPosition()) for k, p in p103.items()}, 'R104', {k: E.P(p.GetPosition()) for k, p in p104.items()})
fb104 = E.P(p104['1'].GetPosition()); fb103 = E.P(p103['2'].GetPosition()); s103 = E.P(p103['1'].GetPosition())
E.add_track(b, 'LM_FB', [(80.2, 135.075), (80.2, 131.7), (84.45, 131.7), (84.45, 128.3), fb104], 0.25)
E.add_track(b, 'LM_FB', [fb104, fb103], 0.25)
# R104's old GND stub and R103's old pads left stubs: remove +5V_PSU/GND track pieces that ended on the old pads
E.add_track(b, '+5V_PSU', [s103, (s103[0] + 0.7, 124.9), (101.425, 124.9)], 0.3)
# A3: C206 down to the U204 courtyard edge, direct track to the tab
moved = E.move_fp(b, 'C206', 129.1, 97.6, 0)
c206 = E.P(E.pads_of(b, 'C206')['1'].GetPosition())
E.add_track(b, '+3V3', [c206, (c206[0], 100.6)], 0.6)
print('C206 dragged track ends', moved, 'pad', c206)
E.save(b)
d = E.drc()
print(E.summary(d))
for p in E.problems(d):
    print('  ', p)

# A2b: U101 pin 5 (ON/OFF) GND tie crossed the new FB track: tie pin 5 to pin 3 under the pins instead
b = pcbnew.LoadBoard(E.FIX)
def is_tie(t):
    if t.GetNetname() != 'GND' or t.GetClass() != 'PCB_TRACK':
        return False
    ends = {E.P(t.GetStart()), E.P(t.GetEnd())}
    return ends in ({(81.9, 135.075), (81.9, 129.325)}, {(81.9, 129.325), (78.5, 125.925)})
print('pin 5 tie pieces removed:', E.delete_tracks(b, is_tie))
E.add_track(b, 'GND', [(81.9, 135.075), (81.9, 138.3)], 0.6)
E.add_via(b, 'GND', 81.9, 138.3)
E.save(b)
d = E.drc()
print(E.summary(d))
for p in E.problems(d):
    print('  ', p)
