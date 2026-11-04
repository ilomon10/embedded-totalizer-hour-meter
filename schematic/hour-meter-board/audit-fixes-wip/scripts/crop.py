"""crop.py NAME X1 Y1 X2 Y2 [SRC]: crop the board render (absolute mm) to render/NAME.png, grid every 5 mm"""
import sys, subprocess, os
R = os.path.join(os.path.dirname(__file__), '..', 'render')
name, x1, y1, x2, y2 = sys.argv[1], *map(float, sys.argv[2:6])
src = sys.argv[6] if len(sys.argv) > 6 else 'all'
X0, Y0, S = 51.5, 43.7187, 37.8
px = lambda x, y: (int((x - X0) * S), int((y - Y0) * S))
a, c = px(x1, y1), px(x2, y2)
w, h = c[0] - a[0], c[1] - a[1]
draw = []
import math
gx = math.ceil(x1 / 5) * 5
while gx < x2:
    p = px(gx, y1)[0] - a[0]
    draw += ['-stroke', '#00000040', '-draw', f'line {p},0 {p},{h}', '-stroke', 'none', '-fill', 'black', '-pointsize', '22', '-draw', f'text {p+3},22 "{gx:g}"']
    gx += 5
gy = math.ceil(y1 / 5) * 5
while gy < y2:
    p = px(x1, gy)[1] - a[1]
    draw += ['-stroke', '#00000040', '-draw', f'line 0,{p} {w},{p}', '-stroke', 'none', '-fill', 'black', '-pointsize', '22', '-draw', f'text 3,{p-3} "{gy:g}"']
    gy += 5
out = os.path.join(R, name + '.png')
subprocess.run(['magick', os.path.join(R, src + '.png'), '-crop', f'{w}x{h}+{a[0]}+{a[1]}', '+repage', *draw, '-resize', '1600x1600>', out], check=True)
print(out)
