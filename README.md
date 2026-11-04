# Totalizer Hour Meter

An ESP32-based **engine hour meter and totalizer** for 12/24 V vehicles and machines. It counts engine run hours from the alternator signal, counts totalizer pulses, and measures vibration, roll/pitch and compass heading with an IMU. Counters survive power cuts in the ESP32's flash and the EEPROM (either one is enough), time is kept in UTC on an RTC, and everything is reported as compact [SensorFrame](sensorframe/README.md) binary frames over USB, UART or Bluetooth SPP to the `hour-meter` configurator.

Firmware version: **2.7.0** (see `kFirmwareVersion` in [`Protocol.h`](esp32/lib/App/src/Protocol.h)).

```
 Vehicle 12/24 V ──► main board ───────────────────────────────┐
 L / D+ (run)─┐      PTC + reverse diode + TVS → LM2596 (5 V)  │
 Pulse input ─┴────► PC817 isolated inputs ───► GPIO27 / GPIO26│
                                                               ▼
                    ┌──────────── ESP32 ───────────────────────────┐
                    │ AT24C256 EEPROM · DS3231 RTC · MPU-6500 IMU  │
                    │ (I2C, all optional and hot-pluggable)        │
                    └───────────────┬──────────────────────────────┘
                                    │ SensorFrame (TLV + CRC16, COBS)
                       USB / UART / Bluetooth SPP
                                    ▼
                    configurator/  hour-meter: TUI · read · commands
```

## Repository map

| Path | What it is |
|---|---|
| [`esp32/`](esp32/README.md) | PlatformIO firmware. Envs: `esp32dev` (firmware for the devboard), `can-board` (the same firmware for the main board), `bench` (module test firmware), `native` (unit tests on the PC) |
| [`configurator/`](configurator/README.md) | `hour-meter` (Bun, released as a standalone binary): full-screen TUI, live reader (`read`), single commands (`get`, `set`, ...), firmware update over USB (`firmware`) and the `DeviceClient` library |
| [`sensorframe/`](sensorframe/README.md) | The wire format: [SPEC.md](sensorframe/SPEC.md), header-only C++ library (`arduino/`), zero-dependency npm package (`js/`), shared golden test vectors |
| [`schematic/hour-meter-board/`](schematic/hour-meter-board/README.md) | Main board (KiCad): ESP32-WROOM-32E, 9–30 V supply and one Molex Micro-Fit 2 × 8 harness plug with CAN, RS232, RS485, isolated DIN1/DIN2, AIN1, DOUT1 and a 5 V sensor supply; MPU-6500 + LIS3MDL, RTC, EEPROM, USB-C, GPS and Qwiic ports. 100 × 100 mm, 2 layers, routed by hand; JLCPCB order files in `production/`, bring-up guide in `BRINGUP.md` |
| [`schematic/hour-meter-devboard/`](schematic/hour-meter-devboard/README.md) | Devboard (KiCad): 88 × 91 mm, 2-layer, through-hole carrier for ready-made modules from Indonesian shops: ESP32 DevKit V4 (USB-C), 817 opto module, GY-9250, DS3231 ZS-042, AT24C256 and a GY-271 compass. Runs from the DevKit's USB-C; Gerbers, a BOM with local shop names, LCSC lists and a 1:1 fit-check PDF in `production/` |
| [`schematic/fault-analysis/`](schematic/fault-analysis/README.md) | ngspice simulations: the main board's ports and harness (`microfit_can.py`), and supply transients, reverse polarity, shorted outputs and miswired connectors for the circuits both boards use (`faults.py`) |
| `schematic/datasets/` | Datasheets (LIS3MDL, MAX13223E) |
| [`simulator/`](simulator/README.md) | Bun device simulator: the real protocol on a virtual serial port (socat), TCP or stdio, with fault scenarios, the Bluetooth lock, and a web UI (`--web`): every value live, a 3D bench, and a truck/plane on an OpenStreetMap map with IMU-only dead reckoning. For driver development without hardware |
| `canbus/` | `can.sh`: CANable2 (slcan) helper for can-utils: `up [rate] [--tx]`, `down`, `scan [seconds]`, `status`. Listen-only by default |

Older board versions (the rev A and rev C module carriers, the rev B main board and its 2-layer, compact, LM2596, I/O and Micro-Fit versions, the auto-routed CAN board and the PSU-B supply) were removed on 2026-11-04. They are in the git history at commit d35ef2d.

## Hardware at a glance

Two boards run the same firmware:

| Board | What it is | Firmware build |
|---|---|---|
| [Main board](schematic/hour-meter-board/README.md) | everything on one PCB, made and assembled by JLCPCB: 9–30 V supply, one harness plug with CAN, RS232, RS485, DIN1/DIN2, AIN1, DOUT1 and a 5 V sensor supply, MPU-6500 + LIS3MDL IMU | `pio run -e can-board` |
| [Devboard](schematic/hour-meter-devboard/README.md) | ready-made modules on a through-hole carrier, powered from USB: ESP32 DevKit V4, 817 opto module, GY-9250, DS3231, AT24C256, GY-271 compass | `pio run -e esp32dev` (the default) |

Both: AT24C256 EEPROM (0x50) · DS3231 RTC (0x68) · MPU-6500/MPU9250 IMU (**0x69**, AD0 high) · alternator input GPIO27 · pulse input GPIO26 (through PC817 optocouplers, outputs active LOW) · Bluetooth Classic SPP (off by default, PIN-locked). The UART link is GPIO16/17 on the devboard and the RS232 port on the main board. Module wiring and the required resistor changes: [esp32/docs/WIRING.md](esp32/docs/WIRING.md).

Before ordering the main board, check part stock with `./scripts/jlc-stock.ts <bom.csv>`.

## Quick start

Prerequisites: [PlatformIO](https://platformio.org/) CLI (firmware), [Bun](https://bun.com) 1.4.4 or newer (configurator, simulator, scripts, doc checks). Optional: socat (simulator tty), Node.js ≥ 18 (only for the `sensorframe/js` npm package tests), KiCad 8+ (hardware), can-utils (`canbus/can.sh`). Users who only need the tools can download the `hour-meter` / `hour-meter-sim` binaries (Linux x64, Windows x64) from the releases page instead.

```bash
# Firmware
cd esp32
pio run -e esp32dev -t upload       # build + flash (devboard)
pio run -e can-board -t upload      # the same, for the main board

# Host tools
cd ../configurator                  # or download hour-meter from the releases page
bun install                         # once: the TUI's packages
bun run start --demo                # try the TUI with a simulated device (no hardware)
bun run start /dev/ttyUSB0          # the real device
bun run start set-time --port /dev/ttyUSB0   # set the RTC from the PC clock (UTC)
bun run start get hour --port /dev/ttyUSB0   # read the hour meter
bun run start firmware flash --port /dev/ttyUSB0   # update to the newest release (no PlatformIO needed)
```

No device at hand? `bun run start --demo` runs a simulated one inside the configurator, or `cd simulator && bun install && bun run start` creates one at `/tmp/ttyHourMeter` for any tool or driver.

Testing loose modules before soldering: `pio run -e bench -t upload`, see [TESTING-MODULES.md](esp32/docs/TESTING-MODULES.md).

## Tests and checks

```bash
cd esp32 && pio test -e native            # firmware unit tests with fake chips (ASan + UBSan)
cd esp32 && pio check -e esp32dev         # clang-tidy static analysis
./esp32/scripts/check-docs.ts             # docs, host tag table and firmware tables agree
cd configurator && bun run test           # hour-meter: commands, DeviceClient, the TUI
cd sensorframe/js && npm test             # SensorFrame JS library
make -C sensorframe/arduino/test          # SensorFrame C++ library on the desktop
cd simulator && bun run test              # simulator: firmware golden frames, frame catalog, command rules
bun test scripts/                         # release notes and asset names, JLCPCB BOM parsing
cd configurator && bun check && bun run lint && bun fmt --check   # types, lint, format (the same in simulator/)
```

## Releasing

One GitHub release, tagged `v<VERSION>` (the [`VERSION`](VERSION) file), carries all three parts: the firmware images, the `hour-meter` binaries and the `hour-meter-sim` binaries. Each part keeps its own version (`kFirmwareVersion` in `Protocol.h`, `TOOL_VERSION` in `configurator/src/version.ts`, `SIM_VERSION` in `simulator/main.ts`), and the release notes show them side by side. [`scripts/release.ts`](scripts/release.ts) does it all:

```bash
./scripts/release.ts --dry-run              # what it would run, plus the release notes; changes nothing
./scripts/release.ts                        # checks, tests, builds, asks, then tags, pushes and publishes
./scripts/release.ts --bump minor           # next release: VERSION 1.0.0 -> 1.1.0 in a commit first
./scripts/release.ts --notes notes.md --draft   # your own notes ("# Title" first line), as a draft
```

It releases HEAD (or `--ref <commit>`). It tests and builds that exact commit in a temporary git worktree, and puts the files, one `SHA256SUMS` and `NOTES.md` in `.release/v<VERSION>/`. It asks before anything leaves your machine. Afterwards it downloads the release and checks `SHA256SUMS`, both binaries' `--version` and the firmware image.

It stops before changing anything if:
- you're not on `main`;
- a released folder has uncommitted changes;
- `gh` isn't logged in;
- `origin/main` has commits you lack;
- the tag or release already exists. Use `--bump` in that case.

It warns when a part changed since the previous release but still has the same version. Without `--notes`, the notes are generated from the Conventional Commit messages since the previous release. Releases before 1.0.0 were separate per part (`firmware-v*`, `configurator-v*`, `simulator-v*`).

`hour-meter firmware` finds the firmware in a release by its file name, `hour-meter-<firmware version>-esp32dev-merged.bin`, and checks it against the release's `SHA256SUMS`. Keep both. The configurator's tests fail if `assetNames()` in `scripts/release-lib.ts` stops matching.

## Documentation

| You are… | Read |
|---|---|
| Building an app that talks to the device | [INTEGRATION-GUIDE.md](esp32/docs/INTEGRATION-GUIDE.md) + [SensorFrame SPEC.md](sensorframe/SPEC.md) |
| Writing a driver: exact bytes of every frame | [FRAME-CATALOG.md](esp32/docs/FRAME-CATALOG.md) |
| Developing without hardware | [simulator/README.md](simulator/README.md) |
| Wiring the hardware | [main board](schematic/hour-meter-board/README.md) and its [bring-up](schematic/hour-meter-board/BRINGUP.md), [devboard](schematic/hour-meter-devboard/README.md), [WIRING.md](esp32/docs/WIRING.md) (the devboard's modules) |
| Working on the firmware | [ARCHITECTURE.md](esp32/docs/ARCHITECTURE.md), [CODING-STANDARD.md](esp32/docs/CODING-STANDARD.md) |
| A TypeScript developer new to C++ | [CPP-FOR-TYPESCRIPT.md](esp32/docs/CPP-FOR-TYPESCRIPT.md) |
| Curious how data survives power cuts | [STORAGE.md](esp32/docs/STORAGE.md), [EEPROM-LAYOUT.md](esp32/docs/EEPROM-LAYOUT.md) |
| Setting up the IMU | [CALIBRATION.md](esp32/docs/CALIBRATION.md) |
| Using the TUI, CLI or Bluetooth | [configurator/README.md](configurator/README.md) |
| Using SensorFrame in another project | [sensorframe/README.md](sensorframe/README.md) |

## Design rules

- **Time is UTC only.** The device stores a Unix epoch with no timezone; host tools convert for display.
- **`esp32/lib/App/src/Protocol.h` is the single source of truth for tags.** After any protocol change, run `./esp32/scripts/check-docs.ts`, update `configurator/src/tags.ts`, port the change to `simulator/src/frames.ts`, and run `bun run test` there (it fails until the simulator's frames match the firmware's golden frames again).
- **USB is the recovery path:** fixed at 115200 baud and always accepts commands. `uartBaud` only affects the UART pins.
- **The stores (ESP32 flash, EEPROM) hold only counters, calibration and settings**, never sample logs. Filtering (Kalman) runs in RAM.
