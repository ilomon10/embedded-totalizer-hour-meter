#!/usr/bin/env python3
"""Production files for hour-meter-devboard, after tools-route-pcb.py:

    python3 tools-production.py

  1. checks: 2 copper layers, DRC with schematic parity (0 errors, 0 unconnected, 0 parity)
  2. Gerbers + Excellon drill files, zipped; the zip may only hold copper layers L1/L2
  3. BOM with the names local electronics shops use (production/*-bom.csv)
  4. 1:1 fit-check PDF: print at 100 % and lay the real modules on it before ordering
  5. pictures for the README: schematic PDF/PNG, 2D board PNG, 3D render
"""
import collections
import csv
import glob
import json
import os
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

import pcbnew

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = "hour-meter-devboard"
PCB = os.path.join(HERE, NAME + ".kicad_pcb")
SCH = os.path.join(HERE, NAME + ".kicad_sch")
OUT = os.path.join(HERE, "production")
GERBERS = os.path.join(OUT, "gerbers")
LAYERS = "F.Cu,B.Cu,F.Mask,B.Mask,F.Silkscreen,B.Silkscreen,Edge.Cuts"

# BOM text per (value, footprint) group: (part to buy, Indonesian search term, note)
LOCAL = {
    "U1": ("ESP32 DevKit V4, USB-C, 38 pins (ESP32-WROOM-32D/E)", "ESP32 DevKit V4 Type C 38 pin",
           "Check its pin rows are 25.4 mm apart (fit-check PDF)"),
    "M1": ("2-channel PC817 isolation module (817 Module)", "modul optocoupler PC817 2 channel",
           "Remove both G jumpers; mounts on 4 M3 standoffs"),
    "M2": ("DS3231 RTC module ZS-042 + CR2032", "modul RTC DS3231 ZS-042",
           "Remove its charge resistor; solder a straight 1x6 header underneath"),
    "M3": ("AT24C256 I2C EEPROM module", "modul EEPROM AT24C256 I2C",
           "A0-A2 and WP jumpers to GND; solder a straight 1x4 header underneath"),
    "M4": ("GY-9250 (MPU9250 or MPU6500) module", "modul GY-9250 MPU9250",
           "Straight 1x10 header underneath, chip side up"),
    "M5": ("GY-271 compass module (QMC5883L or HMC5883L)", "modul kompas GY-271 QMC5883L",
           "Straight 1x5 header underneath (usually supplied), chip side up; no steel or magnets near it"),
    "J1": ("Screw terminal 2 pin, 5.08 mm (KF301-2P)", "terminal block KF301 2P 5.08", "Wire entry toward the board edge"),
    "J3": ("Pin header 2x5, 2.54 mm, straight", "pin header male 2x5 2.54", "Cut from a 2x40 strip"),
    "D1": ("1N4007 rectifier diode", "dioda 1N4007", "Band (cathode) toward the K mark"),
    "D3": ("1N4744A zener 15 V 1 W", "dioda zener 15V 1W 1N4744A",
           "Old 24 V trucks without load-dump protection: P6KE18A TVS in the same holes"),
    "D5": ("LED 3 mm green", "LED 3mm hijau", "Long leg (anode) to the round pad"),
    "R4": ("Resistor 1.5 kohm 1 W metal film", "resistor 1K5 1W", ""),
    "R5": ("Resistor 47 kohm 1/4 W", "resistor 47K 1/4W", ""),
    "R1": ("Resistor 1 kohm 1/4 W", "resistor 1K 1/4W", ""),
    "C1": ("Ceramic capacitor 100 nF 50 V (104)", "kapasitor keramik 104", ""),
    "C2": ("Ceramic capacitor 1 nF 50 V (102)", "kapasitor keramik 102", ""),
    "C3": ("Electrolytic capacitor 10 uF 16 V or 25 V, 5 mm", "elco 10uF 16V", "Long leg (+) to the square pad"),
    "F1": ("PTC resettable fuse 0.1 A 60 V, 5 mm pitch (MF-R010 / JK60-010)", "PTC resettable fuse 0.1A 60V", ""),
}
# Parts that share a BOM line with another reference
SAME_AS = {"J2": "J1", "D2": "D1", "D4": "D3", "R6": "R4", "R7": "R5", "C4": "C1"}
# Hardware that is not on the schematic.
EXTRA = [
    ("Female header 1x20, 2.54 mm (cut to 19)", "female header 1x20 2.54", 2, "U1 sockets"),
    ("Female header 1x6, 2.54 mm", "female header 1x6 2.54", 1, "M2 socket"),
    ("Female header 1x4, 2.54 mm", "female header 1x4 2.54", 1, "M3 socket"),
    ("Female header 1x10, 2.54 mm", "female header 1x10 2.54", 1, "M4 socket"),
    ("Female header 1x5, 2.54 mm", "female header 1x5 2.54", 1, "M5 socket"),
    ("Pin header 1x40, 2.54 mm, straight", "pin header male 1x40 2.54", 1, "Cut 6 + 4 for the M2 and M3 modules"),
    ("Nylon M3 spacer 10-12 mm, with M3 screws", "spacer nylon M3 10mm", 4, "M1 standoffs; parts underneath are up to 6 mm tall"),
    ("Nylon M3 spacer 11 mm (or 10 mm + washer), with nylon M3 screws", "spacer nylon M3 11mm", 2,
     "Optional: holds the GY-9250 rigid. Nylon, like everything near the compass"),
    ("Hook-up wire 22-24 AWG, about 30 cm", "kabel jumper 22 AWG", 1, "8 short wires from the M1 pads to the 817 module terminals"),
    ("CR2032 coin cell (or LIR2032 with the charge resistor kept)", "baterai CR2032", 1, "RTC backup"),
    ("Nylon (or brass) M3 screws and spacers for the enclosure", "baut nylon M3 + spacer nylon", 3,
     "H1, H3, H4. Steel screws in H3/H4 would disturb the compass"),
]


def run(*cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def check_board():
    board = pcbnew.LoadBoard(PCB)
    layers = board.GetCopperLayerCount()
    if layers != 2:
        raise SystemExit(f"{layers} copper layers: this board must stay on 2")
    report = os.path.join(tempfile.mkdtemp(), "drc.json")
    run("kicad-cli", "pcb", "drc", "--severity-all", "--schematic-parity", "--format", "json", "-o", report, PCB)
    with open(report) as f:
        drc = json.load(f)
    kinds = collections.Counter(v["severity"] for v in drc["violations"])
    print(f"DRC: {kinds.get('error', 0)} errors, {kinds.get('warning', 0)} warnings, "
          f"{len(drc['unconnected_items'])} unconnected, {len(drc['schematic_parity'])} parity")
    if kinds.get("error") or drc["unconnected_items"] or drc["schematic_parity"]:
        raise SystemExit("fix the DRC report before ordering")


def gerbers():
    shutil.rmtree(GERBERS, ignore_errors=True)
    os.makedirs(GERBERS)
    run("kicad-cli", "pcb", "export", "gerbers", "--layers", LAYERS, "--subtract-soldermask", "-o", GERBERS + "/", PCB)
    run("kicad-cli", "pcb", "export", "drill", "--format", "excellon", "--excellon-separate-th",
        "--excellon-units", "mm", "-o", GERBERS + "/", PCB)
    copper = set()
    for path in glob.glob(os.path.join(GERBERS, "*")):
        with open(path, errors="ignore") as f:
            m = re.search(r"%TF\.FileFunction,Copper,(L\d+)", f.read(4000))
        if m:
            copper.add(m.group(1))
    if copper != {"L1", "L2"}:
        raise SystemExit(f"copper Gerbers {sorted(copper)}: expected L1 and L2 only")
    zpath = os.path.join(OUT, NAME + "-gerbers.zip")
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(glob.glob(os.path.join(GERBERS, "*"))):
            z.write(path, os.path.basename(path))
    print("Gerbers:", sorted(copper), "->", os.path.relpath(zpath, HERE))


def bom():
    xml = os.path.join(tempfile.mkdtemp(), "net.xml")
    run("kicad-cli", "sch", "export", "netlist", "--format", "kicadxml", "-o", xml, SCH)
    groups = collections.OrderedDict()
    for c in ET.parse(xml).getroot().iter("comp"):
        ref, value = c.get("ref"), c.findtext("value")
        part, search, note = LOCAL.get(SAME_AS.get(ref, ref), (value, value, ""))
        g = groups.setdefault((part, c.findtext("footprint")), {"refs": [], "values": [], "search": search, "note": note})
        g["refs"].append(ref)
        g["values"].append(value)
    order = lambda r: (re.sub(r"\d", "", r), int(re.sub(r"\D", "", r)))
    rows = []
    for (part, footprint), g in sorted(groups.items(), key=lambda kv: order(sorted(kv[1]["refs"], key=order)[0])):
        refs = sorted(g["refs"], key=order)
        values = " / ".join(dict.fromkeys(g["values"]))
        rows.append([", ".join(refs), len(refs), part, g["search"], g["note"], values, footprint.split(":")[-1]])
    rows += [["", qty, part, search, note, "", ""] for part, search, qty, note in EXTRA]
    path = os.path.join(OUT, NAME + "-bom.csv")
    with open(path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["References", "Qty", "Part", "Search term (Tokopedia / Shopee / shop)", "Note", "Schematic value", "Footprint"])
        w.writerows(rows)
    print("BOM:", len(rows), "lines ->", os.path.relpath(path, HERE))


def fit_check():
    path = os.path.join(OUT, NAME + "-fit-check-1to1.pdf")
    run("kicad-cli", "pcb", "export", "pdf", "--mode-single", "--scale", "1", "--black-and-white", "--exclude-value",
        "--layers", "Edge.Cuts,F.Fab,F.Silkscreen", "--sketch-pads-on-fab-layers", "-o", path, PCB)
    print("fit check:", os.path.relpath(path, HERE), "(print at 100 %)")


def pictures():
    tmp = tempfile.mkdtemp()
    run("kicad-cli", "sch", "export", "pdf", "-o", os.path.join(HERE, NAME + ".pdf"), SCH)
    run("kicad-cli", "sch", "export", "svg", "--exclude-drawing-sheet", "-o", tmp, SCH)
    svg = glob.glob(os.path.join(tmp, "*.svg"))[0]
    run("rsvg-convert", "-w", "2400", "-b", "white", svg, "-o", os.path.join(HERE, NAME + ".png"))
    board_svg = os.path.join(tmp, "board.svg")
    run("kicad-cli", "pcb", "export", "svg", "--mode-single", "--fit-page-to-board", "--exclude-drawing-sheet",
        "--layers", "B.Cu,F.Cu,F.Silkscreen,Edge.Cuts", "-o", board_svg, PCB)
    run("rsvg-convert", "-w", "1600", "-b", "white", board_svg, "-o", os.path.join(HERE, NAME + "-pcb.png"))
    run("kicad-cli", "pcb", "render", "--side", "top", "--quality", "high", "--width", "1600", "--height", "1300",
        "--background", "opaque", "-o", os.path.join(HERE, NAME + "-3d.png"), PCB)
    print("pictures:", NAME + ".pdf/.png, -pcb.png, -3d.png")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    check_board()
    gerbers()
    bom()
    fit_check()
    pictures()
