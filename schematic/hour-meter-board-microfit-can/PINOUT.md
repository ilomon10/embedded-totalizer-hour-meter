# Micro-Fit + CAN + RS232 board: pinout and ratings

The electrical ratings of every connector on the [Micro-Fit + CAN + RS232 board](README.md), for installing and wiring it.

- **Supply:** the board runs from **12 V**. In a 24 V truck, feed it from a 24 → 12 V converter ([Supply](#supply)).
- **Sources:** the ratings come from the parts' datasheets and the board's [simulations](SIMULATION.md).
- **Working range:** where a pin is meant to operate.
- **Absolute maximum:** the most a pin survives without damage. Not a working value.

## J1 harness connector

Molex Micro-Fit 3.0, 2 × 8, right-angle header (43045-1600). Mating plug: housing 43025-1600 with 43030-0007 terminals; see the [harness parts](README.md#j1-harness-connector).

```
 16  15  14  13  12  11  10   9      looking into J1 from outside the case (latch on top)
  8   7   6   5   4   3   2   1
```

| Pin | Signal | Type | Working range | Absolute maximum | Current | Notes |
|---|---|---|---|---|---|---|
| 1 | GND | ground | – | – | up to about 1 A | Battery negative. Carries the board's supply current and DOUT1's load current |
| 2 | GND | ground | – | – | – | Return for sensors, RS232, RS485 and CAN |
| 3 | RS232 TX | RS-232 output | ±5.0 V min, ±6.3 V typical | ±70 V | ±80 mA (short circuit) | See [RS232](#rs232) |
| 4 | +5 V out | supply output | 4.8–4.9 V | 5.5 V applied from outside | 200 mA | Resettable fuse F801, for a 5 V sensor |
| 5 | CAN_L | bus | −12 to +12 V common mode | ±58 V (±36 V steady, see [CAN](#can)) | – | See [CAN](#can) |
| 6 | RS485 B | bus | −7 to +12 V (RS-485) | ±70 V (±36 V steady, see [RS485](#rs485)) | – | See [RS485](#rs485) |
| 7 | DIN COM | isolated return | – | ±60 V to GND | – | Return of DIN1/DIN2. Not connected to GND |
| 8 | DIN COM | isolated return | – | ±60 V to GND | – | Second wire for the same return |
| 9 | VIN | supply input | 9–30 V DC, 12 V nominal | 32 V steady, −40 V reverse | 45–350 mA at 12 V | See [Supply](#supply) |
| 10 | DOUT1 | open-drain output | load supply up to 36 V | 60 V (internal clamp) | 0.5 A continuous | See [DOUT1](#dout1) |
| 11 | AIN1 | analog input | 0–30 V | ±60 V continuous | 110 kΩ input | See [AIN1](#ain1) |
| 12 | RS232 RX | RS-232 input | ±3 to ±25 V | ±70 V | 3–7 kΩ input | See [RS232](#rs232) |
| 13 | CAN_H | bus | −12 to +12 V common mode | ±58 V (±36 V steady) | – | See [CAN](#can) |
| 14 | RS485 A | bus | −7 to +12 V (RS-485) | ±70 V (±36 V steady) | – | See [RS485](#rs485) |
| 15 | DIN1 | digital input | 0–36 V, active above 6.7 V | +50 V / −60 V continuous | 1.9 mA at 12 V, 5.8 mA at 24 V | See [DIN1, DIN2](#din1-din2) |
| 16 | DIN2 | digital input | 0–36 V, active above 6.7 V | +50 V / −60 V continuous | as DIN1 | Pulse counter, up to 1 kHz |

**Every pair of neighbouring pins survives a short** ([the harness simulation](SIMULATION.md#4-j1-neighbouring-pins-shorted)):
- the +5 V output (pin 4) touches only RS232 TX, RS232 RX and CAN_L, which cannot push it up;
- DOUT1 (pin 10) sits between VIN and AIN1, across from GND.

**Only one pin is not vehicle-proof:** +5 V out (pin 4). A wire from it to the vehicle supply damages the board. Every other pin survives a 24 V system's 28.8 V.

## Supply

| | |
|---|---|
| Input | VIN (pin 9) to GND (pin 1): 9–30 V DC, 12 V nominal |
| In a 24 V truck | From a 24 → 12 V converter, not the 24 V supply directly. The input does not survive a 24 V vehicle's 36 V jump start or 58 V load dump |
| Protection | 0.5 A resettable fuse (F101), reverse-polarity diode (40 V), 30 V TVS. Survives a 12 V vehicle's clamped load dump (35 V) and ISO 7637-2 pulse 2a |
| Absolute maximum | 32 V steady (the TVS starts conducting at 33 V); −40 V reverse |
| Regulators | LM2596 buck to 5.3 V (5 V rail, 4.9 V after the OR-diode), then AMS1117 to 3.3 V |
| USB-C | Powers the whole board on the bench through its own 0.5 A fuse. Either supply can be connected alone or together |

### Power consumption

At VIN = 12 V, with the current firmware (ESP32 at 240 MHz, Wi-Fi and Bluetooth off), from the [power budget](SIMULATION.md#5-power-budget):

| Condition | 3.3 V rail | 5 V rail (with the 3.3 V load) | Input power | VIN current | From a 24 V battery through the converter |
|---|---|---|---|---|---|
| **Idle:** firmware running, CAN recessive, RS232 idle | 70 mA | 80 mA | 0.52 W | 44 mA | about 25 mA |
| **Typical:** GPS on 3.3 V, two LEDs on, RS485 polling, RS232 into 5 kΩ, CAN sending 25 % of the time, a 10 mA 5 V sensor | 110 mA | 145 mA | 0.95 W | 79 mA | about 45 mA |
| **Maximum:** every port at its limit | 300 mA | 680 mA | 4.2 W | 0.35 A (0.46 A at 9 V) | about 200 mA |

- **Per day:** idle, the board uses about 12.5 Wh. From a 24 V battery through an 85 % converter, about 0.6 Ah, plus the converter's own idle current.
- **CAN + RS232:** they add 85 mW at idle, mostly the MAX13223E (always on, 8 mA).
- **Converter for a 24 V truck:** 12 V out, at least 0.5 A (6 W) continuous, made for 24 V vehicles with load-dump protection, **non-isolated**: the board's GND has to be the vehicle ground, since AIN1, DOUT1, RS485, RS232 and CAN are all referenced to it.
- **F101 and heat:** a resettable fuse holds less current when hot. The maximum case at 9 V (0.46 A) comes close to its 0.5 A rating.

## Inputs and outputs

### CAN

| | |
|---|---|
| Transceiver | NXP TJA1051T/3: ISO 11898-2 high speed, classic CAN up to 1 Mbit/s (5 Mbit/s CAN FD capable, but the ESP32 controller is classic CAN only) |
| Controller | ESP32 TWAI: TX on GPIO33, RX on GPIO15. One bus, 11- and 29-bit identifiers, 12.5 kbit/s to 1 Mbit/s, listen-only mode |
| Bus pins | CAN_H (pin 13), CAN_L (pin 5), bus ground on pin 2. The TJA1051 bus pins are rated ±58 V |
| Protection | SZNUP3105L at J1: 32 V working voltage (does not conduct on a 24 V system's 28.8 V), 30 pF per line |
| Absolute maximum | ±36 V steady from a stiff supply: above that the protector conducts and burns ([simulation](SIMULATION.md#2-can-and-rs485-lines-wired-to-a-supply)). Surges are clamped below 66 V |
| Termination | 120 Ω through JP1001, **open as delivered**. A vehicle bus is already terminated at both ends: bridge it only when the board is at one end of a bus |
| Listen-only | JP1002 bridged: the transceiver cannot transmit (hardware silent mode). Open as delivered: firmware decides (TWAI normal or listen-only mode) |
| Timing | Reads 250 and 500 kbit/s buses with the board on a stub of up to 3 m ([simulation](SIMULATION.md#1-can-bus-timing)) |
| Supply | 5 V for the transceiver (5 mA recessive, up to 70 mA while sending), 3.3 V logic |

What the CAN port reads, and how to wire it, is in [the README](README.md#can-port).

### RS232

| | |
|---|---|
| Transceiver | Maxim (ADI) MAX13223E on ESP32 UART2: TX from GPIO32, RX to GPIO34. The GPS port shares UART2 through the GPIO matrix (on GPIO16/17), so only one of the two works at a time |
| Levels | TX ±5.0 V minimum, ±6.3 V at the end of a cable with the worst EIA-232 load (3 kΩ + 2500 pF). RX: high above 2.4 V, low below 0.6 V, 3–7 kΩ input |
| Rate | Up to 250 kbit/s. The firmware's highest UART setting (921600) is too fast for RS232: use 115200 or less |
| Absolute maximum | **±70 V on TX and RX:** a wire to a 12 V or 24 V supply, or a short to any J1 neighbour, does no damage. Above 14 V the driver draws at most 6 mA |
| Pins | TX on pin 3, RX on pin 12, signal ground on pin 2. A DB9 device: its RXD (DB9 pin 2 on a DTE) to J1 pin 3, its TXD (DB9 pin 3) to J1 pin 12, its GND (DB9 pin 5) to J1 pin 2 |
| Supply | 3.3 V, about 8 mA while on. Always on (FORCEON high): a device that only listens is still driven |

### RS485

| | |
|---|---|
| Transceiver | THVD2410, half duplex, up to 500 kbps, 1/8 unit load (up to 256 nodes) |
| Bus pins | A (pin 14), B (pin 6), bus ground on pin 2. The transceiver is rated ±70 V; common mode ±25 V |
| Protection | SZNUP3105L at J1, the same part as on CAN: ±36 V steady from a stiff supply, surges clamped below 66 V |
| Termination | 120 Ω (JP702) and bias 330 Ω (JP703 + JP704): solder jumpers, open as delivered ([Solder jumpers](README.md#solder-jumpers)) |
| Fault | A or B wired to 12 V or 24 V: the transceiver survives. With a jumper bridged and the other line on GND, R704 burns open |

### DIN1, DIN2

| | |
|---|---|
| Type | Optocoupler-isolated, positive trigger: the input is active when it is above DIN COM |
| Threshold | Active above 6.7 V, idle below 6.5 V. A 12 V or 24 V signal reads active; an open input or a key-on "L" terminal (< 2 V) reads idle |
| Working range | 0–36 V |
| Input current | 0.9 mA at 9 V, 1.9 mA at 12 V, 5.8 mA at 24 V, 9.8 mA at 36 V |
| Absolute maximum | +50 V / −60 V continuous. Survives a 58 V load dump and ISO 7637-2 pulses 1 (−600 V) and 2a (+112 V) |
| Isolation | DIN COM is not connected to GND. Functional isolation for ground offsets, not safety isolation: the closest copper is 1.5 mm away (J1 pins 6 and 7) |
| Firmware | DIN1: engine running (alternator / ignition, GPIO27). DIN2: pulse counter (GPIO26), 22 µs filter, up to 1 kHz |

### AIN1

| | |
|---|---|
| Type | Single-ended voltage input to GND (pin 2), 16-bit ADS1115 |
| Working range | 0–30 V (readable to 36 V). Software ranges 0–22.5 V, 0–11.2 V, 0–5.6 V and 0–2.8 V |
| Accuracy | About ±0.5 % without calibration (0.1 % divider) |
| Input resistance | 110 kΩ to GND |
| Absolute maximum | ±60 V continuous. Survives an unclamped 24 V load dump (202 V) and ISO 7637-2 pulses 1, 2a, 3a and 3b |
| 4–20 mA | Fit R904 (120 Ω 0.1 % 1206): 0.48–2.4 V. With R904 fitted, the absolute maximum drops to the shunt's 0.25 W, about 5.5 V |
| A 5 V sensor | Supply from pin 4 (+5 V out), signal on pin 11, ground on pin 2: three neighbouring cavities |

### DOUT1

| | |
|---|---|
| Type | Open-drain low-side switch (BSP75N, self-protected). The load goes between a fused supply and pin 10 |
| Load current | 0.5 A continuous. The current limit is 0.7–1.5 A, then thermal shutdown with automatic restart |
| Load supply | Up to 36 V (12 V or 24 V vehicle) |
| On resistance | 0.52 Ω typical |
| Inductive loads | Relay coils and solenoids without a flyback diode: the 60–75 V clamp absorbs the kick (200 mJ at 150 °C) |
| Absolute maximum | 60 V on the pin when off. A short to +24 V while on is survived |

### +5 V out (pin 4)

| | |
|---|---|
| Output | 4.9 V with no load, about 4.8 V at 200 mA |
| Current | 200 mA, resettable fuse F801 (trips above 0.46 A) |
| Short to GND | The fuse trips in 0.1–0.4 s and the ESP32 may reset. It recovers by itself |
| Absolute maximum | 5.5 V applied from outside. Never connect it to the vehicle supply |

## Other ports

| Port | Connector | Pins and ratings |
|---|---|---|
| **GPS** (J802) | JST GH 6-pin, Pixhawk pinout, right edge | 1 VCC: 3.3 V as delivered, or 5 V through JP801 with a 200 mA fuse (F803). 2 TX to the GPS's RX (GPIO16). 3 RX from the GPS's TX (GPIO17). 4 SCL. 5 SDA. 6 GND. 3.3 V logic through 100 Ω, not 5 V-tolerant |
| **GPS PPS** (TP801) | solder pad | GPIO4, 3.3 V logic, 100 kΩ pull-down |
| **Qwiic** (J803) | JST SH 4-pin, right edge | 1 GND, 2 3.3 V (not fused: keep external devices under 50 mA), 3 SDA, 4 SCL |
| **USB-C** (J201) | USB 2.0 full speed, right edge | CH340C serial port to the ESP32 (programming, configurator). 5 V sink, fused 0.5 A |
| **Probe pads** | TP807, TP808 | +3V3 and GND |

**I2C bus** (GPS port, Qwiic port and the on-board sensors): 3.3 V, 4.7 kΩ pull-ups on the board. Addresses in use: 0x1E LIS3MDL, 0x48 ADS1115, 0x50 AT24C256C, 0x68 DS3231M, 0x69 MPU-6500.

**No spare GPIOs:** GPIO15 and GPIO33, the Micro-Fit board's spare test pads, now carry CAN RX and TX.

## Indicators and controls

| Part | Function |
|---|---|
| P1, P2, USR (D801–D803) | Green side-view LEDs on the right edge (GPIO18, GPIO19, GPIO5), 1.7 mA each |
| STATUS (D203) | GPIO2 |
| PWR (D106, D202) | 5 V regulator output and 3.3 V rail |
| RESET (SW201), BOOT (SW202) | ESP32 EN and IO0 |
| CR2032 (BT401) | Keeps the RTC running without supply, on the bottom side |

## Operating conditions

- **Temperature:** −20 to +80 °C, the side-view LEDs' range (the fuses, the ESP32 and the transceivers go to +85 °C); the CR2032 cell has its own range, often −20 to +70 °C.
- **Mounting:** in a plastic case. The ESP32 antenna overhangs the top edge ([Enclosure](README.md#enclosure)).
