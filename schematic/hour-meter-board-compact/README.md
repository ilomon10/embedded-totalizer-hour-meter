# Hour Meter main board, compact (rev B, 80 × 70 mm, 2 layers)

The [rev-B main board](../hour-meter-board/README.md) shrunk to **80 × 70 mm (38 % less area than 100 × 90)** on 2 copper layers. It adds milled isolation slots around the vehicle inputs and the fixes from the [fault analysis](../fault-analysis/README.md). It takes the same plug-on [PSU-B](../hour-meter-psu-b/README.md).

The folder is a KiCad *Save As* copy of [`../hour-meter-board-2layer`](../hour-meter-board-2layer/README.md), so the 100 × 90 mm boards are unchanged. The build, routing and finishing scripts are the main board's; `tools-pcb.py` here runs them with this board's outline, placement and slots.

| | |
|---|---|
| Schematic | `hour-meter-board-compact.kicad_sch` + 8 module sheets: the main board's circuit with the [changes below](#circuit-changes). For the connectors and pin map, see the [main board README](../hour-meter-board/README.md); GPIOs are unchanged |
| PCB | `hour-meter-board-compact.kicad_pcb`: 80 × 70 mm, 2 layers, 115 parts, GND pour on both layers |
| Script | `tools-pcb.py` with `check`, `place`, `route [tries]`, `finish [passes]` or `production` |
| Order files | `production/`: Gerber zip, `BOM-hour-meter-board-compact.csv` (59 lines), `CPL-hour-meter-board-compact.csv` (109 parts) |

**Checks at this revision (2026-10-26):**
- **ERC:** 0 errors, 2 intended warnings (the IMU address straps, as on the main board).
- **DRC:** 0 errors, 0 unconnected items, 0 schematic-parity issues, with the `Vehicle` (0.8 mm), `Power` and `Plane` net classes. The 10 warnings:
  - 8 are silkscreen that the fab clips at an edge: the overhanging module's outline, the optocoupler outlines over their slots, and three references next to a slot;
  - the PSU-B outline on the top silkscreen crosses copper, and the mask clips it there;
  - U201's footprint differs from the copy in KiCad 10's library. Don't update it from the library: check its thermal-pad vias first.
- **Design rules:** from JLCPCB's 1–2 layer template: 0.127 mm default clearance and track, 0.12 mm minimum track, 0.12 mm minimum solder-mask web. That web merges no mask openings between different nets. All of these are within JLCPCB's current limits (0.10 mm tracks, 0.15 mm via holes). The 0.5/0.25 mm vias are standard price.
- **Routing:** Freerouting connected everything and `finish` made 5 thermal reliefs solid. On 2026-10-26 the routing was tidied by hand in KiCad 10, and C602 and C605 next to the IMU were rotated. The two vehicle-input links R302–R303 and R307–R308 keep their 0.8 mm route.
- **Order files:** the Gerbers have 2 copper layers (L1 top, L2 bottom).
- **Stock:** all parts are in JLCPCB stock for 10 boards (checked 2026-10-26).

## Circuit changes

| Part | Change | Why |
|---|---|---|
| U701 | SP3485EN → **THVD2410DR** (C1849398) | Bus pins rated ±70 V (±25 V common mode), same SOIC-8 pinout and firmware. An RS485 wire shorted to the 12 V or 24 V supply no longer destroys the port |
| D701, D702 | PSM712 → **2 × SMAJ33CA** (C115251), A and B to GND | 33 V standoff, so a 24 V system's 28.8 V does not make them conduct; 53 V clamp, below the transceiver's 70 V |
| F802, F803 | **New** 200 mA PTC (C20984) on J804 pin 2 and the GPS 5 V option | A shorted header used to put PSU-B's full 5.5–6.8 A current limit through D101 (a 3 A diode) |
| C802 | **New** 100 nF on +5V, at the SRV05-4 | Design review: +5V had no high-frequency decoupling |
| C208 | **New** 1 µF on USB VBUS, at the USBLC6 | Design review: VBUS had no capacitor at all |
| JP301 | **Removed** (VEH_GND–GND solder jumper) | Its open gap was well under a millimetre, the narrowest point of the isolation barrier. To share grounds, wire J301 pin 3 to a GND terminal (J101-2 or J701-3) |

## Layout

- **ESP32 antenna overhangs the top edge by 6.5 mm** (Espressif's preferred placement). The board then needs no copper-free band beside the antenna. Leave the overhang clear of metal in the enclosure.
- **CR2032 holder (BT401) on the underside**, under the RS485 / RTC area. It hangs below the board by its own height, so check that in the MYOUNG BS-07-A1BJ001 datasheet and choose mounting standoffs at least 2 mm longer.
- **Under PSU-B** (bottom-left, 40 × 30 mm): only low SMD parts (power input, RTC, port passives). J102 and the H101 standoff sit at the same offsets as on the main board, so the same PSU-B plugs in.
- **Mounting:** H102 (top-left, a plain hole inside the isolated corner), H103 (right edge), H104 and H105 (bottom corners), plus H101 for PSU-B.
- **Silkscreen:** parts under 30 mm² and the mounting holes have their references on the fab layer only; the board is too dense for more. Connectors, ICs, switches, jumpers and the battery keep theirs, and the PSU-B outline is on the top silkscreen.

### Isolated vehicle inputs

The opto inputs (J301 and everything up to the optocouplers' LEDs) sit in the top-left corner. The milled slots and the copper rules below separate that corner from the rest of the board:

- **Slots:** 1.5 mm wide, one under each optocoupler between its input and output pins, and one between the vehicle inputs and the RS485 section. JLCPCB mills them as part of the board outline.
- **Bridges:** the board material left between the slots, for strength, carries rule areas where no copper may go. So nothing but the two optocouplers crosses the barrier.
- **No pour:** within 2.5 mm of the barrier, and nowhere in the vehicle corner.
- **Measured on the routed board:** the nearest copper of any other net is 3.3 mm from vehicle-side copper in a straight line; where a slot is in the way, the surface path is longer. Each optocoupler's input and output pins are 9.5 mm apart with the slot between them.

### IMU

- **No copper under the chips:** keep-outs under U601 (MPU-6500) and U602 (LIS3MDL) on both layers, as on the 2-layer board, so no track or via runs under either chip.
- **Distances from the magnetometer:**

  | Part | Distance |
  |---|---|
  | USB-C shell | 24 mm |
  | PSU-B | 25 mm |
  | Screw terminals | 36 mm or more |
  | Coin cell | 13 mm |
  | ESP32 module shield | 9.5 mm |

- **Calibration:** the coin cell and the module shield are closer than the usual 20 mm. Both are static, so the hard-iron calibration after assembly (`esp32/docs/CALIBRATION.md`) removes their offset.

## Before you order

The 2-layer board's [Before you order](../hour-meter-board-2layer/README.md#before-you-order) list applies (GND stitching, USB pair, AMS1117 heat, JLCPCB via sizes). In addition:

1. **Antenna overhang:** the module sticks out 6.5 mm past the board edge. Check the JLCPCB placement preview, and that the enclosure leaves room.
2. **Bottom-side holder:** BT401 is a through-hole part on the underside. Hand-solder it, or order JLC THT assembly for the bottom side.
3. **Slots and rule areas:** if you edit the board, keep the slots, the `BARRIER_*` and `EDGE_*` rule areas, and the IMU keep-outs.
   - Keep the `Vehicle`, `Power` and `Plane` net classes too.
   - Importing settings from a fab template (*Board Setup → Import Settings*) replaces them. The KiCad 5 JLCPCB templates also switch the board to 4 copper layers.
   - Afterwards, check that the board still has **2 copper layers** and that the net classes are there.
4. **Fault limits** that still apply (see the [fault analysis](../fault-analysis/README.md)):
   - **24 V vehicles:** PSU-B does not survive a 24 V vehicle's clamped load dump.
   - **Port data lines:** J801 and J802 are logic-level and not battery-proof.
   - **RS485 jumpers:** with J702/J703 fitted, a supply short burns R704–R706.

## Re-generating the board

```bash
python3 tools-pcb.py check        # overlaps, pins poking into the other side, parts under PSU-B, slots, magnetometer distances
python3 tools-pcb.py place        # placement: PLACEMENT, SLOTS and BRIDGES in tools-pcb.py
python3 tools-pcb.py route 4      # Freerouting x4, keep the best -> GND pours
python3 tools-pcb.py finish 3     # close what Freerouting left open (exit 1 if anything is still open)
kicad-cli pcb drc --severity-all --schematic-parity hour-meter-board-compact.kicad_pcb
python3 tools-pcb.py production   # production/: Gerber zip, BOM, CPL
```
