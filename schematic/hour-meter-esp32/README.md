# Hour Meter ESP32: carrier PCB (rev A)

A 130 × 100 mm, 2-layer, through-hole carrier board. The ESP32 DevKit and the sensor modules plug into sockets, the 817 module and the LM2596 module mount on it, and vehicle wires go to screw terminals.

| | |
|---|---|
| Schematic | `hour-meter-esp32.kicad_sch` (PDF: `hour-meter-esp32.pdf`, picture: `hour-meter-esp32.png`) |
| PCB | `hour-meter-esp32.kicad_pcb` (pictures: `hour-meter-esp32-pcb.png`, `hour-meter-esp32-3d.png`) |
| Ready to order | `production/hour-meter-esp32-gerbers-JLCPCB.zip` (Gerbers + drill), `production/hour-meter-esp32-bom.csv` |
| Custom parts | `hour-meter-modules.kicad_sym` (symbols), `hour-meter-modules.pretty/` (footprints) |
| Wiring notes | [`esp32/docs/WIRING.md`](../../esp32/docs/WIRING.md) |

**Checks at release:** ERC 0 errors and 0 warnings; DRC 0 errors, 0 warnings, 0 unconnected, 0 schematic mismatches; Konnect JLCPCB pre-flight READY.

## ⚠ Measure before you order

The module footprints use **typical clone dimensions**. Check them against your parts with calipers. Open `hour-meter-modules.pretty/` in the KiCad footprint editor, or edit the numbers in `tools-gen-footprints.py`.

| Part | Assumed | Check |
|---|---|---|
| ESP32 DevKit V1 30-pin | 2 × 15 pins, **rows 25.4 mm apart** | Some 30-pin boards use 22.86 mm. Measure pin-row to pin-row |
| 817 module | 38 × 29 mm board, 4 × M3 holes 3 mm from the corners | Hole positions; it mounts on standoffs and is wired from its screw terminals to the `IN` / `OUT` pads |
| LM2596 module | 43 × 21 mm, pads 38.1 mm × 15.24 mm apart | Pad positions vary a lot between clones |
| GY-9250 (MPU9250) | 10 pins in a row, board lies flat toward +X | Lies flat with its chip facing up, so the firmware's "z up" holds |
| DS3231 ZS-042 | 6-pin socket, module stands upright | |
| AT24C256 | 5-pin socket (VCC GND SCL SDA WP) | Many boards have a 4-pin header plus a WP jumper. Leave pin 5 empty and set WP with the jumper |
| F1 | MF-R050 (60 V) on the MF-RHT050 footprint | Lead spacing is about 5.1 mm on both; check your part |

## Ordering (JLCPCB)

Upload `production/hour-meter-esp32-gerbers-JLCPCB.zip`. Settings: 2 layers, 1.6 mm, HASL (lead-free), 1 oz copper, any colour. No assembly is needed: all parts are through-hole and hand-soldered (BOM in `production/`).

## Assembly order

1. Low parts first: D1–D4, R4–R7, C1–C2, F1.
2. Then C3 (mind the polarity), the screw terminals J1/J2/J4, header J3, and the female sockets.
3. **Power test without modules:** fit M5 (LM2596), apply 12/24 V to J4, and **turn the trimmer until OUT+ reads 5.0 V**. Only then fit the ESP32.
4. Mount the 817 module on standoffs, **remove both G jumpers**, and wire IN1/G/IN2/G and V1/V2/G/G to the pads.
5. Plug in the ESP32 (antenna toward the board edge, USB toward the "USB" mark), DS3231, AT24C256 and MPU9250.

## Design notes

- **Isolation:** the vehicle-input area (J1, J2, D1/D2, R4/R6, 817 inputs) has no ground pour, and its nets use 0.8 mm clearance (`Vehicle` netclass). Ground pours cover the rest of the board on both layers.
- **Power:** 12/24 V → F1 PTC → D3 (reverse polarity) → D4 TVS + C3 → LM2596 → +5 V → ESP32 VIN. Power traces are 0.8 mm (`Power` netclass).
- **Antenna:** the area under the ESP32 antenna is a copper keep-out.
- **Grounds:** if J4's ground and the vehicle ground are the same chassis (usual), the 817 module still protects the GPIOs from spikes, but the grounds are no longer isolated. See WIRING.md.

## Re-generating after a change

The board is produced by scripts, so a change is three commands:

```bash
python3 tools-gen-footprints.py      # 1. footprints (after editing dimensions)
python3 tools-build-pcb.py place     # 2. netlist -> footprints -> placement (edit PLACEMENT for positions)
python3 tools-route-pcb.py           # 3. keep-outs -> Freerouting -> GND pours
```

Then run DRC in KiCad (or `kicad-cli pcb drc`) and re-export the Gerbers. Freerouting is not deterministic, so a re-run gives slightly different traces.

To adjust by hand instead, open `hour-meter-esp32.kicad_pro` in KiCad, move parts, and re-route with the interactive router. The scripts are only needed for a full regeneration.
