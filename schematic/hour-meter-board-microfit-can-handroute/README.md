# Hour Meter main board, Micro-Fit + CAN + RS232: hand-routing copy

A copy of the [Micro-Fit + CAN + RS232 board](../hour-meter-board-microfit-can/README.md) for routing by hand. It holds that board's schematic, parts and placement as of 2026-11-02, after the second round of hand edits, with every track and via removed. The routed board is unchanged, and nothing done here flows back to it.

| | |
|---|---|
| Schematic | `hour-meter-board-microfit-can-handroute.kicad_sch` (block diagram) + 17 module sheets, one per PCB group: the same circuit, 152 parts and 141 nets |
| PCB | `hour-meter-board-microfit-can-handroute.kicad_pcb`: 100 × 100 mm, 2 layers, routed by hand, audited and fixed on 2026-11-04 ([Audit and fixes](#audit-and-fixes)) |
| Order files | `production/`: Gerber zip, BOM and CPL for JLCPCB ([Ordering](#ordering)) |
| Design notes | the routed board's [README](../hour-meter-board-microfit-can/README.md) and [PINOUT.md](../hour-meter-board-microfit-can/PINOUT.md) |
| Bring-up | [BRINGUP.md](BRINGUP.md): first power-on of a new board and a check of every module |

## Reading the schematic

The schematic was redrawn on 2026-11-02 so each module can be read on its own. The circuit did not change.

- **Top sheet:** a block diagram laid out like the board.
  - J1 is on the left, the field modules beside it, the ESP32 in the middle, and the I2C devices, LEDs and GPS on the right.
  - Each block is one module and has the same name as its group on the PCB. Double-click a block to open its sheet.
  - A block's pins are all of the module's inputs and outputs: supplies (+3V3, +5V) on the top edge, GND on the bottom edge, signals on the sides.
  - A line between two blocks is a real connection. Its label is the net name, which the PCB editor also shows on the track.
- **Module sheets:** each starts with what the module does and what each of its pins is for, and ends with a list of every part and its job.
- **Placement rules:** orange notes and dashed orange boxes mark parts that must sit together on the PCB.
  - Each decoupling capacitor is wired straight to the pin it serves. Its note gives the pin number and the rule, for example C601 within 2 mm of U601 pin 13 (VDD), with a GND via beside its GND pad.
- **Power symbols on a module sheet are local.** They are KiCad 10 local power symbols (`hour-meter-board:GND_LOCAL`, `+3V3_LOCAL`, `+5V_LOCAL`) and join only the pins on that sheet.
  - Power reaches a module only through its +3V3, +5V and GND pins.
  - To add a part to a module, use the local symbols on that sheet; a global `power:` symbol would bypass the module's pins.
  - ERC's "local and global power symbols have the same name" rule is set to ignore for this reason.
- **PWR_FLAG** symbols are not parts. They tell ERC that +5V, GND and VIN_LM (top sheet) and RTC_VBAT (RTC sheet) are powered: these nets are fed through diodes or a battery, which ERC does not count as supplies.
- **Old notes:** the notes on the previous sheets used J1 pin numbers from an older pinout. The new notes come from the netlist.

**What changed when the schematic was redrawn:**
- **Netlist:** the same pin for pin as before: 152 parts and 141 nets, with the same values and footprints.
- **ERC:** the same 2 pin-to-pin warnings as before (U601 AD0 and U602 SA1 tied to +3V3).
- **Net names:** 44 net names that include a sheet name follow the new sheet names. For example, `/Opto inputs (817 module 2ch)/DIN1_R` is now `/DIN inputs/DIN1_R`. VIN_LM and AIN1_ADC now join two modules, so they became `/VIN_LM` and `/AIN1_ADC`.
- **Net classes:** the patterns in the project file follow the new names, and every net keeps its class.
- **PCB:** footprints are re-linked to the new sheets, and the routing is unchanged. DRC before and after: the same 278 unrouted connections and 34 items, 0 schematic parity issues.
- **Backup:** the files from before the redraw are in `backup-before-schematic-remake/`.

**Placement fixes after the redraw (2026-11-02):** checking the board against the sheets' placement rules showed that the ESP32 and USB capacitors sat far from the pins they serve. Five were moved; nothing else changed, and DRC is the same as before.

| Part | Serves | Gap to the pin before | After |
|---|---|---|---|
| C202 100 nF | U201 pin 2 (ESP32 3V3) | 29 mm | 0.6 mm |
| C201 10 µF | U201 pin 2 | 27 mm | 3.8 mm, beside C202 |
| C204 100 nF | U202 pin 16 (CH340C VCC) | 6.7 mm | 0.6 mm |
| C207 100 nF | U204 pin 2 (AMS1117 VO) | 8.0 mm | 0.7 mm |
| C206 22 µF | U204 VO tab | 5.0 mm | 2.1 mm, right under the regulator |

The board from before these moves is `backup-before-schematic-remake/hour-meter-board-microfit-can-handroute.before-cap-moves.kicad_pcb`.

## What is on the board

- **Parts:** all 152. The copy started with the routed board's placement; most parts have since been moved by hand (see [Audit and fixes](#audit-and-fixes) for the IMU's orientation).
- **Net classes:** the routed board's project settings, unchanged:

  | Class | Track | Clearance | Nets |
  |---|---|---|---|
  | Default | 0.25 mm | 0.15 mm | logic signals, the DIN LED nets, VEH_GND |
  | Bus | 0.3 mm | 0.2 mm | CAN_H/L, RS485 A/B, RS232 TXD/RXD |
  | Power | 0.5 mm | 0.2 mm | +5V, +5V_PSU, VIN_LM, LM_SW, VBUS, SENSOR_5V |
  | Rail3V3 | 0.3 mm | 0.15 mm | +3V3 |
  | Plane | 0.3 mm | 0.15 mm | GND, VBUS_IN |
  | Vehicle | 0.5 mm | 0.8 mm | VIN_IN, VIN_RAW, DIN1/DIN2 inputs up to the optocouplers, AIN1_RAW, AIN1_MID, DOUT1 |

- **GND pours** on both layers, unfilled. Fill them with *Edit → Fill All Zones* (B).
- **Keep-outs:**
  - no tracks or vias under the IMU packages;
  - the DIN island's barrier bridges;
  - 0.45 mm strips along the board edge and the slots.
- **Silkscreen:** module titles, a label beside each solder jumper (TERM, BIAS A, BIAS B for RS485; TERM, LISTEN for CAN), J1's pinout and the order-number mark.
- **3D models:** `3d/` holds the JLCPCB models. Git ignores the folder, so after a fresh clone run `python3 tools-pcb.py models` in the routed board's folder, then copy its `3d/` here.

## Module groups

Each module is a KiCad group on the PCB and a sheet of the same name in the schematic. The groups follow `MODULES` in the routed board's `tools-pcb.py`.
- **Select:** a click on any part selects its whole module. KiCad outlines the group and writes its name above the outline where the name fits; zoom in on a narrow module to see it.
- **Move one part:** double-click the group to enter it, then pick the part.
- **Ungroup:** from the right-click menu.
- **Extras:** a module's silkscreen title belongs to its group. The IMU group also holds the IMU keep-outs, so they move with the chips.

| Group | Module | Parts |
|---|---|---|
| J1 harness | Molex Micro-Fit 3.0, 2 × 8 | J1 |
| DIN inputs | DIN1/DIN2 isolated inputs, optocouplers across the barrier | R301–R310, D301–D304, U301, U302, C301, C302 |
| RS485 (U701) | THVD2410, protector, termination and bias jumpers | U701, D701, R701–R706, JP702–JP704, C701 |
| CAN (U1001) | TJA1051T/3, protector, termination and listen-only jumpers | U1001, D1001, R1001, JP1001, JP1002, C1001, C1002 |
| +5V out fuse (F801) | fuse on J1's +5 V sensor supply | F801 |
| RS232 (U1101) | MAX13223E with its charge-pump capacitors | U1101, C1101–C1105 |
| AIN1 front end | pulse capacitor, 4–20 mA shunt, divider | C901, R904, R901, R902 |
| AIN1 ADC (U901) | ADS1115, clamp, filter | U901, D901, R903, C902, C903 |
| DOUT1 (U903) | BSP75N switch and its 5 V buffer | U903, U902, R905, C904 |
| VIN input | 9–30 V input: fuse, VIN sense, reverse diode, TVS | F101, D102–D104, R101 |
| 5V buck (U101) | LM2596 stage | U101, L101, D101, D105, D106, C102–C105, R103–R105 |
| IMU (U601, U602) | MPU-6500, LIS3MDL, I2C pull-ups | U601, U602, C601–C606, R211, R212 |
| EEPROM (U501) | AT24C256C, write-protect jumper | U501, C501, R501, JP501 |
| RTC (U401) | DS3231M, CR2032 holder on the bottom | U401, BT401, C401, C402, R401 |
| ESP32 + USB (U201) | ESP32 module, USB-C, CH340C, 3.3 V regulator, buttons, auto-program, VIN_SENSE filter | U201–U204, J201, SW201, SW202, Q201, Q202, F201, D201–D203, C201–C208, R201–R210, R213, R102, C101 |
| LEDs | side-view indicator LEDs | D801–D803, R808–R810 |
| GPS + Qwiic | JST GH and SH ports, ESD array, series resistors, GPS supply jumper and fuse, probe pads | J802, J803, U802, JP801, F803, R803–R807, C802, TP801, TP807, TP808 |
| Mounting holes | M3 | H102–H105 |

## Routing it

The routed board's [routing rules](../hour-meter-board-microfit-can/README.md#routing-and-grounding) apply:
- **Layers:** signals on the top; keep the bottom a near-solid GND pour, and give each GND pad a via into it.
- **Supply widths:** where they fit, VIN chain 1.0 mm, LM2596 switch node 1.4–1.5 mm with the Cin–U101–D105 loop short, +5V 0.8 mm, +3V3 0.5 mm.
- **Pairs:** CAN, RS485 and RS232 lines as pairs; USB D+/D− as a pair over unbroken GND.
- **GND stitching:** vias on a 5 mm grid, 2.5 mm along the edges by the ESP32.

**When it is routed:**
1. Fill the pours (B).
2. Run DRC with the schematic parity check:

   ```bash
   kicad-cli pcb drc --severity-all --schematic-parity --refill-zones hour-meter-board-microfit-can-handroute.kicad_pcb
   ```

   The routed board shows 5 silkscreen warnings where part outlines meet the board edge and the slots; anything else is new.
3. **Regenerate the order files** after any change to the board ([Ordering](#ordering)).

## Audit and fixes

The hand routing was audited on 2026-11-03, before the JLCPCB order, and fixed on 2026-11-04. The routing was already complete and DRC clean; the audit looked for what DRC cannot see.

**What passed as routed:**
- **DRC and JLCPCB limits:** 0 errors, 0 unconnected items, 0 schematic mismatches. JLCPCB's 2-layer limits, added as KiCad custom rules on a scratch copy, gave 0 violations. The 0.25 / 0.5 mm vias are standard price.
- **Supply copper:** at maximum load every rail loses at most 40 mV, and no track warms more than 4 °C (IPC-2221).
- **IMU capacitors:** C601–C606 each have 1.7–2.0 mm of copper to their own pin.
- **Buck stage:** the catch diode D105 is 4.1 mm of copper from U101 pin 2; the routed board has 14 mm.
- **GND:** the bottom pour is one piece over 81 % of the board; the bus lines run 70–94 % of their length over it. The 12 mm gap under RS485 A is the pour-free band beside the DIN island, as intended.
- **Isolation:** the DIN island's slots are intact, and the GND pours stay 3.65 mm from island copper.
- **Antenna and magnetometer:** the ESP32 antenna overhangs the top edge with no copper under it. U602 is at least 20 mm from every current-carrying part.

**Fixed (2026-11-04):**

| Item | Rule | As routed | Now |
|---|---|---|---|
| +5V feed to J1 pin 4 (through F801) | 0.5 mm or wider (fuse sheet) | 0.3 mm over 115 mm: a shorted sensor wire would heat it by about 120 °C until F801 trips | 0.6 mm: about 40 °C |
| Buck feedback R103/R104 | next to U101 pin 4, LM_FB away from the switch node | at the output, 30 mm of LM_FB running 0.78 mm from LM_SW | right of U101's tab: 13.9 mm of LM_FB, at least 2.3 mm from LM_SW. The old route carries the +5V_PSU sense line, which is not sensitive to noise |
| U101 pin 5 (ON/OFF) | at GND | GND track up to the tab, in the new LM_FB route's way | track down to a GND via below the pin |
| AMS1117 output capacitor C206 | close to U204 pin 2 | 6.5 mm of copper | 3.0 mm, direct track to the tab |
| ESP32 reset capacitor C203 | at U201 pin 3 (EN) | 58 mm and 2 vias away, at the buttons | 2.4 mm. R201 stays by the buttons: a pull-up works from anywhere on the line |
| C201 (10 µF, ESP32 supply) | at U201 pin 2 | 3.0 mm | 6.0 mm: moved to the strip above the 3.3 V track to make room for C203; C202 (100 nF) is still 1.7 mm away, and its GND pad now has a track to U201 pin 1 |
| RS485 protector D701 | first part after J1 | 23–28 mm of copper from J1 | 4.0 / 7.8 mm |
| CAN protector D1001 | first part after J1 | 35–36 mm | 9.4 / 13.7 mm |
| AIN1 front end (C901, R904, R901, R902) | C901 right at J1 pin 11 | C901 40 mm away; the unscaled 30 V line crossed the board beside the CAN lines | C901 5.0 mm away, in a column beside J1; only the scaled AIN1_ADC line crosses the board |
| GND vias | 5 mm stitching grid; vias at surge and switching GND pads | 150 vias; 69 % of the top pour within 5 mm of one, some spots 15 mm away | 258 vias; 88 % of the top pour within 5 mm of one. The farthest spot, 14 mm, is the bottom-left corner under the +5V track. Vias at D104, D105, U101, C102, C103 and R104 |
| VBUS_IN track at J201 | track ends on the via centre | ended 0.35 mm off its via (0.26 mm copper joint) | centred |

The J1 fan-out was re-drawn by hand to fit the protectors: the lines leave J1 in pin order and pass straight through D701 and D1001, as on the routed board. CAN_L crosses under CAN_H once on the bottom layer, as before.

The fixed board was then edited by hand, in two rounds:
- 45° corners on the new fan-out lines and on LM_FB, and the VIN_SENSE bottom-layer hop shortened;
- GND vias re-arranged, and GND tracks added from GND pads to nearby GND vias (U1101, U201's GND pins, the buttons, C205–C207);
- R211/R212, the I2C pull-ups, moved 1.4 mm to the right;
- the jumper legend replaced by a label beside each jumper.

The checks below ran on the board after both rounds (2026-11-04, 08:22 save).

**Backups** in `backup-before-schematic-remake/`:
- `hour-meter-board-microfit-can-handroute.before-audit-fixes.kicad_pcb`: the board as routed by hand, before the fixes;
- `hour-meter-board-microfit-can-handroute.audit-fixed-before-user-edits.kicad_pcb`: the fixed board before the hand edits.

**Not changed:**
- **C102:** the 220 µF input capacitor has 17.7 mm of copper to U101 pin 1. C103 (100 nF, 5.0 mm) takes the fast switching current.
- **Track widths:** the VIN chain and LM_SW are 0.6 mm, not the 1.0–1.5 mm of the routing rules. They warm by at most 4 °C at full load.

**IMU orientation, for the firmware:** U601 (MPU-6500) sits at 180° and U602 (LIS3MDL) at 0°, the orientation both chips had on rev B. U601's X and Y axes therefore point the opposite way. Firmware 2.7.0 reads only U601 (roll and pitch); it must read U601's accelerometer and gyro as (−x, −y, z). The LIS3MDL needs no change when a driver for it is added.

**Virtual smoke test, on the fixed board.** Each track and via is a resistor taken from the board; the regulators, diodes and fuses are DC models (ngspice):

| Case | Result |
|---|---|
| VIN 9, 12, 24, 30 V; idle, typical and maximum load | every chip inside its supply rating; ESP32 3.26–3.30 V, +5V 4.91–5.02 V, J1 pin 4 at least 4.51 V with 0.2 A drawn |
| USB power only, 4.75–5.25 V port | 3.3 V rail in spec; +5V 4.3–4.9 V, so the TJA1051 and the SN74AHCT1G125 run below their 4.5 V minimum on a weak port: test CAN and DOUT1 on VIN ([BRINGUP.md](BRINGUP.md)) |
| Shorts at the connectors (J1 pin 4, Qwiic, GPS supply, DOUT1) | every track holds its fuse's or limiter's current; the worst warms by 39 °C until the fuse trips |
| Circuit simulations (`fault-analysis/microfit_can.py`, `faults.py`) | unchanged from the routed board's [SIMULATION.md](../hour-meter-board-microfit-can/SIMULATION.md), including its open items |

The audit scripts and their results on the fixed board are in `audit-fixes-wip/`, kept for reference. The scripts look for the audit's work copies of the board, which were not kept, so their paths need changing before they run again.

## Ordering

`production/` holds the JLCPCB files for this board:
- `hour-meter-board-microfit-can-handroute-gerbers-JLCPCB.zip`: Gerbers (F.Cu and B.Cu only) and drill files;
- `BOM-hour-meter-board-microfit-can-handroute.csv`: the same parts as the routed board;
- `CPL-hour-meter-board-microfit-can-handroute.csv`: 137 parts, 24 of them turned or re-centred for JLCPCB's footprints.

**Stock (2026-11-04, 10 boards):** every line in stock. J1 (C277731) is down to 31 and falling (48 on 11-03, 41 earlier on 11-04).

**Regenerate** after any change to the board, from the repository root:

```bash
python3 schematic/hour-meter-board/tools-production.py schematic/hour-meter-board-microfit-can-handroute/hour-meter-board-microfit-can-handroute.kicad_pcb
python3 -c "
import importlib.util as u
s = u.spec_from_file_location('tp', 'schematic/hour-meter-board-microfit-can/tools-pcb.py'); tp = u.module_from_spec(s); s.loader.exec_module(tp)
tp.HERE = 'schematic/hour-meter-board-microfit-can-handroute'
tp.PCB = tp.HERE + '/hour-meter-board-microfit-can-handroute.kicad_pcb'
tp.jlc_cpl()"
bun scripts/jlc-stock.ts schematic/hour-meter-board-microfit-can-handroute/production/BOM-hour-meter-board-microfit-can-handroute.csv --boards 10
```

The second command applies the routed board's `JLC_PLACEMENT` rotations to the CPL; KiCad's own CPL export does not. In JLCPCB's placement preview, check the same points as for the routed board ([Before you order](../hour-meter-board-microfit-can/README.md#before-you-order)).
