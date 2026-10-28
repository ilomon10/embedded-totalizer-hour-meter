# Totalizer Hour Meter

An ESP32-based **engine hour meter and totalizer** for 12/24 V vehicles and machines. It counts engine run hours from the alternator signal, counts totalizer pulses, and measures vibration, roll/pitch and compass heading with an IMU. Counters survive power cuts in the ESP32's flash and the EEPROM (either one is enough), time is kept in UTC on an RTC, and everything is reported as compact [SensorFrame](sensorframe/README.md) binary frames over USB, UART or Bluetooth SPP to the `hour-meter` configurator.

Firmware version: **2.6.0** (see `kFirmwareVersion` in [`Protocol.h`](esp32/lib/App/src/Protocol.h)).

```
 Vehicle 12/24 V ──► carrier PCB ──────────────────────────────┐
 L / D+ (run)─┐      PTC + reverse diode + TVS → LM2596 (5 V)  │
 Pulse input ─┴────► PC817 isolation module ──► GPIO27 / GPIO26│
                                                               ▼
                    ┌──────────── ESP32 DevKit ────────────────────┐
                    │ AT24C256 EEPROM · DS3231 RTC · MPU9250 IMU   │
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
| [`esp32/`](esp32/README.md) | PlatformIO firmware. Envs: `esp32dev` (firmware), `bench` (module test firmware), `native` (unit tests on the PC) |
| [`configurator/`](configurator/README.md) | `hour-meter` (Bun, released as a standalone binary): full-screen TUI, live reader (`read`), single commands (`get`, `set`, ...), firmware update over USB (`firmware`) and the `DeviceClient` library |
| [`sensorframe/`](sensorframe/README.md) | The wire format: [SPEC.md](sensorframe/SPEC.md), header-only C++ library (`arduino/`), zero-dependency npm package (`js/`), shared golden test vectors |
| [`schematic/hour-meter-board/`](schematic/hour-meter-board/README.md) | Main board rev B (KiCad, draft): chip-down, one schematic sheet per former module, 4-layer 100 × 90 mm, JLCPCB in-stock parts, runs from 5 V |
| [`schematic/hour-meter-board-2layer/`](schematic/hour-meter-board-2layer/README.md) | The same rev-B board routed on 2 copper layers, for a cheaper PCB. It is a KiCad *Save As* copy, so the 4-layer design stays as it is |
| [`schematic/hour-meter-board-compact/`](schematic/hour-meter-board-compact/README.md) | The rev-B board on 80 × 70 mm and 2 layers: milled isolation slots around the vehicle inputs, fault-protected RS485, fused 5 V header pins, coin cell on the underside |
| [`schematic/hour-meter-board-compact-lm2596/`](schematic/hour-meter-board-compact-lm2596/README.md) | The compact board on 80 × 80 mm with its 5 V supply on the board (LM2596S-ADJ instead of PSU-B) and latching JST VH field connectors |
| [`schematic/hour-meter-board-compact-lm2596-io/`](schematic/hour-meter-board-compact-lm2596-io/README.md) | The LM2596 board on 80 × 92 mm with a Teltonika-style I/O port: AIN1 0–30 V (16-bit ADS1115), DOUT1 0.5 A self-protected low-side switch, 5 V sensor supply. The isolated vehicle inputs are named DIN1 and DIN2 |
| [`schematic/fault-analysis/`](schematic/fault-analysis/README.md) | ngspice fault simulations for the rev-B boards and PSU-B: load dump, ISO 7637 pulses, reverse polarity, shorted outputs, miswired connectors |
| [`schematic/hour-meter-psu-b/`](schematic/hour-meter-psu-b/README.md) | Plug-on 9–36 V → 5.3 V supply (TPS54360B) for the rev-B board |
| [`schematic/hour-meter-esp32/`](schematic/hour-meter-esp32/README.md) | Carrier PCB rev A (KiCad): schematic, 2-layer THT board for the loose modules, JLCPCB Gerbers + BOM in `production/`, generator scripts `tools-*.py`. Superseded by rev B |
| `schematic/totalizator-hour-meter-schematic/` | Early KiCad draft (DevKit pin headers only), superseded by `hour-meter-esp32/` |
| [`simulator/`](simulator/README.md) | Bun device simulator: the real protocol on a virtual serial port (socat), TCP or stdio, with fault scenarios, the Bluetooth lock, and a web UI (`--web`): every value live, a 3D bench, and a truck/plane on an OpenStreetMap map with IMU-only dead reckoning. For driver development without hardware |
| `canbus/` | `can.sh`: CANable2 (slcan) helper for can-utils: `up [rate] [--tx]`, `down`, `scan [seconds]`, `status`. Listen-only by default |

## Hardware at a glance

ESP32 DevKit · AT24C256 EEPROM (0x50) · DS3231 RTC (0x68) · MPU9250 IMU (**0x69**, AD0 high) · alternator input GPIO27 · pulse input GPIO26 · UART GPIO16/17 · Bluetooth Classic SPP (off by default, PIN-locked).

Engine inputs go through a 2-channel PC817 module (outputs active LOW). Wiring details and required resistor changes: [esp32/docs/WIRING.md](esp32/docs/WIRING.md).

The rev-B [main board](schematic/hour-meter-board/README.md) puts all of this on one PCB from JLCPCB in-stock parts. It adds RS485, USB-C, a GPS socket and VIN sensing, uses an MPU-6500 + LIS3MDL in place of the discontinued MPU9250, and takes its 9–36 V supply from the plug-on [PSU-B](schematic/hour-meter-psu-b/README.md). Before ordering, check part stock with `./scripts/jlc-stock.ts <bom.csv>`.

## Quick start

Prerequisites: [PlatformIO](https://platformio.org/) CLI (firmware), [Bun](https://bun.com) 1.4.4 or newer (configurator, simulator, scripts, doc checks). Optional: socat (simulator tty), Node.js ≥ 18 (only for the `sensorframe/js` npm package tests), KiCad 8+ (hardware), can-utils (`canbus/can.sh`). Users who only need the tools can download the `hour-meter` / `hour-meter-sim` binaries (Linux x64, Windows x64) from the releases page instead.

```bash
# Firmware
cd esp32
pio run -e esp32dev -t upload       # build + flash

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
| Wiring the hardware | [WIRING.md](esp32/docs/WIRING.md), [rev-B main board](schematic/hour-meter-board/README.md), [rev-A carrier PCB](schematic/hour-meter-esp32/README.md) |
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
