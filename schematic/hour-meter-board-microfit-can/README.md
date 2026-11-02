# Hour Meter main board, Micro-Fit + CAN + RS232 (rev C, 100 × 100 mm, 2 layers)

The [Micro-Fit board](../hour-meter-board-microfit/README.md) with a **CAN port** and an **RS232 port**, re-laid out module by module. Every field wire still enters on one Molex Micro-Fit 3.0 plug, now with 16 pins. The board stays at 2 copper layers and is built and assembled by JLCPCB.

- **CAN port:** TJA1051T/3 transceiver on the ESP32's CAN controller (TWAI). It reads J1939 and FMS on trucks, OBD-II over CAN on cars, and any 11- or 29-bit CAN bus up to 1 Mbit/s ([CAN port](#can-port)).
- **RS232 port:** a MAX13223E on UART2, replacing the 3.3 V TTL port. Its pins survive ±70 V, so a wire to a 12 V or 24 V supply does no damage ([RS232 port](#rs232-port)).
- **J1 grows to 2 × 8** (Micro-Fit 43045-1600). The new pin order puts each port's pins together and leaves no weak neighbour: any two neighbouring pins can be shorted without damage ([J1](#j1-harness-connector)).
- **RS485 protector:** one SZNUP3105L at J1, the same part as on CAN, in place of the two SMAJ33CA. It frees room at the connector.
- **Modular layout on 100 × 100 mm,** JLCPCB's lowest price band. Each module's parts sit around its IC: J1's signals fan out to the modules in pin order without crossing, the MCU block holds the logic side, and the IMU stays in a quiet corner ([Layout](#layout)).
- **Routing practice:** signals on the top layer, a ground pour over 78 % of the bottom, supply tracks widened after routing, 186 GND stitching and island vias. The bus lines from J1 run 23–37 mm, almost all on top; the logic lines that cross the board to the ESP32 dip to the bottom for part of their length ([Routing and grounding](#routing-and-grounding)).

This folder started as a copy of the Micro-Fit board's, which is unchanged.

| | |
|---|---|
| Schematic | `hour-meter-board-microfit-can.kicad_sch` + 12 sheets. New: `can.kicad_sch` (10xx) and `rs232.kicad_sch` (11xx). Changed: `harness.kicad_sch` (J1 2 × 8), `ports.kicad_sch` (TTL buffer removed), `rs485.kicad_sch` (D701), `esp32-core.kicad_sch` (CAN on GPIO15/33, eight pins moved) |
| PCB | `hour-meter-board-microfit-can.kicad_pcb`: 100 × 100 mm, 2 layers |
| Hand-routing copy | [`../hour-meter-board-microfit-can-handroute/`](../hour-meter-board-microfit-can-handroute/README.md): the same parts and placement with no tracks, one PCB group per module |
| Script | `tools-pcb.py` with `check`, `place`, `route`, `finish`, `reroute`, `widen`, `stitch`, `report`, `update`, `silk`, `production` or `models` |
| Order files | `production/`: Gerber zip, BOM and CPL |
| Pinout and ratings | [PINOUT.md](PINOUT.md): every pin's working range and absolute maximum, the supply and the power consumption |
| Simulations | [SIMULATION.md](SIMULATION.md): CAN bus timing, bus and RS232 faults, J1 neighbour shorts, power budget |
| Firmware | The CAN port needs a TWAI driver; UART2, the GPS, VIN_SENSE and three other pins moved ([GPIO map](#gpio-map), [Firmware to do](#firmware-to-do)) |

## GPIO map

The pins changed against the [Micro-Fit board](../hour-meter-board-microfit/README.md) are in bold. Each of the vehicle-side ports uses pins on the module's left side, which faces it, and the GPS port pins on the right side: the swaps took four long tracks across the board out of the routing. GPIO36 and GPIO39 dip low for about 80 ns whenever the ADC powers up ([Espressif errata GPIO-3.11](https://docs.espressif.com/projects/esp-chip-errata/en/latest/esp32/03-errata-description/esp32/gpio-inputs-pulled-down.html)), so only VIN_SENSE and the IMU interrupt use them; no UART receiver or pulse input does.

| GPIO | Function | | GPIO | Function |
|---|---|---|---|---|
| 0 | BOOT button, auto-program | | 19 | P2 LED |
| 1, 3 | UART0: CH340C (USB) | | 21, 22 | I2C SDA, SCL |
| 2 | STATUS LED | | 23 | DOUT1 control |
| **4** | **GPS PPS** (was RS485 TX) | | 25 | RS485 DE |
| 5 | USR LED | | 26 | DIN2 (pulse counter) |
| 12 | not connected (strapping pin) | | 27 | DIN1 (alternator) |
| 13 | RTC interrupt | | **32** | **UART2 TX: RS232** (was GPS) |
| **14** | **RS485 TX** (was IMU interrupt) | | **33** | **CAN TX** (was a test pad) |
| **15** | **CAN RX** (was a test pad) | | **34** | **UART2 RX: RS232** (was VIN_SENSE) |
| **16** | **GPS: to the GPS's RX** (was UART2 RX) | | 35 | RS485 RX |
| **17** | **GPS: from the GPS's TX** (was UART2 TX) | | **36** | **VIN_SENSE (ADC1)** (was GPS) |
| 18 | P1 LED | | **39** | **IMU interrupt** (was GPS PPS) |

- **Strapping pins:** GPIO15 (CAN RX) is held high by the idle bus at reset, which is its default; GPIO4 is not a strapping pin.
- **Input-only pins** (34, 35, 36, 39) carry inputs only: RS232 RX, RS485 RX, VIN_SENSE, IMU interrupt.

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

- **Stock:** the header is the tightest part (640 at JLCPCB on 2026-10-30): enough for 10 boards, check before a larger order.
- **Wire:** 20 AWG for VIN, GND and DOUT1; 22–24 AWG for signals; a twisted pair for CAN_H/CAN_L and for RS485 A/B.

**Wiring:**
- **Supply:** VIN (9) from a fused +12 V, with a 1 A fuse at the battery end; GND (1) to the battery negative. In a 24 V vehicle, feed VIN from a 24 → 12 V converter ([PINOUT.md](PINOUT.md#supply)). A negative ISO 7637-2 pulse 1 drives the reverse-polarity diode D103 into avalanche; the simulated fix is for the next revision ([SIMULATION.md](SIMULATION.md#what-still-applies-from-the-micro-fit-board)).
- **CAN:** CAN_H on 13, CAN_L on 5, the bus ground on 2 ([CAN port](#can-port)).
- **RS485:** A on 14, B on 6, the bus ground on 2.
- **RS232:** the board's TX on 3, RX on 12, ground on 2 ([RS232 port](#rs232-port)).
- **AIN1 with a 5 V sensor:** supply from 4, signal on 11, ground on 2: three neighbouring cavities.
- **DOUT1:** the load between a fused +12/24 V and 10.
- **DIN1, DIN2:** the signals on 15 and 16, their return on 7 or 8 (DIN COM, not connected to GND on the board).

**Why this pin order:**
- **Vehicle nets on the back row.** VIN, DOUT1, AIN1, DIN1 and DIN2 sit on the back (upper) row and leave the header straight into the board. Their 0.8 mm clearance leaves no room for a track between two of them, so each front-row signal leaves between a back-row pair with at most one vehicle net.
- **Module order.** The signals then leave J1 top to bottom as RS485 A, B | CAN_L, CAN_H | +5 V | RS232 RX, TX | AIN1 | DOUT1 | VIN. Each module sits on the board in that same order, so no two modules' tracks cross. RS485 A and B are swapped against the Micro-Fit board for the same reason.
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
- **JP1002 (LISTEN-ONLY, open):** bridged, the transceiver is held silent: the board can only listen, guaranteed by hardware. Some fleet installations require this on a vehicle bus. Open, the firmware chooses between normal mode (needed for OBD-II requests) and listen-only mode.

**Limits:**
- **One bus, classic CAN:** the ESP32's TWAI controller handles one bus at one bit rate, and classic CAN only. CAN FD frames read as errors, so on a bus that carries them the board must only listen.
- **Stub length:** the board reads 250 and 500 kbit/s buses from a stub of up to 3 m ([simulation](SIMULATION.md#1-can-bus-timing)). J1939 allows 1 m.
- **Faults:** a CAN wire on a 12 V or 24 V supply (up to 36 V) does no damage ([simulation](SIMULATION.md#2-can-and-rs485-lines-wired-to-a-supply)).

**Sources:**
- [ESP-IDF TWAI driver](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/twai.html), [TJA1051 datasheet](https://www.nxp.com/docs/en/data-sheet/TJA1051.pdf), [NUP3105L datasheet](https://www.onsemi.com/pdf/datasheet/nup3105l-d.pdf)
- [J1939 SPN 247, engine total hours](https://docs.dimo.org/dimo-explorer/field-descriptions-in-detail/j1939-heavy-truck/engine-signals/enginetotalhoursofoperationj1939-spn-247); OBD-II protocols ([python-OBD protocol list](https://py-obdii.readthedocs.io/en/latest/api/protocols.html)) and [connector pinout](https://ricksfreeautorepairadvice.com/obd-ii-connector-pinout-diagrams/)
- Teltonika: [FMC640 Manual CAN](https://wiki.teltonika-gps.com/view/FMC640_Manual_CAN_IO), [FMB140 CAN adapters](https://wiki.teltonika-gps.com/view/FMB140_CAN_adapters), [ALL-CAN300](https://shop.ascend.de/en/products/teltonika-telematics-all-can300-can-reading-can-alc300ruvs01), [FMB003](https://www.wisp.pl/p7801,teltonika-fmb003.html), [ECAN02](https://www.pbtech.com/product/NETTTK2201/Teltonika-ECAN02-CAN-Adapter-for-Contactless-Acces)

## RS232 port

- **The part:** a MAX13223E on UART2 (GPIO32 TX, GPIO34 RX: the module's left side, which faces the port), always on, at 3.3 V.
- **Ratings:** ±6.3 V into the worst EIA-232 load (3 kΩ + 2500 pF), up to 250 kbit/s.
- **Why this part and not a MAX3232:** its TX and RX survive ±70 V. A MAX3232-class part (±13.2 V on TX, ±25 V on RX) is destroyed by a wire to a 24 V supply, and by some J1 neighbour shorts. The cost: about $3 more per board (C118523 against the SP3232EEY basic part, C13482), and 8 mA always on.
- **UART2 is shared** with the GPS port through the GPIO matrix, as on the Micro-Fit board: the firmware uses one of the two at a time.
- **Wiring:** to a DB9 device (DTE): its RXD (DB9 pin 2) to J1 pin 3, its TXD (DB9 pin 3) to J1 pin 12, its GND (DB9 pin 5) to J1 pin 2.

## Other ports

| Ref | Port | Connector (LCSC) | Where |
|---|---|---|---|
| J802 | GPS | JST GH 6-pin SM06B-GHS-TB (C133065), Pixhawk pinout | right edge, opening outward |
| TP801 | GPS PPS | 1 mm solder pad | beside J802 |
| J803 | Qwiic | JST SH 4-pin SM04B-SRSS-TB (C160404) | right edge, below J802 |
| J201 | USB-C | HRO TYPE-C-31-M-12 | right edge, beside the ESP32 |
| TP807, TP808 | probe pads | 1 mm pads | +3V3, GND |

- **The logic-level ports are on the right edge:** GPS and Qwiic sit with USB-C on the MCU side, away from the vehicle harness. On the Micro-Fit board they were on the left edge with J1.
- **GPS supply:** JP801 selects 3.3 V (as delivered, 1-2 bridged) or 5 V (cut 1-2, bridge 2-3, fused by F803).

## Indicator LEDs

Three green side-view LEDs (LTST-S270TGKT) sit on the right edge with their lenses at the board edge, as on the Micro-Fit board: P1 (GPIO18), P2 (GPIO19), USR (GPIO5).

## Solder jumpers

| Jumper | Function | As delivered | Change it when |
|---|---|---|---|
| JP1001 | CAN 120 Ω termination | open | the board ends a CAN bus: bridge it |
| JP1002 | CAN listen-only (transceiver silent) | open | a vehicle bus must never see the board transmit: bridge it |
| JP702 | RS485 120 Ω termination (A to B) | open | the board is at one end of the bus: bridge it |
| JP703 + JP704 | RS485 bias: A to 3.3 V and B to GND, 330 Ω each | open | nothing else on the bus biases it: bridge both, on one node only |
| JP501 | EEPROM write protect | open (writes on) | bridge it to lock the EEPROM |
| JP801 | GPS supply | 1-2 bridged (3.3 V) | for a 5 V GPS: cut 1-2, bridge 2-3 |

## Layout

Signal flow runs left to right, from the vehicle harness to the MCU:

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
- **The protection column:** every bus meets its protector right behind its J1 pins, in pin order: D701 (RS485), D1001 (CAN), F801 (+5 V out), C901 + R904 (AIN1 pulse capacitor and 4–20 mA shunt), then the AIN1 divider R901/R902.
  - Only the low-voltage divider foot travels on to the ADC.
  - A 6 mm corridor between J1 and the column lets the lines fan out first.
- **The modules behind it,** each around its IC, in J1's order: RS485 (THVD2410, its jumpers, pull-ups), CAN (TJA1051, jumpers, decoupling), RS232 (MAX13223E with its charge-pump capacitors on the far side), DOUT1 (BSP75N with its drain toward J1, the 5 V buffer behind).
- **Transceiver orientation:** every transceiver's bus pins face J1 and its logic pins face the MCU.
- **The supply:** the 9–30 V input chain (F101, VIN sense, reverse-polarity diode, TVS) runs down the left edge to the LM2596 stage along the bottom edge.
  - The stage keeps the Micro-Fit board's arrangement, with the hot loop Cin–U101–D105 kept short.
  - The 3.3 V regulator sits by the ESP32.
- **Quiet zone:** the IMU stays at the top middle, as on the Micro-Fit board. The magnetometer (U602) is at least 26 mm from every current or magnet:

  | J1 | Coin cell | LM2596 / L101 | DOUT1 switch | USB-C | ESP32 |
  |---|---|---|---|---|---|
  | 36.6 mm | 37.8 mm | 71.8 / 71.5 mm | 42.9 mm | 40.3 mm | 26.1 mm |

- **IMU turned (hand edit, 2026-11-02):** both IMU chips sit 3.4 mm further right and are turned 270° (pin 1 at the top right).
  - Their x axis, which the firmware takes as the nose, now points at the bottom edge; y points at the right edge. At 0°, as on the Micro-Fit board, x pointed at the right edge and y at the top edge.
  - With the box mounted as before, roll and pitch swap and the compass heading turns by 90°. Either turn the IMU back to 0° or remap the axes in the firmware ([Firmware to do](#firmware-to-do)).
  - Both chips turned together, so the magnetometer still lines up with the accelerometer.

- **GPS block:** the lines come down from the ESP32 as PPS, RXD, TXD and step into their 100 Ω resistors from the left. Each resistor's connector side faces U802 (ESD array, turned 180°) and J802, so the block routes without crossings.
- **Blocks from the Micro-Fit board:** the DIN island (same coordinates, slots and barrier), the ESP32/USB block and the LM2596 stage (moved as whole blocks). The IMU block came over unchanged; it has since been moved and turned by hand.
- **AIN1:** its front end is 36.8 mm from the LM2596 switch node (`check` wants ≥ 8 mm).

## Routing and grounding

| Rule | Value | Why |
|---|---|---|
| Layers | signals on top; the bottom is a GND pour, crossed by the logic lines' bottom-layer runs (27 % of the track length) | a return path under every signal (Espressif, TI SLYT499) |
| Freerouting costs | a via costs 80; a bottom-layer track 2.5× a top one; GND a plane during routing | keeps the bottom layer ground; GND pads get vias, not tracks |
| Default tracks | 0.25 mm, 0.15 mm clearance | non-dense board; JLCPCB minimum 0.10/0.10 |
| Bus pairs | CAN, RS485, RS232: 0.3 mm, 0.2 mm clearance | robust, routed as pairs |
| Supply tracks | routed at 0.3–0.5 mm, then widened where clearances allow: +3V3 0.5, +5V 0.8, VIN / DOUT1 1.0, LM2596 loop 1.0–1.5 mm | IPC-2221, 1 oz outer, 10 °C rise: 0.3 mm per amp; margin for ±20 % etch |
| Vehicle nets | 0.5 mm, 0.8 mm clearance | ISO 7637 pulses on harness lines; IPC-2221 needs 0.6 mm at 31–100 V uncoated |
| Vias | 0.6/0.3 mm (signal, GND), 0.5/0.25 mm (11 plane and island vias), 0.8/0.4 mm (supply, vehicle) | JLCPCB standard price |
| GND stitching | 5 mm grid over the board, 2.5 mm along the edges by the ESP32; 1.2 mm from any other hole | λ/20 at 2.4 GHz in FR-4 is about 3 mm; ties the two pours together |
| Keep-outs | no copper under the IMU packages (both layers under the MPU-6500); 0.45 mm strips at the board edge and slots; the DIN island's barrier | MPU-6500 datasheet; JLCPCB copper-to-edge |

- **Teardrops:** not added by the script; KiCad's pcbnew Python API has no teardrop call. JLCPCB recommends them on narrow tracks leaving pads. They can be added in KiCad: *Edit → Edit Teardrops*, then refill.

**The result** (`report` and the measured track lengths at this revision):

| | |
|---|---|
| Track length | 2683 mm on top (70 %), 1176 mm on the bottom (30 %) |
| Vias | 143 on signals and supplies, 186 on GND (stitching, plane and island vias) |
| GND pour | 56 % of the top, 78 % of the bottom |
| Bus lines from J1 | CAN_H/L 33/36 mm, RS485 A/B 30/37 mm, RS232 TXD/RXD 28/23 mm. On the bottom: CAN_L 4 mm, RS485 A/B 10/11 mm, and RS232 TXD for its whole run from under the MAX13223E to J1 (26 mm) |
| Longest logic lines | I2C 201–206 mm (five devices); DOUT1 control 127 mm; GPS 74–78 mm; UART2 76–79 mm; CAN RX/TX 70/55 mm |
| Supply tracks | after `widen`: VIN chain 1.0 mm, LM2596 switch node 1.4–1.5 mm, DOUT1 ≥ 0.85 mm, +5V ≥ 0.4 mm (0.8 mm on 73 % of it), +3V3 0.5 mm on 60 % of it, down to 0.25 mm at pad necks and 0.2 mm on the hand-routed IMU feeds (a few milliamps) |

**How the routing was finished.** `route` and `finish` left 7–14 connections open: long logic lines boxed in at the ESP32 and at the MAX13223E. Then:
1. **Pin moves** gave the GPS, RS232 and IMU lines pins that face their modules ([GPIO map](#gpio-map)). The GPS block was turned to face J802.
2. **`reroute` passes** closed the GPS block, the USB pair and DIN1. Each pass rips up a set of nets with their neighbours (for USB: VBUS, the CC lines, UART0) and re-routes. A pass is kept only when DRC improves.
3. **Hand work, kept only in the board file:**
   - The two UART2 lines leave the MAX13223E on its J1 side (its logic and line pins share one side) and turn up to vias above the chip.
   - Their runs to the ESP32 were found with a grid (A*) router, then checked by DRC.
   - The LIS3MDL corner (U602's pins and C603) takes the Micro-Fit board's routing; the IMU block sits at the same relative position. This frees U602's GND pad 12, which the routed board had boxed in.
   - One GND via joins the pour pieces around the buttons.
4. **Clean-up:** 52 duplicate segments and the dangling vias removed; the USB-C shell pad starved of spokes made solid; three over-close GND via pairs thinned.
5. **Hand edits in KiCad (2026-11-02):** 19 parts moved or turned in the VIN chain, the buck, the EN and VIN_SENSE parts and the RS485/RS232 decoupling, the routing around them redone, and the board moved on the sheet. `MODULES` in `tools-pcb.py` carries the new positions. `widen` then brought the supply tracks back to their widths, and the pours were refilled.
6. **Second round of hand edits (2026-11-02):** the IMU (both chips turned, its capacitors and I2C pull-ups), the EN and VIN_SENSE RCs and the DIN opto-output parts moved, and their routing was redone by hand. Then:
   - **Keep-outs:** the IMU's bottom-layer keep-outs had stayed at the old position. They are rebuilt on the chips, and one GND via moved 1 mm out of the new MPU-6500 keep-out.
   - **Open lines:** the ESP_EN stub at C203 closed. RS485_DE, RS485_RX, UART2_RX and UART2_TX were left open between the ESP32 and the transceivers. Freerouting, with every other track locked, closed only UART2_TX. The grid router closed all four at 0.25 mm, on 0°/45°/90° lines, without moving other tracks. Of four routing orders tried, the kept one has no detour: 103 mm of track and 8 vias for the four.
   - **Widths:** `widen` was not run again, so the hand-routed tracks keep their widths.
   - **Script:** `MODULES` carries the new positions. `match_board` now measures the board's offset on its outline, because the IMU it used to measure on had moved.

**Weak points:**
- **Long logic lines.** The lines crossing to the ESP32 are long, and some run on the bottom for a stretch: CAN TX 45 mm, GPS PPS 56 mm.
- **Why that is acceptable.** They are slow (UART ≤ 115 kbaud, the CAN logic side ≤ 1 Mbit/s, I2C 100 kHz). The stitching vias tie the cut pour back together.
- **Re-routing.** Running `route` again replaces all of this; use `reroute` with net sets for local changes.
- **Buck switch node.** As on the Micro-Fit board, the catch diode D105 sits about 16 mm from the LM2596's switch pin, and the LM_SW copper is 31.5 mm long (24.7 mm before the hand edits moved D105 and L101). It is a 150 kHz stage, 71 mm from the magnetometer, but tighter is better: the [LM2596 datasheet](https://www.ti.com/lit/ds/symlink/lm2596.pdf) asks for short switch-node and diode leads.

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

The board is ready; the firmware gets its own plan:
- **CAN:** BoardPins `kCanTx = 33`, `kCanRx = 15`; the ESP-IDF TWAI driver.
  - Listen-only by default.
  - Bit-rate detection: try 250 and 500 kbit/s in listen-only mode.
  - J1939/FMS decoding: PGN 65253 / SPN 247 gives the engine hours directly.
  - OBD-II PID polling in normal mode.
  - A configurable "any broadcast CAN" table.
- **RS232 and GPS on UART2:** RS232 on RX GPIO34 / TX GPIO32, the GPS on RX GPIO17 / TX GPIO16 (on the Micro-Fit board the TTL port had GPIO16/17 and the GPS GPIO36/32); limit `uartBaud` to 115200 for RS232 cables.
- **Moved pins:** RS485 TX GPIO14 (was GPIO4), IMU_INT GPIO39 (was GPIO14), GPS PPS GPIO4 (was GPIO39), VIN_SENSE GPIO36 (was GPIO34). See [GPIO map](#gpio-map).
- **IMU interrupt on GPIO39:** the pin dips low for about 80 ns each time the ADC powers up (errata GPIO-3.11). Keep the ADC unit open (powered) after the first VIN_SENSE reading, or confirm an interrupt in the IMU's status register before acting on it.
- **IMU axes, if the IMU stays turned:** both chips are turned 270° ([Layout](#layout)). For the Micro-Fit board's axes, read each accelerometer, gyro and magnetometer sample (x, y, z) as (y, −x, z).
- **As on the Micro-Fit board:** AIN1, DOUT1 and the indicator LEDs ([I/O board to do](../hour-meter-board-compact-lm2596-io/README.md#firmware-to-do)).

## Before you order

The [LM2596 board's notes](../hour-meter-board-compact-lm2596/README.md#before-you-order) apply, as on the Micro-Fit board:
- Standard PCBA on both sides, since BT401 is on the bottom;
- all through-hole parts selected (J1 and BT401);
- the tooling-rail remark for the antenna overhang;
- **Order Number → Specify Position** (the mark is on the bottom silkscreen).

In addition:
1. **R904 is not fitted.** It is left out of the BOM and CPL. Hand-solder a 120 Ω 0.1 % 1206 resistor for a 4–20 mA sensor.
2. **The harness plug is not part of the assembly.** Add the 43025-1600 housing (C293527) and 16 × 43030-0007 terminals (C293530) to the LCSC order ([J1](#j1-harness-connector)).
3. **The solder jumpers come open,** apart from JP801 (1-2). Set the CAN and RS485 jumpers for the bus the board joins ([Solder jumpers](#solder-jumpers)).
4. **In the placement preview,** check:
   - the LED lenses face the right edge;
   - BT401's + clip sits on pin 1;
   - J1's mating face is at the left edge;
   - pin 1 of U1001 (TJA1051) and U1101 (MAX13223E) is where the board's marking shows it.

   The CPL already carries JLCPCB's rotations.

### JLCPCB check

Checked on 2026-10-30, last re-run on 2026-11-02, against [JLCPCB's PCB capabilities](https://jlcpcb.com/capabilities/pcb-capabilities) and [assembly capabilities](https://jlcpcb.com/capabilities/pcb-assembly-capabilities), for 2 layers, 1.6 mm and 1 oz copper. The limits ran as KiCad custom rules on a scratch copy of the board: 0 violations.

**Fabrication:**

| Item | JLCPCB | This board |
|---|---|---|
| Copper layers | 2 | 2: the Gerber zip holds L1 (top) and L2 (bottom) only |
| Track width, spacing | 0.10 mm, 0.10 mm | 0.15 mm minimum (one 1.5 mm I2C_SCL track; the rest 0.18–1.5 mm), 0.15 mm (0.2 mm on buses, 0.8 mm on vehicle nets) |
| Vias | 0.15 mm hole minimum. Under 0.3 mm with a pad under 0.45 mm costs extra | 0.30 / 0.60 mm (311), 0.25 / 0.50 mm (11), 0.40 / 0.80 mm (7): standard price |
| Through-hole annular ring | 0.20 mm (0.18 absolute, 0.25 recommended) | 0.20 mm (USB-C shell); J1 0.24 mm |
| Holes | PTH 0.15 mm, NPTH 0.5 mm | PTH 0.20 mm (the ESP32's GND-pad vias), NPTH 0.65 mm (USB-C pegs) |
| Slots | plated 0.5 mm wide and 2 × as long; milled 1.0 mm | USB-C shell 0.6 × 1.2 / 0.6 × 1.7 mm; DIN island 1.5 mm |
| Hole to hole, hole to copper | pads 0.45 mm, vias 0.2 mm; PTH to copper 0.28 mm | no violation |
| Copper to board edge | 0.2 mm | 0.3 mm (board rule) |
| Board size for Standard PCBA | 70 × 70 mm minimum | 100 × 100 mm |
| Silkscreen text | 1.0 mm high, 0.15 mm stroke | all 63 texts 1.0–1.2 mm high, 0.15–0.24 mm stroke |
| Silkscreen lines | 0.15 mm | **0.12 mm** (KiCad's library footprints): printed, may come out thin |

**Assembly:**
- **CPL rotations:** `production` turns or re-centres 24 parts to match JLCPCB's footprints (`JLC_PLACEMENT` in `tools-pcb.py`). New on this board:
  - J1 (C277731): 180°, centroid at the middle of the pad array;
  - U1001 (TJA1051T/3, SOIC-8) and U1101 (MAX13223E, TSSOP-20): 270°;
  - D701 and D1001 (SZNUP3105L, SOT-23): 180°.

  The Micro-Fit board's parts keep their corrections ([Micro-Fit board](../hour-meter-board-microfit/README.md#jlcpcb-check)).
- **How they were found:** each part's pads were fitted onto JLCPCB's footprint for the same LCSC part.

## Checks at this revision

| Check | Result |
|---|---|
| ERC | 0 errors; 2 warnings: the IMU address straps tie a bidirectional pin to the 3.3 V regulator's output, as intended |
| DRC (`--severity-all --schematic-parity --refill-zones`) | 0 errors, 0 unconnected items, schematic parity clean. 5 warnings: footprint silkscreen of U301/U302 at the DIN island's slots and of the ESP32's antenna at the top edge; JLCPCB clips silkscreen there. The saved zone fill is current (DRC without refilling: also 0 errors) |
| JLCPCB limits as custom rules | 0 violations ([JLCPCB check](#jlcpcb-check)) |
| Placement (`check`) | 0 issues, and `MODULES` places every part where the board has it. The magnetometer is at least 26.1 mm from every current or magnet (the ESP32 module is the nearest); AIN1 is 36.8 mm from the switch node |
| Short circuits at the connectors | every supply that leaves the board holds its fuse's or limiter's current: the narrowest tracks warm by at most 34 °C at the AMS1117's 1.5 A limit (0.25 mm pad necks on GPS_VCC and +3V3), every other path by 14 °C or less. The 0.2 mm +3V3 feeds at the IMU each join the rail at one point, so no connector current flows through them |
| Routing (`report`) | see [Routing and grounding](#routing-and-grounding) |
| Stock (`scripts/jlc-stock.ts --boards 10`) | every line in stock on 2026-11-02. **J1 (C277731) is down to 33**; next thinnest BSP75N 611, LIS3MDL 1139 |
| Simulations | re-run on 2026-11-02, results unchanged: [SIMULATION.md](SIMULATION.md) and, for the shared circuits, the [fault analysis](../fault-analysis/README.md) |

## Re-generating the board

```bash
python3 tools-pcb.py check        # placement: overlaps, slots, island, supply strip, AIN1-to-LM_SW and magnetometer distances
python3 tools-pcb.py place        # placed, unrouted board from MODULES in tools-pcb.py
JAVA_TOOL_OPTIONS=-Xmx2048m python3 tools-pcb.py route 2    # Freerouting with the costs above, best of 2 runs
JAVA_TOOL_OPTIONS=-Xmx2048m python3 tools-pcb.py finish 3   # close what is still open, plane vias, clean-up
JAVA_TOOL_OPTIONS=-Xmx2048m python3 tools-pcb.py reroute GPS_TXD,GPS_RXD,GPS_PPS USB_DP,USB_DM,VBUS -   # targeted passes, one per net set
python3 tools-pcb.py widen        # supply and vehicle tracks to their widths where clearances allow
python3 tools-pcb.py stitch       # GND stitching vias
python3 tools-pcb.py silk         # silkscreen labels on the routed board
python3 tools-pcb.py report       # vias, track length per layer, GND coverage
kicad-cli pcb drc --severity-all --schematic-parity --refill-zones hour-meter-board-microfit-can.kicad_pcb
python3 tools-pcb.py production   # production/: Gerber zip, BOM, CPL set for JLCPCB's footprints
python3 tools-pcb.py models       # JLCPCB 3D models into 3d/ (once per checkout), set on the board
```

- **Placement is code:** each module in `MODULES` is a block of parts around its IC. Move a module by changing its block, then `check`, `place` and route again.
- **Hand edits in KiCad:** parts and the whole board can be moved in KiCad. The scripts find the board's offset from its outline's top-left corner. After hand edits, write the new positions back into `MODULES`, so `check` and `place` match the board again.
- **Scratch scripts:** load the board from its real path. Loading a copy from `routing/` and saving it over the board writes default project settings into the `.kicad_pro`, and the net classes are lost.

## 3D models

`python3 tools-pcb.py models` downloads the JLCPCB/EasyEDA STEP files into `3d/` (source: JLCEDA/EasyEDA official library).
- **J1:** KiCad 10 has no model for the 2 × 8 Micro-Fit header, so it uses JLCPCB's (C277731), fitted to the footprint's pads. In the render, the housing sits at the left edge with every pin tail on its pad.
- **The rest:** as on the [Micro-Fit board](../hour-meter-board-microfit/README.md#3d-models).
