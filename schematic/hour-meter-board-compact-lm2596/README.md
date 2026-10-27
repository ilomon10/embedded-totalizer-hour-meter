# Hour Meter main board, compact + LM2596 (rev B, 80 × 80 mm, 2 layers)

The [compact board](../hour-meter-board-compact/README.md) with its 5 V supply **on the board**. A cheap LM2596S-ADJ buck converter replaces the plug-on [PSU-B](../hour-meter-psu-b/README.md), so it is one board: no PSU socket, no standoff, nothing to plug in. The board grows by a 10 mm strip along the bottom edge, from 80 × 70 to **80 × 80 mm**, and keeps 2 copper layers.

The folder is a KiCad *Save As* copy of `../hour-meter-board-compact`, so that board is unchanged. Everything except the power input is the same circuit, placement and isolation design; see the [compact board README](../hour-meter-board-compact/README.md) for the slots, the IMU keep-outs and the circuit changes from the fault analysis.

| | |
|---|---|
| Schematic | `hour-meter-board-compact-lm2596.kicad_sch` + 8 module sheets. Only `power-input.kicad_sch` differs: J102 and H101 are gone and the LM2596 stage is added. GPIOs and the firmware are unchanged |
| PCB | `hour-meter-board-compact-lm2596.kicad_pcb`: 80 × 80 mm, 2 layers, 126 parts, GND pour on both layers |
| Script | `tools-pcb.py` with `check`, `place`, `route [tries]`, `finish [passes]` or `production` |
| Order files | `production/`: Gerber zip, BOM and CPL |

**Checks at this revision (2026-10-27):**
- **ERC:** 0 errors, 2 intended warnings (the IMU address straps, as on the compact board).
- **DRC:** 0 errors, 0 unconnected items, 0 schematic-parity issues. The 8 warnings are silkscreen that the fab clips at an edge or a slot, as on the compact board.
- **Design rules:** the compact board's `Vehicle`, `Power` and `Plane` net classes; `VIN_LM` and `LM_SW` are in `Power`. The Default class is 0.15 mm clearance and 0.2 mm track, not the JLCPCB template's 0.127 mm: with 0.127 mm, Freerouting left 0.095 mm neck-downs and hundreds of clearance errors on this denser board.
- **Isolation:** the nearest copper of any other net is 4.4 mm from vehicle-side copper. The optocouplers keep 9.5 mm between their input and output pins, and there is still no copper under U601 or U602.
- **Routing:** Freerouting, then `finish`. The last open nets (USB VBUS and the UART lines) were ripped up and re-routed, and J101's GND pads connect solidly to the pour.
- **Order files:** the Gerbers have 2 copper layers (L1 top, L2 bottom). The BOM has 68 lines and the CPL 121 parts, 1 of them on the bottom (BT401).
- **Stock:** all parts are in JLCPCB stock for 10 boards (checked 2026-10-27): 30 basic, 1 preferred and 32 extended part types.

## Supply

From the LM2596 datasheet's typical application (adjustable output):

```
J101 9-30 V ─ F101 PTC ─ VIN_RAW ─ D103 SS54 ─ VIN_LM ─┬─ U101 LM2596S-ADJ ─ LM_SW ─ L101 33 µH ─ +5V_PSU ─ D101 SS34 ─ +5V
                                                      D104 SMAJ30CA, C102 220 µF/50 V, C103 100 nF        │
                                                                   D105 SS54 (catch)   C104 220 µF, C105 100 nF, R103/R104, D106
```

| Part | Value | JLCPCB | Why |
|---|---|---|---|
| U101 | LM2596S-ADJ (UMW), TO-263-5 | C347423 | 4.5–40 V in, 3 A, 150 kHz; the cheap, well-stocked regulator of the LM2596 modules |
| D103 | SS54, 40 V 5 A | C22452 (basic) | Reverse-polarity block |
| D104 | SMAJ30CA | C110043 | 30 V standoff (the top of the input range), clamps spikes before they reach the 40 V regulator |
| C102, C103 | 220 µF/50 V (10 × 10 mm) + 100 nF/50 V | C2887271, C14663 | Input capacitors, next to U101's VIN and GND pins |
| D105 | SS54 | C22452 (basic) | Catch diode |
| L101 | 33 µH, 3 A, 12 × 12 mm shielded (SMDRI127-330MT) | C9400 | Datasheet value for this load range |
| C104, C105 | 220 µF/16 V + 100 nF | C2887273, C14663 | Output capacitors |
| R103 / R104 | 3.3 k / 1 k | C22978, C21190 (basic) | V<sub>OUT</sub> = 1.23 V × (1 + 3.3/1) = **5.29 V**. The SS34 OR-diode D101 then leaves about 4.9 V on +5V, as with PSU-B |
| D106 + R105 | red LED, 2.2 k | C2286, C4190 | Supply indicator |

USB-C still powers the whole board for bench work through D201. D101 keeps the regulator from being fed back from USB.

### Input limits

- **12 V vehicles:** fine from 9 V up. A 12 V vehicle's clamped load dump (about 35 V) stays under the 40 V regulator rating.
- **24 V vehicles:** feed the board from a **12 V converter rated for 24 V vehicles** (the plan for the trucks). On its own the 40 V LM2596S does **not** survive a 24 V vehicle's load dump (58–65 V), and a 24 V system's 28.8 V charging voltage is close to the TVS standoff.
- **Not proven by simulation** like PSU-B: the [fault analysis](../fault-analysis/README.md) covers PSU-B only.

## Layout

- **Supply strip (bottom edge, `SUPPLY_AREA` in `tools-pcb.py`):**
  - C102 → U101 (its pins face C102) → D105 → L101, then C104 above L101.
  - The FB divider sits right under U101's pins.
  - The TO-263 tab (GND) sits on the GND pour.
- **Magnetometer:** L101 and U101 are 51 mm from the LIS3MDL. The rule of thumb is 20 mm.
- **Moved 10 mm down with the new edge:** the bottom mounting holes H104 and H105, and the UART connector J801.
- **Unchanged:** everything else, including the isolated vehicle corner and its slots.

## Before you order

The compact board's [Before you order](../hour-meter-board-compact/README.md#before-you-order) and [Ordering it assembled](../hour-meter-board-compact/README.md#ordering-it-assembled-jlcpcb) notes apply here too:
- Standard PCBA on both sides;
- all through-hole parts selected, and U501 soldered without a socket;
- the tooling-rail remark for the antenna overhang;
- **Order Number → Specify Position**: `JLCJLCJLCJLC` is on the bottom silkscreen.

In addition:

1. **Bring-up:** power the board from a current-limited 12 V supply with the ESP32 idle. +5V should read about 4.9 V. Then check that U101 and L101 stay cool at the ESP32's Bluetooth peaks.
2. **If the regulator whines or +5V ripples**, check that C102 and C104 are the low-ESR parts in the BOM.

## Re-generating the board

```bash
python3 tools-pcb.py check        # overlaps, slots, supply strip, magnetometer distances
python3 tools-pcb.py place        # placement: PLACEMENT, SLOTS, BRIDGES and SUPPLY_AREA in tools-pcb.py
python3 tools-pcb.py route 8      # Freerouting, best of 8 tries -> GND pours
python3 tools-pcb.py finish 3     # close what Freerouting left open
kicad-cli pcb drc --severity-all --schematic-parity --refill-zones hour-meter-board-compact-lm2596.kicad_pcb
python3 tools-pcb.py production   # production/: Gerber zip, BOM, CPL
```
