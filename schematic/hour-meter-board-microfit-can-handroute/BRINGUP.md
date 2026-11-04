# Bring-up: first power-on of the hand-routed CAN board

How to power a new board from JLCPCB for the first time without damaging it, then check each module. Go through the steps in order, and stop at the first one that fails ([If a step fails](#if-a-step-fails)).

**You need:**
- a multimeter;
- a bench supply with a current limit;
- a USB-C cable and a PC with PlatformIO;
- a 12 V lamp, or an LED with a 1 kΩ resistor.

**Optional:** a GPS module with a JST GH 6-pin cable, and CAN, RS485 or RS232 adapters.

## Where to measure

Most part references are not printed on the board. These points are easy to find:

| Point | Net | Where |
|---|---|---|
| TP808 | GND | round test pad right of the GPS label |
| TP807 | +3V3 | round test pad above the QWIIC label |
| C102 + pad | VIN_LM (input after the reverse-polarity diode) | big electrolytic capacitor left of U101, + marked on the silkscreen |
| C104 + pad | +5V_PSU (the 5 V regulator's output) | electrolytic capacitor right of L101, + marked |
| J1 pins | VIN, +5V OUT, the bus lines | on the bottom side; the pinout is printed next to them |

Put the black probe on TP808 for every voltage below. The KiCad PCB editor finds any other part: press Ctrl+F and type its reference.

## 1. Look before you power it

- **Fine-pitch chips:** look for solder bridges with a magnifier. The IMU chips U601 and U602 sit under the IMU label, U901 under AIN1 ADC and U1101 under RS232.
- **Polarity:** the + marks of C102 and C104, the cathode bands of D101, D103 and D105 against the silkscreen, and pin 1 of every chip.
- **Solder jumpers:** all are open except JP801, whose pads 1 and 2 come joined (GPS supply 3.3 V).
- **Coin cell:** leave BT401 empty for now.

## 2. Resistance checks, power off

Set the meter to resistance (auto range). Each rail to GND:

| Red probe on | Expect | Stop if |
|---|---|---|
| J1 pin 9 (VIN) | a reading that climbs to tens of kΩ or more while the input capacitors charge | under 100 Ω and not climbing |
| C102 + pad | climbs the same way | under 100 Ω |
| C104 + pad | about 4.3 kΩ (the feedback divider R103 + R104); it may start lower while the capacitors charge | under 100 Ω |
| J1 pin 4 (+5V OUT) | usually above 1 kΩ, rising | under 100 Ω |
| TP807 (+3V3) | usually above 1 kΩ, rising | under 100 Ω |

A reading under 100 Ω that does not climb is a short. Find it before you apply power.

## 3. First power-up from the bench supply

1. Set the supply to 12.0 V with a 100 mA current limit, output off.
2. Connect + to J1 pin 9 (VIN) and − to J1 pin 1 (GND). Use the harness plug, or clip onto the pins on the bottom side.
3. Switch on and watch the current. It should settle at about 45–60 mA within a second. If the supply sits at its 100 mA limit, switch off at once ([If a step fails](#if-a-step-fails)).
4. **LEDs:** the red LED in the 5V BUCK area (D106) and the red power LED by the ESP32 (D202) light.
5. Measure:

   | Point | Expect at 12 V | What it shows |
   |---|---|---|
   | C102 + pad | 11.6–11.8 V | input fuse F101 and reverse-polarity diode D103 pass the supply |
   | C104 + pad | 5.13–5.45 V (5.29 V typical) | LM2596 regulates; R103/R104 set the voltage |
   | J1 pin 4 | 4.9–5.2 V | the +5V rail after D101, through fuse F801 |
   | TP807 | 3.24–3.37 V | the 3.3 V regulator U204 |

6. **Other input voltages:**
   - **9 V:** the same rail voltages; the current rises to about 60–75 mA.
   - **24 V:** the same rail voltages; the current falls to about half the 12 V figure.
   - **30 V (optional):** shows that the surge clamp D104 stays off, because the current stays low.
7. **After a minute:** U101, D105, L101 and U204 are at most slightly warm.

Simulated on this board's copper: every chip's supply stays inside its rating from 9 to 30 V. The copper loses at most 40 mV on any rail.

## 4. USB power and the USB-serial chip

1. Disconnect the bench supply and plug USB-C into the PC.
2. **LEDs:** D202 (3.3 V) lights and D106 stays dark. D101 keeps USB power out of the 5 V regulator's output, which feeds D106.
3. **Voltages:** TP807 reads 3.24–3.37 V and J1 pin 4 about 4.4–4.9 V. That is USB's 5 V less the USB fuse and diode.
   - The CAN transceiver and the DOUT1 buffer need 4.5 V, so test them on VIN power, not on USB alone.
4. **The PC finds the board:**
   - **Linux:** `lsusb` lists `1a86:7523 QinHeng Electronics CH340 serial converter`, and `/dev/ttyUSB0` appears.
   - **Windows:** a COM port appears (CH340 driver).

USB and VIN can be connected at the same time: two diodes share the +5V rail between them.

## 5. Flash the bench firmware and check the I2C chips

```bash
cd esp32
pio run -e bench -t upload
pio device monitor -e bench          # 115200 baud, type a key + Enter
```

The upload puts the ESP32 into download mode by itself (Q201/Q202). If it fails to connect, hold BOOT, press and release RESET, then release BOOT and upload again. The menu is described in [TESTING-MODULES.md](../../esp32/docs/TESTING-MODULES.md).

1. **`s` (I2C scan):** five devices answer.

   | Address | Chip | Module |
   |---|---|---|
   | 0x1E | LIS3MDL magnetometer (U602) | IMU |
   | 0x48 | ADS1115 ADC (U901) | AIN1 ADC |
   | 0x50 | AT24C256 EEPROM (U501) | EEPROM |
   | 0x68 | DS3231M clock (U401) | RTC |
   | 0x69 | MPU-6500 accelerometer and gyro (U601) | IMU |

2. **`a` (all tests):**
   - **EEPROM and RTC:** PASS.
   - **IMU:** PASS with WHO_AM_I 0x70 (MPU-6500).
   - **Magnetometer:** WARN "no AK8963". This is expected: this board's compass is the separate LIS3MDL at 0x1E, which firmware 2.7.0 does not read yet.
3. **Coin cell:** put a CR2032 in BT401 on the bottom, + side facing away from the board. Set the clock with `t <epoch>`, power off and on: the time keeps running.

## 6. Inputs and outputs

Some ports need firmware that is still to be written ([routed board, Firmware to do](../hour-meter-board-microfit-can/README.md#firmware-to-do)). These checks test the hardware with the meter.

- **DIN1 and DIN2 (isolated inputs):**
  - Run `o` in the bench firmware: it shows GPIO27 and GPIO26 live.
  - Apply 12 V with + on J1 pin 15 (DIN1) and − on J1 pin 7 (DIN COM): GPIO27 changes from high to low.
  - Pin 16 (DIN2) does the same for GPIO26.
  - DIN COM is isolated from the board's GND, so the input supply's − goes to pin 7 or 8.
- **AIN1:** apply 12.0 V between J1 pin 11 and GND. C902, next to U901, reads 1.09 V (12 V × 10 kΩ / 109.8 kΩ); 30 V gives 2.73 V.
- **CAN (VIN power):**
  - J1 pins 13 (CAN H) and 5 (CAN L) each read about 2.5 V, and 0 V between them: an idle bus.
  - With power off, the resistance between pins 13 and 5 is above 10 kΩ; with the CAN TERM jumper (JP1001) closed it is about 120 Ω.
- **RS485:** with power off, J1 pins 14 (A) and 6 (B) read above 10 kΩ apart; with JP702 (485 TERM) closed, about 120 Ω.
- **RS232:** J1 pin 3 (TX) sits 5–6 V away from GND, negative when the port idles. 0 V means U1101's charge pump is not running: check C1101–C1104 around U1101.
- **DOUT1:** a 12 V lamp from VIN to J1 pin 10 stays dark. It switches on only once the firmware drives GPIO23.
- **GPS:** plug the module into J802.
  - J802 pin 1 reads 3.3 V (JP801 1-2).
  - After a fix, the module's PPS LED blinks, and TP801 (PPS) pulses once a second.
- **Qwiic:** J803 pin 2 reads 3.3 V.
- **Buttons:** RESET restarts the ESP32 (the monitor prints the menu again).

## If a step fails

| Symptom | Likely cause | Check |
|---|---|---|
| The supply sits at its current limit, rails near 0 V | a short on VIN_LM, +5V or +3V3 | Repeat step 2. With the limit at 100 mA, the part that warms up first is usually the shorted one |
| C102 + is fine, C104 + reads 0 V | the LM2596 is not switching | U101 pin 5 (ON/OFF) must be at GND; solder joints of U101, L101 and D105 |
| C104 + reads close to VIN | the regulator's feedback is open | R103, R104 and U101 pin 4 |
| +5V is fine, TP807 reads 0 V | U204 is not working, or +3V3 is shorted | With power off, TP807 to TP808 again |
| TP807 under 3.2 V and the current is high | a part on +3V3 draws too much | Feel for a warm chip |
| No serial port on USB | U202 (CH340C), J201 or F201 | D202 must light on USB power |
| A chip missing from the I2C scan | its solder joints | Under magnification: U601 and U602 have pads underneath |
| A DIN input does not change | D301/D303 orientation, U301/U302 | Is the input's − on DIN COM (J1 pin 7 or 8)? |
