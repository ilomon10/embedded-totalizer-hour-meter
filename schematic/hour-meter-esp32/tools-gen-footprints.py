#!/usr/bin/env python3
"""Generate module carrier footprints (hour-meter-modules.pretty).

Dimensions are TYPICAL values for common clones - measure your modules and
adjust the numbers below, then re-run:  python3 tools-gen-footprints.py
"""
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hour-meter-modules.pretty")
P = 2.54  # header pitch


def fmt(v):
    return f"{v:.3f}".rstrip("0").rstrip(".")


def pad(num, x, y, size=1.7, drill=1.0, square=False):
    shape = "rect" if square else "circle"
    return (f'  (pad "{num}" thru_hole {shape} (at {fmt(x)} {fmt(y)}) (size {size} {size}) '
            f'(drill {drill}) (layers "*.Cu" "*.Mask"))\n')


def hole(x, y, d=3.2):
    return (f'  (pad "" np_thru_hole circle (at {fmt(x)} {fmt(y)}) (size {d} {d}) (drill {d}) '
            f'(layers "*.Cu" "*.Mask"))\n')


def rect(layer, x1, y1, x2, y2, w=0.1):
    return (f'  (fp_rect (start {fmt(x1)} {fmt(y1)}) (end {fmt(x2)} {fmt(y2)}) '
            f'(stroke (width {w}) (type default)) (fill none) (layer "{layer}"))\n')


def text(kind, s, x, y, layer, size=1.0):
    return (f'  (property "{kind}" "{s}" (at {fmt(x)} {fmt(y)} 0) (layer "{layer}") '
            f'(effects (font (size {size} {size}) (thickness {size * 0.15:.3f}))))\n')


def fp_text(s, x, y, layer, size=1.0):
    return (f'  (fp_text user "{s}" (at {fmt(x)} {fmt(y)} 0) (layer "{layer}") '
            f'(effects (font (size {size} {size}) (thickness {size * 0.15:.3f}))))\n')


def footprint(name, descr, body, bbox, ref_y, val_y, extra_silk=""):
    x1, y1, x2, y2 = bbox
    s = f'(footprint "{name}" (version 20240108) (generator "hour-meter-gen") (layer "F.Cu")\n'
    s += f'  (descr "{descr}")\n  (attr through_hole)\n'
    s += text("Reference", "REF**", (x1 + x2) / 2, ref_y, "F.SilkS")
    s += text("Value", name, (x1 + x2) / 2, val_y, "F.Fab")
    s += rect("F.Fab", x1, y1, x2, y2)
    s += rect("F.CrtYd", x1 - 0.25, y1 - 0.25, x2 + 0.25, y2 + 0.25, 0.05)
    s += extra_silk + body + ")\n"
    with open(os.path.join(OUT, name + ".kicad_mod"), "w") as f:
        f.write(s)


def header_column(first_num, x, count, y0=0.0, numbers=None):
    out = ""
    for i in range(count):
        n = numbers[i] if numbers else first_num + i
        out += pad(n, x, y0 + i * P, square=(i == 0 and not numbers) or (numbers and i == 0))
    return out


# 1. ESP32 DevKit V1, 30 pins, two rows 25.4 mm apart (DOIT layout; antenna up).
body = header_column(1, 0, 15) + header_column(16, 25.4, 15)
silk = rect("F.SilkS", -1.6, -1.6, 27.0, 37.2, 0.12) + fp_text("ANTENNA", 12.7, -5.5, "F.SilkS", 0.8)
footprint("ESP32_DevKit_V1_30pin_Socket",
          "ESP32 DOIT DevKit V1 30-pin on 2x 1x15 female sockets, row spacing 25.4mm (verify!)",
          body, (-1.45, -8.0, 26.85, 43.5), -9.5, 45.0, silk)

# 2. 2-channel PC817 module (38x29mm), wired from its screw terminals to these pads.
#    Input pads left (IN1, G, IN2, G), output pads right (V1, V2, G, G = symbol pins 5,7,6,8).
xin, xout = 0.0, 45.72
bx1, bx2 = 3.81, 3.81 + 38.0
cy = 1.5 * P
by1, by2 = cy - 14.5, cy + 14.5
body = header_column(1, xin, 4) + header_column(None, xout, 4, numbers=[5, 7, 6, 8])
for hx in (bx1 + 3.0, bx2 - 3.0):
    for hy in (by1 + 3.0, by2 - 3.0):
        body += hole(hx, hy)
silk = (rect("F.SilkS", -1.6, -1.6, 1.6, 3 * P + 1.6, 0.12) + rect("F.SilkS", xout - 1.6, -1.6, xout + 1.6, 3 * P + 1.6, 0.12)
        + fp_text("IN", xin, 3 * P + 3.2, "F.SilkS", 0.8) + fp_text("OUT", xout, 3 * P + 3.2, "F.SilkS", 0.8))
footprint("Module_PC817_2CH_Wired",
          "2CH PC817 isolation module 38x29mm on M3 standoffs; wire its terminals to the pads (verify hole positions!)",
          body, (-1.6, by1, xout + 1.6, by2), by1 - 1.5, by2 + 1.5, silk)

# 3-5. Plug-in modules on single-row female sockets.
def socket_module(name, descr, pins, bbox):
    body = header_column(1, 0, pins)
    silk = rect("F.SilkS", -1.6, -1.6, 1.6, (pins - 1) * P + 1.6, 0.12)
    footprint(name, descr, body, bbox, bbox[1] - 1.5, bbox[3] + 1.5, silk)

socket_module("Module_DS3231_ZS042_Socket", "DS3231 ZS-042 module, 1x6 socket (32K SQW SCL SDA VCC GND); module stands upright",
              6, (-3.0, -1.6, 3.0, 5 * P + 1.6))
socket_module("Module_AT24C256_Socket", "AT24C256 module, 1x5 socket (VCC GND SCL SDA WP)",
              5, (-3.0, -1.6, 3.0, 4 * P + 1.6))
socket_module("Module_MPU9250_GY9250_Socket", "GY-9250 MPU9250 module 15.5x25.5mm lying flat over the board, 1x10 socket",
              10, (-1.6, -1.6, 15.5, 9 * P + 1.6))

# 6. LM2596 buck module 43x21mm, soldered via its 4 corner pads.
body = (pad(1, 0, 0, 2.5, 1.3, True) + pad(2, 0, 15.24, 2.5, 1.3) + pad(3, 38.1, 0, 2.5, 1.3) + pad(4, 38.1, 15.24, 2.5, 1.3))
silk = (fp_text("IN+", 3.5, 0, "F.SilkS", 0.8) + fp_text("IN-", 3.5, 15.24, "F.SilkS", 0.8)
        + fp_text("OUT+", 33.8, 0, "F.SilkS", 0.8) + fp_text("OUT-", 33.8, 15.24, "F.SilkS", 0.8))
footprint("Module_LM2596_Buck", "LM2596 DC-DC buck module 43x21mm, corner pads (verify pad positions!)",
          body, (-2.45, -2.88, 40.55, 18.12), 7.62, 10.5, silk)
print("written to", OUT)
