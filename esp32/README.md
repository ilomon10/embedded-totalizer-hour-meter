# Hour Meter Firmware (ESP32)

Engine hour meter and totalizer with persistent storage, real-time clock, and an IMU for vibration, orientation and compass heading. It talks to apps over USB or UART using compact [SensorFrame](../sensorframe/README.md) binary frames.

| You are… | Read |
|---|---|
| Building an app that talks to the device | **[docs/INTEGRATION-GUIDE.md](docs/INTEGRATION-GUIDE.md)** (self-contained, send it to third parties together with [SPEC.md](../sensorframe/SPEC.md)) |
| Writing a driver and need exact bytes | [docs/FRAME-CATALOG.md](docs/FRAME-CATALOG.md) (every frame, annotated hex dumps) |
| Developing without hardware | [simulator/](../simulator/README.md): a fake device on a virtual serial port (`cd ../simulator && deno task start`) |
| Wiring the hardware | [docs/WIRING.md](docs/WIRING.md) |
| Working on the firmware | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/CODING-STANDARD.md](docs/CODING-STANDARD.md) |
| A TypeScript developer new to C++ | [docs/CPP-FOR-TYPESCRIPT.md](docs/CPP-FOR-TYPESCRIPT.md) |
| Curious how data survives power cuts | [docs/EEPROM-LAYOUT.md](docs/EEPROM-LAYOUT.md) |
| Setting up the IMU | [docs/CALIBRATION.md](docs/CALIBRATION.md) |
| Testing modules before soldering | [docs/TESTING-MODULES.md](docs/TESTING-MODULES.md) (bench firmware: `pio run -e bench -t upload`) |
| Configuring / watching the device | TUI: `cd ../node && npm run tui` (or `-- --demo` without hardware), see [node/README.md](../node/README.md) |

## Hardware

ESP32 DevKit · AT24C256 EEPROM (0x50) · DS3231 RTC (0x68) · MPU9250 IMU (**0x69**, AD0 high) · alternator input GPIO27 · pulse input GPIO26 · UART GPIO16/17 · Bluetooth Classic SPP (off by default, PIN-locked).

## Build, flash, run

```bash
cd esp32
pio run -e esp32dev -t upload      # build + flash
cd ../node && npm install
node reader.js /dev/ttyUSB0        # live view
node commands.js set-time          # set the RTC from the PC clock (UTC)
node commands.js get hour          # read the hour meter
npm run tui                        # full-screen configurator + live viewer
```

Expected reader output:

```
2026-10-07T12:34:56.000Z #12 engine ON  run 1250.00 h total 15000 roll 0.4° pitch -1.2° heading 87.5° vib 35/120 mg
```

More CLI commands: `node commands.js` (see the header of [`node/commands.js`](../node/commands.js)).

## Test and check

```bash
pio test -e native           # unit tests on the PC with fake chips (ASan + UBSan)
pio check -e esp32dev        # clang-tidy static analysis
node scripts/check-docs.js   # docs, Node tags and firmware tables agree; reference decoders work
cd ../node && npm test       # host CLI / client tests
```

## Project map

```
esp32/
├── platformio.ini        envs: esp32dev (firmware), native (tests); strict warnings
├── include/              BoardPins.h (pins, I2C addresses) · AppConfig.h (fixed constants)
├── src/                  main.cpp · Application (wiring + main loop) · platform/ (Arduino adapters)
├── lib/
│   ├── Core/             Status, Result<T>, CHECK_ARG/TRY, IClock, PeriodicTask, Vec3
│   ├── I2cBus/           II2cBus interface + Wire implementation (timeouts, bus recovery)
│   ├── At24c/            EEPROM driver
│   ├── Ds3231/           RTC driver + UTC date math
│   ├── Mpu9250/          IMU + magnetometer driver
│   ├── Filters/          Kalman, compass, vibration, running stats
│   ├── Storage/          EEPROM layout, counter journal, settings A/B
│   └── App/              protocol tags, settings schema, hour meter, IMU pipeline, commands, telemetry
├── test/                 fakes/ + test_drivers, test_storage, test_filters, test_app
├── scripts/check-docs.js consistency checker
└── docs/                 guides listed above
```
