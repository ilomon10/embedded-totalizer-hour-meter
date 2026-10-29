# Hour Meter main board, Micro-Fit harness (rev B, 80 × 80 mm, 2 layers)

The [I/O board](../hour-meter-board-compact-lm2596-io/README.md), re-laid out for installation in a truck. Every field wire now enters on **one Molex Micro-Fit 3.0 plug**, as on Teltonika trackers, and the board shrinks from 80 × 92 to **80 × 80 mm**. It still has 2 copper layers. The circuits are the I/O board's; the connectors, the layout and a few small parts changed:

- **One harness connector, J1** (Micro-Fit 3.0, 2 × 7, right-angle), replaces the five JST VH headers J101, J301, J701, J801 and J902.
- **Every port on the left edge:** J1, the GPS port (JST GH) and the Qwiic port (JST SH). USB-C and the buttons stay on the right edge.
- **Three indicator LEDs** on the right edge: two process indicators and one free for the program, all green and side-view so they shine through the case wall ([Indicator LEDs](#indicator-leds)).
- **No pin headers left:**
  - the GPS header is a JST GH 6-pin in the Pixhawk pinout;
  - the expansion header became test pads;
  - the jumpers became solder jumpers.
- **Vehicle zone beside J1:** the supply input, the DIN island, and the RS485, UART, AIN1 and DOUT1 front ends.
  - The board GND is the vehicle ground, as on Teltonika trackers.
  - Only DIN1/DIN2 are isolated: optocouplers, in a slotted island.
- **Smaller parts:**
  - the EEPROM is an SOIC-8 (AT24C256C-SSHL-T) that JLCPCB assembles, instead of a DIP-8 in a socket;
  - the TP101/TP102 VIN/GND solder pads are gone.

This folder started as a copy of the I/O board's; that board is unchanged.

| | |
|---|---|
| Schematic | `hour-meter-board-microfit.kicad_sch` + 10 sheets. The new `harness.kicad_sch` holds J1. The power, opto, RS485, IO and ports sheets lost their connectors and reach J1 through sheet pins. The ports sheet also holds the indicator LEDs |
| PCB | `hour-meter-board-microfit.kicad_pcb`: 80 × 80 mm, 2 layers, 146 parts, GND pour on both layers |
| Script | `tools-pcb.py` with `check`, `place`, `reuse`, `route [tries]`, `finish [passes]`, `update`, `silk`, `production` or `models` |
| Order files | `production/`: Gerber zip, BOM and CPL |
| Pinout and ratings | [PINOUT.md](PINOUT.md): every pin's working range and absolute maximum, the supply and the power consumption |
| Firmware | As on the I/O board: AIN1 and DOUT1 still need firmware ([to do](../hour-meter-board-compact-lm2596-io/README.md#firmware-to-do)), and so do the indicator LEDs on GPIO18, GPIO19 and GPIO5. No other GPIO changed |

**Checks at this revision (2026-10-29):**
- **ERC:** 0 errors, 2 intended warnings (the IMU address straps).
- **DRC:** 0 errors, 0 unconnected items, 0 schematic-parity issues. The 5 warnings are silkscreen that the fab clips: the optocoupler outlines over the isolation slots, and the ESP32 outline at the antenna edge.
- **Copper:** 2 layers. The Gerbers have only L1 (top) and L2 (bottom).
- **Net classes:** the I/O board's `Vehicle`, `Power`, `Plane` and Default classes. The patterns follow the nets that now meet J1 on the root sheet (`/VIN_IN`, `/DIN1_RAW`, `/DIN2_RAW`, `/AIN1_RAW`, `/DOUT1`, `/UART_5V`, `/VEH_GND`).
- **Isolation:** the GND pour stays 3.65 mm from the DIN island's copper (I/O board: 3.3 mm). The closest copper is J1's own: 1.5 mm between DIN COM (pin 6) and RS485 A (pin 5), the connector's 3 mm pitch.
- **Magnetometer (U602)** distances, rule of thumb 20 mm:

  | J1 | Coin cell | LM2596 stage | DOUT1 switch | USB-C |
  |---|---|---|---|---|
  | 33.2 mm | 33.6 mm | 51.4 mm | 22.0 mm | 23.9 mm |

- **AIN1 front end:** 28.5 mm from the LM2596 switch node (`check` wants ≥ 8 mm).
- **Order files:** the BOM has 71 lines and the CPL 131 parts. BT401 is the only part on the bottom. R904 (not fitted) is left out of both.
- **Stock:** all parts are in JLCPCB stock for 10 boards (checked 2026-10-29): 33 basic, 2 preferred and 36 extended lines; 34 different extended parts, since one LED part serves all three LEDs. The tightest are J1 (C277677, 462), the BSP75N (621) and the LIS3MDL (1409).
- **JLCPCB check:** the copper and drilling are within JLCPCB's 2-layer limits. The silkscreen is below their legibility minimums, and the CPL is set for their footprints ([JLCPCB check](#jlcpcb-check)).
- **Fault simulations:** the I/O board's [fault analysis](../fault-analysis/README.md) still applies, since the circuits are unchanged. It adds the [J1 harness](../fault-analysis/README.md#micro-fit-harness-j1) (each pin miswired, each pair of neighbouring cavities shorted), the LM2596 input stage and the indicator LEDs.
  - **Weak spots:** DOUT1 (pin 10) sits beside the +5 V output (11) and across from UART TX (3), see [Why this pin order](#j1-harness-connector).
  - **Supply:** the board runs from a 24 → 12 V converter in the trucks, see [Wiring](#j1-harness-connector) and [PINOUT.md](PINOUT.md#supply).
  - **Pulse 1:** a negative ISO 7637-2 pulse 1 drives the 40 V reverse-polarity diode D103 into avalanche. Behind the converter it never sees one. The [fix](../fault-analysis/README.md#what-is-still-open) is for the next revision.
- **Power:** 0.5 W idle, 0.8 W typical, up to about 4 W with every port at its limit (at 12 V: 40 mA, 70 mA, 0.33 A). See [PINOUT.md](PINOUT.md#power-consumption).

## J1 harness connector

| Pin | Signal | | Pin | Signal |
|---|---|---|---|---|
| 1 | GND (battery negative) | | 8 | VIN 9–30 V, from a 12 V system |
| 2 | GND (sensor, UART and RS485 return) | | 9 | AIN1, 0–30 V |
| 3 | UART TX (3.3 V out) | | 10 | DOUT1, 0.5 A low-side switch |
| 4 | UART RX (5 V-tolerant in) | | 11 | +5 V out, 200 mA (F801) |
| 5 | RS485 A | | 12 | RS485 B |
| 6 | DIN COM (isolated return) | | 13 | DIN1 |
| 7 | DIN COM (second return wire) | | 14 | DIN2 |

Looking into J1 from outside the case (latch on top):

```
 14  13  12  11  10   9   8      upper row (pins 8-14)
  7   6   5   4   3   2   1      lower row, next to the PCB (pins 1-7)
```

The same table is printed on the bottom silkscreen, behind J1.

**Harness parts** (one plug per board):

| Part | Molex | LCSC |
|---|---|---|
| Header on the board (JLCPCB assembles it) | 43045-1400 | C277677 |
| Receptacle housing, 2 × 7 | 43025-1400 | C293526 |
| Female crimp terminals, 20–24 AWG (14 per plug) | 43030-0007 | C293530 |
| Crimp tool | 63819-0000, or a Micro-Fit / "MX3.0" ratchet crimper | – |

- **Where to buy:** order the housing and terminals from LCSC with the JLCPCB order; both are in stock (2026-10-29).
- **Local alternative:** in Indonesia, "MX3.0 2×7" housings and terminals from electronics shops mate with the header. No particular local stockist was confirmed.
- **Wire:** 20 AWG for VIN, GND and DOUT1; 22–24 AWG for signals.

**Wiring:**
- **Supply:** VIN (8) from a fused +12 V, with a 1 A fuse at the battery end; GND (1) to the battery negative.
  - **In a 24 V vehicle,** feed VIN from a 24 → 12 V converter rated for 24 V vehicles. On its own the LM2596 stage does not survive a 24 V vehicle's 36 V jump start or 58 V load dump ([fault analysis](../fault-analysis/README.md#results)). The I/O pins take 24 V signals and loads.
  - **Converter:** 12 V out, at least 0.5 A (1 A for margin), non-isolated so the board's GND stays the vehicle ground ([PINOUT.md](PINOUT.md#supply)).
- **DIN1, DIN2:** the signals (9–36 V when active) on 13 and 14, and their return on 6 or 7 (DIN COM).
  - DIN COM is not connected to GND on the board. Wire it to the signals' ground, usually the chassis.
  - The firmware reads DIN1 as the alternator / engine-running input and DIN2 as the pulse counter, as before. See [WIRING.md](../../esp32/docs/WIRING.md).
- **AIN1:** the sensor signal on 9 and its ground on 2. A 5 V sensor takes its supply from 11, which is shared with the UART port: 200 mA in all.
- **DOUT1:** the load between a fused +12/24 V and 10. DOUT1 switches it to GND, up to 0.5 A.
- **RS485:** A on 5, B on 12, the bus ground on 2. Termination and bias are [solder jumpers](#solder-jumpers).
- **UART sensor:** the board's TX on 3, RX on 4, +5 V on 11, GND on 2.
- **Ratings:** each pin's working range, absolute maximum and current are in [PINOUT.md](PINOUT.md).

**Why this pin order:**
- **Vehicle nets on the back row.** VIN, AIN1, DOUT1, DIN1 and DIN2 are on the back (upper) row and leave the header straight into the board.
  - Their 0.8 mm `Vehicle` clearance leaves no room for a track between two of their pads, which are only 1.5 mm apart.
  - So each front-row signal leaves between a back-row pair that holds at most one vehicle net.
- **The isolated group at one end.** DIN1, DIN2 and the two DIN COM pins fill the pin 7/14 end, next to the DIN island. Their neighbours are RS485 A/B, which are rated ±70 V.
- **Pairs sit together:** VIN/GND (8/1), AIN1/GND (9/2), RS485 A/B (5/12), and UART TX/RX (3/4) with +5 V (11).
- **Known weak spot:** DOUT1 (10) sits beside +5 V out (11) and across from UART TX (3).
  - **The risk:** while DOUT1 is off, its load holds pin 10 at the supply. A stray strand there lifts +5V to 6.6–7.1 V or forces GPIO17 above its input limit ([J1 harness faults](../fault-analysis/README.md#micro-fit-harness-j1)).
  - **Fix for the next revision:** swap DOUT1 and AIN1 (9/10). Both are vehicle nets on the back row, so the rule above still holds.

## Other ports

| Ref | Port | Connector (LCSC) | Pins |
|---|---|---|---|
| J802 | GPS | JST GH 6-pin SM06B-GHS-TB (C133065), left edge | Pixhawk GPS pinout: 1 VCC, 2 TX (to the GPS's RX), 3 RX (from the GPS's TX), 4 SCL, 5 SDA, 6 GND. Ready-made Pixhawk GPS cables fit |
| TP801 | GPS PPS | 1 mm solder pad, below J803 | GPIO39 through R805. The 6-pin GH GPS cable has no PPS wire; solder one on if the module brings PPS out |
| J803 | Qwiic | JST SH 4-pin SM04B-SRSS-TB (C160404), left edge | 1 GND, 2 3V3, 3 SDA, 4 SCL |
| J201 | USB-C | right edge | power and the CH340C serial port, as before |
| TP803, TP806–TP808 | spare GPIOs | 1 mm test pads in a row above C104 | IO15, IO33, +3V3, GND. IO15 is a strapping pin: don't pull it low at boot |

- **GPS supply:** JP801 selects 3.3 V (as delivered, 1-2 bridged). Pixhawk-style GPS units need 5 V: cut 1-2 and bridge 2-3, fused by F803 (200 mA).
- **GPS compass:** the GH port's SCL/SDA share the board's I2C bus, so a GPS unit's compass appears on it.

## Indicator LEDs

Three side-view LEDs sit on the right edge, between H103 and H105, with their lenses at the board edge. Their light leaves sideways through the case wall, beside USB-C.

| LED | Label | Colour | GPIO | Use | Part (LCSC) |
|---|---|---|---|---|---|
| D801 | P1 | green | GPIO18 | process indicator | LTST-S270TGKT (C364567) |
| D802 | P2 | green | GPIO19 | process indicator | LTST-S270TGKT (C364567) |
| D803 | USR | green | GPIO5 | free for the program | LTST-S270TGKT (C364567) |

- **One colour:** all three are the green LTST-S270TGKT. Its JLCPCB footprint and 3D model face the same way as the KiCad footprint, so the lenses face the edge. The yellow and blue parts' models disagreed ([JLCPCB check](#jlcpcb-check)).
- **Drive:** active high (GPIO = 1: LED on), 1.7 mA each through 330 Ω ([fault analysis](../fault-analysis/README.md#results)).
- **GPIO5** is a strapping pin, but only for the SDIO-slave timing, which this board doesn't use. The USR LED may flicker while the ESP32 boots.
- **Unchanged:** the PWR and STATUS (GPIO2) LEDs on the top side stay as before.
- **Firmware:** the three GPIOs were spare test pads; the firmware does not drive them yet.

## Solder jumpers

| Jumper | Function | As delivered | Change it when |
|---|---|---|---|
| JP702 | RS485 120 Ω termination (A to B) | open | the board is at one end of the bus: bridge it |
| JP703 + JP704 | RS485 bias: A to 3.3 V and B to GND, 330 Ω each | open | nothing else on the bus biases it: bridge both, on one node only |
| JP501 | EEPROM write protect | open (writes on) | bridge it to lock the EEPROM |
| JP801 | GPS supply | 1-2 bridged (3.3 V) | for a 5 V GPS: cut 1-2, bridge 2-3 |

JP702–JP704 are stacked beside U701, and the legend under them names each one.

## Layout

- **Vehicle zone (left):**
  - J1 on the left edge, its mating face 0.5 mm inside the board edge.
  - The DIN island in the top-left corner, beside J1's pin 7/14 end. It has milled slots under the optocouplers and along its lower edge, and no pour. Barrier rule areas keep copper off the board material left between the slots.
  - Beside J1's other pins: the RS485 clamps and transceiver, the 5 V fuse, the AIN1 pulse capacitor, and the BSP75N with its drain facing J1, so the 0.5 A DOUT1 loop stays at the connector.
  - Below J1: the VIN fuse and the reverse-polarity diode, the UART/GPS ESD array, and the GPS and Qwiic ports with their resistors.
  - Along the bottom edge: the LM2596 stage.
- **Logic zone (right):**
  - the ESP32 module, with its antenna past the top edge;
  - between the island and the module: the IMU;
  - then the EEPROM, the AIN1 divider + ADS1115, the RS485 pull-ups and the RTC;
  - on the right edge: USB-C, the CH340C, the buttons and, below H103, the three indicator LEDs.
- **Unchanged blocks:** the ESP32/USB block, the IMU and the LM2596 stage keep the I/O board's placement and routing (see `reuse` below).
- **Coin cell:** BT401 is on the bottom side, in the bottom-right corner.

## Enclosure

- **Material: plastic, not aluminium.** The ESP32's antenna is on the PCB and overhangs the top edge.
- **Board and heights:**

  | | |
  |---|---|
  | Board | 80 × 80 mm |
  | Tallest part above | 10 mm (C102) |
  | Tallest part below | 7.5 mm (the CR2032 holder) |
  | J1's pin ends below | 3.2 mm |

  Plan on an inside of at least 90 × 90 × 25 mm, with the board on ≥ 8 mm standoffs.
- **Mounting:** M3 holes in three corners (H102, H104, H105) and on the right edge (H103, 48 mm below the top-right corner, which the antenna occupies).
- **Cut-outs:**
  - left wall: about 25 × 10 mm for J1, with the GH and SH ports below it on the same wall;
  - right wall: about 10 × 4 mm for USB-C, and three 2 mm holes (or light pipes) for the LEDs. The holes sit 59, 64 and 69 mm below the board's top edge, at the board's top surface: the LED lenses are 0.6 mm tall.
- **Example cases:**
  - an ABS box the size of the Hammond 1591XXG (about 120 × 95 × 37 mm outside). Check its drawing for the inside size and the standoff positions.
  - a local IP65 ABS junction box of about 100 × 100 × 50 mm, with the board on its mounting plate.

## Before you order

The [LM2596 board's notes](../hour-meter-board-compact-lm2596/README.md#before-you-order) apply:
- Standard PCBA on both sides, since BT401 is on the bottom;
- all through-hole parts selected (J1 and BT401);
- the tooling-rail remark for the antenna overhang;
- **Order Number → Specify Position**.

In addition:
1. **R904 is not fitted.** It is left out of the BOM and CPL. Hand-solder a 120 Ω 0.1 % 1206 resistor for a 4–20 mA sensor.
2. **The harness plug is not part of the assembly.** Add the 43025-1400 housing and the 43030-0007 terminals to the LCSC order (see the [harness parts](#j1-harness-connector)).
3. **In the placement preview,** check that the LED lenses face the right edge and BT401's + clip sits on pin 1 (below). The CPL already carries JLCPCB's rotations.

### JLCPCB check

Checked on 2026-10-29 against [JLCPCB's PCB capabilities](https://jlcpcb.com/capabilities/pcb-capabilities) and [assembly capabilities](https://jlcpcb.com/capabilities/pcb-assembly-capabilities), for 2 layers, 1.6 mm and 1 oz copper. The hole and clearance limits ran as KiCad custom rules on a scratch copy of the board.

**Fabrication:**

| Item | JLCPCB | This board |
|---|---|---|
| Track width, spacing | 0.10 mm, 0.10 mm | 0.10 mm (one neck-down; most are 0.15–0.5 mm), 0.15 mm |
| Vias | 0.15 mm hole minimum. Under 0.3 mm with a pad under 0.45 mm costs extra | 0.25 / 0.50 mm and 0.40 / 0.80 mm: standard price |
| Through-hole annular ring | 0.20 mm (0.18 absolute, 0.25 recommended) | 0.20 mm (USB-C shell, ESP32 GND-pad vias); J1 0.24 mm |
| Holes | PTH 0.15 mm, NPTH 0.5 mm | PTH 0.20 mm (the ESP32's GND-pad vias), NPTH 0.65 mm (USB-C pegs) |
| Slots | plated 0.5 mm wide and 2 × as long; milled 1.0 mm | USB-C shell 0.6 × 1.2 / 0.6 × 1.7 mm; DIN island 1.5 mm |
| Hole to hole, hole to copper | pads 0.45 mm, vias 0.2 mm; PTH to copper 0.28 mm | no violation |
| Copper to board edge | 0.2 mm | 0.3 mm (board rule) |
| Board size for Standard PCBA | 70 × 70 mm minimum | 80 × 80 mm |
| Silkscreen text | 1.0 mm high, 0.15 mm stroke | **45 texts are 0.8 mm high:** 22 reference designators, the J1 pinout and the board labels. 39 of them have 0.12 mm strokes |
| Silkscreen lines | 0.15 mm | **0.12 mm** (KiCad's library footprints) |

The silkscreen is still printed, but small text can come out blurred. Raising it to 1.0 mm means re-placing labels in the tight spots, so it is left as is.

**Assembly:**
- **CPL rotations:** JLCPCB places each part with its own footprint. `production` turns or re-centres 21 parts to match (`JLC_PLACEMENT` in `tools-pcb.py`):
  - SOT-23, SOT-223, SC-70 and TO-263: 180°;
  - SOIC, VSSOP, QFN, LGA and the ESP32: 270°;
  - J1's centroid moves 9.1 mm from pin 1 to the body centre, BT401's 10.4 mm, U201's 3.6 mm, U101's 2.5 mm and the USB-C's 1.6 mm.
- **How they were found:** each part's pads were fitted onto JLCPCB's footprint for the same LCSC part.
  - Diodes and LEDs were matched by pin name, not pad number: JLCPCB's SS54 (D103, D105) and 0603 LEDs number the anode 1.
  - So D103, D105 and the 0603 LEDs need no turn, though a number match would have reversed them.
- **Polarity:** every diode and LED keeps its cathode on the KiCad cathode pad. Check the cathode marks in the preview anyway.
- **Side-view LEDs (D801–D803):** all three are the green LTST-S270TGKT.
  - Its JLCPCB 3D model has the body on the same side of the pads as the KiCad footprint's lens, and its cathode on pad 1.
  - The yellow (LTST-S270KSKT) and blue (LTST-S270TBKT) parts first chosen for D802 and D803 had models with the body on the other side. One colour avoids that doubt.
- **BT401 (bottom, through-hole):** placed at the midpoint of its pins, turned 270°. Check in the preview that its + clip sits on pin 1 (RTC_VBAT).
- **Switches (SW201, SW202):** JLCPCB's footprint has the same four pads as the KiCad footprint, unturned, so they keep KiCad's rotation.

## Re-generating the board

```bash
python3 tools-pcb.py check        # overlaps, slots, island, supply strip, AIN1-to-LM_SW and magnetometer distances
python3 tools-pcb.py place        # placement: PLACEMENT, SLOTS, BRIDGES, VEHICLE_AREA and SUPPLY_AREA in tools-pcb.py
python3 tools-pcb.py reuse        # the I/O board's routing of the unchanged blocks, + GND pours
JAVA_TOOL_OPTIONS=-Xmx1536m python3 tools-pcb.py finish 3   # Freerouting routes the rest, then plane vias and clean-up
python3 tools-pcb.py silk         # silkscreen labels and reference positions on the routed board
kicad-cli pcb drc --severity-all --schematic-parity --refill-zones hour-meter-board-microfit.kicad_pcb
python3 tools-pcb.py production   # production/: Gerber zip, BOM, CPL set for JLCPCB's footprints (Do-Not-Populate parts left out)
python3 tools-pcb.py models       # JLCPCB 3D models into 3d/ (once per checkout), set on the board
```

- **What `reuse` does:**
  - It copies the I/O board's tracks for the blocks that sit at the same coordinates. The shift is measured on U601.
  - KiCad's DRC then removes every copied piece that clashes with this layout.
  - On the I/O board, copied routing was what got the IMU's +3V3 pins connected.
- **Freerouting varies from run to run:**
  - The committed routing came from the second rip-up pass after `reuse`: 0 open, 0 errors.
  - A `finish 3` run from the same start stopped at 20 open. If `finish` leaves connections open, run it again.
- **Hand fix:** a dead-end GPS_VCC track at JP801 was deleted after routing.
- **Small schematic changes:** `update` adds and removes parts on the routed board, and takes up the tracks of the nets in `UPDATE_RIP`. Then `finish` routes only what is open. How the indicator LEDs went in:
  1. `update`. GPIO5/18/19 kept their routes to where their test pads were.
  2. `finish 3` routed all of them but GPIO18.
  3. One Freerouting pass that ripped up GPIO18 and I2C_SDA together. I2C_SDA had taken the right-edge strip while it was empty.
  4. That pass also broke a VEH_GND link in the DIN island, which was copied back from the board before it.
  5. `finish 0` and `silk`.
- **The board file was moved in KiCad** by (18.20, −48.27) mm on 2026-10-29, and the bottom-silkscreen pinout was split into two columns. Both edits are kept: `add_pinout` now draws the two columns. `route`, `finish`, `update` and `silk` measure the move on U601 and shift the layout to match. `place` and `check` work in the script's own coordinates.
- **Scratch scripts:** load the board from its real path. Loading a copy from `routing/` and saving it over the board writes default project settings into the `.kicad_pro`, and the net classes are lost.

## 3D models

`python3 tools-pcb.py models` downloads the JLCPCB/EasyEDA STEP files into `3d/` (source: JLCEDA/EasyEDA official library).
- **J1:** KiCad 10 has no model for the Micro-Fit header, so it uses JLCPCB's (C277677), fitted to the footprint's pads.
- **GH and SH ports, SOIC-8 EEPROM:** KiCad's library models.
