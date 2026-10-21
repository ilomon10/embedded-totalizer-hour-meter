#!/usr/bin/env python3
"""Write the JLCPCB order files for a board into <project>/production/, with kicad-cli.

  python3 tools-production.py                                      # this main board
  python3 tools-production.py ../hour-meter-psu-b/hour-meter-psu-b.kicad_pcb

Writes <name>-gerbers-JLCPCB.zip (Gerbers + Excellon drill), BOM-<name>.csv
(Comment, Designator, Footprint, LCSC, Qty) and CPL-<name>.csv (Designator, Mid X, Mid Y,
Layer, Rotation). Board-only parts (holes, solder jumpers) are left out of the BOM and CPL.
Check the rotations in JLCPCB's placement preview before ordering; the CPL is KiCad's.
"""
import csv
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
BOARD_ONLY_PREFIXES = ("MountingHole:", "TestPoint:", "Fiducial:", "Jumper:SolderJumper")
INNER = {2: [], 4: ["In1.Cu", "In2.Cu"]}


def run(*args):
    subprocess.run(["kicad-cli", *args], check=True, capture_output=True)


def copper_layers(pcb):
    with open(pcb) as f:
        text = f.read(20000)   # the (layers ...) table sits near the top of the file
    return 4 if '"In1.Cu"' in text else 2


def main():
    pcb = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "hour-meter-board.kicad_pcb"))
    sch = os.path.splitext(pcb)[0] + ".kicad_sch"
    name = os.path.splitext(os.path.basename(pcb))[0]
    out = os.path.join(os.path.dirname(pcb), "production")
    shutil.rmtree(out, ignore_errors=True)   # a fresh directory: no stale file can pass as current
    os.makedirs(out)

    with tempfile.TemporaryDirectory() as tmp:
        gerbers = os.path.join(tmp, "gerbers")
        os.makedirs(gerbers)
        layers = ["F.Cu", *INNER[copper_layers(pcb)], "B.Cu", "F.Mask", "B.Mask", "F.Paste", "B.Paste",
                  "F.SilkS", "B.SilkS", "Edge.Cuts"]
        run("pcb", "export", "gerbers", "--no-protel-ext", "--layers", ",".join(layers), "-o", gerbers + "/", pcb)
        run("pcb", "export", "drill", "--format", "excellon", "--excellon-separate-th", "-o", gerbers + "/", pcb)
        with zipfile.ZipFile(os.path.join(out, f"{name}-gerbers-JLCPCB.zip"), "w", zipfile.ZIP_DEFLATED) as z:
            for f in sorted(os.listdir(gerbers)):
                z.write(os.path.join(gerbers, f), f)

        bom = os.path.join(tmp, "bom.csv")
        run("sch", "export", "bom", "--fields", "Value,Reference,Footprint,LCSC,${QUANTITY}",
            "--labels", "Comment,Designator,Footprint,LCSC,Qty", "--group-by", "Value,Footprint,LCSC",
            "--ref-range-delimiter", "", "-o", bom, sch)
        with open(bom, newline="") as src, open(os.path.join(out, f"BOM-{name}.csv"), "w", newline="") as dst:
            rows = list(csv.DictReader(src))
            w = csv.DictWriter(dst, fieldnames=["Comment", "Designator", "Footprint", "LCSC", "Qty"])
            w.writeheader()
            board_only = set()
            for r in rows:
                if not r["LCSC"] and r["Footprint"].startswith(BOARD_ONLY_PREFIXES):
                    board_only.update(r["Designator"].split(","))
                    continue
                w.writerow(r)

        pos = os.path.join(tmp, "pos.csv")
        run("pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "-o", pos, pcb)
        with open(pos, newline="") as src, open(os.path.join(out, f"CPL-{name}.csv"), "w", newline="") as dst:
            w = csv.writer(dst)
            w.writerow(["Designator", "Mid X", "Mid Y", "Layer", "Rotation"])
            for r in csv.DictReader(src):
                if r["Ref"] in board_only:
                    continue
                w.writerow([r["Ref"], f'{float(r["PosX"]):.4f}mm', f'{float(r["PosY"]):.4f}mm',
                            "Top" if r["Side"] == "top" else "Bottom", r["Rot"]])

    for f in sorted(os.listdir(out)):
        print(os.path.join(out, f), os.path.getsize(os.path.join(out, f)), "bytes")


if __name__ == "__main__":
    main()
