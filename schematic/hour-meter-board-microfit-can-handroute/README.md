# Hour Meter main board, Micro-Fit + CAN + RS232: hand-routing copy

A copy of the [Micro-Fit + CAN + RS232 board](../hour-meter-board-microfit-can/README.md) for routing by hand. It holds that board's schematic, parts and placement as of 2026-11-02, after the second round of hand edits, with every track and via removed. The routed board is unchanged, and nothing done here flows back to it.

| | |
|---|---|
| Schematic | `hour-meter-board-microfit-can-handroute.kicad_sch` + 12 sheets: the same circuit, 152 parts and 141 nets |
| PCB | `hour-meter-board-microfit-can-handroute.kicad_pcb`: 100 × 100 mm, 2 layers, every part placed, no tracks or vias |
| Design notes | the routed board's [README](../hour-meter-board-microfit-can/README.md) and [PINOUT.md](../hour-meter-board-microfit-can/PINOUT.md) |

## What is on the board

- **Parts:** all 152, where the routed board has them. That includes the IMU turned 270°, which turns its axes ([routed board, Layout](../hour-meter-board-microfit-can/README.md#layout)).
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
- **Silkscreen:** as on the routed board: module titles, the jumper legend, J1's pinout and the order-number mark.
- **3D models:** `3d/` holds the JLCPCB models. Git ignores the folder, so after a fresh clone run `python3 tools-pcb.py models` in the routed board's folder, then copy its `3d/` here.

## Module groups

Each module is a KiCad group. The groups follow `MODULES` in the routed board's `tools-pcb.py`.
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
3. **Production files** are not set up in this folder. The routed board's `tools-pcb.py production` also turns the CPL rotations to match JLCPCB's footprints, which KiCad's own CPL export does not do. It writes into that board's `production/` folder.
