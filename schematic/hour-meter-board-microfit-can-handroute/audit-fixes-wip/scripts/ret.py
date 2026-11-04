"""Return path: share of each signal's F.Cu length with solid B.Cu GND beneath, and the B.Cu tracks that cut it."""
import math, pcbnew, bm
b = bm.load(fill=True)
zb = [z for z in b.Zones() if not z.GetIsRuleArea() and z.GetNetname() == 'GND' and z.IsOnLayer(pcbnew.B_Cu)][0]
zf = [z for z in b.Zones() if not z.GetIsRuleArea() and z.GetNetname() == 'GND' and z.IsOnLayer(pcbnew.F_Cu)][0]
pb, pf = zb.GetFilledPolysList(pcbnew.B_Cu), zf.GetFilledPolysList(pcbnew.F_Cu)
def full(short):
    for n in bm.net_pads(b):
        if n == short or n.split('/')[-1] == short:
            return n
for short in ('USB_DP', 'USB_DM', 'I2C_SDA', 'I2C_SCL', 'CAN_H', 'CAN_L', 'RS485_A', 'RS485_B', 'CAN_TX', 'CAN_RX',
              'ESP_EN', 'ESP_IO0', 'U0TXD', 'U0RXD', 'GPS_TXD', 'GPS_RXD', 'IMU_INT', 'RTC_INT', 'LM_FB', 'AIN1_ADC'):
    n = full(short)
    tot = over = 0.0; gaps = []
    blen = 0.0
    for t in b.GetTracks():
        if t.GetNetname() != n or t.GetClass() == 'PCB_VIA':
            continue
        a, c = bm.P(t.GetStart()), bm.P(t.GetEnd())
        L = math.dist(a, c)
        if t.GetLayer() == pcbnew.B_Cu:
            blen += L; continue
        k = max(1, int(L / 0.2))
        for i in range(k):
            p = (a[0] + (c[0] - a[0]) * (i + 0.5) / k, a[1] + (c[1] - a[1]) * (i + 0.5) / k)
            v = pcbnew.VECTOR2I(pcbnew.FromMM(p[0]), pcbnew.FromMM(p[1]))
            tot += L / k
            if pb.Contains(v):
                over += L / k
            else:
                gaps.append(p)
    # cluster gaps
    cl = []
    for p in gaps:
        if cl and math.dist(cl[-1][-1], p) < 0.5:
            cl[-1].append(p)
        else:
            cl.append([p])
    big = sorted(((len(c) * 0.2, (round(c[0][0], 1), round(c[0][1], 1))) for c in cl), reverse=True)[:3]
    print(f"{short:9} F.Cu {tot:5.1f} mm, over B.Cu GND {100*over/max(tot,1e-9):5.1f} %, on B.Cu {blen:5.1f} mm; longest gaps {[(round(l,1), p) for l, p in big if l >= 0.6]}")
