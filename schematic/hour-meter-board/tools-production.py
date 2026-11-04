#!/usr/bin/env python3
"""JLCPCB order files and 3D models for the hour-meter main board, with kicad-cli.

  python3 tools-production.py           # checks, then production/: Gerber zip, BOM, CPL
  python3 tools-production.py models    # download the JLCPCB 3D models the board uses into 3d/

Order files, written into a fresh production/ (no stale file can pass as current):
  hour-meter-board-gerbers-JLCPCB.zip   Gerbers + Excellon drill
  BOM-hour-meter-board.csv              Comment, Designator, Footprint, LCSC, Qty
  CPL-hour-meter-board.csv              Designator, Mid X, Mid Y, Layer, Rotation, set for JLCPCB's footprints
Board-only parts (holes, test pads, solder jumpers) and Do-Not-Populate parts are left out of the BOM and CPL.

Checks before anything is written: 2 copper layers, and DRC with the schematic parity check gives
0 errors, 0 unconnected items, 0 parity issues. The Gerber zip may only hold copper layers L1 and L2.
"""
import collections
import csv
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
NAME = "hour-meter-board"
PCB = os.path.join(HERE, NAME + ".kicad_pcb")
SCH = os.path.join(HERE, NAME + ".kicad_sch")
OUT = os.path.join(HERE, "production")
MODEL_DIR = os.path.join(HERE, "3d")
LAYERS = ["F.Cu", "B.Cu", "F.Mask", "B.Mask", "F.Paste", "B.Paste", "F.SilkS", "B.SilkS", "Edge.Cuts"]
BOARD_ONLY_PREFIXES = ("MountingHole:", "TestPoint:", "Fiducial:", "Jumper:SolderJumper")

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


def run(*args):
    return subprocess.run(["kicad-cli", *args], check=True, capture_output=True, text=True)


def check_board():
    with open(PCB) as f:
        head = f.read(20000)   # the (layers ...) table sits near the top of the file
    if '"In1.Cu"' in head:
        raise SystemExit("inner copper layers found: this board must stay on 2 layers")
    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "drc.json")
        run("pcb", "drc", "--severity-all", "--schematic-parity", "--format", "json", "-o", report, PCB)
        with open(report) as f:
            drc = json.load(f)
    kinds = collections.Counter(v["severity"] for v in drc["violations"])
    print(f"DRC: {kinds.get('error', 0)} errors, {kinds.get('warning', 0)} warnings, "
          f"{len(drc['unconnected_items'])} unconnected, {len(drc['schematic_parity'])} parity")
    if kinds.get("error") or drc["unconnected_items"] or drc["schematic_parity"]:
        raise SystemExit("fix the DRC report before ordering")


def gerbers(tmp):
    folder = os.path.join(tmp, "gerbers")
    os.makedirs(folder)
    run("pcb", "export", "gerbers", "--no-protel-ext", "--layers", ",".join(LAYERS), "-o", folder + "/", PCB)
    run("pcb", "export", "drill", "--format", "excellon", "--excellon-separate-th", "-o", folder + "/", PCB)
    copper = set()
    for f in os.listdir(folder):
        with open(os.path.join(folder, f), errors="ignore") as g:
            m = re.search(r"%TF\.FileFunction,Copper,(L\d+)", g.read(4000))
        if m:
            copper.add(m.group(1))
    if copper != {"L1", "L2"}:
        raise SystemExit(f"copper Gerbers {sorted(copper)}: expected L1 and L2 only")
    with zipfile.ZipFile(os.path.join(OUT, f"{NAME}-gerbers-JLCPCB.zip"), "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(os.listdir(folder)):
            z.write(os.path.join(folder, f), f)


def bom(tmp):
    """Write the BOM; return the board-only designators and each designator's LCSC number."""
    raw = os.path.join(tmp, "bom.csv")
    run("sch", "export", "bom", "--fields", "Value,Reference,Footprint,LCSC,${QUANTITY}",
        "--labels", "Comment,Designator,Footprint,LCSC,Qty", "--group-by", "Value,Footprint,LCSC",
        "--ref-range-delimiter", "", "--exclude-dnp", "-o", raw, SCH)
    board_only, lcsc = set(), {}
    with open(raw, newline="") as src, open(os.path.join(OUT, f"BOM-{NAME}.csv"), "w", newline="") as dst:
        w = csv.DictWriter(dst, fieldnames=["Comment", "Designator", "Footprint", "LCSC", "Qty"])
        w.writeheader()
        for r in csv.DictReader(src):
            refs = [ref.strip() for ref in r["Designator"].split(",")]
            if not r["LCSC"] and r["Footprint"].startswith(BOARD_ONLY_PREFIXES):
                board_only.update(refs)
                continue
            lcsc.update({ref: r["LCSC"].strip() for ref in refs})
            w.writerow(r)
    return board_only, lcsc


def cpl(tmp, board_only, lcsc):
    raw = os.path.join(tmp, "pos.csv")
    run("pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "--exclude-dnp", "-o", raw, PCB)
    turned = 0
    with open(raw, newline="") as src, open(os.path.join(OUT, f"CPL-{NAME}.csv"), "w", newline="") as dst:
        w = csv.writer(dst)
        w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
        for r in csv.DictReader(src):
            if r["Ref"] in board_only:
                continue
            # positions to 0.1 µm first, then the offset: the same figures the earlier two-step script wrote
            x, y, rotation = round(float(r["PosX"]), 4), round(float(r["PosY"]), 4), float(r["Rot"])
            rot = r["Rot"]
            if lcsc.get(r["Ref"]) in JLC_PLACEMENT:
                turn, (cx, cy) = JLC_PLACEMENT[lcsc[r["Ref"]]]
                a = math.radians(rotation)
                # the offset turns with the footprint (KiCad: y down, counter-clockwise as seen); the CPL's y points up
                x += cx * math.cos(a) + cy * math.sin(a)
                y -= -cx * math.sin(a) + cy * math.cos(a)
                rot = f"{(rotation + turn) % 360:.6f}"
                turned += 1
            w.writerow([r["Ref"], f"{x:.4f}mm", f"{y:.4f}mm", "Top" if r["Side"] == "top" else "Bottom", rot])
    print(f"CPL: {turned} parts set for JLCPCB's footprints")


def production():
    check_board()
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    with tempfile.TemporaryDirectory() as tmp:
        gerbers(tmp)
        board_only, lcsc = bom(tmp)
        cpl(tmp, board_only, lcsc)
    for f in sorted(os.listdir(OUT)):
        print(os.path.relpath(os.path.join(OUT, f), HERE), os.path.getsize(os.path.join(OUT, f)), "bytes")


def models():
    """Download each JLCPCB STEP model the board points at (${KIPRJMOD}/3d/<LCSC>.step) that is not in 3d/ yet.
    Git ignores 3d/, so a fresh clone needs this once. Source: the EasyEDA part data (part -> model uuid -> STEP)."""
    with open(PCB) as f:
        wanted = sorted(set(re.findall(r'\(model "\$\{KIPRJMOD\}/3d/(C\d+)\.step"', f.read())))
    os.makedirs(MODEL_DIR, exist_ok=True)
    get = lambda url: urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "tools-production.py"}), timeout=60).read()
    for part in wanted:
        path = os.path.join(MODEL_DIR, f"{part}.step")
        if os.path.exists(path):
            continue
        shapes = json.loads(get(f"https://easyeda.com/api/products/{part}/components?version=6.4.19.5"))[
            "result"]["packageDetail"]["dataStr"]["shape"]
        uuid = next(json.loads(s.split("~", 1)[1])["attrs"]["uuid"] for s in shapes if s.startswith("SVGNODE"))
        step = get(f"https://modules.easyeda.com/qAxj6KHrDKw4blvCG8QJPs7Y/{uuid}")
        if not step.startswith(b"ISO-10303-21"):
            raise SystemExit(f"{part}: EasyEDA did not return a STEP file")
        with open(path, "wb") as f:
            f.write(step)
        print("downloaded", os.path.relpath(path, HERE))
    print(f"3d/: {len(wanted)} models, all present")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "production"
    if mode == "production":
        production()
    elif mode == "models":
        models()
    else:
        raise SystemExit(__doc__)
