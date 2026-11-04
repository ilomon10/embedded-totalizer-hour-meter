"""Fix B: ESP32 reset capacitor C203 at U201 pin 3 (EN); C201 moves to the strip above the 3V3 trunk."""
import math, pcbnew, edit as E
b = pcbnew.LoadBoard(E.FIX)
def ends(t):
    return {E.P(t.GetStart()), E.P(t.GetEnd())}
def kill(netname, pairs):
    n = 0
    for pr in pairs:
        n += E.delete_tracks(b, lambda t, pr=pr: t.GetClass() == 'PCB_TRACK' and t.GetNetname().split('/')[-1] == netname and ends(t) == set(pr))
    return n
print('removed +3V3 C201 links', kill('+3V3', [((126.5, 46.575), (126.5, 47.85)), ((126.5, 46.575), (126.7, 46.375))]))
print('removed GND C201 links', kill('GND', [((125.875, 50.375), (126.5, 49.75)), ((124.4, 50.375), (125.875, 50.375))]))
E.move_fp(b, 'C201', 122.8, 45.0, 180, drag=False)
c201 = E.pads_of(b, 'C201')
p1, p2 = E.P(c201['1'].GetPosition()), E.P(c201['2'].GetPosition())
print('C201 pads', p1, p2)
E.add_track(b, '+3V3', [p1, (p1[0], 46.375)], 0.6)
E.add_via(b, 'GND', 120.9, 44.8)
E.add_track(b, 'GND', [p2, (120.9, 44.8)], 0.4)
E.add_track(b, 'GND', [(126.7, 44.825), (128.75, 44.779)], 0.4)          # C202's GND straight to U201 pin 1
E.move_fp(b, 'C203', 126.6, 48.825, -90, drag=False)
c203 = E.pads_of(b, 'C203')
q1, q2 = E.P(c203['1'].GetPosition()), E.P(c203['2'].GetPosition())
print('C203 pads', q1, q2)
E.add_track(b, 'ESP_EN', [q1, (127.3, 47.35), (128.75, 47.319)], 0.25)
E.save(b)
d = E.drc()
print(E.summary(d))
for p in E.problems(d):
    print('  ', p)
