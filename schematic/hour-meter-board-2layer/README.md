# Hour Meter main board, 2-layer variant (rev B)

This is the [rev-B main board](../hour-meter-board/README.md) routed on **2 copper layers** instead of 4, for a cheaper PCB. The circuit, parts, BOM and placement are the same; only the copper layers and the routing differ. It takes the same plug-on [PSU-B](../hour-meter-psu-b/README.md).

The folder is a copy of `../hour-meter-board`, made the way KiCad's *File → Save As* makes one, so the 4-layer design is unchanged. The build, routing and finishing scripts are the main board's: `tools-pcb.py` here runs them on this folder's files with 2 layers.

| | |
|---|---|
| Schematic | `hour-meter-board-2layer.kicad_sch` + the 8 module sheets: a copy of the main board's, with the same netlist. For the circuit, connectors, jumpers and pin map, see the [main board README](../hour-meter-board/README.md) |
| PCB | `hour-meter-board-2layer.kicad_pcb`: 100 × 90 mm, 2 layers. F.Cu and B.Cu both carry tracks and a GND pour |
| Script | `tools-pcb.py` with `check`, `place`, `route [tries]`, `finish [passes]` or `production` |
| Order files | `production/`: Gerber zip, `BOM-hour-meter-board-2layer.csv`, `CPL-hour-meter-board-2layer.csv` (JLCPCB columns). The BOM and CPL are byte-identical to the 4-layer board's, so assembly is the same; only the bare PCB differs |

**Checks at this revision (2026-10-21):**
- **ERC:** same schematic as the main board: 0 errors, 2 intended warnings.
- **DRC:** 0 errors, 0 unconnected items, 0 schematic-parity issues. The 22 warnings are the same silkscreen ones as on the 4-layer board.
- **Routing:** with the IMU keep-outs in place, Freerouting's first try connected everything, so `finish` had nothing left to do.
- **Stock:** all parts are in JLCPCB stock for 10 boards.

## What changes with 2 layers

| | 4 layers (`hour-meter-board`) | 2 layers (this board) |
|---|---|---|
| GND | Solid In1.Cu plane; GND pads drop to it through vias | Routed as tracks, plus a GND pour on F.Cu and on B.Cu |
| +3V3 | Pour on In2.Cu | Routed as tracks (Plane netclass, 0.3 mm) |
| Signal layers | F.Cu, In2.Cu, B.Cu | F.Cu, B.Cu |
| Under the IMU (U601, U602) | In1.Cu GND plane shields the chips from the tracks below | Keep-outs on both layers: no tracks or vias, GND pour only (see below) |
| Silkscreen | `HOUR METER rev B` | `HOUR METER rev B`, plus `2-LAYER` to its left |

Unchanged: the outline, placement, parts, netclasses, via sizes (0.5/0.25 mm; 0.8/0.4 mm on power and vehicle nets), the copper keep-out under the antenna, and no pour on the vehicle side.

**IMU keep-outs.** The MPU-6500 datasheet prohibits routing under the package. It also asks for no active signals on unshielded layers directly below the gyro, because its drive frequencies (24–30 kHz) can couple in. With only 2 layers nothing shields B.Cu, so `tools-pcb.py place` adds rule areas under U601 and U602 (the LIS3MDL magnetometer gets the same treatment):
- **F.Cu:** the space inside the pad ring.
- **B.Cu:** the package plus 0.5 mm.

They keep tracks and vias out, but let the GND pours in. Keep them if you re-route by hand; KiCad's DRC flags anything that enters them.

## Before you order

The main board's [Before you order](../hour-meter-board/README.md#before-you-order) list applies here too. In addition:

1. **GND return paths.** Without a plane, tracks cut the GND pours into pieces that are joined by vias and the other layer's pour. DRC confirms GND is fully connected, but the paths can be long.
   - **Main split:** on B.Cu, a bundle of tracks running down from the ESP32 module to the ports (x ≈ 170–178 mm) divides the pour.
   - **What to do:** look at both pours in KiCad and add stitching vias along that bundle and wherever a piece hangs on a narrow neck, mainly around the ESP32, the USB parts (J201, U203, U202) and the IMU.
2. **USB D+/D−.** On a 1.6 mm 2-layer board, a 90 Ω pair would need traces about 1 mm wide. Keep the pair short, side by side and over unbroken GND on the other layer instead; at 12 Mbit/s that is enough.
3. **AMS1117 heat.** U204's tab has no +3V3 plane to spread heat into. If the ESP32 transmits a lot, give the tab more +3V3 copper.
4. **JLCPCB order:** 2 layers, 1.6 mm.
   - **Smallest holes:** the 0.25 mm routed vias (0.5 mm pad) and the ESP32's 0.2 mm thermal-pad vias (0.6 mm pad).
   - **Via price:** JLCPCB's [capabilities page](https://jlcpcb.com/capabilities/pcb-capabilities) (checked 2026-10-21) allows 0.15 mm via holes on 2-layer boards. It charges extra for a 0.2–0.25 mm hole only when the via is under 0.45 mm across, so these vias should be standard price. Check the price after you choose the via option on the order form.

## Re-generating the board

```bash
python3 tools-pcb.py place        # placement: PLACEMENT in ../hour-meter-board/tools-build-pcb.py
python3 tools-pcb.py route 4      # Freerouting x4, keep the best -> GND pours
python3 tools-pcb.py finish 3     # close what Freerouting left open (exit 1 if anything is still open)
kicad-cli pcb drc --severity-all --schematic-parity hour-meter-board-2layer.kicad_pcb
python3 tools-pcb.py production   # production/: Gerber zip, BOM, CPL
```

## Compact variant

[`../hour-meter-board-compact`](../hour-meter-board-compact/README.md) is a copy of this board on 80 × 70 mm. It also has milled isolation slots and the fault fixes from [`../fault-analysis`](../fault-analysis/README.md): a fault-protected RS485 transceiver and fused 5 V header pins.

## Keeping the two boards in step

- **Schematic:** this one is a copy, so a circuit change has to go into both. To check they still match, export each netlist with `kicad-cli sch export netlist` and diff them.
- **Placement:** a change to `PLACEMENT` in `../hour-meter-board/tools-build-pcb.py` moves parts on both boards the next time each one is placed.
