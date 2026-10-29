# Micro-Fit board: pinout and ratings

The electrical ratings of every connector on the [Micro-Fit board](README.md), for installing and wiring it.

- **Supply:** the board runs from **12 V**. In a 24 V truck, feed it from a 24 → 12 V converter ([Supply](#supply)).
- **Sources:** the ratings come from the parts' datasheets and the board's [fault simulations](../fault-analysis/README.md).
- **Working range:** where a pin is meant to operate.
- **Absolute maximum:** the most a pin survives without damage. Not a working value.

## J1 harness connector

Molex Micro-Fit 3.0, 2 × 7, right-angle header (43045-1400). Mating plug: housing 43025-1400 with 43030-0007 terminals; see the [harness parts](README.md#j1-harness-connector).

```
 14  13  12  11  10   9   8      looking into J1 from outside the case (latch on top)
  7   6   5   4   3   2   1
```

| Pin | Signal | Type | Working range | Absolute maximum | Current | Notes |
|---|---|---|---|---|---|---|
| 1 | GND | ground | – | – | up to about 1 A | Battery negative. Carries the board's supply current and DOUT1's load current |
| 2 | GND | ground | – | – | – | Return for sensors, UART and RS485 |
| 3 | UART TX | 3.3 V logic output | 0 / 3.3 V | 0 to 3.6 V | ±20 mA | ESP32 GPIO17 through 100 Ω |
| 4 | UART RX | logic input | 3.3 V or 5 V logic | −0.5 to 5.5 V | – | 5 V-tolerant Schmitt buffer, 100 kΩ pull-up to 3.3 V |
| 5 | RS485 A | bus | −7 to +12 V (RS-485) | ±33 V | – | See [RS485](#rs485) |
| 6 | DIN COM | isolated return | – | ±60 V to GND | – | Return of DIN1/DIN2. Not connected to GND |
| 7 | DIN COM | isolated return | – | ±60 V to GND | – | Second wire for the same return |
| 8 | VIN | supply input | 9–30 V DC, 12 V nominal | 32 V steady, −40 V reverse | 40–330 mA at 12 V | See [Supply](#supply) |
| 9 | AIN1 | analog input | 0–30 V | ±60 V continuous | 110 kΩ input | See [AIN1](#ain1) |
| 10 | DOUT1 | open-drain output | load supply up to 36 V | 60 V (internal clamp) | 0.5 A continuous | See [DOUT1](#dout1) |
| 11 | +5 V out | supply output | 4.8–4.9 V | 5.5 V applied from outside | 200 mA | Resettable fuse F801. Shared by a 5 V sensor and the UART device |
| 12 | RS485 B | bus | −7 to +12 V (RS-485) | ±33 V | – | See [RS485](#rs485) |
| 13 | DIN1 | digital input | 0–36 V, active above 6.7 V | +50 V / −60 V continuous | 1.9 mA at 12 V, 5.8 mA at 24 V | See [DIN1, DIN2](#din1-din2) |
| 14 | DIN2 | digital input | 0–36 V, active above 6.7 V | +50 V / −60 V continuous | as DIN1 | Pulse counter, up to 1 kHz |

**Not vehicle-proof:**
- **Pins:** 3, 4 and 11 are logic-level and 5 V pins. A wire from them to the vehicle supply damages the board ([harness faults](../fault-analysis/README.md#micro-fit-harness-j1)).
- **Wiring rule:** keep them on short runs to the device they serve.
- **Known weak spot:** DOUT1 (pin 10) sits beside pin 11 and across from pin 3. See [Why this pin order](README.md#j1-harness-connector).

## Supply

| | |
|---|---|
| Input | VIN (pin 8) to GND (pin 1): 9–30 V DC, 12 V nominal |
| In a 24 V truck | From a 24 → 12 V converter, not the 24 V supply directly. The input does not survive a 24 V vehicle's 36 V jump start or 58 V load dump |
| Protection | 0.5 A resettable fuse (F101), reverse-polarity diode (40 V), 30 V TVS. Survives a 12 V vehicle's clamped load dump (35 V) and ISO 7637-2 pulse 2a |
| Absolute maximum | 32 V steady (the TVS starts conducting at 33 V); −40 V reverse |
| Regulators | LM2596 buck to 5.3 V (5 V rail, 4.9 V after the OR-diode), then AMS1117 to 3.3 V |
| USB-C | Powers the whole board on the bench through its own 0.5 A fuse. Either supply can be connected alone or together |

### Power consumption

At VIN = 12 V, with the current firmware (ESP32 at 240 MHz, Wi-Fi and Bluetooth off):

| Condition | 3.3 V rail | 5 V rail | Input power | VIN current | From a 24 V battery through the converter |
|---|---|---|---|---|---|
| **Idle:** firmware running, nothing connected | 62 mA | 67 mA | 0.5 W | 40 mA | about 25 mA |
| **Typical:** GPS on 3.3 V, two LEDs on, RS485 polling, a 10 mA 5 V sensor | 100 mA | 115 mA | 0.8 W | 70 mA | about 40 mA |
| **Maximum:** every port at its limit (below) | 0.18–0.28 A | 0.49–0.59 A | 3.3–3.9 W | 0.27–0.33 A (0.43 A at 9 V) | about 185 mA |

- **Per day:** idle, the board uses about 12 Wh. From a 24 V battery through the converter, that is about 0.5 Ah, plus the converter's own idle current.
- **Maximum case:**
  - +5 V out (pin 11) and the GPS port on 5 V at their 200 mA fuses;
  - or the GPS on 3.3 V at 100 mA;
  - the Qwiic port at 50 mA;
  - RS485 transmitting continuously into a terminated bus (about 40 mA);
  - USB connected and every LED on.
- **If future firmware turns on Wi-Fi:** add about 100 mA on 3.3 V (about +0.6 W at VIN), with peaks of 500 mA.
- **Assumptions:**
  - LM2596 efficiency 75 % at light load, 80 % near 0.6 A;
  - AMS1117 ground current 5 mA;
  - LED currents as simulated (1.7 mA each).

**Converter for a 24 V truck:**
- **Output:** 12 V, at least 0.5 A (6 W) continuous. A 1 A unit leaves margin for Wi-Fi peaks and start-up.
- **Rating:** made for 24 V vehicles, with load-dump protection.
- **Non-isolated:** the board's GND has to be the vehicle ground. AIN1, DOUT1, RS485 and the UART are all referenced to it.

**F101 and heat:** a resettable fuse holds less current when hot. The maximum case at 12 V (0.33 A) stays under its 0.5 A rating, but at 9 V the maximum case comes close to it.

## Inputs and outputs

### DIN1, DIN2

| | |
|---|---|
| Type | Optocoupler-isolated, positive trigger: the input is active when it is above DIN COM |
| Threshold | Active above 6.7 V, idle below 6.5 V. A 12 V or 24 V signal reads active; an open input or a key-on "L" terminal (< 2 V) reads idle |
| Working range | 0–36 V |
| Input current | 0.9 mA at 9 V, 1.9 mA at 12 V, 5.8 mA at 24 V, 9.8 mA at 36 V (about 3 kΩ above the threshold) |
| Absolute maximum | +50 V / −60 V continuous. Survives a 58 V load dump and ISO 7637-2 pulses 1 (−600 V) and 2a (+112 V) |
| Isolation | DIN COM is not connected to GND. Functional isolation for ground offsets, not safety isolation: the closest copper is 1.5 mm away (J1 pins 5 and 6) |
| Firmware | DIN1: engine running (alternator / ignition, GPIO27). DIN2: pulse counter (GPIO26), 22 µs filter, up to 1 kHz with the default debounce |

### AIN1

| | |
|---|---|
| Type | Single-ended voltage input to GND (pin 2), 16-bit ADS1115 |
| Working range | 0–30 V (readable to 36 V). Software ranges 0–22.5 V, 0–11.2 V, 0–5.6 V and 0–2.8 V; [range table](../hour-meter-board-compact-lm2596-io/README.md#circuit-iokicad_sch) |
| Resolution | 1.4 mV on the 0–36 V range, 0.17 mV on 0–5.6 V |
| Accuracy | About ±0.5 % without calibration (0.1 % divider) |
| Input resistance | 110 kΩ to GND |
| Absolute maximum | ±60 V continuous. Survives an unclamped 24 V load dump (202 V) and ISO 7637-2 pulses 1, 2a, 3a and 3b |
| 4–20 mA | Fit R904 (120 Ω 0.1 % 1206): 0.48–2.4 V. With R904 fitted, the absolute maximum drops to the shunt's 0.25 W, about 5.5 V. A wire to 24 V burns it |

### DOUT1

| | |
|---|---|
| Type | Open-drain low-side switch (BSP75N, self-protected). The load goes between a fused supply and pin 10 |
| Load current | 0.5 A continuous. The current limit is 0.7–1.5 A, then thermal shutdown with automatic restart |
| Load supply | Up to 36 V (12 V or 24 V vehicle), where the short-circuit protection is specified |
| On resistance | 0.52 Ω typical |
| Off state | Leakage 3 µA typical, 15 µA maximum at 32 V. Off during reset and boot |
| Inductive loads | Relay coils and solenoids without a flyback diode: the 60–75 V clamp absorbs the kick (200 mJ at 150 °C) |
| Absolute maximum | 60 V on the pin when off. A short to +24 V while on is survived |
| Limit | Not through an unclamped 24 V load dump: the vehicle's central clamp is needed |

### RS485

| | |
|---|---|
| Transceiver | THVD2410, half duplex, up to 500 kbps, 1/8 unit load (up to 256 nodes) |
| Bus pins | A (pin 5), B (pin 12), bus ground on pin 2. The transceiver itself is rated ±70 V; the 33 V TVS on A and B sets ±33 V continuous; common mode ±25 V |
| Termination | 120 Ω (JP702) and bias 330 Ω (JP703 + JP704): solder jumpers, open as delivered ([Solder jumpers](README.md#solder-jumpers)) |
| Fault | A or B wired to 12 V or 24 V: the transceiver survives. With the jumpers bridged, their resistors burn open |

### UART

| | |
|---|---|
| Port | ESP32 UART2: TX on pin 3 (GPIO17), RX on pin 4 (GPIO16), +5 V on pin 11, GND on pin 2 |
| TX | 3.3 V logic through 100 Ω, ±20 mA |
| RX | 5 V-tolerant Schmitt buffer (74LVC1G17), 100 kΩ pull-up to 3.3 V: takes 3.3 V or 5 V logic |
| Protection | ESD array (SRV05-4) on TX and RX. Not protected against the vehicle supply |

### +5 V out (pin 11)

| | |
|---|---|
| Output | 4.9 V with no load, about 4.8 V at 200 mA |
| Current | 200 mA, resettable fuse F801 (trips above 0.46 A). It feeds a 5 V sensor and the UART device together |
| Short to GND | The fuse trips in 0.1–0.4 s and the ESP32 may reset. It recovers by itself |
| Absolute maximum | 5.5 V applied from outside. Never connect it to the vehicle supply |

## Other ports

| Port | Connector | Pins and ratings |
|---|---|---|
| **GPS** (J802) | JST GH 6-pin, Pixhawk pinout | 1 VCC: 3.3 V as delivered, or 5 V through JP801 with a 200 mA fuse (F803). 2 TX to the GPS's RX (GPIO32). 3 RX from the GPS's TX (GPIO36). 4 SCL. 5 SDA. 6 GND. TX and RX are 3.3 V logic through 100 Ω, not 5 V-tolerant |
| **GPS PPS** (TP801) | solder pad | GPIO39, 3.3 V logic, 100 kΩ pull-down |
| **Qwiic** (J803) | JST SH 4-pin | 1 GND, 2 3.3 V (not fused: keep external devices under 50 mA), 3 SDA, 4 SCL |
| **USB-C** (J201) | USB 2.0 full speed | CH340C serial port to the ESP32 (programming, configurator). 5 V sink, fused 0.5 A |
| **Spare GPIOs** | test pads TP803, TP806–TP808 | IO15, IO33, +3V3, GND. 3.3 V logic. IO15 is a strapping pin: don't pull it low at boot |

**I2C bus** (GPS port, Qwiic port and the on-board sensors): 3.3 V, 4.7 kΩ pull-ups on the board. Addresses in use:

| Address | Part |
|---|---|
| 0x1E | LIS3MDL magnetometer |
| 0x48 | ADS1115 ADC (AIN1) |
| 0x50 | AT24C256C EEPROM |
| 0x68 | DS3231M RTC |
| 0x69 | MPU-6500 IMU |

## Indicators and controls

| Part | Function |
|---|---|
| P1, P2, USR (D801–D803) | Green side-view LEDs on the right edge (GPIO18, GPIO19, GPIO5), 1.7 mA each |
| STATUS (D203) | GPIO2 |
| PWR (D106, D202) | 5 V regulator output and 3.3 V rail |
| RESET (SW201), BOOT (SW202) | ESP32 EN and IO0 |
| CR2032 (BT401) | Keeps the RTC running without supply. It draws a few µA, so a cell lasts for years |

## Operating conditions

- **Temperature:**
  - the board: −20 to +80 °C, the side-view LEDs' range (the fuses and the ESP32 go to +85 °C);
  - the CR2032 cell has its own range, often −20 to +70 °C.
- **Mounting:** in a plastic case. The ESP32 antenna overhangs the top edge ([Enclosure](README.md#enclosure)).
