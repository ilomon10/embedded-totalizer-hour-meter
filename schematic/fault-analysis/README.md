# Fault analysis (rev B boards, PSU-B and the I/O port)

SPICE simulations of the faults a vehicle installation can throw at the hour meter: supply transients, reverse polarity, shorted outputs and miswired connectors. Each case is a small ngspice deck built from the parts on the real schematics, and each result is checked against the parts' ratings.

```bash
python3 faults.py      # needs ngspice, numpy and matplotlib; prints the table below and writes plots/
```

## Method

- **Models:** the semiconductor models are fitted to datasheet points (listed in `faults.py`, next to each `.model`). They are good for stresses and pass/fail margins, not for exact waveforms.
- **Test pulses:** ISO 16750-2 load dump (Test A unclamped, Test B clamped by the alternator) and ISO 7637-2 pulses 1 and 2a (and 3a/3b on AIN1), with the source resistances the standards give. Sources disagree on the 24 V Test B clamp (58 V or 65 V); both are far above the TVS breakdown, so the verdict is the same.
- **Pass criteria:**
  - **TVS energy:** under half the energy the TVS survives for the event's length. That rating is extrapolated from 600 W (10/1000 µs) along the √t slope of its pulse-power curve, which is generous for events much longer than 10 ms.
  - **Converter input:** VIN_P under 60 V (TPS54360B operating limit; 65 V absolute).
  - **Part limits:** every other part within its power, current and absolute-maximum ratings.
- **Not simulated:**
  - **PTC trip:** the fuse's thermal trip is calculated from its datasheet (marked *calculated*).
  - **ESD and burst:** not covered; they are handled by the parts' own IEC ratings.
  - **DOUT1:** the BSP75N has no SPICE model here; its rows are worked from the [Diodes BSP75N datasheet](https://www.diodes.com/assets/Datasheets/BSP75N.pdf) (marked *calculated*).

## Results

The 4-layer board, the 2-layer copy and PSU-B share these circuits. The compact board adds the two fixes in the last two rows of the RS485 and +5V groups.

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

## Plots

- `plots/load-dump.png`: VIN_RAW and TVS current for the 12 V and 24 V clamped load dumps.
- `plots/opto-input.png`: vehicle input transfer curve and LED current from −60 V to +60 V.

## What is still open

1. **24 V vehicles need a different PSU.** A clamped load dump in a 24 V vehicle holds 58–65 V for up to 400 ms. PSU-B's TVS starts conducting at 40 V, so it ends up absorbing the whole event. A 24 V supply needs a 100 V-class converter and a TVS that stays off at 58 V. It plugs into the same J102, so the main boards don't change. PSU-B is fine for 12 V vehicles.
2. **Unclamped load dump (Test A).** Not covered by any rev-B PSU. Modern alternators clamp centrally.
3. **Port data lines.** J801 and J802 are logic-level module ports. Making them survive a wire to the battery would need series resistors on every line; the compact board documents them as not battery-proof instead.
4. **RS485 jumpers.** With J702/J703 fitted, a bus wire shorted to the supply burns the 120 Ω and 330 Ω resistors (the THVD2410 survives).
5. **DOUT1 and unclamped load dumps.** A load on DOUT1 hangs on the vehicle supply directly, so in a 24 V vehicle without central load-dump suppression the BSP75N's clamp absorbs the event and fails. AIN1 survives it.

## Sources

- ISO 16750-2 and ISO 7637-2 test levels: [TI SNOAAA1](https://ti.com/lit/pdf/snoaaa1), [Diotec load-dump app note](https://p7f.vogel.de/companies/6a/4e/6a4e52d6c1b9a/app-note-load-dump-protection-v10.pdf), [Analog Devices LTC4380 article](https://www.analog.com/en/resources/technical-articles/low-quiescent-current-surge-stopper-robust-automotive-supply-protection.html)
- TPS54360B current limit and thermal shutdown: [TI datasheet](https://www.ti.com/document-viewer/TPS54360B/datasheet/electrical-characteristics-snvsb92162)
- THVD2410 bus ratings and pinout: [TI THVD2410](https://www.ti.com/product/THVD2410), [datasheet](https://www.ti.com/lit/ds/symlink/thvd2410.pdf)
- PSM712: [LCSC C2875817](https://www.lcsc.com/product-detail/C2875817.html)
- BSP75N clamp, current limit and avalanche energy: [Diodes BSP75N datasheet](https://www.diodes.com/assets/Datasheets/BSP75N.pdf); BAV99 forward voltage and leakage: [onsemi BAV99L](https://www.onsemi.com/pdf/datasheet/bav99lt1-d.pdf); ADS1115 input-current rating: [TI ADS1115](https://www.ti.com/lit/ds/symlink/ads1115.pdf)
