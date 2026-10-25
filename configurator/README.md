# hour-meter: configurator for the hour meter

One tool for the hour-meter device: a full-screen **configurator and live viewer** (TUI), a **live reader**, a **command line** for single commands, and a **firmware updater**. It is one Bun program, also shipped as a standalone binary, so no Bun, Node or npm install is needed to use it.

```bash
hour-meter                              # pick the board's port on the connect screen
hour-meter --demo                       # try everything with a simulated device (no hardware)
hour-meter /dev/ttyUSB0                 # straight to that port (USB, or a USB-TTL adapter on the UART pins)
hour-meter get hour --port /dev/ttyUSB0 # one command, one ACK
hour-meter firmware flash               # update the firmware to the newest release (over USB)
```

## Install

**Binary:** download `hour-meter-<version>-<platform>` from the [releases page](https://github.com/ilomon10/embedded-totalizer-hour-meter/releases) (each release `v*` carries the firmware, this tool and the simulator; older ones are tagged `configurator-v*`), unpack it, and run `hour-meter`. Verify the download with `sha256sum -c SHA256SUMS`. Binaries are built for Linux x64 and Windows x64; on macOS or an ARM board, run it from source.

**From source** (needs [Bun](https://bun.com) 1.4.4 or newer):

```bash
cd configurator
bun install                             # once: OpenTUI and React
bun run start --demo                    # same options as the binary
bun run start /dev/ttyUSB0
```

**Ports:** a serial device (`/dev/ttyUSB0`, `/dev/rfcomm0`, `/dev/cu.usbserial-*` on macOS) or `tcp://host:port`. The TUI without a port opens the [connect screen](#connect-screen). Commands and `read` without a port use `$HOUR_METER_PORT`, else `/dev/ttyUSB0`. Serial ports work on **Linux and macOS** (the port is configured with `stty`, 115200 8N1).

**Windows:** the binary runs, but COM ports are not supported yet. Use `--demo`, the [simulator](../simulator/README.md) over TCP, or a serial-to-TCP bridge with `tcp://host:port`. `firmware list` and `firmware download` work; flashing needs Linux or macOS.

## TUI: configurator + live viewer

Ten screens in three groups: **maintain** (read and correct the counters, keep a record), **set up** (install, check the wiring, configure, calibrate) and **service** (find faults, update the firmware). It works in an 80×24 terminal; from 100 columns the menu becomes a sidebar.

### Connect screen

`hour-meter` without a port starts here:

```
 HOUR METER  configurator 2.0.0                                                 Connect to a device
╭─ Ports ──────────────────────────────────────────────────────────────────────────────────────────╮
│                                                                                                  │
│ ▸ /dev/ttyUSB0          Silicon Labs CP2102 USB to UART… · ESP32 board   last used               │
│   /dev/rfcomm0          Bluetooth · asks for the PIN                                             │
│                                                                                                  │
│   Type a port or tcp://host:port…                                                                │
│   Demo device: a simulated hour meter, no hardware needed                                        │
│                                                                                                  │
╰────────────────────────────────────────────────────────────────────────────── rescans every 1 s ─╯
╭─ Tips ───────────────────────────────────────────────────────────────────────────────────────────╮
│ The board restarts when its USB port opens and answers after about 2 s.                          │
│ No port listed? Try another cable (some only charge) and check you are in the                    │
│ dialout (Debian/Ubuntu) or uucp (Arch) group.                                                    │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
                                        ↑↓ select   Enter connect   e type a port   d demo   q quit
```

- **The list updates by itself.** Plug in the board and its port appears, already selected. On Linux each USB port is named by its adapter chip (from `/dev/serial/by-id`).
- **The last port used is selected first.** Without one, `$HOUR_METER_PORT`, else the first port that looks like an ESP32 board (CP210x, CH340, FTDI).
- **`e` takes a typed port**: a path or `tcp://host:port` (the simulator, a serial-to-TCP bridge). A Bluetooth port asks for the PIN, unless `--pin` gave it. The PIN is kept for reconnects.
- **A port that does not open says why** on this screen: it is not there, it is in use by another program, or you have no permission. For permission it names the group to join, e.g. `sudo usermod -aG uucp $USER` (Arch) or `dialout` (Debian, Ubuntu).

`hour-meter /dev/ttyUSB0` (or `--demo`) skips this screen. `p` in the TUI comes back to it.

### Screens

```
 HOUR METER │ 1A2B3C4D │ fw 2.6.0 │ ● DEMO simulated │ 08:16:33 UTC                    ▲ 2 to check
╭──────────────────╮╭─ Overview ───────────────────────────────────────────────────────────────────╮
│ MAINTAIN         ││ HOUR METER               TOTALIZER                ENGINE                     │
│ ▸1 Overview      ││ 1250.00 h                15017.00 units           ● RUNNING                  │
│  2 Counters      ││ 4500005 s                15017 pulses · 1 per unit input on · vib 39 mg      │
│  3 Report        ││ saved 1 min 5 s ago (#812)                                                   │
│ SET UP           ││                                                                              │
│  4 Commission    ││ NEEDS ATTENTION                                                            2 │
│  5 Live inputs   ││ ▸▲ IMU not calibrated      Tilt and vibration are inaccurate.  → 7 Calibrate │
│  6 Settings      ││  ▲ Compass not calibrated  The heading is off.                 → 7 Calibrate │
│  7 Calibrate     ││                                                                              │
│ SERVICE          ││ DEVICE                                                                       │
│  8 Diagnostics▲2 ││ Clock      2026-10-25 08:16:33 UTC · local 16:16 · ✔ same as this PC         │
│  9 Firmware      ││ Modules    ✔ EEPROM   ✔ RTC   ✔ IMU   ✔ compass                              │
│  0 Log           ││ Storage    ✔ flash + EEPROM · settings from flash copy A                     │
│                  ││ Restart    power-on, 0 s ago · previous run ended normally                   │
│                  ││ Link       demo device · telemetry every 1 s · 53 frames                     │
│                  ││ Firmware   2.6.0                                                             │
│                  ││                                                                              │
│                  ││ [h] set hours…   [t] set time   [r] refresh   [w] service report             │
│                  ││                                                                              │
╰──────────────────╯╰────────────────────────────────────────────────────────── updated 0.1 s ago ─╯
                            ↑↓ select   Enter open   h hours   t time   ? help   : command   q quit
```

| Key | Screen | What it is for |
|---|---|---|
| `1` | Overview | The counters and the engine; what needs attention, each with the screen that fixes it; the device clock against this PC, modules, storage, last restart, link. `h` set hours…, `t` set the time, `w` service report |
| `2` | Counters | Set the hour meter (hours) or the totalizer (units or pulses) to any value. The dialog shows now → new and the change, and refuses an empty value. A reset to 0 needs `RESET` typed. Saved on the device at once |
| `3` | Report | A service report in Markdown, with the raw values as JSON at the end, saved in `~/hour-meter-reports` (`$HOUR_METER_REPORTS`). Technician and unit are remembered per device |
| `4` | Commission | Eight install steps, checked from live data where it can: the engine input at key-on and with the engine running, pulses counting, the clock, the modules. `Enter` runs a step, then moves on once it passed; `Space` ticks the modules that are fitted. Progress is kept per device |
| `5` | Live inputs | The wiring check: the raw engine input against what is counted; the vibration RMS as a chart over time (`-` and `+` show 30 s to 10 min), with the threshold as a dotted line and the 10 s measurements shaded; the measurements with the key on and the engine off (`o`) and idling (`i`), which suggest a vibration threshold (`t`). Roll, pitch and heading as gauges: the machine seen from behind and from the side, and a compass |
| `6` | Settings | All 20 settings in groups, with plain names, units, ranges and factory defaults. Changes wait (`• was 200`) until `a` shows them before → after with what they do, then go as one command: all or none. A change that cuts your own link (`output` over USB, `bluetooth` off over Bluetooth) is flagged in red |
| `7` | Calibrate | Accel + gyro, and the compass, guided: the checks first (IMU fitted, engine off, board level), then progress and the result |
| `8` | Diagnostics | Every status flag in plain words, with its fix; restarts, storage, I2C and link counters. Reboot, panic signal and hard reset, each after a confirmation |
| `9` | Firmware | The releases (the newest is selected, never a prerelease) and the update, with `FLASH` typed, shown as a checklist. See [Update the firmware](#update-the-firmware) |
| `0` | Log | Events, commands and problems, scrollable and filtered, kept when you switch ports. `s` saves it to a file |

On every screen: `Tab` moves between the menu and the screen, `?` lists the keys, `:` or `Ctrl+K` finds any screen, setting or action, `r` reads everything again, `p` picks another port and `q` quits (it asks first if settings are not applied yet). A screen never takes these keys for itself, except while you type in a field. Nothing that changes the device runs on one key: you see what will change and confirm it.

### When something is wrong

A banner under the header names the problem and the key that helps. Nothing shows while all is well:

```
 ✖ The board was unplugged (12 s ago). Plug it back in: it reconnects by itself.     [p] other port
 ▲ Bluetooth session locked: live data, settings and counters need the PIN.               [u] unlock
 ▲ No data for 8 s (telemetry is every 1 s).                                            [8] diagnose
 ▲ Live data goes to the UART pins only (output = UART). Commands still work.           [6] settings
```

"No data" waits 5 s, or three telemetry intervals if that is longer. A reset is only offered, never automatic: 8 Diagnostics has the panic signal and the hard reset. A boot is logged with its cause, for example `device restarted: watchdog while IMU (reset reason 6)`, and 8 Diagnostics shows the last restart cause and **safe mode**.

**Unplug and replug.** The TUI keeps going when the board is unplugged. When the port comes back, it connects again and reads everything anew. A board that comes back under another name (`/dev/ttyUSB1`) is found by its adapter. Bluetooth drops and a restarted TCP bridge work the same way. While disconnected, commands say `not connected` at once instead of timing out. The last values stay on screen; when another board shows up on the port, the old one's values are cleared. A port given on the command line that is not there yet is waited for the same way, so `hour-meter /dev/ttyUSB0` can start before the board is plugged in.

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

Every Bluetooth connection starts **locked**. `--pin` (or `HOUR_METER_PIN`, or `u` in the TUI) unlocks it. A wrong PIN answers `BadPin`; after 5 wrong tries the device refuses for 60 s. `hour-meter read` and every command accept `--pin` too.

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

In the TUI, press `9`, pick a release, press `Enter` and type `FLASH` (`f` flashes a file). The update shows as a checklist: download and check, back up, enter the bootloader, write, verify, restart and reconnect, check and restore. Another screen can be opened meanwhile; `q` and `p` wait until it is done.

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

The hard reset talks to the adapter through libc (`ioctl`, via `bun:ffi`), so it needs Linux or macOS. It is untested on real hardware on macOS Apple Silicon. On Windows use `--signal`.

### Hours count with the key on but the engine off

The engine-running input is on a wire that is live at ACC/ON. `hour-meter read` shows `engine ON` before the engine starts. Move the input to the alternator's L / D+ terminal or the oil-pressure warning switch ([how to find the wire](../esp32/docs/WIRING.md#pick-the-wire)). If no such wire is reachable, set `runVibMinMg` (firmware 2.5.0). The reader then shows `engine OFF (input on)` while the key is on and the engine is stopped.

### Device sends nothing over USB

1. Try `hour-meter reset` (or `n` and `x` in the TUI's 8 Diagnostics). The device restarts and the boot EVENT says why it was stuck.
2. Check the `output` setting is not UART-only: `hour-meter get settings` over the UART pins (or Bluetooth) shows `output`. `uart` keeps the USB port silent; set `output=both`.
3. After a restart, `lastCause` and `lastStage` (in `get status`, the boot EVENT and the TUI's 8 Diagnostics) say what happened: `watchdog`, `i2cStuck`, `usbStalled`, `panicSignal`, `rebootCommand` or `crash`, and what the firmware was doing (IMU, RTC, EEPROM...).
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
bun install            # once
bun run test           # command words, DeviceClient protocol rules, a --demo round trip, port listing,
                       # reconnecting after an unplug (fake ports), the ROM bootloader protocol and whole
                       # flashes against a fake ROM, release lists; the TUI's models, its controller, and
                       # its screens drawn by OpenTUI's test renderer (also a flash's checklist)
bun check              # type-check
bun run lint           # oxlint
bun fmt --check        # formatting (settings in bunfig.toml)
bun run compile        # release binaries for Linux x64 and Windows x64 into dist/ (+ SHA256SUMS)
```

The TUI draws with OpenTUI's native library, one per platform. `bun install` fetches only this machine's; for the Windows binary, run `bun install --os='*' --cpu='*'` once (the release script does).

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
│   ├── links.ts        serial (plain file I/O + stty), TCP, in-memory link pair
│   ├── ports.ts        the serial ports now (connect screen), plain words for a port that does not open
│   ├── connection.ts   the TUI's link: reconnects after an unplug, hands the port to the flasher
│   ├── demo.ts         --demo: the simulator's device in-process
│   ├── cli.ts          shared flags and connect()
│   ├── platform.ts     the OS name ('windows', not 'win32') and errno codes
│   ├── commands.ts     one command, one ACK
│   ├── reader.ts       live view
│   ├── esp-rom.ts      ESP32 ROM bootloader protocol: SLIP, sync, compressed writes, MD5
│   ├── flash.ts        firmware images, the regions written (NVS kept), the flash sequence
│   ├── releases.ts     firmware on the GitHub releases: list (API, else the release feed), checked downloads
│   ├── firmware.ts     `firmware`: version, list, download, flash with backup and restore
│   └── tui/            the TUI (OpenTUI + React): main.tsx entry, shell.tsx frame and menu, screens/ (one
│                       per screen), controller.ts (device actions, no UI), model/ (pure: health, settings,
│                       counters, commission, report...), state.ts (frames → device state)
├── tools/compile.ts    release binaries
└── test/
```

Why not the npm `serialport` package? It is a native add-on, so every release binary would have to carry the right build of it. Serial ports are plain files instead: opened with `node:fs` and set up with `stty`. The port is opened twice: a non-blocking handle that Bun polls for reading, and one for writing, so a read waiting for data never holds back a write (the ROM bootloader only answers what it is sent). That keeps the binary free of native code, but rules out Windows COM ports for now.

To release: bump `TOOL_VERSION` in `src/version.ts`, commit, and run [`scripts/release.ts`](../scripts/release.ts) from the repository root (see [Releasing](../README.md#releasing)). `bun run compile` alone builds the binaries into `dist/`.
