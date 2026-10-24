# Wiring

Pin assignments are defined in [`include/BoardPins.h`](../include/BoardPins.h). Change them there only.

## I2C bus (shared)

```
 ESP32 3V3 ───┬──────────────┬───────────────┬────────────── VCC of all modules
 ESP32 GND ───┼──────────────┼───────────────┼────────────── GND of all modules
 GPIO21 SDA ──┼─── SDA ──────┼─── SDA ───────┼─── SDA
 GPIO22 SCL ──┴─── SCL ──────┴─── SCL ───────┴─── SCL
              AT24C256        DS3231          MPU9250
              0x50            0x68            0x69  (AD0 → 3V3 !)
              A0,A1,A2→GND                    (+ AK8963 0x0C inside)
```

| Device | Address | Notes |
|---|---|---|
| AT24C256 EEPROM | `0x50` | A0–A2 to GND. WP to GND (write enabled). Optional from firmware 2.6.0: the ESP32's flash keeps the same values ([STORAGE.md](STORAGE.md)) |
| DS3231 RTC | `0x68` | Fixed address |
| MPU9250 IMU | **`0x69`** | **Tie AD0 to 3V3.** With AD0 low it would also be `0x68` and collide with the RTC: both chips would answer, and the data would be garbage |
| AK8963 magnetometer | `0x0C` | Inside the MPU9250, reached through bypass mode (set by the firmware) |
| AT24C32 on ZS-042 RTC boards | `0x57` | Present on many DS3231 modules. Not used, harmless |

**Pull-ups:** I2C needs one set of pull-ups (2.2–4.7 kΩ to 3V3) on SDA and SCL. Most breakout modules already have them. With three modules in parallel the combined value can get low (< 1.5 kΩ); if the bus is unreliable, remove the pull-ups from some modules. Keep wires under about 30 cm at 400 kHz.

**3.3 V only.** Power the modules from 3V3, not 5V: the ESP32's I2C pins are not 5 V tolerant.

## DS3231 battery warning (ZS-042 modules)

Many cheap ZS-042 DS3231 boards include a "charging" circuit (a 200 Ω resistor + diode from VCC to the battery). With a normal **CR2032 (not rechargeable)** this can make the battery swell or leak. Either fit an LIR2032 (rechargeable), or remove the resistor (or diode) next to the battery holder. ### Running without a battery

The firmware copes with a battery-less RTC (no data is lost; see [INTEGRATION-GUIDE §9.2](INTEGRATION-GUIDE.md#92-running-without-an-rtc-battery)):

- the **hour meter and totalizer are unaffected**: they continue from EEPROM after every power cut;
- after a power cut the device reports `timeInvalid` (and `rtcBatteryLost` if the time had been set before), and uses uptime timestamps;
- the `hour-meter` tool **re-sends the PC clock automatically** (TUI and `hour-meter read`; disable with `--no-time-sync`);
- `setTime` works even with no RTC fitted at all (time kept in RAM until the next reboot, flag `timeNotBackedUp`).

What you lose without a battery is real time **while no app is connected after a power cut**. To keep time across power cuts without an app, use one of:

| Option | Keeps time for | Notes |
|---|---|---|
| LIR2032 rechargeable cell | months to years | Works with the ZS-042 charging circuit as-is |
| CR2032 + remove the ZS-042 charging resistor | years | Cheapest; see the warning above |
| Supercapacitor 1 F / 5.5 V on VBAT (with the charging resistor) | ~3 days (0.22 F: ~20 h) | No battery to replace; DS3231 draws ~3 µA |
| Power the board from **permanent** battery +12/24 V (not ignition) | as long as the battery | J4 to battery +; the board draws ~60–100 mA, so check the vehicle can afford it when parked |

## Power input (12/24 V vehicle supply)

```
 J4 +12/24V ──► F1 MF-R050 (60V PTC) ──► D3 1N5819 ──┬── D4 P6KE36CA (TVS) ──┬── C3 100µF 50V ──► LM2596 IN+
 J4 GND ─────────────────────────────────────────────┴───────────────────────┴───────────────────► LM2596 IN-
                                                     LM2596 OUT+ (set 5.0 V!) ──► ESP32 VIN       OUT- ──► GND
```

| Part | Why |
|---|---|
| F1 PTC 0.5 A / 60 V | Resets itself after a short. A 16 V polyfuse (MF-RG/MF-RHT series) is **not** enough for 24 V vehicles |
| D3 1N5819 | Reverse-polarity protection, 0.4 V drop |
| D4 P6KE36CA | Clamps load-dump and ignition spikes (36 V standoff, above a 24 V system's 28.8 V) |
| C3 100 µF 50 V | Input buffer for the buck converter |
| LM2596 module | 4.5–40 V in → 5 V out. **Adjust the trimmer to 5.0 V before fitting the ESP32** |

If you also plug in USB while VIN is powered, check that your DevKit has a diode between USB 5 V and VIN.

## Engine inputs

Both engine signals go through a **2-channel PC817 optocoupler module** (the blue/green "817 Module" board, rated 3.6–24 V input / 3.6–30 V output):

```
 Engine running (L / D+)   ──► 817 module CH1 (IN1 → V1) ──► GPIO27   (pick the wire: see Channel 1)
 Pulse sensor, 12/24 V     ──► 817 module CH2 (IN2 → V2) ──► GPIO26   (optional, see below)
```

| Input | Pin | Default behaviour | Settings |
|---|---|---|---|
| Engine running | GPIO27 | **LOW = running** (CH1 conducts), 200 ms debounce | `altActiveHigh` (default `false`), `altDebounceMs`, `runVibMinMg` |
| Totalizer pulses | GPIO26 | Falling edge (= pulse start through CH2), ≥ 1 ms apart | `pulseRisingEdge`, `pulseMinIntervalUs`, `pulsesPerUnit` |

**Never connect vehicle voltage directly to a GPIO.** Vehicle systems have load-dump spikes well over 40 V, and the ESP32 pins tolerate 3.6 V at most.

### The 817 module

```
            INPUT side (vehicle)                    OUTPUT side (ESP32)
          ┌──────────────────────────────────────────────────┐
  IN1 ────┤ R1 ─ LED1 ─►|PC817 ch1 LED     ch1 transistor C ├──── V1
  G   ────┤                      ▼          ch1 transistor E ├──── G
          │                 [J1 jumper: G(in) ↔ G(out)]       │
  IN2 ────┤ R3 ─ LED2 ─►|PC817 ch2 LED     ch2 transistor C ├──── V2
  G   ────┤                                 ch2 transistor E ├──── G
          └──────────────────────────────────────────────────┘
```

- **IN / G (input):** apply voltage to IN (positive) and G. The on-board resistor (about 3 kΩ on most boards) plus the red indicator LED and the PC817 LED need about **3.7 V** to switch on.
- **V / G (output):** V is the phototransistor **collector**, G its **emitter**. When the input is on, V is pulled to G (**LOW**); when off, V floats and needs a pull-up. Most boards also have a resistor (R2/R4, about 3 kΩ) in series with V.
- **Jumper per channel:** connects input G to output G. **Remove both jumpers.** With a jumper fitted, vehicle ground and ESP32 ground are joined and the isolation is gone.

### Channel 1: engine-running input

The device counts run time while this input has voltage. So it needs a wire that is **dead with the key ON and the engine stopped**, and live only once the engine runs. Many wires near the alternator are live as soon as the key is at ACC/ON, and then the meter counts while the engine is off.

#### Pick the wire

| Wire | Key OFF | Key ON / ACC, engine off | Engine running | Use it? |
|---|---|---|---|---|
| **L** or **D+** on the alternator (thin wire to the charge-warning lamp), measured **at the alternator** | 0 V | **< 2 V** (the regulator grounds it; the lamp lights) | battery V (13–14 V / 27–28 V) | ✔ **best** |
| Oil-pressure **warning switch** terminal (the wire between the lamp and the switch) | 0 V | **< 1 V** (the switch is closed to ground) | battery V through the lamp | ✔ good alternative |
| The same charge-lamp wire, tapped **behind the dashboard** on the key side of the lamp | 0 V | battery V | battery V | ✘ counts at ACC |
| **IG**, **R** or **S** in the alternator's small plug (from the key switch / sense) | 0 V | battery V | battery V | ✘ counts at ACC |
| **B / B+** (thick output cable) | battery V | battery V | battery V | ✘ always counts |
| **P** or **W** (phase / tachometer) | 0 V | 0 V | AC pulses, frequency follows RPM | ✘ not with this circuit (the input reads a steady level) |
| Oil-pressure **gauge sender** (not the warning switch) | | a resistance, not a switch | | ✘ |

Terminal letters differ between makers, so **measure before you connect.** With a multimeter between the candidate wire and vehicle ground (chassis), take three readings:

1. **Key OFF:** about 0 V. If it reads battery voltage, it's B+: wrong wire.
2. **Key ON / ACC, engine off:** must read **below 2 V**. Battery voltage here is the "counts at ACC" wire.
3. **Engine running:** must read **above 10 V** on a 12 V system, **above 20 V** on 24 V.

Only a wire that passes all three is right. Then confirm with the device connected: `hour-meter read` shows `engine OFF` with the key on and the engine stopped, and `engine ON` within about a second of starting.

> **Oil-pressure switch:** tap the switch terminal itself, not the dashboard side of the warning lamp. The lamp (bulb or LED) must stay in the circuit, because it is what carries battery voltage to the wire once the switch opens. The 2 mA the input draws through it does not light it.

#### Only a key-on wire is reachable

If you can't reach L / D+ or the oil-pressure switch (sealed harness, rental machine), use the key-on wire and let the IMU confirm that the engine turns. Set `runVibMinMg`: run time then counts only while the input is on **and** the vibration RMS is at least that many mg. It is also a useful safety net with the right wire.

1. Key ON, engine **off**: watch `vibRms` in `hour-meter read` (or the TUI) for 10 s and note the highest value, e.g. 8 mg.
2. Engine at **idle**: note the lowest value, e.g. 45 mg.
3. Set a value about halfway and at least twice the engine-off value: `hour-meter set runVibMinMg=25`.
4. Check: with the key on and the engine off, `hour-meter read` shows `engine OFF (input on)`; at idle it shows `engine ON`.

How it behaves:
- **Starting and stopping:** the engine counts from the first vibration window above the threshold. That is at most `vibrationWindowMs` (default 1 s) after it starts. Counting stops when the RMS falls below 70 % of the threshold, so quiet moments at idle don't stop it.
- **No IMU fitted or unplugged:** the input alone decides, so no hours are lost.
- **Turning it off:** `0` turns the check off (the default).
- **Mounting:** mount the board solidly to the machine. A loose or foam-mounted board under-reads vibration.

#### Circuit

**Input side (vehicle):**

```
                    D1               R4
 L / D+ (see above) ►|─────────────/\/\/\───────── IN1  ┐
                  1N4007        1.5 kΩ 0.5 W              │ 817 module CH1
 Vehicle ground ───────────────────────────────── G    ┘ (input side)
```

**Output side (ESP32):**

```
 3V3 ───── R5 47 kΩ ──────●──────────●──────── GPIO27
                          │          │
                     V1 ──┘       C1 100 nF
                     (817 out)       │
 ESP32 GND ─────── G (817 out) ──────┴──────── GND
```

| Part | Value | Why |
|---|---|---|
| D1 | 1N4007, band toward the module | Reverse-polarity and negative-spike protection (the module has none) |
| R4 | **1.5 kΩ, 0.5 W** | Keeps a **24 V** system (28.8 V charging) within the module's 24 V input rating and the on-board resistor's power limit. Works for 12 V systems too |
| R5 | **47 kΩ** to 3V3 | Pull-up for the open-collector output. Must be weak: with the ~3 kΩ on-board series resistor, 10 kΩ would put the LOW level (≈ 0.85 V) above the ESP32's 0.8 V input threshold. The firmware also enables the internal pull-up |
| C1 | 100 nF, GPIO27 to GND | Filters ignition noise. The firmware's 200 ms debounce handles the rest |
| TVS (optional) | SMBJ36A from IN1 (after D1) to vehicle ground | Extra load-dump protection in harsh installations |

Input current through D1 + R4 + module (≈ 3.7 V of LED drops, 3 kΩ on-board):

| Alternator output | LED current | On-board resistor power | Result |
|---|---:|---:|---|
| 0–2 V (engine stopped, L lamp on) | 0 mA | — | OFF → GPIO27 HIGH → **stopped** (below the 3.7 V turn-on, so charge-lamp voltage is ignored) |
| 12–13 V with the engine **stopped** | 1.7 mA | 0.01 W | ON → counts as **running**: this is a key-on wire, see [Pick the wire](#pick-the-wire) |
| 12.0 V (12 V system, weak) | 1.7 mA | 0.01 W | ON → GPIO27 LOW → **running** |
| 14.4 V (12 V system charging) | 2.2 mA | 0.01 W | ON |
| 28.8 V (24 V system charging) | 5.4 mA | 0.09 W | ON (SMD resistor limit ≈ 0.125 W) |

The output only needs about 0.1 mA (3.3 V across 47 kΩ ∥ internal pull-up), so even 1.7 mA of LED current saturates the PC817.

**Logic:** engine running → CH1 LED on (red indicator LED1 lights) → V1 pulled to G → **GPIO27 = LOW**. That is why the default is `altActiveHigh = false`.

### Channel 2: pulse input (optional)

Use CH2 when the totalizer or speed sensor outputs a **12/24 V** pulse: same parts as channel 1 (D2 1N4007 + R6 1.5 kΩ on the input; R7 47 kΩ pull-up and C2 to GPIO26 on the output), with **C2 = 1 nF** instead of 100 nF so fast pulses survive. Each pulse pulls GPIO26 LOW, which matches the default falling-edge counting. The PC817 is fine up to a few kHz.

If the pulse sensor is an open-collector/3.3 V-safe output, skip CH2 and wire it straight to GPIO26 (internal pull-up).

### Checking it with a multimeter (ESP32 powered)

| Engine | IN1 to G (input side) | LED1 on module | GPIO27 to GND | Reader shows |
|---|---|---|---|---|
| Key ON, engine off | < 2 V | off | ≈ 3.3 V | `engine OFF` |
| Running | ≈ 13–14 V or 27–28 V | **on** | < 0.6 V | `engine ON`, `runHours` counting |

- **Counts with the key on and the engine off (LED1 on):** the input is on a key-on wire. Move it ([Pick the wire](#pick-the-wire)) or set `runVibMinMg`.
- **Reads the other way round:** the `altActiveHigh` setting doesn't match your wiring.
- **LED1 lights but GPIO27 stays HIGH:** check the output wires. V1 must go to GPIO27 and the output G to ESP32 GND.
- **GPIO27 LOW is about 0.8 V:** the pull-up is too strong. Use 47 kΩ, not 10 kΩ.

KiCad schematic and carrier PCB: [`schematic/hour-meter-esp32/`](../../schematic/hour-meter-esp32/README.md).

## Serial

| Link | Pins | Level | Notes |
|---|---|---|---|
| USB | board USB connector | USB | Always 115200 baud; always accepts commands |
| UART | GPIO17 TX, GPIO16 RX, GND | 3.3 V TTL | Baud = `uartBaud`. For RS-232 add a MAX3232. RS-485 needs a transceiver plus driver-enable switching, which is **not implemented yet** (`pins::kRs485De` is reserved for it) |
