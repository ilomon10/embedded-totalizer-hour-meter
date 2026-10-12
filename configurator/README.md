# hour-meter: configurator for the hour meter

One tool for the hour-meter device: a full-screen **configurator and live viewer** (TUI), a **live reader**, and a **command line** for single commands. It is one Deno program, also shipped as a standalone binary, so no Node, npm or Deno install is needed to use it.

```bash
hour-meter --demo                       # try everything with a simulated device (no hardware)
hour-meter /dev/ttyUSB0                 # the real device (USB, or a USB-TTL adapter on the UART pins)
hour-meter get hour --port /dev/ttyUSB0 # one command, one ACK
```

## Install

**Binary:** download `hour-meter-<version>-<platform>` from the [releases page](https://github.com/ilomon10/embedded-totalizer-hour-meter/releases) (tags `configurator-v*`), unpack it, and run `hour-meter`. Verify the download with `sha256sum -c SHA256SUMS`. On macOS, if Gatekeeper blocks the unsigned binary, run `xattr -d com.apple.quarantine hour-meter` once.

**From source** (needs [Deno](https://deno.com) 2):

```bash
cd configurator
deno task start --demo                  # same options as the binary
deno task start /dev/ttyUSB0
```

**Ports:** a serial device (`/dev/ttyUSB0`, `/dev/rfcomm0`, `/dev/cu.usbserial-*` on macOS) or `tcp://host:port`. The default is `$HOUR_METER_PORT`, else `/dev/ttyUSB0`. Serial ports work on **Linux and macOS** (the port is configured with `stty`, 115200 8N1).

**Windows:** the binary runs, but COM ports are not supported yet. Use `--demo`, the [simulator](../simulator/README.md) over TCP, or a serial-to-TCP bridge with `tcp://host:port`.

## TUI: configurator + live viewer

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ HOUR METER                ● connected /dev/ttyUSB0        dev 1a2b3c4d fw 2.3.0│
│  1 Dashboard    2 IMU    3 Settings    4 Actions    5 Log                      │
╰──────────────────────────────────────────────────────────────────────────────╯
┌ Hour meter ──────────────────────┐┌ Motion ───────────────────────────────┐
│ Run hours   1250.00 h            ││ Roll / pitch  2.50° / -0.48°          │
│ Engine      RUNNING              ││ Heading       33.5°                   │
│ Totalizer   15038 pulses         ││ Vibration     RMS 37 mg  peak 103 mg  │
└──────────────────────────────────┘└───────────────────────────────────────┘
┌ Time (device is UTC) ────────────┐┌ Modules ──────────────────────────────┐
│ 2026-10-07T05:27:10Z (local ...) ││ ✔ EEPROM  ✔ RTC  ✔ IMU  ✘ MAG          │
└──────────────────────────────────┘└───────────────────────────────────────┘
```

| Key | Screen | What it does |
|---|---|---|
| `1` | Dashboard | Hour meter, engine state, totalizer, time (UTC + local), modules present, motion and vibration, status warnings |
| `2` | IMU | Raw vs filtered accel/gyro/mag side by side. `r`/`f`/`b`/`o` = stream raw / filtered / both / off, `+`/`-` = stream rate |
| `3` | Settings | All 17 settings with ranges. `↑↓` select, `Enter` edit, type the new value, `Enter` apply, `Esc` cancel. Values are checked before sending (same ranges as the firmware) |
| `4` | Actions | Set time from the PC; set the hour meter (hours) or totalizer (units or pulses) to any value, showing the current value; reset hour meter only, totalizer only, or both (type `RESET`); calibrate; unlock Bluetooth; reboot |
| `5` | Log | Device events (boot, modules plugged/unplugged, calibration results), command results, errors |
| `Tab`, `g`, `q` | | Next screen, refresh everything, quit |

**Automatic time sync** is on: whenever the device reports an unknown time (for example an RTC without battery after a power cut), the TUI sends the PC clock as UTC. Disable with `--no-time-sync`.

`--demo` runs the [simulator](../simulator/README.md)'s device in-process, so its frames are byte-identical to the real firmware's.

## Over Bluetooth

Bluetooth is off by default. Turn it on once over USB and set your own PIN:

```bash
hour-meter set bluetooth=true btPin=4821      # via USB
```

Then pair and bind a serial port (Linux):

```bash
bluetoothctl            # scan on, pair <MAC>, trust <MAC>   (device: HourMeter-XXXX)
sudo rfcomm bind 0 <MAC> 1
hour-meter /dev/rfcomm0 --pin 4821
```

Every Bluetooth connection starts **locked**. `--pin` (or `HOUR_METER_PIN`, or *Actions → Unlock* in the TUI) unlocks it. A wrong PIN answers `BadPin`; after 5 wrong tries the device refuses for 60 s. `hour-meter read` and every command accept `--pin` too.

## Command line

```bash
hour-meter get status                  # hour | settings | status | calib
hour-meter set telemetryIntervalMs=500 output=both
hour-meter set bluetooth=true btPin=4821
hour-meter set-time                    # PC clock as UTC
hour-meter set-hours 1234.5            # set the hour meter to any value
hour-meter set-units 5230.75           # set the totalizer in units (uses pulsesPerUnit)
hour-meter set-count 523075            # ...or in raw pulses
hour-meter reset-hours --yes           # hour meter only -> 0
hour-meter reset-totalizer --yes       # totalizer only -> 0
hour-meter calibrate gyro              # or mag
hour-meter reset-counters --yes        # both -> 0
hour-meter reboot
hour-meter read /dev/ttyUSB0 [--imu]   # scrolling live view, auto time sync
hour-meter --help                      # everything, with all flags
```

Commands take `--port <port>` (or `$HOUR_METER_PORT`), `--pin <PIN>` for Bluetooth, and `--demo`. `read` and the TUI take the port as their first argument.

## Library

```ts
import { DeviceClient } from './src/device.ts';

const dev = await DeviceClient.open('/dev/ttyUSB0'); // or 'tcp://127.0.0.1:5555'
dev.enableAutoTimeSync();
dev.on('frame', (msg) => console.log(msg.msgType, msg.values));
const ack = await dev.request({ get: 1 }); // retries with the same seq, rejects with AckError on an error ACK
```

The protocol is documented for other languages in [`esp32/docs/INTEGRATION-GUIDE.md`](../esp32/docs/INTEGRATION-GUIDE.md), with byte-exact examples in [`FRAME-CATALOG.md`](../esp32/docs/FRAME-CATALOG.md).

## Development

```bash
deno task test         # command words, DeviceClient protocol rules, TUI reducer, a --demo round trip
deno task check        # type-check
deno lint && deno fmt --check
deno task compile      # release binaries for 5 platforms into dist/ (+ SHA256SUMS)
```

```
configurator/
├── main.ts             `hour-meter`: TUI by default, `read`, or a command
├── src/
│   ├── tags.ts         the host protocol table (checked against the firmware by esp32/scripts/check-docs.ts;
│   │                   the simulator imports it too)
│   ├── sensorframe.ts  the only bridge to ../sensorframe/js (codec, frame splitter)
│   ├── device.ts       DeviceClient: request/ACK matching, retries, auto time sync
│   ├── links.ts        serial (Deno.open + stty), TCP, in-memory link pair
│   ├── demo.ts         --demo: the simulator's device in-process
│   ├── cli.ts          shared flags and connect()
│   ├── commands.ts     one command, one ACK
│   ├── reader.ts       live view
│   └── tui/            Ink screens (App.tsx), pure reducer (state.ts), entry (main.tsx)
├── tools/compile.ts    release binaries
└── test/
```

Why not the npm `serialport` package? Under Deno its native add-on opens the port, but every read and write then fails with `EBADF`. So serial ports are opened with `Deno.open` and set up with `stty`. That keeps the binary free of native code, but rules out Windows COM ports for now. Opening device files needs Deno's `-A` permission, which `deno task start` and the release binary use.

To release: bump `TOOL_VERSION` in `src/version.ts`, run `deno task compile`, tag `configurator-v<version>`, and attach `dist/*.tar.gz`, `dist/*.zip` and `dist/SHA256SUMS` to a GitHub release.
