#!/usr/bin/env python3
"""Build hour-meter-board-microfit-can.kicad_pcb: the Micro-Fit board with a CAN port and an RS232 port, its
harness header grown to a Molex Micro-Fit 3.0 2 x 8 (J1), re-laid out module by module on 100 x 100 mm, 2 layers.

  python3 tools-pcb.py check            -> placement checks only (writes nothing but a scratch board in routing/)
  python3 tools-pcb.py place            -> placed, unrouted board
  python3 tools-pcb.py route [tries]    -> Freerouting (best of N tries, default 4) + GND pours
  python3 tools-pcb.py finish [passes]  -> close what Freerouting left open (exit 1 if anything still is)
  python3 tools-pcb.py reroute NETS ... -> targeted passes: rip up each comma-separated net set and re-route
  python3 tools-pcb.py widen            -> widen supply and vehicle tracks as far as their clearances allow
  python3 tools-pcb.py stitch           -> GND stitching vias over the board (5 mm grid, 2.5 mm by the ESP32)
  python3 tools-pcb.py report           -> routing figures: vias, track length per layer, GND coverage
  python3 tools-pcb.py update           -> add / remove parts on the routed board after a schematic change
  python3 tools-pcb.py silk             -> re-apply the silkscreen labels and reference positions (no re-route)
  python3 tools-pcb.py production       -> production/: Gerber zip, BOM and CPL for JLCPCB (CPL set for JLCPCB's footprints)
  python3 tools-pcb.py models           -> download the JLCPCB 3D models into 3d/ and set them on the board

A variant of ../hour-meter-board-microfit (see README.md). The build, route and finish scripts are the main
board's, called with this board's LAYOUT. Every part belongs to one module, and a module's parts sit around its IC
(MODULES below). The floor plan, signal flow left to right:
  * left edge: J1, every field wire. Each bus has its protector right behind its J1 pins (the protection column),
    then its transceiver module; the signals leave J1 in module order, so no two modules' tracks cross;
  * top-left: the isolated DIN island (milled slots, no pour), unchanged from the Micro-Fit board;
  * middle: the IMU (quiet corner, far from currents and magnets), the RTC + EEPROM, the AIN1 ADC;
  * right: the ESP32 module (antenna past the top edge) with USB, the 3.3 V regulator and the buttons, the
    indicator LEDs and the GPS / Qwiic ports on the right edge;
  * bottom: the 9-30 V input chain down the left edge and the LM2596 stage along the bottom edge.
"""
import csv
import json
import math
import os
import shutil
import subprocess
import sys
import urllib.request

import importlib.util
import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
MAIN = os.path.join(HERE, "..", "hour-meter-board")
SCH = os.path.join(HERE, "hour-meter-board-microfit-can.kicad_sch")
PCB = os.path.join(HERE, "hour-meter-board-microfit-can.kicad_pcb")
IMU = ("U601", "U602")

_spec = importlib.util.spec_from_file_location("finish", os.path.join(MAIN, "tools-finish-routing.py"))
finish = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(finish)
route, build = finish.route, finish.build
build.REF_TEXT_MM = 1.0                      # JLCPCB legibility minimum: 1.0 mm text, 0.15 mm stroke

X0, Y0, W, H = 100.0, 100.0, 100.0, 100.0   # 100 x 100 mm: JLCPCB's lowest price band for 2-layer boards
PSU_AREA = None                              # no plug-on PSU-B: the LM2596 stage is on the board
SUPPLY_AREA = (108.0, 174.0, 158.0, 200.0)   # the buck stage (keep it compact: hot loop, magnetometer distance)
AIN_PARTS = ("R901", "R902", "R903", "C902", "D901", "U901")   # AIN1 divider, filter, clamp and ADC: away from LM_SW
AIN_MIN_DISTANCE = 8.0                       # mm from any LM_SW pad (the LM2596 switch node)
ORDER_MARK_AT = (165.0, 140.0)               # JLCPCB order number, bottom silkscreen
BARRIER_X = 133.0                            # isolation barrier: through the optocoupler centres
ISLAND_BOTTOM = 120.5                        # the DIN island ends here, between J1 pins 6/14 and 7/15
VEHICLE_AREA = (100.0, 100.0, BARRIER_X + 2.5, ISLAND_BOTTOM + 2.9)   # no pours within 2.5 mm of the barrier,
# nor around J1's RS485 pins next to the island: the GND pour stays > 3 mm from island copper
SLOT = 1.5                                   # slot width, mm

# ESP32 module: origin at (186, 106.32) puts its antenna section (6.5 mm) past the top edge; PLACEMENT
# takes the courtyard centre, which sits 7.23 mm above the origin for this footprint
U201_ORIGIN = (186.0, 106.32)

# J1 (Micro-Fit 2 x 8, rotated 90: mating face on the left edge, pin 1 at the bottom). The courtyard centre sits
# 2.585 mm left of and 10.5 mm above pin 1; front row (pins 1-8) 9.42 mm in from the edge, back row (9-16) 3 mm
# further. Pins 7/8/15/16 (DIN) at y 119/116 meet the DIN island exactly where the Micro-Fit board's did.
J1_PIN1 = (109.5, 137.0)
J1_AT = (J1_PIN1[0] - 2.585, J1_PIN1[1] - 10.5)


def module(parts, dx=0.0, dy=0.0):
    """A module's parts, {ref: (x, y, rotation, side)}, moved as one block by (dx, dy)."""
    return {ref: (x + dx, y + dy, rot, side) for ref, (x, y, rot, side) in parts.items()}


# Each module is a block of parts around its IC. Blocks that keep the Micro-Fit board's arrangement are copied
# from it and moved as a whole (dx, dy); the new ones are laid out here. Signals leave J1 top to bottom as
# RS485 A, B | CAN_L, CAN_H | +5 V | RS232 RX, TX | AIN1 | DOUT1 | VIN, and the modules follow in that order.
MODULES = {
    # --- mechanical: mounting holes in three corners and on the right edge (the antenna takes the top-right) ---
    "mounting": {"H102": (104.0, 104.0, 0, "F"), "H104": (104.0, 196.0, 0, "F"), "H105": (196.0, 196.0, 0, "F"),
                 "H103": (196.0, 148.4, 0, "F")},
    "harness": {"J1": J1_AT + (90, "F")},
    # --- DIN island (isolated, top-left corner), as on the Micro-Fit board: two chains of 3 x 1k, M7, zener,
    #     LED bleeder, optocoupler across the slotted barrier; opto outputs on the logic side ---
    "din": {
        "R306": (116.2, 102.0, 0, "F"), "R307": (121.2, 102.0, 0, "F"),   # DIN2 (J1 pin 16)
        "R308": (116.2, 105.0, 0, "F"), "R309": (121.0, 105.0, 0, "F"),
        "D303": (117.5, 108.4, 180, "F"), "D304": (123.0, 108.4, 0, "F"),
        "U302": (BARRIER_X, 105.2, 0, "F"),
        "R301": (116.2, 112.2, 0, "F"), "R302": (121.2, 112.2, 0, "F"),   # DIN1 (J1 pin 15)
        "R303": (116.2, 115.2, 0, "F"), "R304": (121.0, 115.2, 0, "F"),
        "D301": (117.5, 118.6, 180, "F"), "D302": (123.0, 118.6, 0, "F"),
        "U301": (BARRIER_X, 115.4, 0, "F"),
        "R310": (141.5, 104.281, 90, "F"), "C302": (140.0, 104.281, 270, "F"),
        "R305": (140.7, 113.681, 180, "F"), "C301": (140.8, 117.081, 180, "F"),
    },
    # --- protection column, 6 mm right of J1 so the lines can fan out first: each line meets its protector in
    #     J1 order (RS485, CAN, +5 V fuse, AIN1 pulse capacitor and divider top) ---
    # --- RS485: D701 (dual-line protector), termination / bias jumpers, THVD2410 with A/B facing J1, its logic
    #     pins and pull-ups toward the MCU ---
    "rs485": {
        "D701": (122.0, 124.9, 0, "F"),
        "R704": (126.3, 123.6, 0, "F"), "JP702": (130.4, 123.6, 0, "F"),   # 120R termination
        "R705": (126.3, 126.3, 0, "F"), "JP703": (130.4, 126.3, 0, "F"),   # bias A
        "R706": (126.3, 129.0, 0, "F"), "JP704": (130.4, 129.0, 0, "F"),   # bias B
        "C701": (133.6, 128.48, 270, "F"),
        "U701": (139.5, 125.8, 180, "F"),
        "R702": (146.4, 123.6, 0, "F"), "R703": (146.4, 125.8, 0, "F"), "R701": (146.4, 128.0, 0, "F"),
    },
    # --- CAN: D1001 at J1, termination jumper, TJA1051T/3 with CANH/CANL facing J1 ---
    "can": {
        "D1001": (122.0, 131.0, 0, "F"),
        "R1001": (126.3, 131.8, 0, "F"), "JP1001": (130.4, 131.8, 0, "F"),
        "JP1002": (131.0, 135.4, 0, "F"),
        "C1002": (138.0, 129.7, 0, "F"),
        "U1001": (138.0, 133.5, 180, "F"), "C1001": (144.0, 132.9, 90, "F"),
    },
    # --- +5 V sensor supply fuse at J1 pin 4 ---
    "sensor5v": {"F801": (124.0, 134.58, 0, "F")},
    # --- RS232: MAX13223E with its line pins facing J1, charge-pump capacitors on the far side ---
    "rs232": {
        "U1101": (131.0, 141.8, 180, "F"),
        "C1105": (126.2, 144.38, 90, "F"),
        "C1104": (136.8, 139.8, 90, "F"), "C1102": (138.6, 141.8, 90, "F"),
        "C1101": (136.8, 143.8, 90, "F"), "C1103": (138.6, 145.8, 90, "F"),
    },
    # --- AIN1 front end in the column: 1 kV pulse capacitor, 4-20 mA shunt, then the 2 x 49.9k divider, so only
    #     the low-voltage divider foot travels to the ADC ---
    "ain1_front": {"C901": (122.4, 139.6, 0, "F"), "R904": (122.4, 142.6, 0, "F"),
                   "R901": (122.4, 145.6, 0, "F"), "R902": (122.4, 148.6, 0, "F")},
    # --- DOUT1: BSP75N with its drain toward J1 pin 10, the 5 V buffer behind it ---
    "dout1": {
        "U903": (124.0, 155.0, 0, "F"),
        "U902": (132.6, 154.2, 0, "F"), "C904": (135.8, 154.2, 90, "F"), "R905": (132.6, 157.4, 0, "F"),
    },
    # --- AIN1 ADC: divider foot + filter, clamp, ADS1115 ---
    "ain1_adc": {
        "R903": (145.6, 151.4, 90, "F"), "C902": (147.6, 151.4, 90, "F"),
        "D901": (150.6, 147.6, 0, "F"),
        "U901": (152.0, 151.6, 0, "F"), "C903": (156.0, 151.6, 90, "F"),
    },
    # --- 9-30 V input chain down the left edge: fuse, VIN sense, reverse-polarity diode, TVS ---
    "vin": {
        "F101": (105.3, 146.28, 270, "F"),
        "D102": (112.8, 148.48, 180, "F"), "R101": (112.7, 151.88, 0, "F"),
        "D103": (105.0, 155.0, 90, "F"), "D104": (107.3, 162.58, 180, "F"),
    },
    # --- LM2596 buck stage along the bottom edge, as on the Micro-Fit board, 20 mm lower:
    #     Cin -> U101 (pins face Cin) -> catch diode -> L101 -> Cout -> OR diode D101 -> +5V ---
    "buck": module({
        "C102": (115.0, 171.0, 180, "F"), "C103": (125.0, 164.2, 0, "F"),
        "U101": (130.4, 171.0, 0, "F"),
        "D105": (141.5, 168.5, 90, "F"),
        "L101": (151.0, 172.6, 0, "F"),
        "C104": (148.5, 162.0, 0, "F"), "C105": (142.6, 163.0, 90, "F"),
        "R103": (120.9, 178.38, 0, "F"), "R104": (127.5, 178.4, 0, "F"),   # FB divider, under the U101 pins
        "R105": (117.5, 163.6, 0, "F"), "D106": (120.5, 163.6, 0, "F"),   # power LED
        "D101": (125.6, 156.0, 90, "F"),
    }, dy=20.0),
    # --- IMU: as on the Micro-Fit board (top middle, far from J1, the buck stage, the coin cell and USB). Both chips
    #     turned 270 by hand on 2026-11-02 (pin 1 top right): their x axis, the firmware's nose, now points at the
    #     bottom edge (at 0 it pointed at the right edge) and y at the right edge ---
    "imu": {
        "U601": (150.4, 107.481, 270, "F"), "U602": (150.4, 114.481, 270, "F"),
        "C603": (144.7, 109.981, 90, "F"),                                     # REGOUT (pin 10)
        "C606": (150.5, 111.681, 0, "F"),                                      # LIS3MDL C1 (pin 4)
        "C601": (140.7, 109.181, 180, "F"), "C604": (140.7, 111.081, 180, "F"),
        "C602": (145.5, 106.756, 270, "F"), "C605": (143.8, 106.756, 270, "F"),
        "R211": (158.6, 111.081, 180, "F"), "R212": (158.6, 112.781, 180, "F"),   # I2C pull-ups
    },
    # --- EEPROM and RTC on the I2C bus, the coin cell under the RTC on the bottom side ---
    "eeprom": {"U501": (160.0, 123.0, 0, "F"), "C501": (164.6, 123.0, 90, "F"),
               "R501": (157.0, 127.0, 0, "F"), "JP501": (161.2, 127.0, 0, "F")},
    "rtc": {"U401": (160.0, 134.0, 0, "F"), "C401": (155.4, 134.0, 90, "F"),
            "C402": (164.7, 132.4, 90, "F"), "R401": (164.7, 136.0, 90, "F"),
            "BT401": (161.0, 166.0, 90, "B")},
    # --- ESP32, 3.3 V regulator, USB-C, CH340C, auto-program and buttons: the Micro-Fit board's block, 20 mm
    #     right; R102 / C101 (VIN_SENSE foot and filter) stay by the module's ADC pins ---
    "mcu": module({
        "U201": (U201_ORIGIN[0] - 20.0, U201_ORIGIN[1] - 7.23, 0, "F"),
        "R201": (150.0, 103.306, 270, "F"), "C203": (148.2, 103.306, 90, "F"),    # EN RC, at pin 3
        "R102": (149.1, 106.381, 180, "F"), "C101": (149.1, 108.181, 180, "F"),  # VIN_SENSE foot + filter, GPIO36
        "U204": (158.6, 125.0, 0, "F"),
        "D203": (165.6, 121.0, 0, "F"), "R210": (168.6, 121.0, 0, "F"),   # STATUS LED, at GPIO2 (pin 24)
        "D202": (165.6, 122.8, 0, "F"), "R209": (168.6, 122.8, 0, "F"),   # PWR LED, at the 3V3 regulator
        "C205": (156.9, 130.4, 0, "F"), "C201": (161.2, 130.4, 0, "F"), "C206": (161.2, 132.6, 0, "F"),
        "C202": (156.9, 132.4, 0, "F"), "C207": (156.9, 134.2, 0, "F"),
        "J201": (175.0, 125.6, 90, "F"),
        "U203": (167.3, 126.1, 90, "F"), "R207": (167.3, 129.9, 0, "F"), "R208": (167.3, 131.7, 0, "F"),
        "F201": (167.0, 134.0, 0, "F"), "D201": (167.0, 136.6, 0, "F"), "C208": (167.0, 139.0, 0, "F"),
        "SW201": (176.0, 135.0, 0, "F"), "SW202": (176.0, 141.2, 0, "F"),
        "U202": (158.2, 140.5, 90, "F"),
        "C204": (153.9, 146.2, 0, "F"), "R213": (156.9, 146.2, 0, "F"),
        "R203": (159.9, 146.2, 0, "F"), "R204": (162.9, 146.2, 0, "F"),
        "Q201": (167.2, 141.6, 0, "F"), "Q202": (167.2, 145.4, 0, "F"),
        "R205": (170.6, 141.6, 90, "F"), "R206": (170.6, 145.4, 90, "F"), "R202": (170.6, 148.9, 90, "F"),
    }, dx=20.0),
    # --- indicator LEDs, side-view, lenses at the right edge, each with its 330R ---
    "leds": module({
        "D801": (179.0, 159.0, 270, "F"), "R808": (175.4, 159.0, 0, "F"),
        "D802": (179.0, 164.0, 270, "F"), "R809": (175.4, 164.0, 0, "F"),
        "D803": (179.0, 169.0, 270, "F"), "R810": (175.4, 169.0, 0, "F"),
    }, dx=20.0),
    # --- GPS (JST GH, Pixhawk pinout) and Qwiic (JST SH) on the right edge, openings outward, with the GPS
    #     ESD array, series resistors, pull-up / pull-down, supply select and fuse beside them. The GPS lines
    #     come down from the ESP32 as PPS, RXD, TXD (left to right) and step into the resistor rows from the
    #     left: each resistor's ESP32 pad faces left, its connector-side pad faces U802 and J802 ---
    "ports": {
        "J802": (196.75, 177.9, 90, "F"), "J803": (196.65, 188.6, 90, "F"),
        "U802": (190.4, 177.4, 180, "F"), "C802": (190.4, 181.0, 0, "F"),   # TX_EXT top left, RX_EXT bottom left
        "R806": (186.4, 174.0, 180, "F"),                                   # GPS_TXD pull-up, on the TXD line
        "R803": (186.4, 176.0, 180, "F"), "R804": (186.4, 178.0, 180, "F"),
        "R805": (186.4, 180.0, 180, "F"), "R807": (182.6, 180.0, 180, "F"), "TP801": (190.4, 184.38, 0, "F"),
        "JP801": (186.2, 184.4, 0, "F"), "F803": (186.2, 187.8, 0, "F"),
        "TP807": (182.5, 184.28, 0, "F"), "TP808": (182.5, 187.78, 0, "F"),   # +3V3 and GND probe pads
    },
}
PLACEMENT = {ref: at for parts in MODULES.values() for ref, at in parts.items()}

SLOTS = (
    ((BARRIER_X, 102.6), (BARRIER_X, 107.8), SLOT),        # under U302
    ((BARRIER_X, 112.8), (BARRIER_X, 120.0), SLOT),        # under U301 and below it
    ((114.8, 121.3), (128.4, 121.3), SLOT),                # between the DIN island and RS485
)

# Board material left between the slots (for strength): no copper may cross the barrier there, so the
# island is closed to every other net and only the optocouplers bridge it
BRIDGES = (
    (BARRIER_X - 2.5, 100.0, BARRIER_X + 2.5, 102.6),     # top edge to the U302 slot
    (BARRIER_X - 2.5, 107.8, BARRIER_X + 2.5, 112.8),     # between the two opto slots
    (128.4, 120.0, BARRIER_X + 2.5, 122.2),               # the corner
    (100.0, 120.0, 114.8, 121.0),                         # left edge to the bottom slot, between J1 pins 6/14 and 7/15
)

# Silkscreen: module names (1.0 mm, JLCPCB's legibility minimum) and the solder-jumper legends
LABELS = [
    ("HOUR METER rev C", 171.0, 196.0, 1.2, True),
    ("DIN", 110.6, 108.2, 1.0, True), ("ISOLATED", 110.6, 109.8, 1.0, True),   # island corner above J1
    ("RS485", 139.5, 122.0, 1.0, True), ("CAN", 138.0, 137.2, 1.0, True), ("RS232", 131.0, 146.2, 1.0, True),
    ("DOUT1", 124.0, 159.6, 1.0, True), ("AIN1 ADC", 150.0, 155.2, 1.0, True), ("VIN 9-30V", 106.0, 169.5, 1.0, True),
    ("5V BUCK", 134.0, 177.6, 1.0, True), ("IMU", 147.0, 119.3, 1.0, True), ("EEPROM", 160.0, 118.9, 1.0, True),
    ("RTC", 160.0, 138.0, 1.0, True), ("GPS", 191.0, 173.2, 1.0, True), ("QWIIC", 189.0, 192.6, 1.0, True),
    # the solder jumpers in the column left of U701 / U1001, top to bottom (too tight for their own references)
    ("JUMPERS TOP-DOWN:", 149.6, 137.8, 1.0, False), ("JP702 485 TERM", 149.6, 139.3, 1.0, False),
    ("JP703 485 BIAS A", 149.6, 140.8, 1.0, False), ("JP704 485 BIAS B", 149.6, 142.3, 1.0, False),
    ("JP1001 CAN TERM", 149.6, 143.8, 1.0, False), ("JP1002 CAN LISTEN", 149.6, 145.3, 1.0, False),
]

# J1 pinout on the bottom silkscreen, behind the header, for whoever crimps the harness: (x, y) of the first line
J1_PINOUT_TITLE = ("J1 MICRO-FIT 3.0", 103.0, 172.0)
J1_PINOUT_COLUMNS = ((122.0, ("1 GND", "2 GND", "3 232 TX", "4 +5V OUT", "5 CAN L", "6 485 B", "7 DIN COM",
                              "8 DIN COM")),
                     (112.0, ("9 VIN", "10 DOUT1", "11 AIN1", "12 232 RX", "13 CAN H", "14 485 A", "15 DIN1",
                              "16 DIN2")))
J1_PINOUT_Y, J1_PINOUT_PITCH = 174.0, 1.5

LAYOUT = build.Layout((X0, Y0, W, H), PSU_AREA, VEHICLE_AREA, None, frozenset({"U201", "J201"}),
                      PLACEMENT, LABELS, SLOTS)
build.LAYOUT = LAYOUT


def place(pcb=PCB):
    """The main board's build with this layout on 2 layers, plus the IMU keep-outs."""
    board = build.build(SCH, pcb, layers=2)
    imu_keepouts(board)
    for i, rect in enumerate(BRIDGES):
        route.add_rule_area(board, rect, f"BARRIER_{i + 1}", tracks=True)
    edge_keepouts(board)
    tidy_silkscreen(board)
    add_pinout(board)
    set_models(board)
    build.add_order_mark(board, "B", ORDER_MARK_AT)
    title = board.GetTitleBlock()
    title.SetTitle("Hour Meter main board, Micro-Fit + CAN + RS232 (100 x 100 mm, 2 layers)")
    title.SetRevision("C")
    board.SetTitleBlock(title)
    return board


# Routing practice for a 2-layer board: signals on the top layer, the bottom layer kept as a near-solid ground
# plane with short jumpers only. Freerouting reads these costs from the DSN: a via costs more than a detour, a
# track on the bottom layer costs 2.5 times one on top, and GND is a plane on the bottom layer during routing, so
# every GND pad gets a via into it instead of a GND track.
AUTOROUTE_SETTINGS = """    (autoroute_settings
      (fanout off) (autoroute on) (postroute on) (vias on)
      (via_costs 80) (plane_via_costs 5) (start_ripup_costs 100) (start_pass_no 1)
      (layer_rule F.Cu (active on) (preferred_direction horizontal)
        (preferred_direction_trace_costs 1.0) (against_preferred_direction_trace_costs 1.4))
      (layer_rule B.Cu (active on) (preferred_direction vertical)
        (preferred_direction_trace_costs 2.5) (against_preferred_direction_trace_costs 4.0))
    )
"""


def autoroute(board, pcb):
    """route.autoroute with the settings above and a bottom-layer GND plane in the DSN. Replaces the shared one
    for this board, so `route` and `finish` both use it."""
    stem = os.path.join(build.routing_dir(pcb), os.path.splitext(os.path.basename(pcb))[0])
    dsn, ses = stem + ".dsn", stem + ".ses"
    plane = route.add_pour(board, pcbnew.B_Cu, "GND")
    exported = pcbnew.ExportSpecctraDSN(board, dsn)
    board.Remove(plane)
    if not exported:
        raise SystemExit("DSN export failed")
    with open(dsn) as f:
        text = f.read()
    at = text.index("    (boundary")
    with open(dsn, "w") as f:
        f.write(text[:at] + AUTOROUTE_SETTINGS + text[at:])
    if os.path.exists(ses):
        os.remove(ses)
    subprocess.run(["java", "-jar", route.FREEROUTING, "--gui.enabled=false", "-de", dsn, "-do", ses,
                    "--router.autorouter.max_passes=300", "-mt", "4",
                    "--router.automatic_neckdown=true", "--router.fanout.ripup_allowed=true"],
                   check=True, timeout=3600, capture_output=True)
    if not pcbnew.ImportSpecctraSES(board, ses):
        raise SystemExit("SES import failed")
    route.fix_via_drills(board)


route.autoroute = autoroute

_shared_add_pour = route.add_pour


def add_pour(board, layer, net_name, clearance=0.3):
    """The shared pour with 0.4 mm thermal spokes and gaps: KiCad drops spokes thinner than the zone's 0.25 mm
    minimum width, which left every GND pad without a solid connection floating."""
    zone = _shared_add_pour(board, layer, net_name, clearance)
    zone.SetThermalReliefSpokeWidth(build.mm(0.4))
    zone.SetThermalReliefGap(build.mm(0.4))
    return zone


route.add_pour = add_pour

# Track widths after routing: Freerouting routes the supply nets at their netclass width (0.3-0.5 mm, narrow enough
# to reach fine-pitch pads), then each segment is widened as far as its clearances allow. IPC-2221, 1 oz outer
# layer, 10 C rise: 0.3 mm carries 1 A, 0.8 mm 2 A; the widths leave margin for JLCPCB's +/-20 % etch tolerance.
WIDEN = (
    ("/Power input (5 V + PSU header)/LM_SW", 1.5), ("/Power input (5 V + PSU header)/VIN_LM", 1.0),
    ("/Power input (5 V + PSU header)/+5V_PSU", 1.0), ("/Power input (5 V + PSU header)/VIN_RAW", 1.0),
    ("/VIN_IN", 1.0), ("/DOUT1", 1.0), ("+5V", 0.8), ("/ESP32 core + USB (DevKitC)/VBUS", 0.6),
    ("/SENSOR_5V", 0.6), ("+3V3", 0.5),
)


def widen_tracks(pcb=PCB):
    """Widen every segment of the WIDEN nets toward its target width, in 0.05 mm steps down from the target,
    keeping each net's clearance to other copper, the keep-outs and the board edge."""
    board = pcbnew.LoadBoard(pcb)
    areas = finish.keepouts(board)
    report = []
    for net, target in WIDEN:
        obstacles = finish.other_net_copper(board, net)
        tracks = [t for t in finish.tracks_of(board) if t.GetNetname() == net and t.GetClass() == "PCB_TRACK"]
        grown = 0
        for track in tracks:
            old = track.GetWidth()
            layer = track.GetLayer()
            clearance = pcbnew.ToMM(track.GetOwnClearance(layer))
            width = target
            while build.mm(width) > old:
                track.SetWidth(build.mm(width))
                if finish.clear_of(obstacles, track.GetEffectiveShape(layer), [layer], clearance, areas):
                    grown += 1
                    break
                width = round(width - 0.05, 3)
            else:
                track.SetWidth(old)
        report.append(f"{net.split('/')[-1]} {grown}/{len(tracks)}")
    route.fill_all(board)
    pcbnew.SaveBoard(pcb, board)
    print("widened segments:", ", ".join(report))


STITCH_PITCH = 5.0          # mm, GND stitching grid (lambda/20 at 2.4 GHz in FR-4 is about 3 mm: see STITCH_FINE)
STITCH_FINE = (2.5, 160.0)  # 2.5 mm along the board edges (3.5 mm band) right of x = 160, around the ESP32
STITCH_VIA = (0.6, 0.3)     # diameter, drill: JLCPCB standard price


def stitch_ground(pcb=PCB):
    """GND stitching vias wherever both GND pours are solid around the via: a 5 mm grid over the board, 2.5 mm
    along the edges near the ESP32 antenna. Skips part courtyards, rule areas and copper of other nets."""
    board = pcbnew.LoadBoard(pcb)
    route.fill_all(board)
    gnd = board.FindNet("GND")
    fills = {}
    zones = board.Zones()
    for zone in (zones[i] for i in range(len(zones))):
        if not zone.GetIsRuleArea() and zone.GetNetname() == "GND":
            for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
                if zone.IsOnLayer(layer):
                    poly = zone.GetFilledPolysList(layer).CloneDropTriangulation()
                    poly.Deflate(build.mm(STITCH_VIA[0] / 2 + 0.05), pcbnew.CORNER_STRATEGY_ROUND_ALL_CORNERS,
                                 build.mm(0.01))
                    fills[layer] = poly
    keepouts = [zones[i] for i in range(len(zones)) if zones[i].GetIsRuleArea() and zones[i].GetDoNotAllowVias()]
    courtyards = [build.courtyard(fp) for fp in build.footprints_of(board)]
    holes = [build.courtyard_box(fp) for fp in build.footprints_of(board) if fp.GetReference().startswith("H")]
    # drilled items a new via must keep 1.2 mm from (centre to centre): vias and through-hole pads
    drilled = [t.GetPosition() for t in finish.tracks_of(board) if t.GetClass() == "PCB_VIA"]
    drilled += [p.GetPosition() for fp in build.footprints_of(board) for p in fp.Pads() if p.GetDrillSize().x > 0]
    x0, y0, w, h = build.LAYOUT.outline
    fine, fine_x = STITCH_FINE
    points = set()
    for pitch in (STITCH_PITCH, fine):
        n_x, n_y = int(w / pitch), int(h / pitch)
        for i in range(n_x + 1):
            for j in range(n_y + 1):
                x, y = x0 + i * pitch, y0 + j * pitch
                near_edge = min(x - x0, x0 + w - x, y - y0, y0 + h - y) < 3.5
                if pitch == fine and not (near_edge and x >= fine_x):
                    continue
                points.add((round(x, 3), round(y, 3)))
    added = 0
    for x, y in sorted(points):
        p = pcbnew.VECTOR2I(build.mm(x), build.mm(y))
        if not all(layer in fills and fills[layer].Contains(p) for layer in (pcbnew.F_Cu, pcbnew.B_Cu)):
            continue
        if any(k.Outline().Contains(p) for k in keepouts) or any(c.OutlineCount() and c.Contains(p) for c in courtyards):
            continue
        if any(b.Contains(p) for b in holes):
            continue
        if any((d.x - p.x) ** 2 + (d.y - p.y) ** 2 < build.mm(1.2) ** 2 for d in drilled):
            continue
        drilled.append(p)
        via = pcbnew.PCB_VIA(board)
        via.SetPosition(p)
        via.SetWidth(build.mm(STITCH_VIA[0]))
        via.SetDrill(build.mm(STITCH_VIA[1]))
        via.SetNet(gnd)
        board.Add(via)
        added += 1
    route.fill_all(board)
    pcbnew.SaveBoard(pcb, board)
    print(f"added {added} GND stitching vias")


def reroute(sets, pcb=PCB):
    """Targeted Freerouting passes for connections `finish` cannot close because other nets box them in. Each set
    is a comma-separated list of nets (the last part of the name: GPS_TXD, USB_DP), the open ones plus their
    neighbours; its tracks come up and Freerouting routes everything open again ("-" rips nothing). A pass is kept
    when KiCad's DRC shows fewer open connections and no new errors; starved thermal reliefs are left out of that
    count, `finish` makes them solid."""
    names = [str(n) for n in pcbnew.LoadBoard(pcb).GetNetsByName().keys()]

    def state():
        unconnected, errors, _ = finish.drc(pcb)
        return unconnected, [e for e in errors if e["type"] != "starved_thermal"]

    best_copy = os.path.join(build.routing_dir(pcb), "reroute-best.kicad_pcb")
    shutil.copyfile(pcb, best_copy)
    best = state()
    print(f"start: {len(best[0])} unconnected, {len(best[1])} errors", flush=True)
    for nets in sets:
        rip = set() if nets == "-" else {n for short in nets.split(",") for n in names if n.split("/")[-1] == short}
        finish.freeroute(pcb, rip)
        now = state()
        keep = (len(now[0]), len(now[1])) < (len(best[0]), len(best[1])) and len(now[1]) <= len(best[1])
        print(f"  {nets}: {len(now[0])} unconnected, {len(now[1])} errors -> {'kept' if keep else 'dropped'}", flush=True)
        if keep:
            shutil.copyfile(pcb, best_copy)
            best = now
        else:
            shutil.copyfile(best_copy, pcb)
    for pair in best[0]:
        print("  open:", " <-> ".join(item["description"] for item in pair["items"]))


def routing_report(pcb=PCB):
    """How the routing measures up: vias, track length per layer, GND pour coverage of the bottom layer."""
    board = pcbnew.LoadBoard(pcb)
    tracks = board.Tracks()
    length = {pcbnew.F_Cu: 0.0, pcbnew.B_Cu: 0.0}
    vias = {"signal": 0, "GND": 0}
    for t in (tracks[i] for i in range(len(tracks))):
        if t.GetClass() == "PCB_VIA":
            vias["GND" if t.GetNetname() == "GND" else "signal"] += 1
        else:
            length[t.GetLayer()] = length.get(t.GetLayer(), 0.0) + pcbnew.ToMM(t.GetLength())
    total = sum(length.values()) or 1.0
    area = {}
    zones = board.Zones()
    for zone in (zones[i] for i in range(len(zones))):
        if not zone.GetIsRuleArea() and zone.GetNetname() == "GND":
            for layer in (pcbnew.F_Cu, pcbnew.B_Cu):
                if zone.IsOnLayer(layer):
                    area[layer] = area.get(layer, 0.0) + zone.GetFilledPolysList(layer).Area() / 1e12
    x0, y0, w, h = build.LAYOUT.outline
    print(f"tracks: top {length[pcbnew.F_Cu]:.0f} mm ({100 * length[pcbnew.F_Cu] / total:.0f} %), "
          f"bottom {length[pcbnew.B_Cu]:.0f} mm ({100 * length[pcbnew.B_Cu] / total:.0f} %)")
    print(f"vias: {vias['signal']} signal, {vias['GND']} GND")
    print(f"GND copper: top {100 * area.get(pcbnew.F_Cu, 0) / (w * h):.0f} %, bottom "
          f"{100 * area.get(pcbnew.B_Cu, 0) / (w * h):.0f} % of the board")


def add_pinout(board, size=1.0):
    """J1's pinout on the bottom silkscreen, mirrored so it reads from below: a title, then one text per
    pin in two columns."""
    def add(line, x, y, justify, thickness):
        text = pcbnew.PCB_TEXT(board)
        text.SetText(line)
        text.SetLayer(pcbnew.B_SilkS)
        text.SetMirrored(True)
        text.SetHorizJustify(justify)
        text.SetTextSize(pcbnew.VECTOR2I(build.mm(size), build.mm(size)))
        text.SetTextThickness(build.mm(thickness))
        text.SetPosition(pcbnew.VECTOR2I(build.mm(x), build.mm(y)))
        board.Add(text)

    title, x, y = J1_PINOUT_TITLE
    add(title, x, y, pcbnew.GR_TEXT_H_ALIGN_RIGHT, 0.18)
    for x, lines in J1_PINOUT_COLUMNS:
        for i, line in enumerate(lines):
            add(line, x, J1_PINOUT_Y + i * J1_PINOUT_PITCH, pcbnew.GR_TEXT_H_ALIGN_LEFT, 0.15)


# 3D models from JLCPCB's part library (EasyEDA), for parts whose KiCad 10 model is missing or generic:
# LCSC -> (offset x, y, z in mm, z rotation in degrees), lined up on the KiCad footprint's pads. The STEP files
# are downloaded into 3d/ (git-ignored) by `models`; source: JLCEDA/EasyEDA official library, https://easyeda.com
JLC_MODELS = {
    "C165948": ((0.0, -0.879, 0.0), 180),     # J201 USB-C, HRO TYPE-C-31-M-12
    "C318884": ((0.0, 0.0, 0.05), 0),         # SW201, SW202 TS-1187A
    "C2979167": ((10.588, 0.0, 0.6), 180),    # BT401 CR2032 holder
    "C19078719": ((0.0, 0.0, 0.0), 0),        # F101 1812 PTC
    "C9400": ((0.0, 0.0, 0.0), 0),            # L101 SMDRI127-330MT
    "C277731": ((10.5, -1.565, 0.0), 180),    # J1 Molex Micro-Fit 3.0 43045-1600 (KiCad 10 has no model for it)
}
# EasyEDA has no STEP file for these parts: use the model of a part with the same body and pads (LCSC -> LCSC)
MODEL_STANDINS = {}
# JLCPCB places each part with its own (EasyEDA) footprint. For these parts that footprint is turned, or has its
# origin elsewhere, compared with the KiCad footprint: (degrees to add to the CPL rotation, JLCPCB's origin in the
# KiCad footprint's frame, mm). Found by fitting JLCPCB's pads onto the KiCad pads: diodes and LEDs by pin name
# (C22452 and the 0603 LEDs number the anode 1, so they need no turn), the switches' four pads and BT401 by hand.
# Every other part matches within 0.1 mm.
JLC_PLACEMENT = {
    "C277731": (180, (10.5, 1.5)),    # J1 Micro-Fit 2 x 8: KiCad's origin is pin 1
    "C2979167": (180, (10.4, 0.0)),   # BT401 CR2032 holder (bottom): KiCad's origin is pin 1
    "C165948": (0, (0.0, -1.57)),     # J201 USB-C
    "C133065": (0, (0.0, -0.1)),      # J802 JST GH
    "C701341": (270, (0.0, 3.62)),    # U201 ESP32-WROOM-32E
    "C347423": (180, (-2.49, 0.0)),   # U101 LM2596S, TO-263-5
    "C6186": (180, (-0.18, 0.0)),     # U204 AMS1117, SOT-223
    "C172450": (180, (0.0, 0.0)),     # U903 BSP75N, SOT-223
    "C68983": (180, (0.0, 0.0)),      # D901 BAV99, SOT-23
    "C20526": (180, (0.0, 0.0)),      # Q201, Q202, SOT-23
    "C7484": (180, (0.0, 0.0)),       # U902 SN74AHCT1G125, SOT-23-5
    "C85364": (180, (0.0, 0.0)),      # U802 SRV05-4, SOT-23-6
    "C426705": (180, (0.0, 0.0)),     # U801 74LVC1G17, SC-70-5
    "C7519": (270, (0.0, 0.0)),       # U203 USBLC6-2SC6, SOT-23-6
    "C84681": (270, (0.0, 0.0)),      # U202 CH340C, SOIC-16
    "C107410": (270, (0.0, 0.0)),     # U401 DS3231M, SOIC-8
    "C6482": (270, (0.0, 0.0)),       # U501 AT24C256C, SOIC-8
    "C468683": (270, (0.0, 0.0)),     # U901 ADS1115, VSSOP-10
    "C50278": (270, (0.0, 0.0)),      # U601 MPU-6500, QFN-24
    "C478483": (270, (0.0, 0.0)),     # U602 LIS3MDL, LGA-12
    "C38695": (270, (0.0, 0.0)),      # U1001 TJA1051T/3, SOIC-8
    "C233434": (180, (0.0, 0.0)),     # D701, D1001 SZNUP3105L, SOT-23 (lines on pins 1/2, so either way round)
    "C118523": (270, (0.0, 0.0)),     # U1101 MAX13223E, TSSOP-20
}
# KiCad 10 renamed or lacks these library models
LIB_MODELS = {"U601": "Package_DFN_QFN.3dshapes/QFN-24_3x3mm_P0.4mm.step"}
MODEL_DIR = os.path.join(HERE, "3d")


def fetch_models():
    """Download each JLC_MODELS STEP file that is not in 3d/ yet (EasyEDA part data -> model uuid -> STEP)."""
    os.makedirs(MODEL_DIR, exist_ok=True)
    for lcsc in JLC_MODELS:
        path = os.path.join(MODEL_DIR, f"{lcsc}.step")
        if os.path.exists(path):
            continue
        req = lambda url: urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "tools-pcb.py"}), timeout=60).read()
        source = MODEL_STANDINS.get(lcsc, lcsc)
        shapes = json.loads(req(f"https://easyeda.com/api/products/{source}/components?version=6.4.19.5"))[
            "result"]["packageDetail"]["dataStr"]["shape"]
        uuid = next(json.loads(s.split("~", 1)[1])["attrs"]["uuid"] for s in shapes if s.startswith("SVGNODE"))
        step = req(f"https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/{uuid}")
        if not step.startswith(b"ISO-10303-21"):
            raise SystemExit(f"{lcsc}: EasyEDA did not return a STEP file")
        with open(path, "wb") as f:
            f.write(step)
        print("downloaded", path)


def jlc_cpl():
    """Rewrite production/CPL-*.csv for JLCPCB's footprints (JLC_PLACEMENT): the shared script writes KiCad's."""
    name = os.path.splitext(os.path.basename(PCB))[0]
    out = os.path.join(HERE, "production")
    lcsc = {}
    with open(os.path.join(out, f"BOM-{name}.csv"), newline="") as f:
        for row in csv.DictReader(f):
            lcsc.update({ref.strip(): row["LCSC"].strip() for ref in row["Designator"].split(",")})
    cpl = os.path.join(out, f"CPL-{name}.csv")
    with open(cpl, newline="") as f:
        rows = list(csv.DictReader(f))
    for row in rows:
        if lcsc.get(row["Designator"]) not in JLC_PLACEMENT:
            continue
        turn, (cx, cy) = JLC_PLACEMENT[lcsc[row["Designator"]]]
        rotation = float(row["Rotation"])
        a = math.radians(rotation)
        # the offset turns with the footprint (KiCad: y down, counter-clockwise as seen); the CPL's y points up
        dx, dy = cx * math.cos(a) + cy * math.sin(a), -cx * math.sin(a) + cy * math.cos(a)
        row["Mid X"] = f"{float(row['Mid X'].removesuffix('mm')) + dx:.4f}mm"
        row["Mid Y"] = f"{float(row['Mid Y'].removesuffix('mm')) - dy:.4f}mm"
        row["Rotation"] = f"{(rotation + turn) % 360:.6f}"
    with open(cpl, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    print(f"{cpl}: {sum(lcsc.get(r['Designator']) in JLC_PLACEMENT for r in rows)} parts set for JLCPCB's footprints")

def set_models(board):
    """Point the footprints at the JLCPCB models (by LCSC field) and the renamed KiCad library models."""
    fps = board.Footprints()
    for fp in (fps[i] for i in range(len(fps))):
        lcsc = {f.GetName(): f.GetText() for f in fp.GetFields()}.get("LCSC", "")
        ref = fp.GetReference()
        if lcsc in JLC_MODELS:
            (x, y, z), rz = JLC_MODELS[lcsc]
            name, offset, rotation = f"${{KIPRJMOD}}/3d/{lcsc}.step", pcbnew.VECTOR3D(x, y, z), pcbnew.VECTOR3D(0, 0, rz)
        elif ref in LIB_MODELS:
            name, offset, rotation = f"${{KICAD10_3DMODEL_DIR}}/{LIB_MODELS[ref]}", pcbnew.VECTOR3D(0, 0, 0), pcbnew.VECTOR3D(0, 0, 0)
        else:
            continue
        models = fp.Models()
        while len(models):
            models.pop()
        model = pcbnew.FP_3DMODEL()
        model.m_Filename, model.m_Offset, model.m_Rotation = name, offset, rotation
        models.append(model)


def edge_keepouts(board, width=0.45):
    """Strips along the outline and around each slot where no track or via may go. Freerouting is not told
    KiCad's 0.3 mm copper-to-edge clearance and would otherwise route right against the edge."""
    strips = [(X0, Y0, X0 + W, Y0 + width), (X0, Y0 + H - width, X0 + W, Y0 + H),
              (X0, Y0, X0 + width, Y0 + H), (X0 + W - width, Y0, X0 + W, Y0 + H)]
    for (x1, y1), (x2, y2), slot in SLOTS:
        r = slot / 2 + width
        strips.append((min(x1, x2) - r, min(y1, y2) - r, max(x1, x2) + r, max(y1, y2) + r))
    for i, rect in enumerate(strips):
        route.add_rule_area(board, rect, f"EDGE_{i + 1}", tracks=True, fills=True)


# reference text moved clear of its neighbours on this dense board: ref -> (x, y[, angle])
REF_POSITIONS = {   # clear of neighbouring silkscreen, pads and the island's slots
    "L101": (149.4, 192.6),                                            # on the part's body
    "U701": (139.5, 125.8, 90), "U1001": (138.0, 133.5, 90),           # on the body, along it: the module titles
    "U1101": (131.0, 141.8, 90), "U501": (160.0, 123.0, 90),           # sit where the references were
    "U302": (129.0, 109.2), "U301": (129.0, 111.4),                    # between the opto-couplers, left of the slot
    "JP501": (161.2, 129.0), "SW202": (196.0, 145.4),                  # below the part
}
HIDDEN_REFS = ("JP702", "JP703", "JP704", "JP1001", "JP1002")   # named by the legends in LABELS


# nets whose tracks `update` takes up so `finish` routes them afresh. Empty for the indicator LEDs: GPIO5/18/19
# keep their routes to where their test pads were, and Freerouting extends them east to the LEDs (the direct way
# down the right edge is blocked by USB-C, the buttons and H103)
UPDATE_RIP = ()


def board_offset(board):
    """(dx, dy) in mm by which the board file sits away from this script's coordinates: the user may move the whole
    board in KiCad (2026-10-29: by (18.2, -48.27)). Measured on the outline's top-left corner (the smallest x and y
    of the Edge.Cuts shapes' end points, line width left out), which no part move changes: on 2026-11-02 the IMU
    moved on its own, and a part-based offset was 3.4 mm out."""
    drawings = board.Drawings()
    edges = [drawings[i].Cast() for i in range(len(drawings)) if drawings[i].GetLayer() == pcbnew.Edge_Cuts]
    points = [p for shape in edges for p in (shape.GetStart(), shape.GetEnd())]
    x, y = min(p.x for p in points), min(p.y for p in points)
    return round(pcbnew.ToMM(x) - X0, 4), round(pcbnew.ToMM(y) - Y0, 4)


def match_board(pcb=PCB):
    """Shift build.LAYOUT (outline, vehicle area, placement, labels, slots) onto the board file as it was saved, so
    pours, plane vias, new parts and labels land where they belong on a board moved in KiCad."""
    dx, dy = board_offset(pcbnew.LoadBoard(pcb))
    if (dx, dy) != (0.0, 0.0):
        x0, y0, w, h = LAYOUT.outline
        move = lambda r: (r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy)
        build.LAYOUT = LAYOUT._replace(
            outline=(x0 + dx, y0 + dy, w, h), vehicle_area=move(LAYOUT.vehicle_area),
            placement={ref: (x + dx, y + dy, rot, side) for ref, (x, y, rot, side) in LAYOUT.placement.items()},
            labels=[(text, x + dx, y + dy, size, bold) for text, x, y, size, bold in LAYOUT.labels],
            slots=tuple(((x1 + dx, y1 + dy), (x2 + dx, y2 + dy), width) for (x1, y1), (x2, y2), width in LAYOUT.slots))
        print(f"the board file is moved by ({dx}, {dy}) mm from the script's coordinates: layout shifted to match")
    return dx, dy


def update_parts(pcb=PCB, rip=()):
    """Bring the routed board in line with the schematic without re-routing it: parts that left the schematic are
    removed, parts that stay take the schematic's value and fields, new parts are placed from PLACEMENT and get
    their nets, and the tracks of the `rip` nets are taken up. `finish` then routes every open connection."""
    comps, nets = build.export_netlist(SCH)
    board = pcbnew.LoadBoard(pcb)
    have = {fp.GetReference(): fp for fp in build.footprints_of(board)}
    for ref in sorted(set(have) - set(comps)):
        finish.remove(board, have[ref])
        print("removed", ref)
    for ref in sorted(set(have) & set(comps)):   # a changed part number, e.g. another LED colour
        fp, comp = have[ref], comps[ref]
        description = fp.GetField(pcbnew.FIELD_T_DESCRIPTION)
        if fp.GetValue() == comp["value"] and description.GetText() == comp["description"] and \
                all(fp.GetFieldText(name) == text for name, text in comp["extra"].items()):
            continue
        fp.SetValue(comp["value"])
        description.SetText(comp["description"])
        for name, text in comp["extra"].items():
            fp.SetField(name, text)
            fp.GetField(name).SetVisible(False)
        print("updated", ref)
    added = {}
    for ref in sorted(set(comps) - set(have)):   # as build.add_footprints_and_nets does it
        comp = comps[ref]
        fp = build.load_fp(comp["footprint"])
        fp.SetReference(ref)
        fp.SetValue(comp["value"])
        fp.SetPath(pcbnew.KIID_PATH(comp["path"]))
        fp.GetField(pcbnew.FIELD_T_DATASHEET).SetText(comp["datasheet"])
        fp.GetField(pcbnew.FIELD_T_DESCRIPTION).SetText(comp["description"])
        fp.SetExcludedFromBOM(not comp["in_bom"])
        fp.SetDNP(comp["dnp"])
        for name, text in comp["extra"].items():
            fp.SetField(name, text)
            fp.GetField(name).SetVisible(False)
        fp.Reference().SetTextSize(pcbnew.VECTOR2I(build.mm(build.REF_TEXT_MM), build.mm(build.REF_TEXT_MM)))
        fp.Reference().SetTextThickness(build.mm(build.REF_TEXT_MM * 0.15))
        board.Add(fp)
        build.place(fp, *build.LAYOUT.placement[ref])
        added[ref] = fp
        print("added", ref)
    renetted = set()
    for name, nodes in nets:
        if name.startswith(("unconnected-(", "Net-(")):
            name = name.replace("/", "{slash}")   # matches eeschema's escaping of pin names
        net = board.FindNet(name)
        if net is None:
            net = pcbnew.NETINFO_ITEM(board, name)
            board.Add(net)
        for ref, pin in nodes:
            fp = added.get(ref) or have.get(ref)
            for pad in fp.Pads() if fp else ():
                if pad.GetNumber() == pin and pad.GetNetname() != name:
                    if ref not in added:   # a pin swap: both the old and the new net get routed afresh
                        renetted.update({pad.GetNetname(), name})
                        print(f"re-netted {ref} pad {pin}: {pad.GetNetname()} -> {name}")
                    pad.SetNet(net)
    rip = set(rip) | renetted
    ripped = [t for t in finish.tracks_of(board) if t.GetNetname() in rip]
    for track in ripped:
        finish.remove(board, track)
    print(f"took up {len(ripped)} tracks and vias of", ", ".join(rip) or "no nets")
    tidy_silkscreen(board, *board_offset(board))
    set_models(board)
    pcbnew.SaveBoard(pcb, board)


def relabel(pcb=PCB):
    """Re-apply LABELS and the reference positions to the routed board, so silkscreen fixes need no re-route."""
    board = pcbnew.LoadBoard(pcb)
    drawings = board.Drawings()
    for item in [drawings[i] for i in range(len(drawings))]:
        if item.GetClass() == "PCB_TEXT" and item.GetLayer() == pcbnew.F_SilkS:
            finish.remove(board, item)
    build.add_labels(board, build.LAYOUT.labels)
    tidy_silkscreen(board, *board_offset(board))
    pcbnew.SaveBoard(pcb, board)


def tidy_silkscreen(board, dx=0.0, dy=0.0):
    """The board is too dense for a silkscreen reference on every part: parts under 30 mm^2 and the
    mounting holes keep theirs on the fab layer only, while connectors, switches, jumpers, the battery
    and the larger ICs stay labelled. (dx, dy): how far the board was moved in KiCad."""
    fps = board.Footprints()
    for fp in (fps[i] for i in range(len(fps))):
        ref = fp.GetReference()
        small = build.courtyard_box(fp).GetArea() < build.mm(1) * build.mm(1) * 30
        if ref.startswith("H") or ref in HIDDEN_REFS or (small and not ref.startswith(("J", "SW", "BT"))):
            fp.Reference().SetVisible(False)
        if ref in REF_POSITIONS:
            x, y, *angle = REF_POSITIONS[ref]
            fp.Reference().SetPosition(pcbnew.VECTOR2I(build.mm(x + dx), build.mm(y + dy)))
            if angle:
                fp.Reference().SetTextAngleDegrees(angle[0])


def imu_keepouts(board):
    """No tracks or vias under the IMU packages (MPU-6500: no routing under the package; LIS3MDL is a
    magnetometer), on either layer; the GND pours may fill in. F.Cu: inside the pad ring; B.Cu: package + 0.5 mm."""
    fps = board.Footprints()   # index access: SWIG iterators are unreliable under Python 3.14
    for ref in IMU:
        fp = next(fps[i] for i in range(len(fps)) if fps[i].GetReference() == ref)
        boxes = [p.GetBoundingBox() for p in fp.Pads()]
        left, right = min(b.GetLeft() for b in boxes), max(b.GetRight() for b in boxes)
        top, bottom = min(b.GetTop() for b in boxes), max(b.GetBottom() for b in boxes)

        def inner_edge(edge, value, inner, pick):   # inner end of the pad row along one side
            return pick(inner(b) for b in boxes if abs(edge(b) - value) < build.mm(0.01))

        x1, y1, x2, y2 = (pcbnew.ToMM(v) for v in (
            inner_edge(lambda b: b.GetLeft(), left, lambda b: b.GetRight(), max),
            inner_edge(lambda b: b.GetTop(), top, lambda b: b.GetBottom(), max),
            inner_edge(lambda b: b.GetRight(), right, lambda b: b.GetLeft(), min),
            inner_edge(lambda b: b.GetBottom(), bottom, lambda b: b.GetTop(), min)))
        route.add_rule_area(board, (x1 + 0.05, y1 + 0.05, x2 - 0.05, y2 - 0.05), f"{ref}_KEEPOUT_F",
                            tracks=True, layers=[pcbnew.F_Cu], fills=True)
        x1, y1, x2, y2 = (pcbnew.ToMM(v) for v in (left, top, right, bottom))
        route.add_rule_area(board, (x1 - 0.5, y1 - 0.5, x2 + 0.5, y2 + 0.5), f"{ref}_KEEPOUT_B",
                            tracks=True, layers=[pcbnew.B_Cu], fills=True)


def placement_issues(board):
    """Checks a compact, two-sided board needs beyond courtyard overlaps."""
    issues = []
    fps = board.Footprints()
    fps = [fps[i] for i in range(len(fps))]
    top = [fp for fp in fps if fp.GetLayer() == pcbnew.F_Cu]
    bottom = [fp for fp in fps if fp.GetLayer() == pcbnew.B_Cu]
    tht = lambda fp: [p for p in fp.Pads() if p.GetAttribute() in (pcbnew.PAD_ATTRIB_PTH, pcbnew.PAD_ATTRIB_NPTH)]
    # through-hole pins (and screw holes) come out on the other side: they must not land inside a part there
    for fp_a, others in [(a, bottom) for a in top] + [(b, top) for b in bottom]:
        for pad in tht(fp_a):
            for fp_b in others:
                cy = build.courtyard(fp_b)
                if cy.OutlineCount() and cy.Collide(pad.GetPosition(), build.mm(0.6)):
                    issues.append(f"{fp_a.GetReference()} pin {pad.GetNumber()} pokes into {fp_b.GetReference()} on the other side")
    # a screw head covers its hole's courtyard on both sides
    holes = [fp for fp in fps if fp.GetReference().startswith("H")]
    for hole in holes:
        for fp in bottom:
            if build.courtyard_box(hole).Intersects(build.courtyard_box(fp)):
                issues.append(f"{hole.GetReference()} screw head overlaps {fp.GetReference()} on the bottom")
    # the buck stage stays in its strip (short hot loop, far from the magnetometer)
    x1, y1, x2, y2 = (build.mm(v) for v in SUPPLY_AREA)
    by_ref = {fp.GetReference(): fp for fp in fps}
    for ref in ("U101", "L101", "C102", "C104", "D105"):
        box = build.courtyard_box(by_ref[ref])
        if not (box.GetLeft() >= x1 and box.GetRight() <= x2 and box.GetTop() >= y1 and box.GetBottom() <= y2):
            issues.append(f"{ref} is outside SUPPLY_AREA")
    # the AIN1 front end keeps its distance from the LM2596 switch node
    gap, near = ain_switch_distance(fps)
    if gap < AIN_MIN_DISTANCE:
        issues.append(f"{near} is {gap:.1f} mm from LM_SW (want >= {AIN_MIN_DISTANCE} mm)")
    # slots must not cut pads
    for (sx1, sy1), (sx2, sy2), width in SLOTS:
        seg = pcbnew.SHAPE_SEGMENT(pcbnew.VECTOR2I(build.mm(sx1), build.mm(sy1)), pcbnew.VECTOR2I(build.mm(sx2), build.mm(sy2)),
                                   build.mm(width))
        for fp in fps:
            for pad in fp.Pads():
                if pad.GetEffectiveShape(pcbnew.F_Cu).Collide(seg, build.mm(0.3)):
                    issues.append(f"slot at ({sx1},{sy1}) cuts {fp.GetReference()} pad {pad.GetNumber()}")
    # a pad inside a barrier bridge could never be reached
    for bx1, by1, bx2, by2 in BRIDGES:
        rect = pcbnew.SHAPE_RECT(build.mm(bx1), build.mm(by1), build.mm(bx2 - bx1), build.mm(by2 - by1))
        for fp in fps:
            for pad in fp.Pads():
                if pad.GetNetname() and pad.GetEffectiveShape(pcbnew.F_Cu).Collide(rect, 0):
                    issues.append(f"{fp.GetReference()} pad {pad.GetNumber()} is inside the barrier bridge at ({bx1},{by1})")
    # island pads stay inside the island and everything else outside it
    island = pcbnew.SHAPE_RECT(build.mm(X0), build.mm(Y0), build.mm(BARRIER_X - X0), build.mm(ISLAND_BOTTOM - Y0))
    nets = island_nets(fps)
    for fp in fps:
        for pad in fp.Pads():
            if not pad.GetNetname() or fp.GetReference() in ("U301", "U302"):
                continue
            inside = pad.GetEffectiveShape(pcbnew.F_Cu).Collide(island, 0)
            if inside != (pad.GetNetname() in nets):
                where = "inside" if inside else "outside"
                issues.append(f"{fp.GetReference()} pad {pad.GetNumber()} ({pad.GetNetname()}) is {where} the DIN island")
    return issues


# the isolated side of the optocouplers: the DIN front-end parts, the opto LED pins and J1's DIN pins
ISLAND_PADS = {"J1": ("7", "8", "15", "16"), "U301": ("1", "2"), "U302": ("1", "2")}
ISLAND_PARTS = ("R301", "R302", "R303", "R304", "R306", "R307", "R308", "R309", "D301", "D302", "D303", "D304")


def island_nets(fps):
    """Names of the nets on the isolated side of the barrier."""
    nets = set()
    for fp in fps:
        ref = fp.GetReference()
        for pad in fp.Pads():
            if ref in ISLAND_PARTS or pad.GetNumber() in ISLAND_PADS.get(ref, ()):
                nets.add(pad.GetNetname())
    return nets


def ain_switch_distance(fps):
    """Shortest pad-to-pad distance (mm) from the AIN1 front end to the LM_SW net, and the part it is from."""
    switch = [p for fp in fps for p in fp.Pads() if p.GetNetname().endswith("/LM_SW")]
    best = (float("inf"), "")
    for fp in (fp for fp in fps if fp.GetReference() in AIN_PARTS):
        for pad in fp.Pads():
            for sw in switch:
                d = pad.GetEffectiveShape(pcbnew.F_Cu).GetClearance(sw.GetEffectiveShape(pcbnew.F_Cu))
                best = min(best, (pcbnew.ToMM(d), fp.GetReference()))
    return best


def magnetometer_report(board):
    """Distance from the LIS3MDL to the parts that disturb a compass (rule of thumb: 20 mm)."""
    fps = board.Footprints()
    by_ref = {fps[i].GetReference(): fps[i] for i in range(len(fps))}
    centre = by_ref["U602"].GetPosition()
    lines = []
    for ref, why in (("BT401", "coin cell (steel)"), ("J1", "Micro-Fit (DOUT1 / VIN current)"),
                     ("J201", "USB-C shell"), ("L101", "buck inductor"), ("U101", "LM2596"), ("U903", "DOUT1 switch"),
                     ("U201", "ESP32 shield")):
        # the ESP32 courtyard includes the antenna keep-out wings; measure to the module's pads instead
        box = build.pads_box(by_ref[ref]) if ref == "U201" else build.courtyard_box(by_ref[ref])
        dx = max(box.GetLeft() - centre.x, 0, centre.x - box.GetRight())
        dy = max(box.GetTop() - centre.y, 0, centre.y - box.GetBottom())
        lines.append(f"{ref} {why}: {pcbnew.ToMM(math.hypot(dx, dy)):.1f} mm")
    return lines


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "check"
    count = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else None
    if mode in ("check", "place"):
        board = place(PCB if mode == "place" else build.throwaway(PCB))
        issues = build.courtyard_overlaps(board) + placement_issues(board)
        print(f"placement issues ({len(issues)}):", "; ".join(issues) or "none")
        print("magnetometer U602 to:", "; ".join(magnetometer_report(board)))
        gap, near = ain_switch_distance(build.footprints_of(board))
        print(f"AIN1 front end to LM_SW: {gap:.1f} mm ({near})")
        pcbnew.SaveBoard(PCB if mode == "place" else build.throwaway(PCB), board)
        if mode == "place":
            print("saved", PCB)
    elif mode == "route":
        match_board()
        route.main(4 if count is None else count, PCB)
    elif mode == "finish":
        match_board()
        finish.main(3 if count is None else count, PCB)
    elif mode == "reroute":
        match_board()
        reroute(sys.argv[2:])
    elif mode == "widen":
        match_board()
        widen_tracks()
    elif mode == "stitch":
        match_board()
        stitch_ground()
    elif mode == "report":
        routing_report()
    elif mode == "update":
        match_board()
        update_parts(rip=UPDATE_RIP)
        print("saved", PCB)
    elif mode == "silk":
        match_board()
        relabel()
        print("saved", PCB)
    elif mode == "models":
        fetch_models()
        board = pcbnew.LoadBoard(PCB)
        set_models(board)
        pcbnew.SaveBoard(PCB, board)
        print("saved", PCB)
    elif mode == "production":
        subprocess.run([sys.executable, os.path.join(MAIN, "tools-production.py"), PCB], check=True)
        jlc_cpl()
    else:
        raise SystemExit(__doc__)
