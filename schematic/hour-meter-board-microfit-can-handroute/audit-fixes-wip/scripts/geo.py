"""geo.py PCB REF... : courtyard boxes and pads (number, net, centre, size) of parts; tracks of given nets with --nets"""
import sys, pcbnew
mm = pcbnew.ToMM
pcb = sys.argv[1]
b = pcbnew.LoadBoard(pcb)
args = sys.argv[2:]
nets = []
if '--nets' in args:
    i = args.index('--nets'); nets = args[i + 1].split(','); args = args[:i]
for r in args:
    f = b.FindFootprintByReference(r)
    L = pcbnew.F_CrtYd if f.GetLayer() == pcbnew.F_Cu else pcbnew.B_CrtYd
    bb = f.GetCourtyard(L).BBox()
    print(f"{r} {f.GetValue()} at ({mm(f.GetPosition().x):.3f},{mm(f.GetPosition().y):.3f}) rot {f.GetOrientationDegrees():.0f} "
          f"courtyard x {mm(bb.GetLeft()):.2f}..{mm(bb.GetRight()):.2f} y {mm(bb.GetTop()):.2f}..{mm(bb.GetBottom()):.2f}")
    for p in f.Pads():
        s = p.GetSize(pcbnew.F_Cu)
        bbp = p.GetBoundingBox()
        print(f"    pad {p.GetNumber():3} {p.GetNetname().split('/')[-1]:14} ({mm(p.GetPosition().x):.3f},{mm(p.GetPosition().y):.3f}) "
              f"box x {mm(bbp.GetLeft()):.2f}..{mm(bbp.GetRight()):.2f} y {mm(bbp.GetTop()):.2f}..{mm(bbp.GetBottom()):.2f}")
for n in nets:
    for t in b.GetTracks():
        if t.GetNetname().split('/')[-1] == n:
            if t.GetClass() == 'PCB_VIA':
                print(f"  {n} via ({mm(t.GetPosition().x):.3f},{mm(t.GetPosition().y):.3f}) {mm(t.GetWidth(pcbnew.F_Cu)):.2f}/{mm(t.GetDrillValue()):.2f}")
            else:
                print(f"  {n} {b.GetLayerName(t.GetLayer())} ({mm(t.GetStart().x):.4f},{mm(t.GetStart().y):.4f})-({mm(t.GetEnd().x):.4f},{mm(t.GetEnd().y):.4f}) w {mm(t.GetWidth()):.2f}")
