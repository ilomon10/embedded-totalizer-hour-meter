# Hour Meter main board (rev B, chip-down)

One PCB that replaces the rev-A module carrier. Every module the hour meter used (ESP32 DevKitC, 817 opto module, DS3231, AT24C256, MPU9250, MAX485) is drawn chip-down from JLCPCB in-stock parts. Each module has its own schematic sheet, and the root sheet joins them. The board runs from 5 V. The 9–36 V vehicle supply is a separate plug-on board, [PSU-B](../hour-meter-psu-b/README.md), so the converter can be swapped without touching the main board.

**Status: first draft.** The schematic is complete, and the PCB is placed and auto-routed so you can review it and refine it in KiCad. Read [Before you order](#before-you-order) first.

| | |
|---|---|
| Schematic | `hour-meter-board.kicad_sch` (root) + one sheet per module, listed below |
| PCB | `hour-meter-board.kicad_pcb`: 100 × 90 mm, 4 layers (F.Cu signal, In1.Cu GND plane, In2.Cu +3V3 plane, B.Cu signal) |
| Custom symbol | `hour-meter-board.kicad_sym` (MPU-6500, [pin map](#mpu-6500-symbol)) |
| Board scripts | `tools-build-pcb.py` (netlist → placed board), `tools-route-pcb.py` (planes → Freerouting → pours), `tools-finish-routing.py` (closes what Freerouting left open), `tools-production.py` (order files) |
| Order files | `production/`: Gerber zip, `BOM-hour-meter-board.csv`, `CPL-hour-meter-board.csv` (JLCPCB columns) |
| PDF | `hour-meter-board.pdf`: root + 8 module sheets |
| Stock check | `../../scripts/jlc-stock.ts <bom.csv> --boards N` (live JLCPCB API) |
| 2-layer variant | [`../hour-meter-board-2layer`](../hour-meter-board-2layer/README.md): the same circuit and placement, routed on 2 copper layers |
| Compact variant | [`../hour-meter-board-compact`](../hour-meter-board-compact/README.md): 80 × 70 mm, 2 layers, isolation slots, and the fault fixes below |
| Fault analysis | [`../fault-analysis`](../fault-analysis/README.md): on this board, an RS485 wire shorted to the vehicle supply destroys the RS485 port, and a shorted J804 / GPS 5 V pin overloads D101; the compact variant fixes both |

**Checks at this revision (2026-10-21):**
- **ERC (full hierarchy):** 0 errors, 2 warnings (both [intended](#erc-and-drc-notes)).
- **DRC:** 0 errors, 0 unconnected items, 0 schematic-parity issues. The 22 warnings are all [silkscreen](#erc-and-drc-notes).
- **Stock:** both production BOMs are in JLCPCB stock for 10 boards.

## Module → sheet

Each sheet is its own `.kicad_sch` file. You can plot it alone or reuse it in another project.

| Former module | Sheet | Chip-down parts | What changed vs the module |
|---|---|---|---|
| ESP32 DevKit(C) | `esp32-core` | ESP32-WROOM-32E-N4, CH340C, USB-C, USBLC6-2SC6, AMS1117-3.3 | CH340C instead of CP2102N, powered from 3V3 so UART0 is 3.3 V. The same 2-transistor auto-program circuit that `pio upload` and `hour-meter reset --hard` use. The board's only I2C pull-ups (4.7 k) |
| *(new)* | `power-input` | Screw terminal, 60 V PTC, PSU socket, SS34, VIN divider | Main board is 5 V; VIN goes to the PSU socket and to `VIN_SENSE` (GPIO34) |
| 817 module 2ch | `opto-inputs` | 2 × PC817C, M7, BZT52C4V7, 3 × 1 k per channel | Sized for 9–36 V. About 7 V threshold, so a key-on L terminal (< 2 V) reads OFF. No module LEDs: at 9 V they would take the opto's current. Isolated `VEH_GND`, JP301 to tie it to GND |
| DS3231 ZS-042 | `rtc-ds3231` | DS3231MZ+TRL, CR2032 holder | **No charging circuit.** No AT24C32. INT/SQW goes to GPIO13 |
| AT24C256 module | `eeprom-at24c256` | DIP-8 socket | Swappable chip, address 0x50, WP jumper J501 |
| MPU9250 GY-9250 | `imu` | MPU-6500 + LIS3MDL | The MPU-9250 is out of stock and discontinued. MPU-6500 is the same accel/gyro (the firmware already accepts it at 0x69). LIS3MDL is the compass at 0x1E |
| MAX485 module | `rs485` | SP3485EN (3.3 V), PSM712 TVS | Termination (J702) and fail-safe bias (J703, 330 R) on jumpers, both off by default |
| *(new)* | `ports` | JST-XH UART, GPS socket, Qwiic, 2×5 expansion | 5 V-tolerant UART RX buffer (74LVC1G17), SRV05-4 ESD, 200 mA fused 5 V on the UART port |

Reference schematics used: [ESP32-DevKitC V4](https://dl.espressif.com/dl/schematics/esp32_devkitc_v4_sch.pdf), [ZS-042 charging issue](https://forum.arduino.cc/t/ds3231-cr2032-vs-lir2032-warning-is-your-module-killing-the-battery/557346), [MAX485 module](https://protosupplies.com/product/max485-ttl-to-rs-485-interface-module/), [PC817 2-ch module](https://www.codrey.com/?p=11341), [GY-9250](https://components101.com/sensors/MPU9250-9-dof-mems-sensor-module-datasheet-pinout-features-working), [AT24C256 module](https://www.tinytronics.nl/en/data-storage/modules/eeprom-module-256kb-at24c256), MPU-6500 datasheet PS-MPU-6500A-01.

## Connectors and jumpers

| Ref | What | Pins |
|---|---|---|
| J101 | Vehicle supply, 9–36 V (screw, 5.08 mm) | 1 VIN, 2 GND |
| J301 | Vehicle inputs (screw, 5.08 mm) | 1 ALT (alternator L/D+ or oil-pressure switch), 2 PULSE, 3 VEH_GND |
| J701 | RS485 (screw, 5.08 mm) | 1 A, 2 B, 3 GND |
| J201 | USB-C: configurator, firmware upload, power for bench use | |
| J801 | UART sensor port (JST-XH 2.5 mm) | 1 +5V (200 mA PTC), 2 TXD (out, 3.3 V), 3 RXD (in, 5 V tolerant), 4 GND |
| J802 | GPS card socket (2.54 mm, u-blox style) | 1 VCC (JP801: 3V3 default, 5V option), 2 GND, 3 GPS TX → ESP, 4 GPS RX ← ESP, 5 PPS |
| J803 | Qwiic I2C (JST-SH 1 mm) | 1 GND, 2 +3V3, 3 SDA, 4 SCL |
| J804 | Expansion 2×5 | 1 +3V3, 2 +5V, 3 IO5, 4 IO18, 5 IO19, 6 IO23, 7 IO15, 8 IO33, 9–10 GND. IO5 and IO15 are strapping pins; don't pull them low at boot |
| J102 | PSU-B socket 2×3 | 1 VIN, 2 GND, 3 +5V_PSU, 4 +5V_PSU, 5 GND, 6 VIN. The pinout is symmetric, so a board plugged in rotated 180° still sees the same pins. PSU-B's header sits on *its* bottom side: KiCad's socket footprint is the mirror image of the header footprint, so only a flipped header lines up pin for pin |
| J501 | EEPROM write-protect | Shunt fitted = read-only |
| J702 | RS485 termination 120 R | Fit on the two nodes at the bus ends only |
| J703 | RS485 fail-safe bias (330 R to 3V3 / GND) | Fit both shunts on exactly one node. Idle A–B is 0.28 V with both ends terminated |
| JP301 | Solder jumper VEH_GND–GND | Open (default) = opto inputs isolated |
| JP801 | Solder jumper GPS VCC | 1-2 bridged = 3V3 (default); cut and bridge 2-3 for 5 V |

## ESP32 pin map

| GPIO | Function | GPIO | Function |
|---|---|---|---|
| 0 | BOOT button, auto-program | 21 / 22 | I2C SDA / SCL |
| 1 / 3 | UART0 ↔ CH340C (USB) | 25 | RS485 DE (UART1 RTS in RS485 half-duplex mode) |
| 2 | Status LED (yellow) | 26 | PULSE input (active low) |
| 4 | RS485 TX (UART1) | 27 | ALT input (active low) |
| 5, 15, 18, 19, 23, 33 | Expansion J804 | 32 | GPS RX (ESP TX) |
| 12 | Not connected (strapping pin) | 34 | VIN_SENSE (ADC1_CH6) = VIN × 5.6/105.6 |
| 13 | RTC INT/SQW | 35 | RS485 RX (UART1) |
| 14 | IMU INT | 36 / 39 | GPS TX (ESP RX) / GPS PPS |
| 16 / 17 | UART2 RX / TX (sensor port) | EN | RESET button, auto-program |

I2C addresses: LIS3MDL 0x1E, AT24C256 0x50, DS3231 0x68, MPU-6500 0x69, and anything on Qwiic (a u-blox GPS answers at 0x42).

The ESP32 has three UARTs: USB uses UART0, RS485 uses UART1, and the sensor port uses UART2. GPS shares UART2 through the GPIO matrix (firmware setting), or connects over I2C through Qwiic.

## Power

```
J101 9-36 V ─ F101 PTC 60 V/0.5 A ─ VIN_RAW ─┬─ J102 ─► PSU-B (TVS, reverse diode, TPS54360B) ─► 5.28 V ─ J102 ─ D101 SS34 ─┐
                                              └─ D102 ─ 100k/5.6k ─ VIN_SENSE (GPIO34)                                    ├─ +5V
USB-C VBUS ─ F201 0.5 A ─ USBLC6 ─ D201 B5819W ──────────────────────────────────────────────────────────────────────────┘
+5V ─ AMS1117-3.3 ─ +3V3 (In2.Cu plane)        +5V ─ F801 0.2 A ─ UART port pin 1
```

USB alone powers the whole board for bench work. On USB only, +5V is about 4.6 V, which is enough for the AMS1117; the DevKitC has the same margin.

## How the board was routed

1. **Freerouting:** `tools-route-pcb.py` left 14 connections open in the densest spots: the IMU QFN, the USB pair, the I2C bus and the ESP32 pin edges.
2. **Finishing:** `tools-finish-routing.py` closed them:
   - **More Freerouting:** extra passes starting from the routed board, ripping up the still-open nets first.
   - **Plane vias:** GND and +3V3 pads still open get a short stub to a via down to their plane.
   - **Strap-pin escapes:** U601 pins 22 (nCS → +3V3) and 11 (FSYNC → GND) each get a short stub straight out of the QFN to a via. For pin 22 a GND trace in the way was removed, since GND reaches the In1 plane anyway.
   - **Island vias:** a via inside each F.Cu GND pour island that had no other way to the plane.
3. **Acceptance:** every step was checked with KiCad's DRC and kept only if it closed connections without adding errors.

## Before you order

The PCB is an auto-routed first draft. Check these in KiCad:

1. **Placement.** Parts were placed by `tools-build-pcb.py` (PLACEMENT table). Move anything you like there, or in KiCad directly.
2. **USB D+/D−.** They are routed and connected, but Freerouting does not route differential pairs. For a cleaner 12 Mbit/s link, re-route USB_DP/USB_DM as a short, length-matched 90 Ω pair through the USBLC6 pads (about 0.2 mm / 0.15 mm on JLC04161H-7628).
3. **Magnetometer clearance.** Keep U602 (LIS3MDL) as far as you can from the PSU-B board, the coin-cell holder (steel), the screw terminals and the USB-C shell. Calibrate after assembly (`esp32/docs/CALIBRATION.md`).
4. **ESP32 antenna.** Nothing may sit inside its courtyard band along the top edge. The router already keeps all copper out of it.
5. **JLCPCB order:** 4 layers, 1.6 mm, JLC04161H-7628 stackup, Economic PCBA, top side.
   - **THT parts:** the screw terminals, headers, DIP socket and coin-cell holder are through-hole. Order JLC THT assembly or hand-solder them.
   - **EEPROM chip:** not assembled. Insert an AT24C256 / 24LC256 DIP-8 (LCSC C434602) into the socket yourself.
   - **Rotations:** check every rotation in JLCPCB's placement preview.
6. **Stock:** run the stock check on the day you order:
   ```bash
   kicad-cli sch export bom --fields 'Reference,Value,Footprint,LCSC,${QUANTITY}' \
     --labels 'Designator,Comment,Footprint,LCSC,Qty' --group-by 'Value,Footprint,LCSC' \
     --ref-range-delimiter '' -o bom.csv schematic/hour-meter-board/hour-meter-board.kicad_sch
   ./scripts/jlc-stock.ts bom.csv --boards 10
   ```

## Bring-up

1. **Before fitting PSU-B, on USB:**
   - the red LED is on;
   - +3V3 measures 3.30 V;
   - `lsusb` shows a QinHeng CH340;
   - `cd esp32 && pio run -e bench -t upload` works without pressing BOOT, which proves auto-program.
2. **Hard reset:** `hour-meter reset --hard --port /dev/ttyUSB0` resets the board.
3. **Bench firmware:** it finds 0x50, 0x68 and 0x69. The LIS3MDL at 0x1E needs the firmware follow-up below.
4. **Inputs:** with 12 V on J301-1 and J301-3, GPIO27 reads LOW; at 2 V it reads HIGH. Repeat on PULSE.
5. **PSU-B:** test it alone first (see its README), then plug it in. VIN 12 V and 24 V give +5V ≈ 4.9 V, and `VIN_SENSE` reads VIN × 0.053.
6. **RS485:** loop back through a USB-RS485 dongle with J702 fitted.

## Firmware changes this board needs

These are not done yet; they need a separate plan.

- **`esp32/include/BoardPins.h`:** RS485 TX 4 / RX 35 / DE 25, GPS 36/32/39, VIN_SENSE 34, RTC_INT 13, IMU_INT 14, LED 2.
- **RS485 transport:** UART1 in RS485 half-duplex mode.
- **IMU:** a LIS3MDL driver behind a magnetometer interface. The MPU-6500 already works through `Mpu9250.cpp`, minus heading.
- **VIN_SENSE:** battery voltage, alternator charging and early power-fail flush.
- **Other:** GPS (NMEA/UBX), and a persistent "powered seconds" counter.

## MPU-6500 symbol

Source: TDK InvenSense PS-MPU-6500A-01 rev 1.1, Table 10 and pin-out figure (top view). Footprint: `Sensor_Motion:InvenSense_QFN-24_3x3mm_P0.4mm`. Its 24 pads are numbered counter-clockwise from pin 1 at the top left, and the exposed die pad is left unsoldered, as in KiCad's MPU-9250 footprint. Each lead uses the same number for its symbol pin and its pad.

| Lead | Name | Symbol pin type | Connection here |
|---|---|---|---|
| 1–6, 14–17 | NC | no_connect | open |
| 7 | AUX_CL | output | open |
| 8 | VDDIO | power_in | +3V3, 10 nF |
| 9 | AD0/SDO | bidirectional | +3V3 (address 0x69) |
| 10 | REGOUT | passive | 100 nF to GND |
| 11 | FSYNC | input | GND |
| 12 | INT | output | IMU_INT (GPIO14) |
| 13 | VDD | power_in | +3V3, 100 nF |
| 18 | GND | power_in | GND |
| 19 | RESV | no_connect | open ("do not connect") |
| 20 | RESV | passive | GND ("connect to GND") |
| 21 | AUX_DA | bidirectional | open |
| 22 | nCS | input | +3V3 (I2C mode) |
| 23 | SCL/SCLK | input | I2C_SCL |
| 24 | SDA/SDI | bidirectional | I2C_SDA |

KiCad's MPU-9250 symbol is **not** a drop-in: its pin 1 is RESV→VDDIO, while on the MPU-6500 pin 1 is NC.

## ERC and DRC notes

- **ERC warnings (2), intended:** MPU-6500 AD0 and LIS3MDL SA1 (bidirectional pins) are strapped to +3V3 to set their I2C addresses. KiCad flags any bidirectional pin tied to a power output.
- **DRC warnings (22), silkscreen only:** reference designators that overlap other silkscreen (17), sit on a pad (4, from R401, SW201 and C202) or come close to the board edge (1: H102). JLCPCB clips silkscreen off pads, so they are cosmetic. Move the references in KiCad if you want a clean silk layer.
- **CH340C V3:** it reaches +3V3 through R213 (0 R). The datasheet ties V3 to VCC at 3.3 V, but KiCad's symbol types V3 as a power output, so a direct wire would be an ERC error.
- **Konnect symbols are all in_bom=yes:** this includes the mounting holes and solder jumpers. `jlc-stock.ts` reports those lines as BOARD-ONLY. Untick "in BOM" in KiCad if you prefer.

## Re-generating the board

```bash
python3 tools-build-pcb.py check   # overlaps only
python3 tools-build-pcb.py place   # netlist -> footprints -> placement (edit PLACEMENT)
python3 tools-route-pcb.py 4       # GND plane + antenna keep-out -> Freerouting x4, keep the best -> pours
python3 tools-finish-routing.py 3  # close what Freerouting left open (exit 1 if anything still is)
kicad-cli pcb drc --severity-all --schematic-parity hour-meter-board.kicad_pcb
python3 tools-production.py        # production/: Gerber zip, BOM-*.csv, CPL-*.csv (JLCPCB format)
python3 tools-production.py ../hour-meter-psu-b/hour-meter-psu-b.kicad_pcb   # same for PSU-B
```

- **Routing results vary:** Freerouting gives different traces on every run, so `tools-route-pcb.py N` routes N times and keeps the board with the fewest unconnected items. Every try starts from the placed board.
- **Netclasses:** Default, Power, Plane and Vehicle are stored in `hour-meter-board.kicad_pro`.
- **2-layer variant:** `../hour-meter-board-2layer/tools-pcb.py` runs these same scripts on its own copy of the project, with 2 copper layers.
- **Hand edits:** to refine by hand, open the project in KiCad, move parts and use the interactive router. The scripts are only needed for a full regeneration.
