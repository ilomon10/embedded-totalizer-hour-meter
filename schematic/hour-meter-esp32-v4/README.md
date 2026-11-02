# Hour Meter ESP32 V4: module carrier PCB (rev C)

An 88 × 71 mm, 2-layer, through-hole carrier for ready-made modules from Indonesian electronics shops:
- the ESP32 DevKit V4 (USB-C, 38 pins);
- the 2-channel PC817 "817 Module";
- the GY-9250 (MPU9250/6500);
- the DS3231 ZS-042 RTC;
- the AT24C256 EEPROM.

The DevKit's USB-C is the only supply. Vehicle wires go to screw terminals, and every other part is a common THT part.

This replaces [rev A](../hour-meter-esp32/README.md), the 30-pin DevKit V1 + LM2596 carrier, on half its area. The firmware pins are unchanged.

![3D view of the board](hour-meter-esp32-v4-3d.png)

| | |
|---|---|
| Schematic | `hour-meter-esp32-v4.kicad_sch` (PDF: `hour-meter-esp32-v4.pdf`, picture: `hour-meter-esp32-v4.png`) |
| PCB | `hour-meter-esp32-v4.kicad_pcb` (pictures: `hour-meter-esp32-v4-pcb.png`, `hour-meter-esp32-v4-3d.png`) |
| Ready to order | `production/hour-meter-esp32-v4-gerbers.zip` (Gerbers + drill files) |
| Parts list | `production/hour-meter-esp32-v4-bom.csv`: what to buy, with the search terms local shops use |
| Check before ordering | `production/hour-meter-esp32-v4-fit-check-1to1.pdf`: print at 100 % and lay the modules on it |
| Custom parts | `hour-meter-modules.kicad_sym` (symbols), `hour-meter-modules.pretty/` (footprints, from `tools-gen-footprints.py`) |
| Input simulations | [fault analysis](../fault-analysis/README.md), *V4 module carrier* group |

**Checks at release:**
- ERC: 0 errors, 0 warnings.
- DRC: 0 errors, 0 warnings, 0 unconnected, 0 schematic mismatches.
- 2 copper layers; the Gerbers hold copper L1/L2 only.
- No logic copper in the vehicle zone.

## What is on the board

| Ref | Part | Connects to |
|---|---|---|
| U1 | ESP32 DevKit V4 on 2 × 19 sockets. The antenna overhangs the top edge; the USB-C end points down | everything |
| M1 | 817 module on 4 M3 standoffs, above its own input protection | J1/J2 inputs → GPIO27/GPIO26 |
| M2, M3, M4 | DS3231, AT24C256 and GY-9250, lying flat on sockets, chip side up | I2C, 3V3 |
| J1, J2 | Screw terminals: alternator (D+/L) and 12/24 V pulse; pin 2 = vehicle ground | M1 inputs |
| J3 | Spare 2 × 5 header: UART2 and five GPIOs, 3V3 through F1 | U1 |
| D5 | Status LED (green, 3 mm) | GPIO2 |

| ESP32 pin | Use | | I2C address | Device |
|---|---|---|---|---|
| GPIO21 / 22 | I2C SDA / SCL (100 kHz, module pull-ups) | | 0x50 | AT24C256 (A0–A2 = GND) |
| GPIO27 | ALT_IN, from J1 through 817 channel 1 (LOW = running) | | 0x68 | DS3231 |
| GPIO26 | PULSE_IN, from J2 through 817 channel 2 | | 0x57 | AT24C32 on the ZS-042 (unused) |
| GPIO17 / 16 | UART2 TX / RX on J3 | | 0x69 | MPU9250 / 6500 (AD0 = 3V3) |
| GPIO4, 13, 25, 32, 33 | Spare, on J3 | | 0x0C | AK8963 magnetometer (MPU9250 only) |
| GPIO2 | Status LED D5, active high. **The firmware doesn't drive it yet** | | | |

J3, seen from the top (labels on the silkscreen, full pinout on the back):

```
upper row   2 GND    4 RX2 (IO16)   6 IO13   8 IO32   10 GND
lower row   1 3V3*   3 TX2 (IO17)   5 IO4    7 IO25    9 IO33        * through F1, 0.1 A PTC
```

J3 is for 3.3 V logic only, and nothing on it is vehicle-proof. GPIO12, 14 and 15 are left off: 12 and 15 are boot strapping pins, and 14 puts out PWM at boot.

## ⚠ Measure before you order

The module footprints use typical clone dimensions. **Print `production/hour-meter-esp32-v4-fit-check-1to1.pdf` at 100 %** (no "fit to page"). Check that the board outline measures 88 × 71 mm, then lay each module on its outline: the pins must land on the pads. If one doesn't fit, change its numbers in `tools-gen-footprints.py` and regenerate (see [the end](#regenerating-after-a-change)).

| Part | Assumed | Check |
|---|---|---|
| ESP32 DevKit V4 | 2 × 19 pins, rows **25.4 mm apart** (Espressif's DevKitC footprint), antenna about 7 mm beyond pin 1 | Some narrow 38-pin clones use 22.86 mm |
| 817 module | 38 × 29 mm, 4 × M3 holes **32 × 24 mm** apart | Only one seller lists the hole spacing |
| GY-9250 | 15.5 × 25.5 mm, 10 pins down the left edge; M3 holes 12 mm right of the pins, 0.5 mm and 21.6 mm below pin 1 | The holes come from a photo. If they don't line up, leave the two standoffs out |
| DS3231 ZS-042 | 38 × 22 mm, 1 × 6 pins on one short edge, 32K at the top | |
| AT24C256 | About 36 × 13.5 mm, 4 pins on one short edge: GND, SDA, SCL, VCC from the top | Other boards differ: match the labels |
| F1 | 5.0 mm lead pitch | |

## Ordering the PCB

Upload `production/hour-meter-esp32-v4-gerbers.zip` to a local PCB maker or to JLCPCB / PCBWay (both ship to Indonesia).

| Setting | Value |
|---|---|
| Layers, size | 2 layers, 88 × 71 mm, FR-4 1.6 mm, 1 oz copper |
| Finish, colour | HASL (lead-free is fine), any colour, silkscreen on both sides |
| Smallest track / gap | 0.4 mm / 0.3 mm (0.8 mm between vehicle and logic copper) |
| Smallest hole | 0.6 mm (vias, 1.2 mm pads); component holes 0.8–1.3 mm, mounting holes 3.2 mm |
| Silkscreen text | 1.0 mm and up |

These rules are coarser than most fabs need, so a local maker who can't do fine tracks can still make this board. No assembly service is needed.

## Buying the parts

Everything is in `production/hour-meter-esp32-v4-bom.csv`, with a search term for Tokopedia, Shopee or a shop counter. Besides the five modules and the THT parts, it lists:
- the female headers: 2 × 1×20 (cut to 19), 1×6, 1×4, 1×10;
- a 1×40 straight pin strip for re-fitting the module headers;
- 4 nylon M3 spacers (10–12 mm) for the 817 module;
- hook-up wire and a CR2032.

**D3/D4:** the 1N4744A (15 V, 1 W zener) suits 12 V vehicles, and 24 V vehicles whose alternator clamps load dump (all recent ones). On an older 24 V truck without that clamp, fit a **P6KE18A** TVS in the same holes instead ([simulation](../fault-analysis/README.md#results)).

## Preparing the modules

Every module lies flat, chip side up, on a standard 8.5 mm female socket. Each needs a straight pin header soldered on its underside, pointing down.

1. **817 module:** remove **both G jumpers**. With a jumper fitted, the vehicle ground and the ESP32 ground are joined and the isolation is gone ([WIRING.md](../../esp32/docs/WIRING.md#the-817-module)).
2. **DS3231 ZS-042:**
   - Remove the **charge resistor** (or its diode) beside the battery holder; a CR2032 is not rechargeable ([WIRING.md](../../esp32/docs/WIRING.md)).
   - Replace the right-angle header with a straight one on the battery side. The holder then faces the carrier; no parts sit under it.
3. **AT24C256:** set the A0, A1, A2 and WP jumpers to GND (address 0x50, writes allowed). Move its header to the underside.
4. **GY-9250:** solder its header on the underside.
5. **DevKit:** as sold.

## Assembly order

1. **Low parts first, including the ones that end up under modules:**
   - R1, R5, R7, C1, C2 and C4 go under the DevKit.
   - D1–D4, R4 and R6 go under the 817 module.
   - D1/D2 (1N4007) and D3/D4 (1N4744A) look alike: check the print. The band goes to the **K** mark.
2. **The other parts:**
   - F1, then C3 (long leg to the square + pad) and D5 (long leg to the round pad);
   - J1 and J2, with the wire entry facing the board edge;
   - J3.
3. **Sockets:**
   - 2 × 1×19 for the DevKit: plug the DevKit in while you solder them, so the rows stay parallel.
   - 1×6 (M2), 1×4 (M3) and 1×10 (M4).
4. **817 module:**
   - Solder 8 short wires (about 4 cm) into the **IN1 G IN2 G** and **V1 G V2 G** pads.
   - Mount the module on its 4 spacers.
   - Screw the wires into its terminals in the same order: inputs on the left, outputs on the right.
5. **Plug in the modules.** The pin names printed on each module must match the labels beside its socket.
6. **First power-up:**
   - Connect USB-C to a PC and open the [configurator](../../configurator/README.md) (`hour-meter /dev/ttyUSB0`).
   - Its Overview screen lists the modules and the device clock. `hour-meter read /dev/ttyUSB0 --imu` shows the IMU live.
   - Then check the inputs as in [WIRING.md](../../esp32/docs/WIRING.md#checking-it-with-a-multimeter-esp32-powered).

## In the vehicle

- **Power:** use a USB car charger with 5 V, 1 A or more, rated for 24 V if the truck is 24 V.
  - Its ground is usually the vehicle ground. The 817 module then still keeps vehicle spikes off the GPIOs, but the two grounds are no longer isolated.
- **Inputs:** J1 takes the engine-running wire (alternator D+/L or the oil-pressure switch) on pin 1 and vehicle ground on pin 2. J2 takes a 12/24 V pulse. To find the right wire, see [Pick the wire](../../esp32/docs/WIRING.md#pick-the-wire).
- **Mounting:** M3 screws in H1–H4, solidly fixed: the vibration check needs it.
  - H2 sits under the DevKit and H3 under the AT24C256. Unplug those modules to reach the screws.
  - The X and Y arrows on the silkscreen show the IMU axes; level the IMU with the configurator's calibration.

## Design notes

- **Power:**
  - The DevKit's 5V pin is unused, so nothing can back-feed the USB port.
  - All modules run from the DevKit's 3V3 regulator. This keeps their I2C pull-ups at 3.3 V; the ESP32's pins are not 5 V tolerant.
  - F1 (0.1 A PTC) feeds J3's 3V3, so a short outside the box can't pull the DevKit's 3V3 down.
- **Vehicle inputs:** each input runs through D1 (reverse polarity), R4 (1.5 kΩ, 1 W, current limit) and D3 (15 V clamp) into the 817 module.
  - **Turn-on and current:** the GPIO goes LOW from about 3 V on the terminal, so a key-on charge-lamp wire (below 2 V) reads as stopped. The PC817 LED gets 1.9 mA at 12 V and 4.0 mA at 28.8 V.
  - **Within ratings:** the module's input stays below 16 V, and every part within its rating, for every 12 V case, the clamped 24 V load dump and ISO 7637-2 pulses 1 and 2a.
  - **Exception:** the unclamped 24 V load dump, which is what the P6KE18A option is for.
- **Isolation:**
  - The vehicle zone (top left, under the 817 module) has no ground pour on either layer.
  - Its nets use the `Vehicle` netclass, with 0.8 mm clearance.
  - While Freerouting runs, keep-out strips along the zone's inner edges stop logic tracks from passing through. They are removed before the board is saved.
- **Antenna:** it overhangs the top edge, and the 3 mm of board under its end is a copper keep-out.
- **Heights:**
  - About 8 mm fits under the DevKit (its board sits 11 mm up) and about 6 mm under the 817 module (on 10–12 mm spacers).
  - C3 (11 mm tall), F1, J3 and D5 stay outside every module.
  - The strip below the DevKit's USB-C end holds only low parts, because the cable plug sits above it.
- **Status LED:** D5 with R1 to ground holds GPIO2 low at boot, which is what download mode needs.

## Changes from rev A

| | Rev A | Rev C (this board) |
|---|---|---|
| ESP32 | DevKit V1, 30 pins | DevKit V4, USB-C, 38 pins |
| Supply | 12/24 V terminal, PTC, TVS, LM2596 module | DevKit USB-C only |
| 817 module | Beside the parts, wired | Stacked on spacers over its input protection |
| Input protection | 1N4007 + 1.5 kΩ 0.5 W | 1N4007 + 1.5 kΩ 1 W + 15 V clamp (1N4744A or P6KE18A) |
| RTC / EEPROM / IMU | Upright or loose on sockets; EEPROM 1×5 | All lying flat; EEPROM 1×4 (its own pin order) |
| Extras | UART header | Spare GPIO header with PTC, status LED |
| Size | 130 × 100 mm | 88 × 71 mm |

## Regenerating after a change

The board is produced by scripts:

```bash
python3 tools-gen-footprints.py      # 1. module footprints (edit dimensions after measuring)
python3 tools-build-pcb.py place     # 2. netlist -> footprints -> placement (PLACEMENT table); `check` = dry run
python3 tools-route-pcb.py           # 3. keep-outs and fence -> Freerouting -> GND pours
python3 tools-production.py          # 4. 2-layer and DRC checks -> Gerbers zip, BOM, fit-check PDF, pictures
```

- **Schematic edits:** use KiCad (or the Konnect tools), then run steps 2–4.
- **References:** `tools-build-pcb.py` puts each reference beside its part, where it touches no pad or other silkscreen.
- **Routing:** Freerouting is not deterministic, so a re-run gives slightly different traces. It runs with pin neck-down off, so every track keeps its netclass width.
- **By hand:** you can also open `hour-meter-esp32-v4.kicad_pro` in KiCad, move parts and route interactively. Run `tools-production.py` afterwards for the checks and files.
