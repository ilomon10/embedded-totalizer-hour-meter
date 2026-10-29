# Fault analysis (rev B boards, PSU-B, the LM2596 boards and the Micro-Fit harness)

SPICE simulations of the faults a vehicle installation can throw at the hour meter: supply transients, reverse polarity, shorted outputs and miswired connectors. Each case is a small ngspice deck built from the parts on the real schematics, and each result is checked against the parts' ratings.

```bash
python3 faults.py      # needs ngspice, numpy and matplotlib; prints the table below and writes plots/
```

Which results apply to which board:
- **100 × 90 boards and the compact board, with PSU-B:** the [results table](#results) from *Supply* to *UART / GPS port data lines*.
- **[LM2596 board](../hour-meter-board-compact-lm2596/README.md):** the *LM2596 input stage* group instead of PSU-B's *Supply*, plus the compact board's rows.
- **[I/O board](../hour-meter-board-compact-lm2596-io/README.md):** the LM2596 board's, plus *AIN1* and *DOUT1*.
- **[Micro-Fit board](../hour-meter-board-microfit/README.md):** the I/O board's, plus the [J1 harness](#micro-fit-harness-j1) and the *indicator LEDs*.

## Method

- **Models:** the semiconductor models are fitted to datasheet points (listed in `faults.py`, next to each `.model`). They are good for stresses and pass/fail margins, not for exact waveforms.
- **Test pulses:** ISO 16750-2 load dump (Test A unclamped, Test B clamped by the alternator) and ISO 7637-2 pulses 1 and 2a (and 3a/3b on AIN1), with the source resistances the standards give. Sources disagree on the 24 V Test B clamp (58 V or 65 V); both are far above the TVS breakdown, so the verdict is the same.
- **Pass criteria:**
  - **TVS energy:** under half the energy the TVS survives for the event's length. That rating is extrapolated from 600 W (10/1000 µs) along the √t slope of its pulse-power curve, which is generous for events much longer than 10 ms.
  - **Converter input:** VIN_P under 60 V (TPS54360B operating limit; 65 V absolute).
  - **Part limits:** every other part within its power, current and absolute-maximum ratings.
- **Fuses:** F101 on the LM2596 boards trips once its I²t reaches its slowest trip (150 ms at 8 A). The TVS and the regulator are judged up to that moment. F801–F803 are worked out the same way (80 ms at 8 A).
- **Harness shorts:** DOUT1 is open drain, so while it is off its load pulls pin 10 up to the supply. A short to pin 10 therefore sees the supply through the load: a relay coil (85 Ω on 12 V, 280 Ω on 24 V) or a 0.5 A load. The board's +5V load is taken as 50 mA (the AMS1117 with the ESP32 awake); the less the board draws, the further a back-feed lifts +5V. The ESP32 GPIO is 3.3 V behind 33 Ω (its default drive strength).
- **LEDs:** fitted to LCSC's forward voltage at 20 mA, with a generic slope for InGaN (green, blue) and AlInGaP (yellow). Brightness is the 20 mA figure scaled by current.
- **Not simulated:**
  - **PTC trip:** the fuse's thermal trip is calculated from its datasheet (marked *calculated*).
  - **ESD and burst:** not covered; they are handled by the parts' own IEC ratings.
  - **DOUT1:** the BSP75N has no SPICE model here; its rows are worked from the [Diodes BSP75N datasheet](https://www.diodes.com/assets/Datasheets/BSP75N.pdf) (marked *calculated*).

## Results

The 4-layer board, the 2-layer copy and PSU-B share these circuits. The compact board adds the two fixes in the last two rows of the RS485 and +5V groups. The LM2596 boards replace PSU-B with an on-board LM2596 stage, in its own group further down.

| Fault | Result | Detail |
|---|---|---|
| **Supply (J101 → PSU-B)** | | |
| 12 V vehicle, clamped load dump (35 V) | Pass | TVS (40 V breakdown) stays off; VIN_P peaks at 34.7 V |
| 24 V vehicle, clamped load dump (58 V, Ri 1–8 Ω) | **Fail** | SMBJ36CA absorbs 21–87 J over ~370 ms; it survives about 16 J |
| 12 V vehicle, unclamped load dump (101 V) | **Fail** | 139 J into the TVS. Only relevant without the alternator's central clamp |
| ISO 7637-2 pulse 1 (−150 V / 12 V, −600 V / 24 V) | Pass | 9–11 A, 0.2 J into the TVS (rated ~0.9 J) |
| ISO 7637-2 pulse 2a (+112 V, 2 Ω, 50 µs) | Pass | The 100 µF bulk capacitor absorbs it; VIN_P peaks at 39 V |
| Reverse battery (−28 V) | Pass | D2 blocks; nothing reaches the converter |
| Jump start / overvoltage (36 V) | Pass | TVS stays off; VIN_P 35.7 V |
| **+5V rail** | | |
| +5V shorted at J804 pin 2 or the GPS 5 V option (100 × 90 boards) | **Fail** | No fuse there: D101 (3 A part) carries PSU-B's 5.5–6.8 A current limit, 3–4 W |
| Same short, compact board (F802 / F803) | Pass | The 200 mA PTC trips in 110–170 ms (D101 takes about 0.5 J), then holds about 114 mA (*calculated*) |
| **Vehicle inputs (J301)** | | |
| Switching threshold | Pass | Reads active above 6.7 V and idle below 6.5 V, so a key-on L terminal (< 2 V) reads OFF |
| 36 V and 58 V on the input | Pass | 9.8 mA / 17 mA; each 1206 1k at 96 mW / 291 mW (291 mW is a short overload, within the 1206's rating for a load-dump-length event) |
| −60 V, pulse 2a (+112 V), pulse 1 (−600 V) | Pass | M7 blocks reverse (1000 V rating); LED peak 44 mA (rated 1 A pulse) |
| **RS485 (J701)** | | |
| A or B wired to 12 V / 24 V / reversed 12 V (100 × 90 boards) | **Fail** | PSM712 conducts 0.3–5.8 A (rated ~0.3 W continuous); SP3485 bus pins are rated −7…+12 V |
| Same, compact board (THVD2410 + 2 × SMAJ33CA) | Pass | Bus pins rated ±70 V; at ±28.8 V the 33 V TVS stays off |
| Same, compact board, termination/bias jumpers fitted | Pass\* | The transceiver survives, but R704–R706 (0.37–3.1 W) burn open: replace them after the fault |
| **UART / GPS port data lines (J801, J802)** | | |
| A data line wired to 12 V or 24 V | **Fail** | SRV05-4 takes 3.6–10.7 A and lifts +5V to 11–22 V. These are 3.3/5 V logic ports, not battery-proof |
| **AIN1 (J902-2, [I/O board](../hour-meter-board-compact-lm2596-io/README.md))** | | |
| Reading at 30 V | Pass | ADC pin at 2.732 V, the ideal 10 / 109.8 ratio |
| ±60 V continuous | Pass | 0.18 / 0.54 mA into the clamp (ADS1115 input: 10 mA); 16–18 mW per 49.9k. The ADC pin sits at 3.84 V / −0.59 V, past the ±0.3 V rail limit but current-limited, as the ADS1115's input-current rating allows |
| 24 V unclamped load dump (Test A, 202 V, 350 ms) | Pass | 99 V and 20 mJ per 49.9k (400 V overload rating); 1.6 mA into the clamp |
| ISO 7637-2 pulse 1 (−600 V, 50 Ω, 1 ms) | Pass | C901 sees 596 V, which is why it is a 1 kV part; 299 V per 49.9k; 5.2 mA into the clamp |
| ISO 7637-2 pulses 2a (+112 V), 3a (−220 V), 3b (+150 V) | Pass | C901 holds the 150 ns pulses 3a/3b to 27 V; pulse 2a peaks at 139 V on C901 |
| **DOUT1 (J902-4, I/O board, *calculated*)** | | |
| 24 V clamped load dump (58 V), DOUT1 off | Pass | Below the BSP75N's 60 V minimum clamp voltage: it stays off |
| Relay or solenoid switched off without a flyback diode | Pass | A 0.5 A, 0.5 H solenoid stores 63 mJ; the BSP75N clamps 200 mJ at 150 °C (550 mJ at 25 °C) |
| DOUT1 shorted to 24 V (28.8 V) while on | Pass | Current limit 0.7–1.5 A, then thermal shutdown with auto restart. The short-circuit protection is specified up to 36 V with the 5 V input (U902 gives it 4.9 V) |
| 24 V unclamped load dump (Test A) through a relay coil | **Fail** | With a 240 Ω coil the clamp takes about 3 J over 200 ms (rated 0.2–0.55 J). Like the supply input, DOUT1 needs the vehicle's central clamp |
| **LM2596 input stage (LM2596, I/O and Micro-Fit boards: F101 → D103 SS54 → D104 SMAJ30CA, C102 → LM2596S)** | | |
| 12 V vehicle, clamped load dump (35 V) | Pass | A typical SMAJ30CA stays off; VIN_LM peaks at 34.8 V. One at its 33.3 V minimum breakdown takes 4.1 J over 260 ms (it survives about 9 J) |
| 12 V jump start (24 V), reverse battery (−28 V), pulse 2a (+112 V) | Pass | The TVS stays off and D103 blocks the reverse battery. C102 absorbs pulse 2a: VIN_LM peaks at 31.5 V |
| 24 V vehicle running, 28.8–32 V | Pass | The TVS stays off; VIN_LM is 31.8 V at 32 V (LM2596S: 40 V) |
| 24 V jump start (36 V) | **Fail** | The SMAJ30CA conducts 0.3–1.1 A (11–40 W) for as long as it lasts: F101 (0.5 A hold) doesn't stop it |
| 24 V vehicle, clamped load dump (58 V, Ri 1–8 Ω) | **Fail** | 30–54 J into the TVS (it survives 7–12 J). With Ri 1 Ω the LM2596S input reaches 46.9 V (45 V absolute maximum) before F101 trips at 139 ms |
| ISO 7637-2 pulse 1, 12 V (−150 V, 10 Ω, 2 ms) | **Fail** | The TVS sits behind D103, so the pulse drives the 40 V SS54 into avalanche (10.8 A, 190 mJ; not rated) and pulls C102 and the LM2596S input to −4.7 V |
| ISO 7637-2 pulse 1, 24 V (−600 V, 50 Ω, 1 ms) | Check | The same avalanche (11.4 A, 198 mJ); VIN_LM stays positive |
| Proposed fix: SMBJ36CA on VIN_RAW, ahead of D103; D103 a 100 V SS510 (PSU-B's order) | Pass | Pulse 1: 9–11 A and 0.2 J into the TVS (it survives about 0.9 J). The diode stays out of avalanche, and VIN_LM dips only to 10 V (12 V) or 24 V (24 V). The 35 V load dump is unchanged |
| VIN_SENSE divider to GPIO34 (D102, 100k / 5.6k) | Pass | 0.45 V at 9 V, 1.50 V at 28.8 V, 3.04 V at 58 V (ESP32 maximum 3.6 V) |
| **Indicator LEDs (Micro-Fit D801–D803: GPIO → 330 Ω → LED)** | | |
| D801 P1, green LTST-S270TGKT | Pass | 1.7 mA, about 38 mcd |
| D802 P2, yellow LTST-S270KSKT | Pass | 4.2 mA, about 17 mcd |
| D803 USER, blue LTST-S270TBKT | Pass | 1.5 mA, about 13 mcd. Across its 2.8–3.8 V forward-voltage spread: 0.5–2.6 mA (5–24 mcd), so a high-voltage part looks dim behind a light pipe |

## Micro-Fit harness (J1)

The [Micro-Fit board](../hour-meter-board-microfit/README.md#j1-harness-connector) brings every field wire in on one 2 × 7 plug. Its logic pins (UART TX/RX and the +5 V output) now sit beside vehicle-voltage pins. Pin 1 is across from pin 8, pin 2 from pin 9, and so on:

```
back row   8 VIN    9 AIN1   10 DOUT1   11 +5V      12 RS485 B   13 DIN1   14 DIN2
front row  1 GND    2 GND     3 UART TX  4 UART RX   5 RS485 A    6 COM     7 COM
```

Two kinds of harness fault are covered:
- **A wire on the wrong pin:** a terminal in the wrong cavity, or a wire to the battery.
- **Neighbouring cavities shorted:** a stray strand or a crushed terminal. There are 12 side-by-side pairs and 7 pairs across.

### A pin wired to the supply or to ground

| Pin | Signal | Wired to +14.4 V or +28.8 V | Wired to ground |
|---|---|---|---|
| 1, 2 | GND | Shorts the supply in the harness: the 1 A fuse at the battery opens | Normal |
| 3, 4 | UART TX, RX | **Fail**: the SRV05-4 takes 3.6–10.7 A and lifts +5V to 11–22 V (UART rows above) | Pass: TX drives 25 mA into R801; RX reads a break |
| 5, 12 | RS485 A, B | Pass: THVD2410 bus pins rated ±70 V. With JP702–JP704 bridged, their resistors burn open (Pass\*) | Pass: the driver limits its current |
| 6, 7 | COM (VEH_GND) | Pass: DIN1/DIN2 see a reverse voltage, which the M7 blocks | Normal |
| 8 | VIN | Normal | Shorts the supply in the harness: the battery fuse opens |
| 9 | AIN1 | Pass (±60 V). **Fail** with the 4–20 mA shunt R904 fitted: 6.9 W in a 0.25 W part | Pass: reads 0 V |
| 10 | DOUT1 | Pass: the load is bypassed. When DOUT1 switches on, the BSP75N limits at 0.7–1.5 A and shuts down | Pass: the load stays on |
| 11 | +5 V out | **Fail**: before F801 trips (0.4 s at 14.4 V, 50 ms at 28.8 V), it passes 3.5–10 A (its maximum is 10 A). +5V reaches 12–22 V and the SRV05-4 absorbs 11–17 J | Pass: the LM2596 limits at 3.6–6.9 A and F801 trips in 0.1–0.4 s. The ESP32 may reset (*calculated*) |
| 13, 14 | DIN1, DIN2 | Normal: inputs for 9–36 V | Normal (idle) |

### Neighbouring cavities shorted

| Pins | Short | Result | Detail |
|---|---|---|---|
| 1–2, 6–7 | Same net | – | |
| 1–8 | GND–VIN | Pass | The supply is shorted at the plug and the battery-end fuse opens. No board copper carries the current |
| 2–3 | GND–UART TX | Pass | GPIO17 drives 25 mA into R801 |
| 2–9 | GND–AIN1 | Pass | AIN1 reads 0 V |
| 3–4 | UART TX–RX | Pass | Loop-back: GPIO17 and the far end's TX meet through R801 (about 20 mA) |
| **3–10** | **UART TX–DOUT1** | **Fail** | While DOUT1 is off, its load holds pin 10 at the supply. A 280 Ω relay coil forces GPIO17 to 4.2 V with 28 mA (ESP32 input limit: VDD + 0.3 V). A 0.5 A load also puts 2.2 W into the SRV05-4. While DOUT1 is on: as 2–3 |
| 4–5 | UART RX–RS485 A | Pass | RX reads the bus traffic; the THVD2410 drives A between 0 and 3.3 V |
| 4–11 | UART RX–+5V | Pass | The 74LVC1G17 input takes 5 V; 17 µA flows back through R802 |
| 5–6 | RS485 A–COM | Pass | A shorted to the vehicle ground: the driver limits its current; the bus is down |
| 5–12 | RS485 A–B | Pass | Bus short: the driver limits its current |
| 6–13, 7–14 | COM–DIN | Pass | The input reads idle. A switch that drives it high is shorted to ground, and its own fuse opens |
| 8–9 | VIN–AIN1 | Pass | AIN1 reads VIN. With R904 fitted: **Fail**, as AIN1 wired to the supply |
| 9–10 | AIN1–DOUT1 | Pass | AIN1 reads DOUT1. With R904 fitted and DOUT1 off, a 280 Ω coil drives 72 mA (0.6 W) through it: **Fail** |
| **10–11** | **DOUT1–+5V** | **Fail** | While DOUT1 is off, a relay coil (85 Ω on 12 V, 280 Ω on 24 V) feeds 80–90 mA into +5V and lifts it to 6.6 V: Pass\*, since the SN74AHCT1G125 is rated 5.5 V operating, 7 V absolute. A 0.5 A load on 24 V lifts it to 7.1 V with 2.3 W in the SRV05-4. While DOUT1 is on, the BSP75N limits at 0.7–1.5 A and F801 trips: Pass |
| 11–12 | +5V–RS485 B | Pass | B sits at 5 V; with JP704 bridged, R706 takes 76 mW (rated 100 mW) |
| 12–13 | RS485 B–DIN1 | Pass\* | While DIN1 is active, B sits at its voltage and the THVD2410 survives. With JP702–JP704 bridged, R704–R706 burn open, as in the compact board's RS485 rows |
| 13–14 | DIN1–DIN2 | Pass | Both inputs read the same |

## Plots

- `plots/load-dump.png`: VIN_RAW and TVS current for the 12 V and 24 V clamped load dumps.
- `plots/opto-input.png`: vehicle input transfer curve and LED current from −60 V to +60 V.
- `plots/lm2596-pulse1.png`: ISO 7637-2 pulse 1 on the LM2596 stage, as built and with the proposed fix.

## What is still open

1. **24 V vehicles need a different supply.** A clamped load dump in a 24 V vehicle holds 58–65 V for up to 400 ms.
   - **PSU-B:** its TVS starts conducting at 40 V, so it ends up absorbing the whole event. A 24 V supply needs a 100 V-class converter and a TVS that stays off at 58 V. It plugs into the same J102, so the main boards don't change.
   - **LM2596 boards (including Micro-Fit):** they fail the same load dump, and a 24 V jump start (36 V) too, because their SMAJ30CA conducts from 33 V. Feed them from a 24 → 12 V converter rated for 24 V vehicles, as the [LM2596 board](../hour-meter-board-compact-lm2596/README.md#input-limits) says.
   - Both are fine for 12 V vehicles.
2. **Unclamped load dump (Test A).** Not covered by any rev-B supply. Modern alternators clamp centrally.
3. **LM2596 stage and pulse 1.** The TVS sits behind the reverse-polarity diode, so a negative pulse lands on the 40 V SS54 (about 0.2 J of avalanche, which it is not rated for). On 12 V it also pulls the regulator input negative. The fix simulated above is PSU-B's order: an SMBJ36CA on VIN_RAW ahead of D103, and a 100 V SS510 as D103. D104 can stay.
4. **Port data lines.** J801 and J802 are logic-level module ports. Making them survive a wire to the battery would need series resistors on every line; the compact board documents them as not battery-proof instead. On the Micro-Fit board the UART and its +5 V share the vehicle harness (J1 pins 3, 4 and 11), so the same limit now applies to a harness mistake.
5. **Micro-Fit J1: DOUT1 beside +5 V out and UART TX.** While DOUT1 is off, its load holds pin 10 at the supply, and pins 11 and 3 are its neighbours. Fixes for the next revision:
   - **Swap DOUT1 and AIN1 (pins 9 and 10).** DOUT1's neighbours become VIN, AIN1 and GND. Both are vehicle nets on the back row, so the board's pin-order routing rule still holds. AIN1's 110 kΩ input is harmless beside +5 V and TX.
   - **A 100 V Schottky after F801** (an SS510, as on PSU-B) stops anything feeding back into +5V through pin 11, including pin 11 wired to the supply. It costs about 0.4 V on the 5 V output.
   - **R801 1 kΩ instead of 100 Ω** keeps GPIO17 under about 4 mA when TX is pulled up. The SRV05-4 still takes a 0.5 A load's current, so this protects only the ESP32.
6. **RS485 jumpers.** With J702/J703 (Micro-Fit: JP702–JP704) fitted, a bus wire shorted to the supply burns the 120 Ω and 330 Ω resistors (the THVD2410 survives).
7. **DOUT1 and unclamped load dumps.** A load on DOUT1 hangs on the vehicle supply directly, so in a 24 V vehicle without central load-dump suppression the BSP75N's clamp absorbs the event and fails. AIN1 survives it.
8. **AIN1 with R904 fitted.** The 120 Ω 4–20 mA shunt makes AIN1 no longer battery-proof: a wire to 24 V puts 6.9 W into it. A 4–20 mA loop on a vehicle needs its own fuse.

## Sources

- ISO 16750-2 and ISO 7637-2 test levels: [TI SNOAAA1](https://ti.com/lit/pdf/snoaaa1), [Diotec load-dump app note](https://p7f.vogel.de/companies/6a/4e/6a4e52d6c1b9a/app-note-load-dump-protection-v10.pdf), [Analog Devices LTC4380 article](https://www.analog.com/en/resources/technical-articles/low-quiescent-current-surge-stopper-robust-automotive-supply-protection.html)
- TPS54360B current limit and thermal shutdown: [TI datasheet](https://www.ti.com/document-viewer/TPS54360B/datasheet/electrical-characteristics-snvsb92162)
- THVD2410 bus ratings and pinout: [TI THVD2410](https://www.ti.com/product/THVD2410), [datasheet](https://www.ti.com/lit/ds/symlink/thvd2410.pdf)
- PSM712: [LCSC C2875817](https://www.lcsc.com/product-detail/C2875817.html)
- BSP75N clamp, current limit and avalanche energy: [Diodes BSP75N datasheet](https://www.diodes.com/assets/Datasheets/BSP75N.pdf); BAV99 forward voltage and leakage: [onsemi BAV99L](https://www.onsemi.com/pdf/datasheet/bav99lt1-d.pdf); ADS1115 input-current rating: [TI ADS1115](https://www.ti.com/lit/ds/symlink/ads1115.pdf)
- LM2596 input limits and current limit (40 V operating, 45 V absolute, 3.6–6.9 A): [TI LM2596](https://www.ti.com/lit/ds/symlink/lm2596.pdf), as for the board's UMW part ([LCSC C347423](https://www.lcsc.com/product-detail/C347423.html))
- LM2596-stage parts, from their LCSC listings: SMAJ30CA [C110043](https://www.lcsc.com/product-detail/C110043.html), SS54 [C22452](https://www.lcsc.com/product-detail/C22452.html), F101 1812L050/60GR [C19078719](https://www.lcsc.com/product-detail/C19078719.html), F801 SMD1206P020TF [C20984](https://www.lcsc.com/product-detail/C20984.html), SRV05-4 [C85364](https://www.lcsc.com/product-detail/C85364.html)
- Indicator LEDs: LTST-S270TGKT [C364567](https://www.lcsc.com/product-detail/C364567.html), LTST-S270KSKT [C133119](https://www.lcsc.com/product-detail/C133119.html), LTST-S270TBKT [C125115](https://www.lcsc.com/product-detail/C125115.html)
