#!/usr/bin/env python3
"""Generate module carrier footprints (hour-meter-modules.pretty).

Every module lies flat, chip side up, on 8.5 mm female sockets: its own pin
header is soldered on its underside. Only the socket pads, the wire pads and
the standoff rings get a courtyard; the module body is drawn on F.Fab and the
silkscreen, so low THT parts may sit underneath it.

Dimensions are TYPICAL values for common clones - measure your modules and
adjust the numbers below, then re-run:  python3 tools-gen-footprints.py
"""
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hour-meter-modules.pretty")
P = 2.54  # header pitch


def fmt(v):
    return f"{v:.3f}".rstrip("0").rstrip(".")


def pad(num, x, y, size=1.8, drill=1.0, square=False):
    shape = "rect" if square else "circle"
    return (f'  (pad "{num}" thru_hole {shape} (at {fmt(x)} {fmt(y)}) (size {size} {size}) '
            f'(drill {drill}) (layers "*.Cu" "*.Mask"))\n')


def standoff(x, y, ring=6.0):
    # M3 standoff: plated ring with no number (never gets a net), so tracks and
    # pours keep their clearance from the standoff and the screw head below.
    return (f'  (pad "" thru_hole circle (at {fmt(x)} {fmt(y)}) (size {ring} {ring}) (drill 3.2) '
            f'(layers "*.Cu" "*.Mask"))\n')


def rect(layer, x1, y1, x2, y2, w=0.1):
    return (f'  (fp_rect (start {fmt(x1)} {fmt(y1)}) (end {fmt(x2)} {fmt(y2)}) '
            f'(stroke (width {w}) (type default)) (fill none) (layer "{layer}"))\n')


def circle(layer, x, y, r, w=0.1):
    return (f'  (fp_circle (center {fmt(x)} {fmt(y)}) (end {fmt(x + r)} {fmt(y)}) '
            f'(stroke (width {w}) (type default)) (fill none) (layer "{layer}"))\n')


def line(layer, x1, y1, x2, y2, w=0.15):
    return (f'  (fp_line (start {fmt(x1)} {fmt(y1)}) (end {fmt(x2)} {fmt(y2)}) '
            f'(stroke (width {w}) (type default)) (layer "{layer}"))\n')


def corners(x1, y1, x2, y2, avoid=(), leg=3.0, w=0.12):
    """Silkscreen corner marks of a module body; legs that would touch a standoff ring are left out."""
    leg = min(leg, (x2 - x1) / 4, (y2 - y1) / 4)
    out = ""
    for cx, dx in ((x1, leg), (x2, -leg)):
        for cy, dy in ((y1, leg), (y2, -leg)):
            for ex, ey in ((cx + dx, cy), (cx, cy + dy)):
                if all(seg_dist(cx, cy, ex, ey, ax, ay) > r + 0.35 for ax, ay, r in avoid):
                    out += line("F.SilkS", cx, cy, ex, ey, w)
    return out


def seg_dist(x1, y1, x2, y2, px, py):
    dx, dy = x2 - x1, y2 - y1
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
    return ((x1 + t * dx - px) ** 2 + (y1 + t * dy - py) ** 2) ** 0.5


def text(kind, s, x, y, layer, size=1.0, hide=False):
    return (f'  (property "{kind}" "{s}" (at {fmt(x)} {fmt(y)} 0) (layer "{layer}")' + (' (hide yes)' if hide else '')
            + f' (effects (font (size {size} {size}) (thickness {size * 0.15:.3f}))))\n')


def fp_text(s, x, y, layer, size=1.0, justify=None):
    j = f" (justify {justify})" if justify else ""
    return (f'  (fp_text user "{s}" (at {fmt(x)} {fmt(y)} 0) (layer "{layer}") '
            f'(effects (font (size {size} {size}) (thickness {max(size * 0.15, 0.15):.3f})){j}))\n')


def footprint(name, descr, body, ref_xy, val_xy, courtyards, graphics=""):
    s = f'(footprint "{name}" (version 20240108) (generator "hour-meter-gen") (layer "F.Cu")\n'
    s += f'  (descr "{descr}")\n  (attr through_hole)\n'
    s += text("Reference", "REF**", ref_xy[0], ref_xy[1], "F.SilkS")
    s += text("Value", name, val_xy[0], val_xy[1], "F.Fab")
    for x1, y1, x2, y2 in courtyards:
        s += rect("F.CrtYd", x1, y1, x2, y2, 0.05)
    s += graphics + body + ")\n"
    with open(os.path.join(OUT, name + ".kicad_mod"), "w") as f:
        f.write(s)


def header_column(x, numbers, y0=0.0, step=P, size=1.8):
    return "".join(pad(n, x, y0 + i * step, size, square=(i == 0)) for i, n in enumerate(numbers))


def socket_crtyd(x, y_first, y_last):
    lo, hi = min(y_first, y_last), max(y_first, y_last)
    return (x - 1.6, lo - 1.6, x + 1.6, hi + 1.6)


def pin_labels(x, names, y0=0.0, step=P, size=1.0):
    # Pin names inside the module outline: readable while fitting the socket.
    return "".join(fp_text(n, x, y0 + i * step, "F.SilkS", size, "left") for i, n in enumerate(names))


# 1. ESP32 DevKit V4 (DevKitC layout), 38 pins on 2x 1x19 sockets, rows 25.4 mm apart
#    (same as Espressif's ESP32-DevKitC footprint). Antenna end at -Y, USB-C at +Y.
#    Pads: left row 1..19 and right row 20..38, both numbered from the antenna end.
L = 18 * P
body = header_column(0, range(1, 20)) + header_column(25.4, range(20, 39))
gfx = (rect("F.Fab", -1.25, -7.0, 26.65, 47.4)                 # DevKit board
       + rect("F.Fab", 3.73, -7.0, 21.71, -1.1)                # ESP32 antenna
       + rect("F.SilkS", -1.4, -1.4, 1.4, L + 1.4, 0.12)
       + rect("F.SilkS", 24.0, -1.4, 26.8, L + 1.4, 0.12)
       + fp_text("3V3", 1.8, 0, "F.SilkS", 1.0, "left")
       + fp_text("GND", 23.6, 0, "F.SilkS", 1.0, "right")
       + fp_text("ESP32 DevKit V4", 12.7, 30.0, "F.SilkS", 1.0)
       + fp_text("USB-C", 12.7, L + 0.2, "F.SilkS", 1.0))
footprint("ESP32_DevKitC_V4_38pin_Socket",
          "ESP32 DevKit V4 Type-C (DevKitC layout, 38 pins) on 2x 1x19 female sockets, rows 25.4 mm apart (verify!)",
          body, (12.7, 32.0), (12.7, 24.5),
          [socket_crtyd(0, 0, L), socket_crtyd(25.4, 0, L)], gfx)

# 2. 2-channel PC817 module 38 x 29 mm, stacked on 4 M3 standoffs (holes 32 x 24 mm).
#    Origin = module centre. Short wires run from its screw terminals to the pads:
#    inputs left (IN1 G IN2 G), outputs right (V1 G V2 G), in terminal order.
bx, by = 19.0, 14.5
hx, hy = 16.0, 12.0
xp, pitch, ring = bx + 2.6, 3.5, 5.2
ys = [-1.5 * pitch, -0.5 * pitch, 0.5 * pitch, 1.5 * pitch]
body = header_column(-xp, [1, 2, 3, 4], ys[0], pitch, 2.0) + header_column(xp, [5, 6, 7, 8], ys[0], pitch, 2.0)
rings = [(sx, sy, ring / 2) for sx in (-hx, hx) for sy in (-hy, hy)]
body += "".join(standoff(x, y, ring) for x, y, _ in rings)
gfx = (rect("F.Fab", -bx, -by, bx, by) + corners(-bx, -by, bx, by, rings)
       + fp_text("817 MODULE ON M3 STANDOFFS", 0, -by + 1.6, "F.SilkS", 1.0)
       + fp_text("REMOVE BOTH G JUMPERS", 0, by - 1.6, "F.SilkS", 1.0)
       + "".join(fp_text(n, -bx + 0.6, y, "F.SilkS", 1.0, "left") for n, y in zip(["IN1", "G", "IN2", "G"], ys))
       + "".join(fp_text(n, bx - 0.6, y, "F.SilkS", 1.0, "right") for n, y in zip(["V1", "G", "V2", "G"], ys)))
crt = [socket_crtyd(-xp, ys[0], ys[3]), socket_crtyd(xp, ys[0], ys[3])]
crt += [(x - r - 0.25, y - r - 0.25, x + r + 0.25, y + r + 0.25) for x, y, r in rings]
footprint("Module_PC817_2CH_Stacked",
          "2CH PC817 isolation module 38x29mm on 4 M3 standoffs (holes 32x24mm, verify!); parts up to 6 mm fit underneath",
          body, (0, -by + 3.2), (0, by + 1.5), crt, gfx)

# 3. GY-9250 (MPU9250/6500) 15.5 x 25.5 mm, flat, chip up, body toward +X.
#    Origin = pin 1 (VCC). Two M3 standoff holes on the far edge (measure!).
names = ["VCC", "GND", "SCL", "SDA", "EDA", "ECL", "AD0", "INT", "NCS", "FSYNC"]
y_top, y_bot = -1.32, 9 * P + 1.32
holes = [(12.0, 0.5, 2.3), (12.0, 21.6, 2.3)]
body = header_column(0, range(1, 11)) + "".join(standoff(x, y, 2 * r) for x, y, r in holes)
gfx = (rect("F.Fab", -1.5, y_top, 14.0, y_bot) + corners(-1.5, y_top, 14.0, y_bot, holes)
       + pin_labels(1.7, names)
       + line("F.SilkS", 8.0, 14.0, 12.0, 14.0) + line("F.SilkS", 12.0, 14.0, 11.2, 13.5) + line("F.SilkS", 12.0, 14.0, 11.2, 14.5)
       + line("F.SilkS", 8.0, 14.0, 8.0, 10.0) + line("F.SilkS", 8.0, 10.0, 7.5, 10.8) + line("F.SilkS", 8.0, 10.0, 8.5, 10.8)
       + fp_text("X", 12.6, 15.2, "F.SilkS", 1.0) + fp_text("Y", 9.0, 9.8, "F.SilkS", 1.0)
       + fp_text("GY-9250", 9.0, 18.0, "F.SilkS", 1.0))
crt = [socket_crtyd(0, 0, 9 * P)] + [(x - r - 0.25, y - r - 0.25, x + r + 0.25, y + r + 0.25) for x, y, r in holes]
footprint("Module_MPU9250_GY9250_Flat",
          "GY-9250 MPU9250/6500 module 15.5x25.5mm lying flat (chip up) on a 1x10 socket, M3 standoff holes (verify!)",
          body, (8.0, 5.0), (6.25, y_bot + 1.2), crt, gfx)

# 4. DS3231 ZS-042 38 x 22 mm, flat, chip side up, body toward +X, CR2032 holder underneath.
#    Origin = pin 1 (32K). Pass-through header on the far end stays unused.
names = ["32K", "SQW", "SCL", "SDA", "VCC", "GND"]
y_top, y_bot = 2.5 * P - 11.0, 2.5 * P + 11.0
body = header_column(0, range(1, 7))
gfx = (rect("F.Fab", -1.5, y_top, 36.5, y_bot) + corners(-1.5, y_top, 36.5, y_bot)
       + circle("F.Fab", 21.0, 2.5 * P, 10.0)
       + pin_labels(1.7, names)
       + fp_text("DS3231 ZS-042", 21.0, 2.5 * P - 1.0, "F.SilkS", 1.0)
       + fp_text("CR2032 holder below", 21.0, 2.5 * P + 1.0, "F.SilkS", 1.0))
footprint("Module_DS3231_ZS042_Flat",
          "DS3231 ZS-042 RTC module 38x22mm lying flat (chip up) on a 1x6 socket (32K SQW SCL SDA VCC GND); keep the area under the CR2032 holder free",
          body, (33.5, y_top + 1.4), (17.5, y_bot + 1.2), [socket_crtyd(0, 0, 5 * P)], gfx)

# 5. AT24C256 module ~36 x 13.5 mm, flat, chip side up, body toward +X.
#    Its 4-pin header reads GND SDA SCL VCC from the top edge (photo of the
#    common blue board). Origin = pin 1 (VCC), at the bottom of the row.
names = ["GND", "SDA", "SCL", "VCC"]
y_top, y_bot = -3 * P - 2.94, 2.94
body = "".join(pad(n, 0, -i * P, square=(n == 1)) for i, n in enumerate([1, 2, 3, 4]))
gfx = (rect("F.Fab", -1.5, y_top, 34.5, y_bot) + corners(-1.5, y_top, 34.5, y_bot)
       + pin_labels(1.7, names, -3 * P)
       + fp_text("AT24C256 (A0-A2, WP = GND)", 17.0, y_top + 1.6, "F.SilkS", 1.0))
footprint("Module_AT24C256_Flat",
          "AT24C256 EEPROM module ~36x13.5mm lying flat (chip up) on a 1x4 socket (GND SDA SCL VCC from the top, verify!)",
          body, (31.5, y_bot - 1.4), (16.5, y_bot + 1.2), [socket_crtyd(0, -3 * P, 0)], gfx)

# 6. Radial PTC (e.g. MF-R010 / JK60-010), 5.0 mm lead pitch, 0.9 mm holes (local-fab friendly).
body = pad(1, 0, 0, 1.8, 0.9, True) + pad(2, 5.0, 0, 1.8, 0.9)
gfx = rect("F.Fab", -1.2, -1.6, 6.2, 1.6) + rect("F.SilkS", -1.35, -1.75, 6.35, 1.75, 0.12)
footprint("PTC_Radial_P5.00mm", "Radial resettable fuse (PTC), 5.0 mm lead pitch, body up to 7.4 x 3.2 mm",
          body, (2.5, -2.8), (2.5, 2.8), [(-1.6, -2.0, 6.6, 2.0)], gfx)

print("written to", OUT)
