# Totalizer Hour Meter

An ESP32-based **engine hour meter and totalizer** for 12/24 V vehicles and machines. It counts engine run hours from the alternator signal, counts totalizer pulses, and measures vibration, roll/pitch and compass heading with an IMU. Counters survive power cuts in EEPROM, time is kept in UTC on an RTC, and everything is reported as compact [SensorFrame](sensorframe/README.md) binary frames over USB, UART or Bluetooth SPP to Node.js host tools.

Firmware version: **2.3.0** (see `kFirmwareVersion` in [`Protocol.h`](esp32/lib/App/src/Protocol.h)).

```
 Vehicle 12/24 V ──► carrier PCB ──────────────────────────────┐
 Alternator  ─┐      PTC + reverse diode + TVS → LM2596 (5 V)  │
 Pulse input ─┴────► PC817 isolation module ──► GPIO27 / GPIO26│
                                                               ▼
                    ┌──────────── ESP32 DevKit ────────────────────┐
                    │ AT24C256 EEPROM · DS3231 RTC · MPU9250 IMU   │
                    │ (I2C, all optional and hot-pluggable)        │
                    └───────────────┬──────────────────────────────┘
                                    │ SensorFrame (TLV + CRC16, COBS)
                       USB / UART / Bluetooth SPP
                                    ▼
                    node/  reader · CLI (commands.js) · TUI
```

## Repository map

| Path | What it is |
|---|---|
| [`esp32/`](esp32/README.md) | PlatformIO firmware. Envs: `esp32dev` (firmware), `bench` (module test firmware), `native` (unit tests on the PC) |
| [`node/`](node/README.md) | Host tools: `DeviceClient` library, live reader (`reader.js`), command CLI (`commands.js`), full-screen Ink TUI (`tui/`) |
| [`sensorframe/`](sensorframe/README.md) | The wire format: [SPEC.md](sensorframe/SPEC.md), header-only C++ library (`arduino/`), zero-dependency npm package (`js/`), shared golden test vectors |
| [`schematic/hour-meter-esp32/`](schematic/hour-meter-esp32/README.md) | Carrier PCB rev A (KiCad): schematic, 2-layer THT board, JLCPCB Gerbers + BOM in `production/`, generator scripts `tools-*.py` |
| `schematic/totalizator-hour-meter-schematic/` | Early KiCad draft (DevKit pin headers only), superseded by `hour-meter-esp32/` |
| [`simulator/`](simulator/README.md) | Deno device simulator: the real protocol on a virtual serial port (socat), TCP or stdio, with fault scenarios and the Bluetooth lock. For driver development without hardware |
| `canbus/` | `can.sh`: CANable2 (slcan) helper for can-utils: `up [rate] [--tx]`, `down`, `scan [seconds]`, `status`. Listen-only by default |

## Hardware at a glance

ESP32 DevKit · AT24C256 EEPROM (0x50) · DS3231 RTC (0x68) · MPU9250 IMU (**0x69**, AD0 high) · alternator input GPIO27 · pulse input GPIO26 · UART GPIO16/17 · Bluetooth Classic SPP (off by default, PIN-locked).

Engine inputs go through a 2-channel PC817 module (outputs active LOW). Wiring details and required resistor changes: [esp32/docs/WIRING.md](esp32/docs/WIRING.md).

## Quick start

Prerequisites: [PlatformIO](https://platformio.org/) CLI, Node.js ≥ 18. Optional: [Deno](https://deno.com) 2 + socat (simulator), KiCad 8+ (hardware), can-utils (`canbus/can.sh`).

```bash
# Firmware
cd esp32
pio run -e esp32dev -t upload       # build + flash

# Host tools
cd ../node
npm install
npm run tui -- --demo               # try the TUI with a simulated device (no hardware)
npm run tui -- /dev/ttyUSB0         # the real device
node commands.js set-time           # set the RTC from the PC clock (UTC)
node commands.js get hour           # read the hour meter
```

No device at hand? `cd simulator && deno task start` creates a simulated one at `/tmp/ttyHourMeter`; use that path instead of `/dev/ttyUSB0`.

Testing loose modules before soldering: `pio run -e bench -t upload`, see [TESTING-MODULES.md](esp32/docs/TESTING-MODULES.md).

## Tests and checks

```bash
cd esp32 && pio test -e native            # firmware unit tests with fake chips (ASan + UBSan)
cd esp32 && pio check -e esp32dev         # clang-tidy static analysis
node esp32/scripts/check-docs.js          # docs, Node tags and firmware tables agree
cd node && npm test                       # host CLI / client / TUI reducer tests
cd sensorframe/js && npm test             # SensorFrame JS library
make -C sensorframe/arduino/test          # SensorFrame C++ library on the desktop
cd simulator && deno task test            # simulator: firmware golden frames, frame catalog, command rules
```

## Documentation

| You are… | Read |
|---|---|
| Building an app that talks to the device | [INTEGRATION-GUIDE.md](esp32/docs/INTEGRATION-GUIDE.md) + [SensorFrame SPEC.md](sensorframe/SPEC.md) |
| Writing a driver: exact bytes of every frame | [FRAME-CATALOG.md](esp32/docs/FRAME-CATALOG.md) |
| Developing without hardware | [simulator/README.md](simulator/README.md) |
| Wiring the hardware | [WIRING.md](esp32/docs/WIRING.md), [carrier PCB README](schematic/hour-meter-esp32/README.md) |
| Working on the firmware | [ARCHITECTURE.md](esp32/docs/ARCHITECTURE.md), [CODING-STANDARD.md](esp32/docs/CODING-STANDARD.md) |
| A TypeScript developer new to C++ | [CPP-FOR-TYPESCRIPT.md](esp32/docs/CPP-FOR-TYPESCRIPT.md) |
| Curious how data survives power cuts | [EEPROM-LAYOUT.md](esp32/docs/EEPROM-LAYOUT.md) |
| Setting up the IMU | [CALIBRATION.md](esp32/docs/CALIBRATION.md) |
| Using the TUI, CLI or Bluetooth | [node/README.md](node/README.md) |
| Using SensorFrame in another project | [sensorframe/README.md](sensorframe/README.md) |

## Design rules

- **Time is UTC only.** The device stores a Unix epoch with no timezone; host tools convert for display.
- **`esp32/lib/App/src/Protocol.h` is the single source of truth for tags.** After any protocol change, run `node esp32/scripts/check-docs.js`, port the change to `simulator/src/frames.ts`, and run `deno task test` there (it fails until the simulator's frames match the firmware's golden frames again).
- **USB is the recovery path:** fixed at 115200 baud and always accepts commands. `uartBaud` only affects the UART pins.
- **EEPROM holds only counters, calibration and settings**, never sample logs. Filtering (Kalman) runs in RAM.
