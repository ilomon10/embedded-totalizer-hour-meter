# Testing Modules Before Soldering

Test every module **on its own** with the bench-test firmware before it goes into the carrier board. A faulty clone module found on the bench costs minutes; found after soldering, it costs an evening.

The bench firmware (`src/bench/BenchMain.cpp`, PlatformIO env `bench`) uses the **same drivers** as the product firmware, so a module that passes here works the same way later.

## 1. Flash the bench firmware

```bash
cd esp32
pio run -e bench -t upload
pio device monitor -e bench          # 115200 baud, type a key + Enter
```

You get a menu:

```
=== Hour meter module bench test ===
  s  I2C scan (what is connected?)
  e  AT24C256 EEPROM   (non-destructive: saves and restores the test area)
  r  DS3231 RTC        (time valid, ticking, temperature)
  i  MPU9250 IMU       (keep it flat and still)
  o  817 module inputs (live levels of GPIO27 / GPIO26 for 20 s)
  p  power / LM2596 checklist (multimeter)
  a  run all automatic tests (s e r i)
  t <epoch>  set the RTC to a UTC epoch, e.g. t 1791376496
```

Each test prints **PASS**, **WARN** (works, but read the note) or **FAIL** (with the likely cause).

## 2. Wire one module at a time (breadboard / jumper wires)

All I2C modules use the same four wires. Power them from **3V3, never 5 V**.

| Module pin | ESP32 DevKit pin |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SDA | GPIO21 |
| SCL | GPIO22 |

| Order | Module | Extra wiring | Key | PASS means |
|---:|---|---|---|---|
| 1 | — (nothing) | — | `s` | Shows the bus is free (FAIL "nothing answers" is expected here) |
| 2 | AT24C256 | A0, A1, A2 = GND (default jumpers) | `s`, `e` | Found at 0x50; 96 bytes written across a page edge and read back; original bytes restored |
| 3 | DS3231 | — | `s`, `r` | Found at 0x68; seconds tick; temperature plausible. WARN "time not set" is normal without a battery: `t <epoch>` sets it |
| 4 | MPU9250 | **AD0 → 3V3** | `s`, `i` | Found at 0x69; \|accel\| ≈ 1 g flat and still; gyro quiet; magnetometer 10–150 µT |
| 5 | 817 module | V1 → GPIO27, V2 → GPIO26, G(out) → GND, 47 kΩ pull-ups to 3V3, **jumpers removed**; IN1/IN2 from a 12 V bench supply through 1N4007 + 1.5 kΩ | `o` | GPIO27 goes LOW while 12 V is on IN1 and HIGH when off |
| 6 | LM2596 | 12/24 V in, nothing on the output | `p` | Follow the checklist; set 5.00 V **before** connecting the ESP32 |
| 7 | All together | everything on the same bus | `a` | Summary table: scan/eeprom/rtc/imu PASS |

Getting the current UTC epoch for `t`: `date +%s` (Linux/macOS) or `Math.floor(Date.now()/1000)` in a browser console.

## 3. Common failures

| Symptom | Likely cause |
|---|---|
| Scan: "nothing answers" with a module connected | VCC/GND missing, SDA/SCL swapped, module needs pull-ups (most have them) |
| IMU FAIL "something at 0x68: tie AD0 to 3V3" | AD0 floating/low: the IMU sits on the RTC's address |
| IMU WARN "no AK8963" | The board is an MPU6500 (no compass). Everything else works; heading will be unavailable |
| IMU FAIL "values never change" | Dead or counterfeit chip |
| EEPROM FAIL at 0x50 but something at 0x51–0x57 | Address jumpers not all on GND |
| RTC FAIL "not ticking" | Oscillator dead or EOSC set by another tool (the driver clears it; retry once) |
| 817: CH1 never goes LOW | IN1 polarity, D1 backwards, LED on the module does not light → input side |
| 817: CH1 stuck LOW | G jumper still fitted with a shared ground fault, or pull-up missing |

## 4. After the bench: modular by design

The product firmware does **not** require every module:

- Boots and counts engine hours with **no modules at all** (inputs only).
- Each I2C module is **detected while running**: plug it in and it is attached within ~2 s; unplug it and it is marked missing after ~6 s. Every change is reported as an EVENT (`devicesChanged`) and in the TUI's *Modules* panel.
- An EEPROM plugged in later: its stored hour meter is **added** to what was counted meanwhile, and its settings take effect (or your RAM settings are saved to it if you changed any).
- Missing RTC: `setTime` still works (RAM clock, flag `timeNotBackedUp`).
- Missing IMU: no vibration/orientation data; everything else works.

So you can also bring the board up gradually: flash the product firmware with only the ESP32 fitted, watch it in the TUI (`npm run tui`), then add modules one by one and see each appear.

> Hot-plugging on a breadboard is fine for testing. In the vehicle, power down before plugging modules: an I2C connection made live can glitch the bus (the firmware recovers, but avoid it in production).
