# Hour Meter main board (Micro-Fit + CAN + RS232, 100 × 100 mm, 2 layers)

The hour meter's own board: an ESP32-WROOM-32E with every field wire on one Molex Micro-Fit 3.0 plug (2 × 8 pins), running from a 9–30 V supply. It is routed by hand on 2 copper layers, and JLCPCB makes and assembles it.

- **CAN port:** a TJA1051T/3 on the ESP32's CAN controller (TWAI). It can read J1939 and FMS on trucks, OBD-II over CAN on cars, and any 11- or 29-bit CAN bus up to 1 Mbit/s ([CAN port](#can-port)).
- **RS232 port:** a MAX13223E on UART2. Its pins survive ±70 V, so a wire to a 12 V or 24 V supply does no damage ([RS232 port](#rs232-port)).
- **RS485** (THVD2410), two isolated inputs **DIN1/DIN2** (PC817), **AIN1** 0–30 V (ADS1115), **DOUT1** 0.5 A (BSP75N) and a fused **+5 V sensor supply**.
- **On the board:** MPU-6500 + LIS3MDL IMU, DS3231M clock with a CR2032, AT24C256C EEPROM, LM2596 5 V supply, USB-C with auto-program, JST GH GPS and JST SH Qwiic ports, three indicator LEDs.
- **J1, 2 × 8:** each port's pins sit together, and any two neighbouring pins can be shorted without damage ([J1](#j1-harness-connector)).

| | |
|---|---|
| Schematic | `hour-meter-board.kicad_sch`: a block diagram + 17 module sheets, one per PCB group; 152 parts, 141 nets ([Reading the schematic](#reading-the-schematic)) |
| PCB | `hour-meter-board.kicad_pcb`: 100 × 100 mm, 2 layers, routed by hand, audited and fixed on 2026-11-04 ([Audit and fixes](#audit-and-fixes)) |
| Order files | `production/`: Gerber zip, BOM and CPL for JLCPCB, made by `tools-production.py` ([Ordering](#ordering)) |
| Pinout and ratings | [PINOUT.md](PINOUT.md): every pin's working range and absolute maximum, the supply and the power consumption |
| Simulations | [SIMULATION.md](SIMULATION.md): CAN bus timing, bus and RS232 faults, J1 neighbour shorts, power budget |
| Bring-up | [BRINGUP.md](BRINGUP.md): first power-on of a new board and a check of every module |
| Firmware | `pio run -e can-board -t upload` in `esp32/`: the hour-meter firmware with this board's pins and IMU axes. The GPS, CAN, RS485, AIN1, DOUT1, the LEDs and the LIS3MDL still need firmware ([Firmware to do](#firmware-to-do)) |

**Checks (2026-11-04):**

| Check | Result |
|---|---|
| ERC | 0 errors; 2 warnings: the IMU address straps tie a bidirectional pin to +3V3, as intended |
| DRC (`--severity-all --schematic-parity`) | 0 errors, 0 unconnected items, 0 schematic mismatches. 5 warnings: part silkscreen at the DIN island's slots and at the ESP32 antenna's board edge, which JLCPCB clips |
| JLCPCB limits | 0 violations as KiCad custom rules ([JLCPCB check](#jlcpcb-check)) |
| Simulations | the smoke test on the copper passes ([Audit and fixes](#audit-and-fixes)). The circuit simulations pass, apart from the open items in [SIMULATION.md](SIMULATION.md): a negative ISO 7637-2 pulse 1 on the input diode, and 24 V vehicles need a 24 → 12 V converter |

## GPIO map

GPIO36 and GPIO39 dip low for about 80 ns whenever the ADC powers up ([Espressif errata GPIO-3.11](https://docs.espressif.com/projects/esp-chip-errata/en/latest/esp32/03-errata-description/esp32/gpio-inputs-pulled-down.html)), so only VIN_SENSE and the IMU interrupt use them. No UART receiver or pulse input does.

| GPIO | Function | | GPIO | Function |
|---|---|---|---|---|
| 0 | BOOT button, auto-program | | 19 | P2 LED |
| 1, 3 | UART0: CH340C (USB) | | 21, 22 | I2C SDA, SCL |
| 2 | STATUS LED | | 23 | DOUT1 control |
| 4 | GPS PPS | | 25 | RS485 DE |
| 5 | USR LED | | 26 | DIN2 (pulse counter) |
| 12 | not connected (strapping pin) | | 27 | DIN1 (alternator) |
| 13 | RTC interrupt | | 32 | UART2 TX: RS232 |
| 14 | RS485 TX | | 33 | CAN TX |
| 15 | CAN RX | | 34 | UART2 RX: RS232 |
| 16 | GPS: to the GPS's RX | | 35 | RS485 RX |
| 17 | GPS: from the GPS's TX | | 36 | VIN_SENSE (ADC1) |
| 18 | P1 LED | | 39 | IMU interrupt |

- **Strapping pins:** GPIO15 (CAN RX) is held high by the idle bus at reset, which is its default. GPIO4 is not a strapping pin.
- **Input-only pins** (34, 35, 36, 39) carry inputs only: RS232 RX, RS485 RX, VIN_SENSE, IMU interrupt.
- **Pin order:** each vehicle-side port uses pins on the module's left side, which faces it, and the GPS port pins on the right side. That keeps long tracks from crossing the board.

## J1 harness connector

| Pin | Signal | | Pin | Signal |
|---|---|---|---|---|
| 1 | GND (battery negative) | | 9 | VIN 9–30 V, from a 12 V system |
| 2 | GND (signal return: sensors, RS232, RS485, CAN) | | 10 | DOUT1, 0.5 A low-side switch |
| 3 | RS232 TX | | 11 | AIN1, 0–30 V |
| 4 | +5 V out, 200 mA (F801) | | 12 | RS232 RX |
| 5 | CAN_L | | 13 | CAN_H |
| 6 | RS485 B | | 14 | RS485 A |
| 7 | DIN COM (isolated return) | | 15 | DIN1 |
| 8 | DIN COM (second return wire) | | 16 | DIN2 |

Looking into J1 from outside the case (latch on top):

```
 16  15  14  13  12  11  10   9      upper row (pins 9-16)
  8   7   6   5   4   3   2   1      lower row, next to the PCB (pins 1-8)
```

The same table is printed on the bottom silkscreen.

**Harness parts** (one plug per board):

| Part | Molex | LCSC |
|---|---|---|
| Header on the board (JLCPCB assembles it) | 43045-1600 | C277731 |
| Receptacle housing, 2 × 8 | 43025-1600 | C293527 |
| Female crimp terminals, 20–24 AWG (16 per plug) | 43030-0007 | C293530 |
| Crimp tool | 63819-0000, or a Micro-Fit / "MX3.0" ratchet crimper | – |

- **Stock:** the header is the tightest part; check it before ordering ([Ordering](#ordering)).
- **Wire:** 20 AWG for VIN, GND and DOUT1; 22–24 AWG for signals; a twisted pair for CAN_H/CAN_L and for RS485 A/B.

**Wiring:**
- **Supply:** VIN (9) from a fused +12 V, with a 1 A fuse at the battery end; GND (1) to the battery negative. In a 24 V vehicle, feed VIN from a 24 → 12 V converter ([PINOUT.md](PINOUT.md#supply)). A negative ISO 7637-2 pulse 1 drives the reverse-polarity diode D103 into avalanche; the simulated fix is for the next revision ([SIMULATION.md](SIMULATION.md#circuits-shared-with-the-earlier-boards)).
- **CAN:** CAN_H on 13, CAN_L on 5, the bus ground on 2 ([CAN port](#can-port)).
- **RS485:** A on 14, B on 6, the bus ground on 2.
- **RS232:** the board's TX on 3, RX on 12, ground on 2 ([RS232 port](#rs232-port)).
- **AIN1 with a 5 V sensor:** supply from 4, signal on 11, ground on 2: three neighbouring cavities.
- **DOUT1:** the load between a fused +12/24 V and 10.
- **DIN1, DIN2:** the signals on 15 and 16, their return on 7 or 8 (DIN COM, not connected to GND on the board).

**Why this pin order:**
- **Vehicle nets on the back row.** VIN, DOUT1, AIN1, DIN1 and DIN2 sit on the back (upper) row and leave the header straight into the board. Their 0.8 mm clearance leaves no room for a track between two of them, so each front-row signal leaves between a back-row pair with at most one vehicle net.
- **Module order.** The signals leave J1 top to bottom as RS485 A, B | CAN_L, CAN_H | +5 V | RS232 RX, TX | AIN1 | DOUT1 | VIN. Each module sits on the board in that same order, so no two modules' tracks cross.
- **No weak neighbour.**
  - +5 V out (4) touches only RS232 TX and RX and CAN_L, which cannot push it above 5 V.
  - DOUT1 (10) sits between VIN and AIN1, across from GND.
  - The RS232 (±70 V) and CAN (±58 V) pins can sit beside vehicle pins.
  - The [harness simulation](SIMULATION.md#4-j1-neighbouring-pins-shorted) shorts every neighbouring pair: none damages the board.
- **The isolated group at one end.** DIN1, DIN2 and the two DIN COM pins fill the pin 8/16 end, next to the DIN island.

## CAN port

**What it can read:** the CAN bus is one physical layer (ISO 11898-2) for every protocol on it. The protocol lives in the firmware.

| Source | Where on the vehicle | Rate | What the firmware does |
|---|---|---|---|
| **J1939 / FMS** (trucks, buses, machines) | 9-pin Deutsch diagnostic plug (C = CAN_H, D = CAN_L), or the FMS gateway | 250 kbit/s (some 500) | listens: decodes broadcast PGNs, e.g. engine hours (PGN 65253 / SPN 247), engine speed (61444), fuel used (65257), fuel level (65276), vehicle speed (65265) |
| **OBD-II over CAN** (ISO 15765-4) | 16-pin OBD plug: pin 6 CAN_H, pin 14 CAN_L, pins 4/5 ground, pin 16 +12 V | 500 kbit/s (some 250), 11- or 29-bit | sends a request per value (mode 01 PIDs: RPM, speed, coolant, fuel level, run time), reads the answers |
| **Any broadcast CAN** (proprietary frames) | any CAN pair | 125 k–1 Mbit/s | listens: a table of CAN ID, byte position, scale and offset per value, set in the configurator |

**Compared with Teltonika trackers:**

| Teltonika feature | This board |
|---|---|
| FMx640/FMC650: dual CAN J1939/FMS, K-line (tachograph), J1708 | one CAN bus; no K-line or J1708: the ESP32 has no third UART left, and J1 no free pin |
| FMB140/FMC150: built-in LV-CAN200 / ALL-CAN300 reader with Teltonika's licensed per-vehicle database | the same hardware role, but without the database: car-specific frames need the "any broadcast CAN" table, filled per vehicle |
| "Manual CAN" (user-set CAN ID and byte mask) | the "any broadcast CAN" table above |
| FMB003/FMC003 OBD-II plug: PIDs over CAN and over K-line (ISO 9141-2, KWP2000) | OBD-II over CAN only: every US car since 2008 and most cars since about 2008 elsewhere. Older cars on K-line or J1850 are not covered |
| contactless CAN readers (ECAN02, CAN-CONTROL) | wire one to J1's CAN pins like a bus; check its output level is ISO 11898-2 |

**Jumpers:**
- **JP1001 (TERM, open):** a 120 Ω terminator across the bus. A vehicle bus is already terminated at both ends, so leave it open when tapping one. Bridge it only when the board ends a bus, for example on the bench with one other node.
- **JP1002 (LISTEN, open):** bridged, the transceiver is held silent: the board can only listen, guaranteed by hardware. Some fleet installations require this on a vehicle bus. Open, the firmware chooses between normal mode (needed for OBD-II requests) and listen-only mode.

**Limits:**
- **One bus, classic CAN:** the ESP32's TWAI controller handles one bus at one bit rate, and classic CAN only. CAN FD frames read as errors, so on a bus that carries them the board must only listen.
- **Stub length:** the board reads 250 and 500 kbit/s buses from a stub of up to 3 m ([simulation](SIMULATION.md#1-can-bus-timing)). J1939 allows 1 m.
- **Faults:** a CAN wire on a 12 V or 24 V supply (up to 36 V) does no damage ([simulation](SIMULATION.md#2-can-and-rs485-lines-wired-to-a-supply)).

**Sources:**
- [ESP-IDF TWAI driver](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/twai.html), [TJA1051 datasheet](https://www.nxp.com/docs/en/data-sheet/TJA1051.pdf), [NUP3105L datasheet](https://www.onsemi.com/pdf/datasheet/nup3105l-d.pdf)
- [J1939 SPN 247, engine total hours](https://docs.dimo.org/dimo-explorer/field-descriptions-in-detail/j1939-heavy-truck/engine-signals/enginetotalhoursofoperationj1939-spn-247); OBD-II protocols ([python-OBD protocol list](https://py-obdii.readthedocs.io/en/latest/api/protocols.html)) and [connector pinout](https://ricksfreeautorepairadvice.com/obd-ii-connector-pinout-diagrams/)
- Teltonika: [FMC640 Manual CAN](https://wiki.teltonika-gps.com/view/FMC640_Manual_CAN_IO), [FMB140 CAN adapters](https://wiki.teltonika-gps.com/view/FMB140_CAN_adapters), [ALL-CAN300](https://shop.ascend.de/en/products/teltonika-telematics-all-can300-can-reading-can-alc300ruvs01), [FMB003](https://www.wisp.pl/p7801,teltonika-fmb003.html), [ECAN02](https://www.pbtech.com/product/NETTTK2201/Teltonika-ECAN02-CAN-Adapter-for-Contactless-Acces)

## RS232 port

- **The part:** a MAX13223E on UART2 (GPIO32 TX, GPIO34 RX), always on, at 3.3 V.
- **Ratings:** ±6.3 V into the worst EIA-232 load (3 kΩ + 2500 pF), up to 250 kbit/s.
- **Why this part and not a MAX3232:** its TX and RX survive ±70 V. A MAX3232-class part (±13.2 V on TX, ±25 V on RX) is destroyed by a wire to a 24 V supply, and by some J1 neighbour shorts. The cost: about $3 more per board (C118523 against the SP3232EEY basic part, C13482), and 8 mA always on.
- **UART2 is shared** with the GPS port through the GPIO matrix: the firmware uses one of the two at a time.
- **Wiring:** to a DB9 device (DTE): its RXD (DB9 pin 2) to J1 pin 3, its TXD (DB9 pin 3) to J1 pin 12, its GND (DB9 pin 5) to J1 pin 2.

## Other ports

| Ref | Port | Connector (LCSC) | Where |
|---|---|---|---|
| J802 | GPS | JST GH 6-pin SM06B-GHS-TB (C133065), Pixhawk pinout | right edge, opening outward |
| TP801 | GPS PPS | 1 mm solder pad | beside J802 |
| J803 | Qwiic | JST SH 4-pin SM04B-SRSS-TB (C160404) | right edge, below J802 |
| J201 | USB-C | HRO TYPE-C-31-M-12 | right edge, beside the ESP32 |
| TP807, TP808 | probe pads | 1 mm pads | +3V3, GND |

- **The logic-level ports are on the right edge:** GPS and Qwiic sit with USB-C on the MCU side, away from the vehicle harness.
- **GPS supply:** JP801 selects 3.3 V (as delivered, 1-2 bridged) or 5 V (cut 1-2, bridge 2-3, fused by F803).

## Indicator LEDs

Three green side-view LEDs (LTST-S270TGKT) sit on the right edge with their lenses at the board edge: P1 (GPIO18), P2 (GPIO19), USR (GPIO5). Beside the ESP32, a red PWR LED (D202) shows 3.3 V and a yellow STATUS LED (D203) hangs on GPIO2.

## Solder jumpers

| Jumper | Function | As delivered | Change it when |
|---|---|---|---|
| JP1001 | CAN 120 Ω termination | open | the board ends a CAN bus: bridge it |
| JP1002 | CAN listen-only (transceiver silent) | open | a vehicle bus must never see the board transmit: bridge it |
| JP702 | RS485 120 Ω termination (A to B) | open | the board is at one end of the bus: bridge it |
| JP703 + JP704 | RS485 bias: A to 3.3 V and B to GND, 330 Ω each | open | nothing else on the bus biases it: bridge both, on one node only |
| JP501 | EEPROM write protect | open (writes on) | bridge it to lock the EEPROM |
| JP801 | GPS supply | 1-2 bridged (3.3 V) | for a 5 V GPS: cut 1-2, bridge 2-3 |

Each jumper has a label beside it on the silkscreen (TERM, BIAS A, BIAS B for RS485; TERM, LISTEN for CAN).

## Layout

Signal flow runs left to right, from the vehicle harness to the MCU. The modules sit roughly like this:

```
 ┌─ DIN island (isolated) ──┬─ IMU ──┬────────────── ESP32 (antenna past the top edge) ─┐
 │  R30x  D30x   U301/U302  │ U601   │  EN RC, VIN_SENSE filter          │  3V3 LDO    │
 ├─ slot ───────────────────┤ U602   │                                   │  USB-C ─────┤ right edge:
 J1  │ D701 │ RS485 jumpers  U701 │ R70x │  EEPROM   RTC              CH340C, auto-program│ USB-C,
 2x8 │ D1001│ CAN jumpers   U1001 │      │                                  RESET  BOOT  │ buttons,
 left│ F801 │                     │      │                                               │ LEDs,
 edge│ C901 │ RS232  U1101 + charge-pump caps   ADS1115 + divider foot  BT401 (bottom)   │ GPS (GH),
     │ R901-2│                                                                    GPS/Qwiic module│ Qwiic (SH)
     │ U903 DOUT1 + buffer                                                                 │
 ├ VIN chain ┴──── LM2596: Cin → U101 → D105 → L101 → Cout → D101 → +5V ───────────────┘
```

- **Fixed first:** J1 on the left edge, the ESP32 antenna over the top edge, USB-C, the buttons, the LEDs and the GPS/Qwiic ports on the right edge, M3 holes in three corners and on the right edge.
- **The protection column:** every bus meets its protector right behind its J1 pins, in pin order: D701 (RS485), D1001 (CAN), F801 (+5 V out), then the AIN1 front end (C901, R904, R901, R902) in a column beside J1. Only the scaled AIN1 line crosses the board to the ADC.
- **The modules behind it,** each around its IC, in J1's order: RS485 (THVD2410, its jumpers, pull-ups), CAN (TJA1051, jumpers, decoupling), RS232 (MAX13223E with its charge-pump capacitors), DOUT1 (BSP75N with its drain toward J1, the 5 V buffer behind).
- **Transceiver orientation:** every transceiver's bus pins face J1 and its logic pins face the MCU.
- **The supply:** the 9–30 V input chain (F101, VIN sense, reverse-polarity diode, TVS) runs down the left edge to the LM2596 stage along the bottom edge, with the hot loop Cin–U101–D105 kept short. The 3.3 V regulator sits by the ESP32.
- **Quiet zone:** the IMU sits at the top middle. The magnetometer (U602) is at least 20 mm from every current-carrying part.

**IMU axes.** U601 (MPU-6500) sits at 180° and U602 (LIS3MDL) at 0°. The two chips define their axes opposite ways: with pin 1 at the top left, the MPU-6500's X points right and its Y up, while the LIS3MDL's X points left and its Y down (the axis figures in both datasheets). This placement therefore lines the chips up: both X axes point toward J1 and both Y axes toward the bottom edge.
- **Firmware 2.7.0** reads only U601 (roll and pitch). The `can-board` build turns its readings 180° (`board::kImuRotation` in `esp32/include/BoardPins.h`), so x points from J1 toward the USB-C edge and y toward the ESP32's antenna edge. A LIS3MDL driver needs the same 180° turn.
- **In the vehicle:** the firmware takes x as the nose, so mount the board with the USB-C edge toward the front.

## Reading the schematic

The schematic is drawn so each module can be read on its own.

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
- **Net classes:**

  | Class | Track | Clearance | Nets |
  |---|---|---|---|
  | Default | 0.25 mm | 0.15 mm | logic signals, the DIN LED nets, VEH_GND |
  | Bus | 0.3 mm | 0.2 mm | CAN_H/L, RS485 A/B, RS232 TXD/RXD |
  | Power | 0.5 mm | 0.2 mm | +5V, +5V_PSU, VIN_LM, LM_SW, VBUS, SENSOR_5V |
  | Rail3V3 | 0.3 mm | 0.15 mm | +3V3 |
  | Plane | 0.3 mm | 0.15 mm | GND, VBUS_IN |
  | Vehicle | 0.5 mm | 0.8 mm | VIN_IN, VIN_RAW, DIN1/DIN2 inputs up to the optocouplers, AIN1_RAW, AIN1_MID, DOUT1 |

## Module groups

Each module is a KiCad group on the PCB and a sheet of the same name in the schematic.
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

## Routing rules

Keep to these when re-routing any part of the board:

| Rule | Value | Why |
|---|---|---|
| Layers | signals on top; the bottom a near-solid GND pour, crossed by short logic runs. Every GND pad gets a via into it | a return path under every signal (Espressif, TI SLYT499) |
| Default tracks | 0.25 mm, 0.15 mm clearance | non-dense board; JLCPCB minimum 0.10/0.10 |
| Bus pairs | CAN, RS485, RS232: 0.3 mm, 0.2 mm clearance, routed as pairs; USB D+/D− as a pair over unbroken GND | robust lines |
| Supply tracks | where they fit: VIN chain 1.0 mm, LM2596 switch node 1.4–1.5 mm with the Cin–U101–D105 loop short, +5V 0.8 mm, +3V3 0.5 mm | IPC-2221, 1 oz outer, 10 °C rise: 0.3 mm per amp |
| Vehicle nets | 0.5 mm, 0.8 mm clearance | ISO 7637 pulses on harness lines; IPC-2221 needs 0.6 mm at 31–100 V uncoated |
| Vias | 0.6/0.3 mm; 0.5/0.25 mm where space is tight | JLCPCB standard price |
| GND stitching | 5 mm grid over the board, 2.5 mm along the edges by the ESP32 | λ/20 at 2.4 GHz in FR-4 is about 3 mm; ties the two pours together |
| Keep-outs | no tracks or vias under the IMU packages; the DIN island's barrier; 0.45 mm strips at the board edge and the slots | MPU-6500 datasheet; isolation; JLCPCB copper-to-edge |

**This board as routed:** 3132 mm of track on top (79 %) and 854 mm on the bottom (21 %); tracks 0.2–0.76 mm; 251 vias of 0.6/0.3 mm and 121 of 0.5/0.25 mm, 258 of them on GND. The bottom pour is one piece over 81 % of the board.

**After a change:**
1. Fill the pours (*Edit → Fill All Zones*, B).
2. Run DRC with the schematic parity check:

   ```bash
   kicad-cli pcb drc --severity-all --schematic-parity --refill-zones hour-meter-board.kicad_pcb
   ```

   The 5 silkscreen warnings above are expected; anything else is new.
3. **Regenerate the order files** ([Ordering](#ordering)).

## Audit and fixes

The hand routing was audited on 2026-11-03, before the JLCPCB order, and fixed on 2026-11-04. The routing was already complete and DRC clean; the audit looked for what DRC cannot see.

**What passed as routed:**
- **DRC and JLCPCB limits:** 0 errors, 0 unconnected items, 0 schematic mismatches. JLCPCB's 2-layer limits, added as KiCad custom rules on a scratch copy, gave 0 violations. The 0.25 / 0.5 mm vias are standard price.
- **Supply copper:** at maximum load every rail loses at most 40 mV, and no track warms more than 4 °C (IPC-2221).
- **IMU capacitors:** C601–C606 each have 1.7–2.0 mm of copper to their own pin.
- **Buck stage:** the catch diode D105 is 4.1 mm of copper from U101 pin 2.
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

The J1 fan-out was re-drawn by hand to fit the protectors: the lines leave J1 in pin order and pass straight through D701 and D1001. CAN_L crosses under CAN_H once on the bottom layer.

The fixed board was then edited by hand, in two rounds:
- 45° corners on the new fan-out lines and on LM_FB, and the VIN_SENSE bottom-layer hop shortened;
- GND vias re-arranged, and GND tracks added from GND pads to nearby GND vias (U1101, U201's GND pins, the buttons, C205–C207);
- R211/R212, the I2C pull-ups, moved 1.4 mm to the right;
- the jumper legend replaced by a label beside each jumper.

The checks below ran on the board after both rounds (2026-11-04, 08:22 save).

**Not changed:**
- **C102:** the 220 µF input capacitor has 17.7 mm of copper to U101 pin 1. C103 (100 nF, 5.0 mm) takes the fast switching current.
- **Track widths:** the VIN chain and LM_SW are 0.6 mm, not the 1.0–1.5 mm of the routing rules. They warm by at most 4 °C at full load.

**Virtual smoke test, on the fixed board.** Each track and via is a resistor taken from the board; the regulators, diodes and fuses are DC models (ngspice):

| Case | Result |
|---|---|
| VIN 9, 12, 24, 30 V; idle, typical and maximum load | every chip inside its supply rating; ESP32 3.26–3.30 V, +5V 4.91–5.02 V, J1 pin 4 at least 4.51 V with 0.2 A drawn |
| USB power only, 4.75–5.25 V port | 3.3 V rail in spec; +5V 4.3–4.9 V, so the TJA1051 and the SN74AHCT1G125 run below their 4.5 V minimum on a weak port: test CAN and DOUT1 on VIN ([BRINGUP.md](BRINGUP.md)) |
| Shorts at the connectors (J1 pin 4, Qwiic, GPS supply, DOUT1) | every track holds its fuse's or limiter's current; the worst warms by 39 °C until the fuse trips |
| Circuit simulations (`fault-analysis/microfit_can.py`, `faults.py`) | as in [SIMULATION.md](SIMULATION.md), including its open items |

**Kept for reference:**
- `backup-before-schematic-remake/`: the board before the fixes (`*.before-audit-fixes.kicad_pcb`) and the fixed board before the hand edits (`*.audit-fixed-before-user-edits.kicad_pcb`), under the project's earlier name.
- `audit-fixes-wip/`: the audit scripts and their results. The scripts look for the audit's work copies of the board, which were not kept, so their paths need changing before they run again.

## Enclosure

- **Material: plastic, not aluminium.** The ESP32's antenna is on the PCB and overhangs the top edge.
- **Board and heights:**

  | | |
  |---|---|
  | Board | 100 × 100 mm |
  | Tallest part above | 10 mm (C102) |
  | Tallest part below | 7.5 mm (the CR2032 holder) |

  Plan on an inside of at least 110 × 110 × 25 mm, with the board on ≥ 8 mm standoffs.
- **Cut-outs:** left wall about 31 × 10 mm for J1; right wall for USB-C (10 × 4 mm), the three LED holes, the GH and SH ports.

## Firmware to do

The board is ready; these parts need firmware:
- **CAN:** BoardPins `kCanTx = 33`, `kCanRx = 15`; the ESP-IDF TWAI driver.
  - Listen-only by default.
  - Bit-rate detection: try 250 and 500 kbit/s in listen-only mode.
  - J1939/FMS decoding: PGN 65253 / SPN 247 gives the engine hours directly.
  - OBD-II PID polling in normal mode.
  - A configurable "any broadcast CAN" table.
- **RS232 and GPS on UART2:** RS232 on RX GPIO34 / TX GPIO32 is done: the `can-board` build runs the UART link there and leaves the GPS pins alone. Still to do: the GPS on RX GPIO17 / TX GPIO16, and a 115200 limit on `uartBaud` for RS232 cables.
- **RS485:** TX GPIO14, RX GPIO35, DE GPIO25 (R703 holds DE low, so the driver stays off until the firmware drives it).
- **IMU interrupt on GPIO39:** the pin dips low for about 80 ns each time the ADC powers up (errata GPIO-3.11). Keep the ADC unit open (powered) after the first VIN_SENSE reading, or confirm an interrupt in the IMU's status register before acting on it.
- **LIS3MDL compass** (U602, I2C 0x1E): a driver, with the same 180° turn as U601 ([IMU axes](#layout)).
- **AIN1:** an ADS1115 driver: I2C address 0x48, single-ended AIN0, range chosen by a setting, scale 10.98 (the R901/R902 divider). Optional per-board calibration.
- **DOUT1:** GPIO23, active high (1 = load on). There is no read-back. The BSP75N restarts by itself after a thermal shutdown, so there is no latch to reset. R905 holds the line low until the firmware drives it.
- **Settings:** the 128-byte `SettingsRecord` is full, so AIN1 and DOUT1 settings need an EEPROM layout change.
- **LEDs and VIN_SENSE:** P1 (GPIO18), P2 (GPIO19), USR (GPIO5) and STATUS (GPIO2); VIN_SENSE on GPIO36 (ADC1).

## Before you order

- **Assembly:** Standard PCBA on both sides, since BT401 is on the bottom; all through-hole parts selected (J1 and BT401).
- **Antenna overhang:** the ESP32 module overhangs the top edge by 6.5 mm. Standard assembly adds tooling rails, and one on the top edge would hit the antenna, so add the order remark: "ESP32 module overhangs the top edge by 6.5 mm, please place the tooling rails on the left and right edges."
- **Order number:** choose **Order Number → Specify Position**; the mark is on the bottom silkscreen.
- **R904 is not fitted.** It is left out of the BOM and CPL. Hand-solder a 120 Ω 0.1 % 1206 resistor for a 4–20 mA sensor.
- **The harness plug is not part of the assembly.** Add the 43025-1600 housing (C293527) and 16 × 43030-0007 terminals (C293530) to the LCSC order ([J1](#j1-harness-connector)).
- **The solder jumpers come open,** apart from JP801 (1-2). Set the CAN and RS485 jumpers for the bus the board joins ([Solder jumpers](#solder-jumpers)).
- **In the placement preview,** check:
  - the LED lenses face the right edge;
  - BT401's + clip sits on pin 1;
  - J1's mating face is at the left edge;
  - pin 1 of U1001 (TJA1051) and U1101 (MAX13223E) is where the board's marking shows it.

  The CPL already carries JLCPCB's rotations.

### JLCPCB check

Checked against [JLCPCB's PCB capabilities](https://jlcpcb.com/capabilities/pcb-capabilities) and [assembly capabilities](https://jlcpcb.com/capabilities/pcb-assembly-capabilities), for 2 layers, 1.6 mm and 1 oz copper. The limits ran as KiCad custom rules on a scratch copy of the final board: 0 violations.

| Item | JLCPCB | This board |
|---|---|---|
| Copper layers | 2 | 2: the Gerber zip holds L1 (top) and L2 (bottom) only; `tools-production.py` checks it |
| Track width, spacing | 0.10 mm, 0.10 mm | 0.2 mm minimum track, 0.15 mm clearance (0.2 mm on buses, 0.8 mm on vehicle nets) |
| Vias | 0.15 mm hole minimum. Under 0.3 mm with a pad under 0.45 mm costs extra | 0.30 / 0.60 mm (251), 0.25 / 0.50 mm (121): standard price |
| Through-hole annular ring | 0.20 mm (0.18 absolute, 0.25 recommended) | 0.20 mm (USB-C shell); J1 0.24 mm |
| Holes | PTH 0.15 mm, NPTH 0.5 mm | PTH 0.20 mm (the ESP32's GND-pad vias), NPTH 0.65 mm (USB-C pegs) |
| Slots | plated 0.5 mm wide and 2 × as long; milled 1.0 mm | USB-C shell 0.6 × 1.2 / 0.6 × 1.7 mm; DIN island 1.5 mm |
| Copper to board edge | 0.2 mm | 0.3 mm (board rule) |
| Board size for Standard PCBA | 70 × 70 mm minimum | 100 × 100 mm |
| Silkscreen text | 1.0 mm high, 0.15 mm stroke | 62 texts, 1.0–1.2 mm high, 0.15–0.24 mm stroke |
| Silkscreen lines | 0.15 mm | **0.12 mm** (KiCad's library footprints): printed, may come out thin |

**CPL rotations:** `tools-production.py` turns or re-centres 24 parts to match JLCPCB's footprints (`JLC_PLACEMENT`), for example J1 (C277731) 180° with its centroid at the middle of the pad array, U1001 and U1101 270°, D701 and D1001 180°. Each was found by fitting JLCPCB's pads onto the KiCad pads.

## Ordering

`production/` holds the JLCPCB files for this board:
- `hour-meter-board-gerbers-JLCPCB.zip`: Gerbers (F.Cu and B.Cu only) and drill files;
- `BOM-hour-meter-board.csv`: 152 parts minus the board-only ones (holes, test pads, solder jumpers) and R904;
- `CPL-hour-meter-board.csv`: 137 parts, 24 of them turned or re-centred for JLCPCB's footprints.

**Stock (2026-11-04, 10 boards):** every line in stock. J1 (C277731) is down to 31 and falling.

**Regenerate** after any change to the board:

```bash
cd schematic/hour-meter-board
python3 tools-production.py      # DRC and 2-layer checks, then production/
cd ../..
bun scripts/jlc-stock.ts schematic/hour-meter-board/production/BOM-hour-meter-board.csv --boards 10
```

## 3D models

The board uses KiCad's library models, and JLCPCB's models for six parts KiCad 10 has none for or draws differently: J1, USB-C (J201), the buttons (SW201, SW202), the CR2032 holder (BT401), F101 and L101. They live in `3d/`, which git does not track: after a fresh clone, run `python3 tools-production.py models` once to download them (source: the JLCEDA/EasyEDA library).

## History

- **2026-10-30:** designed as the Micro-Fit board with a CAN port and an RS232 port (rev C), placed by script and routed with Freerouting.
- **2026-11-02:** copied for routing by hand, with one KiCad group per module. The schematic was redrawn module by module the same day; the netlist stayed the same pin for pin, and five ESP32 and USB capacitors moved next to their pins.
- **2026-11-03 to 11-04:** routed by hand, audited and fixed ([Audit and fixes](#audit-and-fixes)).
- **2026-11-04:** this became the repository's main board, under the name `hour-meter-board`. The older boards it grew from (rev B and its 2-layer, compact, LM2596, I/O and Micro-Fit versions, the auto-routed CAN board and the PSU-B supply) were removed from the repository. They are in the git history at commit d35ef2d, for example `git show d35ef2d:schematic/hour-meter-board-microfit-can/README.md`.
