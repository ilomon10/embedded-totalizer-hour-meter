# hour-meter: configurator for the hour meter

One tool for the hour-meter device: a full-screen **configurator and live viewer** (TUI), a **live reader**, a **command line** for single commands, and a **firmware updater**. It is one Deno program, also shipped as a standalone binary, so no Node, npm or Deno install is needed to use it.

```bash
hour-meter --demo                       # try everything with a simulated device (no hardware)
hour-meter /dev/ttyUSB0                 # the real device (USB, or a USB-TTL adapter on the UART pins)
hour-meter get hour --port /dev/ttyUSB0 # one command, one ACK
hour-meter firmware flash               # update the firmware to the newest release (over USB)
```

## Install

**Binary:** download `hour-meter-<version>-<platform>` from the [releases page](https://github.com/ilomon10/embedded-totalizer-hour-meter/releases) (each release `v*` carries the firmware, this tool and the simulator; older ones are tagged `configurator-v*`), unpack it, and run `hour-meter`. Verify the download with `sha256sum -c SHA256SUMS`. On macOS, if Gatekeeper blocks the unsigned binary, run `xattr -d com.apple.quarantine hour-meter` once.

**From source** (needs [Deno](https://deno.com) 2):

```bash
cd configurator
deno task start --demo                  # same options as the binary
deno task start /dev/ttyUSB0
```

**Ports:** a serial device (`/dev/ttyUSB0`, `/dev/rfcomm0`, `/dev/cu.usbserial-*` on macOS) or `tcp://host:port`. The default is `$HOUR_METER_PORT`, else `/dev/ttyUSB0`. Serial ports work on **Linux and macOS** (the port is configured with `stty`, 115200 8N1).

**Windows:** the binary runs, but COM ports are not supported yet. Use `--demo`, the [simulator](../simulator/README.md) over TCP, or a serial-to-TCP bridge with `tcp://host:port`. `firmware list` and `firmware download` work; flashing needs Linux or macOS.

## TUI: configurator + live viewer

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ HOUR METER                ● connected /dev/ttyUSB0        dev 1a2b3c4d fw 2.5.0│
│  1 Dashboard    2 IMU    3 Settings    4 Actions    5 Log    6 Firmware        │
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
| `6` | Firmware | The device's firmware and the releases on GitHub. `↑↓` select, `Enter` flash the selected release (type `FLASH`), `d` download, `c` check again, `f` flash a file. The header shows `→ 2.6.0 available` when a newer release exists. See [Update the firmware](#update-the-firmware) |
| `Tab`, `g`, `q` | | Next screen, refresh everything, quit |
| `H` | any | Hard-reset the board over USB (also *Actions → Hard reset (USB)*). Local serial ports only |

If no frame arrives for 5 s (from connecting, or after the last frame), a banner says **"No data from the device. Press H to hard-reset."**. The reset is only ever offered, never automatic. A boot is logged with its cause, for example `device restarted: watchdog while IMU (reset reason 6)`, and the Dashboard shows the last restart cause and a **safeMode** warning.

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

## Update the firmware

The board's USB port is enough: no PlatformIO, Python or esptool.

```bash
hour-meter firmware                         # the device's firmware and the newest release
hour-meter firmware flash                   # back up, write the newest release, check, restore
hour-meter firmware flash 2.4.0             # a given version or release tag (v1.0.0), also an older one
hour-meter firmware flash .pio/build/esp32dev/firmware.bin   # your own build (merged image or app)
hour-meter firmware list                    # every firmware release
hour-meter firmware download -o firmware/   # only download it, checked against SHA256SUMS
```

In the TUI, press `6`, pick a release, press `Enter` and type `FLASH`.

`flash` does this:

1. Gets the image from the GitHub release and checks it against the release's `SHA256SUMS`. Downloads are kept in `~/.cache/hour-meter/firmware` (macOS: `~/Library/Caches/hour-meter/firmware`).
2. Reads the device and saves a backup of its firmware version, counters and settings in `~/.cache/hour-meter/backups`. Only you can read it: it holds the Bluetooth PIN.
3. Asks before writing (`--yes` skips the question).
4. Resets the board into the ESP32 ROM bootloader through the adapter's DTR/RTS lines, as `pio run -t upload` does. It writes at 460800 baud (`--baud`; 115200 if the port cannot go faster) and checks each part with the chip's MD5.
5. Restarts the board, reads it again and checks the version.

**What is kept.** Flashing never touches the EEPROM or the ESP32's own copy of the values (partition `hmdata`, firmware 2.6.0), which hold the hour meter, the totalizer and the settings. A firmware with another EEPROM layout reformats it at its first boot. In that case `flash` writes the counters back from the backup, and the settings too if the new firmware fell back to defaults. Any other changed settings are listed with a ready `hour-meter set ...` line. The Bluetooth pairing (the NVS partition) is not overwritten.

**If it goes wrong:**
- A cut flash (USB pulled, laptop asleep) is safe to repeat: the bootloader is in ROM. Run `hour-meter firmware flash` again.
- `no answer from the ESP32 bootloader`: use the board's own USB port, not the UART pins. Boards without auto-reset need it done by hand: hold BOOT, tap EN, release BOOT, run `hour-meter firmware flash --no-reset`, then press EN when it is done.

**Limits:**
- Flashing needs Linux or macOS and the board's USB port. It does not work over `tcp://`, Bluetooth, `--demo` or the UART pins.
- It writes only to a classic ESP32 (the chip is checked first).
- Without a token, GitHub's API allows 60 requests an hour per IP address, and a shared office or mobile connection uses that up. The list then comes from the release feed, which holds the newest 10 releases. `GITHUB_TOKEN` adds your own quota.

## Command line

```bash
hour-meter get status                  # hour | settings | status | calib
hour-meter set telemetryIntervalMs=500 output=both
hour-meter set bluetooth=true btPin=4821
hour-meter set runVibMinMg=25          # count only while the engine vibrates (firmware 2.5.0; 0 = off)
hour-meter set-time                    # PC clock as UTC
hour-meter set-hours 1234.5            # set the hour meter to any value
hour-meter set-units 5230.75           # set the totalizer in units (uses pulsesPerUnit)
hour-meter set-count 523075            # ...or in raw pulses
hour-meter reset-hours --yes           # hour meter only -> 0
hour-meter reset-totalizer --yes       # totalizer only -> 0
hour-meter calibrate gyro              # or mag
hour-meter reset-counters --yes        # both -> 0
hour-meter reboot
hour-meter reset                       # restart a stuck device: panic signal, then USB hard reset if silent
hour-meter reset --signal              # panic signal only (also over tcp://)
hour-meter reset --hard                # pulse EN through the USB adapter only (serial ports only)
hour-meter read /dev/ttyUSB0 [--imu]   # scrolling live view, auto time sync
hour-meter firmware [version|list|download|flash]   # see "Update the firmware"
hour-meter --help                      # everything, with all flags
```

Commands take `--port <port>` (or `$HOUR_METER_PORT`), `--pin <PIN>` for Bluetooth, and `--demo`. `read` and the TUI take the port as their first argument.

### Restarting a device that does not answer

`hour-meter reset` first sends the **panic signal** (64 zero bytes: the firmware restarts at once, with no frame and no ACK; not accepted over Bluetooth). If no boot EVENT follows within 3 s and the port is a local serial port, it does a **hard reset**: the DTR/RTS lines of the USB-serial adapter pulse the ESP32 EN pin for 100 ms (like `esptool --after hard_reset`; IO0 stays high, so it boots normally). It then waits for the boot EVENT and prints one line, for example `device restarted (reset reason 1 power-on, last cause: panicSignal while serial / command)`.

The hard reset talks to the adapter through libc (`ioctl`), so it needs Linux or macOS and the binary's usual `-A` permission. It is untested on real hardware on macOS Apple Silicon. On Windows use `--signal`.

### Hours count with the key on but the engine off

The engine-running input is on a wire that is live at ACC/ON. `hour-meter read` shows `engine ON` before the engine starts. Move the input to the alternator's L / D+ terminal or the oil-pressure warning switch ([how to find the wire](../esp32/docs/WIRING.md#pick-the-wire)). If no such wire is reachable, set `runVibMinMg` (firmware 2.5.0). The reader then shows `engine OFF (input on)` while the key is on and the engine is stopped.

### Device sends nothing over USB

1. Try `hour-meter reset` (or press `H` in the TUI). The device restarts and the boot EVENT says why it was stuck.
2. Check the `output` setting is not UART-only: `hour-meter get settings` over the UART pins (or Bluetooth) shows `output`. `uart` keeps the USB port silent; set `output=both`.
3. After a restart, `lastCause` and `lastStage` (in `get status`, the boot EVENT and the TUI Dashboard) say what happened: `watchdog`, `i2cStuck`, `usbStalled`, `panicSignal`, `rebootCommand` or `crash`, and what the firmware was doing (IMU, RTC, EEPROM...).
4. **Safe mode:** after 3 unplanned restarts in a row the device boots without I2C (flag `safeMode`; no RTC, IMU or EEPROM). Firmware 2.6.0 still keeps the hour meter, totalizer and settings in the ESP32's flash meanwhile. It leaves safe mode on a power-cycle, a hard reset, or `hour-meter reboot`. Fix the bus fault (a loose or shorted I2C module) first, or it will come back.

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
deno task test         # command words, DeviceClient protocol rules, TUI reducer, a --demo round trip,
                       # the ROM bootloader protocol and whole flashes against a fake ROM, release lists
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
│   ├── reset.ts        panic signal, USB hard reset and bootloader reset (DTR/RTS through libc ioctl)
│   ├── restart.ts      boot EVENT cause/stage text
│   ├── links.ts        serial (Deno.open + stty), TCP, in-memory link pair
│   ├── demo.ts         --demo: the simulator's device in-process
│   ├── cli.ts          shared flags and connect()
│   ├── commands.ts     one command, one ACK
│   ├── reader.ts       live view
│   ├── esp-rom.ts      ESP32 ROM bootloader protocol: SLIP, sync, compressed writes, MD5
│   ├── flash.ts        firmware images, the regions written (NVS kept), the flash sequence
│   ├── releases.ts     firmware on the GitHub releases: list (API, else the release feed), checked downloads
│   ├── firmware.ts     `firmware`: version, list, download, flash with backup and restore
│   └── tui/            Ink screens (App.tsx, FirmwareView.tsx), pure reducer (state.ts), entry (main.tsx)
├── tools/compile.ts    release binaries
└── test/
```

Why not the npm `serialport` package? Under Deno its native add-on opens the port, but every read and write then fails with `EBADF`. So serial ports are opened with `Deno.open` and set up with `stty`. The port is opened twice, once to read and once to write: Deno runs the operations on one handle one after the other, so a read waiting for data would hold back every write. That keeps the binary free of native code, but rules out Windows COM ports for now. Opening device files needs Deno's `-A` permission, which `deno task start` and the release binary use.

To release: bump `TOOL_VERSION` in `src/version.ts`, commit, and run [`scripts/release.ts`](../scripts/release.ts) from the repository root (see [Releasing](../README.md#releasing)). `deno task compile` alone builds the binaries into `dist/`.
