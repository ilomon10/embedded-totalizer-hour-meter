# Hour Meter main board, compact + LM2596 + I/O (rev B, 80 × 92 mm, 2 layers)

> **Work in progress:** this folder is a copy of the [I/O board](../hour-meter-board-compact-lm2596-io/README.md), the start of its harness re-layout (one Micro-Fit 3.0 connector, vehicle zone on the left, smaller board). Until that is done, the text below still describes the I/O board.

The [LM2596 board](../hour-meter-board-compact-lm2596/README.md) with a general-purpose **I/O port for trucks**, modelled on the I/O of Teltonika trackers. A new 5-pin JST VH header, J902, carries:
- one analog input, **AIN1** (0–30 V);
- one digital output, **DOUT1** (0.5 A low-side switch);
- a 5 V sensor supply.

The two isolated vehicle inputs keep their circuit and are now called **DIN1** and **DIN2**. The board grows by a 12 mm strip along the bottom edge, from 80 × 80 to **80 × 92 mm**, and keeps 2 copper layers.

The folder is a KiCad *Save As* copy of `../hour-meter-board-compact-lm2596`, so that board is unchanged. The supply, the other connectors and the isolation design are the same:
- the [LM2596 board README](../hour-meter-board-compact-lm2596/README.md) covers the supply and the connectors;
- the [compact board README](../hour-meter-board-compact/README.md) covers the slots, the IMU keep-outs and the fault fixes.

| | |
|---|---|
| Schematic | `hour-meter-board-compact-lm2596-io.kicad_sch` + 9 module sheets. The new `io.kicad_sch` holds J902, AIN1 and DOUT1. Changes on the other sheets: the opto inputs are renamed DIN1/DIN2, GPIO23 is `DOUT1_CTRL`, J804 pin 6 is no longer connected, and the two-hole TP101 is split into the VIN and GND solder pads TP101 and TP102 |
| PCB | `hour-meter-board-compact-lm2596-io.kicad_pcb`: 80 × 92 mm, 2 layers, 143 parts, GND pour on both layers |
| Script | `tools-pcb.py` with `check`, `place`, `reuse`, `route [tries]`, `finish [passes]`, `production` or `models` |
| Order files | `production/`: Gerber zip, BOM and CPL |
| Firmware | Not yet: AIN1 and DOUT1 need firmware support (see [Firmware](#firmware-to-do)). DIN1 and DIN2 work as before |

**Checks at this revision (2026-10-29):**
- **ERC:** 0 errors, 2 intended warnings (the IMU address straps, as on the compact board).
- **DRC:** 0 errors, 0 unconnected items, 0 schematic-parity issues. The 6 warnings are silkscreen that the fab clips at an edge or a slot, as on the LM2596 board.
- **Copper:** 2 layers. The Gerbers have only L1 (top) and L2 (bottom). The GND pour on both layers reaches the new bottom edge.
- **Net classes:** the LM2596 board's `Vehicle`, `Power`, `Plane` and Default classes. The patterns follow the DIN1/DIN2 rename, AIN1_RAW, AIN1_MID and DOUT1 are added to `Vehicle`, and +5V_OUT to `Power`.
- **Isolation:** the GND pour is 3.3 mm from the nearest vehicle-side copper, as on the LM2596 and compact boards.
- **Routing:**
  - Everything this board shares with the LM2596 board uses that board's routing, copied by `reuse`. Freerouting (`finish`) routed only the I/O strip.
  - One hand fix: Freerouting's round trip left an old UART2_TX track 1 µm inside the 0.2 mm clearance to UART_5V, so its bend moved 0.1 mm.
  - Hand-routed: the 0.5 mm B.Cu track from J101 pin 1 to the TP101 solder pad.
- **Order files:** the BOM has 76 lines and the CPL 135 parts. R904 (not fitted) is left out of both, and BT401 is still the only part on the bottom.
- **Stock:** all parts are in JLCPCB stock for 10 boards (checked 2026-10-28): 33 basic, 1 preferred and 42 extended lines. The Diodes BSP75N has the least stock (621). The Infineon BSP75N (C114056, 7210 in stock) fits the same footprint.
- **Fault simulations:** AIN1 passes every case in the [fault analysis](../fault-analysis/README.md). DOUT1 is calculated from its datasheet.

## I/O ratings

Teltonika's figures are from the [FMC640 datasheet](https://content.gps-trace.com/assets/67231701-b3b8-4129-a56e-7af40bd35ac8) (electrical characteristics table), the [FMC650 datasheet](https://gowifi.co.nz/specs/DS-FMC650.pdf) and the [FMB140 wiki](https://wiki.teltonika-gps.com/view/FMB140_General_description).

| Channel | Teltonika FMC640 / FMC650 / FMB1xx | This board |
|---|---|---|
| **DIN1, DIN2** | 15 kΩ (FMC640) or 47 kΩ (FMB140) input. Threshold 7.5 V (FMB140 DIN2/DIN3: 2.5 V). Absolute maximum ±32 V. Not isolated | Optocoupler-isolated, with a common return (COM). Threshold about 7 V: reads active above 6.7 V and idle below 6.5 V. For 9–36 V signals, positive trigger. Simulated against a 58 V load dump, −600 V (pulse 1) and +112 V (pulse 2a). DIN2 counts pulses: 22 µs filter, 1 kHz with the firmware's default debounce |
| **AIN1** | 0–10 V (120 kΩ) or 0–30 V (147 kΩ), chosen in software | **0–30 V**, plus software ranges of 0–11 V and 0–5.6 V (table below). 16-bit ADS1115. Input resistance 110 kΩ. About ±0.5 % without calibration (0.1 % divider). Reads down to 0 V. Survives ±60 V continuous. **4–20 mA** with R904 fitted |
| **DOUT1** | Open drain, 0.5 A, 300–600 mΩ, 120 µA off-state leakage, for 10–30 V loads | Open-drain low-side switch, **0.5 A continuous** (0.7 A minimum rating), 0.52 Ω typical. For 12 V and 24 V loads up to 36 V. **Self-protected BSP75N** smart switch (details below). Off-state leakage 3 µA typical, 15 µA maximum at 32 V |
| Sensor supply | 1-Wire supply only (3.3–3.9 V) | **+5 V, 200 mA** (PTC fuse) on J902 pin 1, for ratiometric 5 V transducers |
| Ground | Common with the supply | DIN1/DIN2 isolated (COM). AIN1, DOUT1 and +5 V share the board GND, which is J101 pin 2, the battery negative |

**BSP75N protection:**
- **60–75 V active clamp:** a relay coil switches off without a flyback diode, and DOUT1 stays off through a 24 V clamped load dump (58 V).
- **Current limit 0.7–1.5 A**, then thermal shutdown with automatic restart. A short to +24 V doesn't harm it.
- **Off during reset and boot.**

## Connectors

| Ref | Port | Header (JLCPCB) | Pins | Plug |
|---|---|---|---|---|
| **J902** | **I/O** | B5P-VH (C160318) | 1 +5V out, 2 AIN1, 3 GND, 4 DOUT1, 5 GND | VHR-5N |
| J301 | DIN1 / DIN2 (isolated) | B3P-VH (C160316) | 1 DIN1, 2 DIN2, 3 COM | VHR-3N |
| TP101 | VIN solder pad | 3 × 3 mm SMD pad on the **bottom side**, above J101 | 1 VIN | wire soldered on (18–22 AWG), for an installation without a plug |
| TP102 | GND solder pad | 3 × 3 mm SMD pad on the **bottom side**, below J101 | 1 GND | wire soldered on (18–22 AWG) |
| J101, J701, J801–J803 | | as on the [LM2596 board](../hour-meter-board-compact-lm2596/README.md#connectors) | | |

- **Silkscreen:** the J902 pin names (5V, AIN1, GND, DOUT1, GND) are printed above the header. Pin 1 is on the left, with the square pad.
- **No other plug fits J902:** it is the only 5-pin header on the board.
- **Pin order:** DOUT1 sits between two GND pins, so a stray strand can only switch the load on.
- **J804 (expansion header) pin 6** no longer carries GPIO23; GPIO23 drives DOUT1.

## Wiring

- **Voltage sensor (0–5 V, 0–10 V, 0–30 V):** signal to AIN1 (J902-2), sensor ground to J902-3. A ratiometric 5 V sensor (pressure transducer, Hall sensor) can take its supply from J902-1. Sensors that need 12/24 V take it from the vehicle.
- **Fuel or temperature gauge sender:** wire AIN1 in parallel with the sender wire to read the voltage the gauge already drives through it. Don't disconnect the gauge.
- **4–20 mA sensor:** fit R904, a 120 Ω 0.1 % 1206 resistor, which gives 0.48–2.4 V. The loop supply comes from the vehicle or J902-1. **Leave R904 empty for voltage sensors:** with it fitted, 24 V on AIN1 burns 4.8 W in it.
- **DOUT1 load (relay coil, buzzer, lamp, up to 0.5 A):**
  - wire one side of the load to a fused +12/24 V and the other side to DOUT1 (J902-4);
  - DOUT1 switches the load's low side to GND;
  - a flyback diode across a relay coil is optional (the BSP75N clamps the kick).
- **DIN1, DIN2:**
  - wire the signals (9–36 V when active) to J301-1 and J301-2, and their ground to J301-3 (COM);
  - the inputs are isolated: COM is not connected to the board GND;
  - the firmware reads DIN1 as the alternator / engine-running input (GPIO27) and DIN2 as the pulse counter (GPIO26), as before. See [WIRING.md](../../esp32/docs/WIRING.md).

## Circuit (`io.kicad_sch`)

```
J902-2 AIN1 ─┬─ R901 49.9k ─ R902 49.9k ─┬─ U901 ADS1115 AIN0 (I2C 0x48)
         C901 10 nF 1 kV          R903 10k ┤ C902 100 nF ┤ D901 BAV99 to GND / +3V3
         R904 (not fitted)                (0.1 % resistors: ratio 10 / 109.8)

GPIO23 ─┬─ U902 74AHCT1G125 (+5V) ─ U903 BSP75N IN     drain ─ J902-4 DOUT1, source/tab ─ GND
     R905 100k to GND

+5V ─ F902 200 mA PTC ─ J902-1
```

**AIN1 ranges** (the ADS1115's programmable gain; the input is 10.98 × the ADC voltage):

| ADS1115 range | AIN1 range | Step |
|---|---|---|
| ±4.096 V | 0–36 V (limited by the 3.3 V supply) | 1.4 mV |
| ±2.048 V | 0–22.5 V | 0.69 mV |
| ±1.024 V | 0–11.2 V | 0.34 mV |
| ±0.512 V | 0–5.6 V | 0.17 mV |
| ±0.256 V | 0–2.8 V (4–20 mA with R904: 0.48–2.4 V) | 0.09 mV |

**Why these parts:**
- **ADS1115 instead of the ESP32's own ADC:**
  - the ESP32 reads only 150–2450 mV at 11 dB, so the bottom ~2 V of a 30 V divider would read 0;
  - its ADC is non-linear;
  - GPIO33, the last free ADC1 pin, stays free.
- **Two 49.9k resistors in series:** a −600 V pulse 1 then puts 299 V on each, under the 400 V overload rating of a 1206 part. The divider draws 0.27 mA at 30 V.
- **C901 is a 1 kV part:** it sits on the pin, where pulse 1 puts 596 V on it.
- **BAV99 clamp:** it shares the overload current with the ADS1115's own input diodes, 0.6 mA at most at ±60 V (the ADS1115 allows 10 mA). It is a silicon diode with 25 nA leakage: a Schottky (BAT54S) leaks microamps when hot, which would offset small readings through the 9.1 kΩ divider.
- **BSP75N** (Diodes BSP75NTA, C172450; the Infineon BSP75N, C114056, is a drop-in alternative):
  - its protection is specified for an input of 4.5 V and up;
  - U902 buffers the 3.3 V GPIO to the +5 V rail (4.9 V);
  - with 4.9 V on the input, the short-circuit protection holds up to 36 V on the drain, above a 24 V system's 28.8 V.
- **[Fault simulations](../fault-analysis/README.md):**
  - AIN1 passes every case: ±60 V, an unclamped 24 V load dump, and ISO 7637-2 pulses 1, 2a, 3a and 3b.
  - DOUT1 is worked from the datasheet. It passes the clamped load dump, an inductive kick and a short to 24 V.
  - DOUT1 fails only an **unclamped** 24 V load dump through its load. The supply input has the same limit: the vehicle needs its central load-dump clamp.

## Layout

- **I/O strip (new bottom edge):**
  - J902 sits in the middle, with its pins along the edge;
  - the AIN1 divider, ADS1115 and clamp are to its left;
  - the DOUT1 buffer and BSP75N are to its right, with the BSP75N's drain pin facing J902.
- **Distance from the LM2596:** `tools-pcb.py check` keeps the AIN1 front end at least 8 mm from the LM2596 switch node (`LM_SW`). It is 14.5 mm away.
- **Net classes:** AIN1_RAW, AIN1_MID and DOUT1 are in the `Vehicle` class (0.8 mm clearance, 0.5 mm track); +5V_OUT is in `Power`.
- **Mounting holes:** H104 and H105 moved to the new bottom corners.
- **Moved part:** J801 keeps the position it was moved to by hand on the LM2596 board.
- **VIN/GND solder pads:** TP101 (VIN) and TP102 (GND) are 3 × 3 mm pads on the back, above and below J101. They replace the LM2596 board's two-hole TP101.
  - TP101 has a B.Cu track from J101 pin 1, in the `Vehicle` class.
  - TP102 has a B.Cu track from J101 pin 2, and joins the GND pour solid, since its thermal spokes would be thinner than the pour's minimum.
  - With the largest pad size (4 × 4 mm) TP101 would still be 2.2 mm from other-net copper (0.8 mm needed) and 1.45 mm from the edge.
  - TP101/TP102 are in parallel with J101: use one or the other, never both from different supplies.
- **Unchanged:** everything else.

## Firmware (to do)

AIN1 and DOUT1 need firmware before they do anything:
- **ADS1115 driver:** I2C address 0x48, single-ended AIN0 (MUX 100), range chosen by a setting, scale 10.98. Optional per-board calibration.
- **DOUT1:** GPIO23, active high (1 = load on). There is no read-back. The BSP75N restarts by itself after a thermal shutdown, so there is no latch to reset.
- **Settings:** the 128-byte `SettingsRecord` is full, so AIN1 and DOUT1 settings need an EEPROM layout change.
- **No change for DIN1/DIN2:** they are the same GPIO27/26 as the ALT/PULSE inputs.

## 3D models

As on the [LM2596 board](../hour-meter-board-compact-lm2596/README.md#3d-models): `python3 tools-pcb.py models` downloads the JLCPCB/EasyEDA STEP files into `3d/`. EasyEDA has no STEP file for J902's B5P-VH (C160318), so `MODEL_STANDINS` shows it with the model of a VH-type header of the same size and pinout, CJT A3963WV-5P (C239412). The new ICs use KiCad's library models.

## Before you order

The [LM2596 board's notes](../hour-meter-board-compact-lm2596/README.md#before-you-order) apply: Standard PCBA on both sides, all through-hole parts selected, the tooling-rail remark, and **Order Number → Specify Position**. In addition:

1. **R904 is not fitted.** It is left out of the BOM and CPL. Hand-solder a 120 Ω 0.1 % 1206 resistor for a 4–20 mA sensor.
2. **J902's plug:** order VHR-5N housings with SVH-21T-P1.1 contacts alongside the other harness plugs.
3. **Bring-up, once the firmware supports it:**
   - AIN1 reads a bench supply at 0, 5, 10 and 30 V within 0.5 %;
   - DOUT1 switches a 24 V relay;
   - shorting DOUT1 to the 24 V supply current-limits and recovers.

## Re-generating the board

```bash
python3 tools-pcb.py check        # overlaps, slots, supply strip, AIN1-to-LM_SW distance, magnetometer distances
python3 tools-pcb.py place        # placement: PLACEMENT, SLOTS, BRIDGES and SUPPLY_AREA in tools-pcb.py
python3 tools-pcb.py reuse        # the LM2596 board's routing for every part the two boards share, + GND pours
python3 tools-pcb.py finish 1     # Freerouting routes the I/O strip, then plane vias and clean-up
kicad-cli pcb drc --severity-all --schematic-parity --refill-zones hour-meter-board-compact-lm2596-io.kicad_pcb
python3 tools-pcb.py production   # production/: Gerber zip, BOM, CPL (Do-Not-Populate parts left out)
python3 tools-pcb.py models       # JLCPCB 3D models into 3d/ (once per checkout), set on the board
```

- **Why `reuse`:** routing the whole board from scratch (`route 2`, then `finish`) left 5 +3V3 connections open, at the IMU's pins and in the ADS1115 corner. The LM2596 board's routing already solves the IMU. `reuse` measures the LM2596 board file's offset on U601 and maps the renamed nets. It drops the old GPIO23 route to J804. It also drops the two routes from J101 to the LM2596 board's two-hole TP101, because the VIN one would cross TP102 here. `finish` then routes TP101 and TP102.
- **If `finish` drops a nearly finished result:** `finish` keeps a result only if it has no more errors than before. On this board, Freerouting's first pass reached 1 open connection with 1 clearance error (the UART2_TX bend above), so `finish` dropped it. In that case:
  1. keep that pass;
  2. fix the error;
  3. run `finish 0`: plane vias and clean-up, with no Freerouting pass.
- **Memory:** Freerouting needs free memory. On a machine short of it, cap the Java heap: `JAVA_TOOL_OPTIONS=-Xmx1536m python3 tools-pcb.py finish 1`.
