# Host tools for the hour meter

Node.js tools for the headless hour-meter device: a full-screen **TUI** (configurator and live viewer), a command-line client, a live reader, and the `DeviceClient` library they share.

```bash
cd node
npm install
npm run tui -- --demo          # try everything with a simulated device (no hardware)
npm run tui -- /dev/ttyUSB0    # the real device (USB, or a USB-TTL adapter on the UART pins)
```

## TUI: configurator + viewer

```
╭──────────────────────────────────────────────────────────────────────────────╮
│ HOUR METER                ● connected /dev/ttyUSB0        dev 1a2b3c4d fw 2.2.0│
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

It is written in TypeScript with [Ink](https://github.com/vadimdemedes/ink) (React for terminals): `tui/App.tsx` holds the screens, `tui/state.ts` is a pure, unit-tested reducer (frames → view state), and `tui/demo-device.ts` is the simulator. No build step: `tsx` runs it directly.

## Over Bluetooth

Bluetooth is off by default. Turn it on once over USB and set your own PIN:

```bash
node commands.js set bluetooth=true btPin=4821      # via USB
```

Then pair and bind a serial port (Linux):

```bash
bluetoothctl            # scan on, pair <MAC>, trust <MAC>   (device: HourMeter-XXXX)
sudo rfcomm bind 0 <MAC> 1
npm run tui -- /dev/rfcomm0 --pin 4821
```

On Windows, use the "Standard Serial over Bluetooth link" COM port: `npm run tui -- COM7 --pin 4821`.

Every Bluetooth connection starts **locked**. `--pin` (or `HOUR_METER_PIN`, or *Actions → Unlock* in the TUI) unlocks it. A wrong PIN answers `BadPin`; after 5 wrong tries the device refuses for 60 s. `commands.js` and `reader.js` accept `--pin` too.

## Command line

```bash
node commands.js get status                  # hour | settings | status | calib
node commands.js set telemetryIntervalMs=500 output=both
node commands.js set-time                    # PC clock as UTC
node commands.js set-hours 1234.5            # set the hour meter to any value
node commands.js set-units 5230.75           # set the totalizer in units (uses pulsesPerUnit)
node commands.js set-count 523075            # ...or in raw pulses
node commands.js reset-hours --yes           # hour meter only -> 0
node commands.js reset-totalizer --yes       # totalizer only -> 0
node commands.js calibrate gyro              # or mag
node commands.js reset-counters --yes        # both -> 0
node reader.js /dev/ttyUSB0 [--imu]          # scrolling live view, auto time sync
```

Port: argument, `--port`, or `HOUR_METER_PORT` (default `/dev/ttyUSB0`).

## Library

```js
const { DeviceClient } = require('./device');
const dev = await DeviceClient.open('/dev/ttyUSB0');
dev.enableAutoTimeSync();
dev.on('frame', (msg) => console.log(msg.msgTypeName, msg.values));
const ack = await dev.request({ get: 1 });   // retries with the same seq, rejects on error ACK
```

The protocol is documented for other languages in [`esp32/docs/INTEGRATION-GUIDE.md`](../esp32/docs/INTEGRATION-GUIDE.md).

## Development

```bash
npm test             # node:test for the JS client + tsx tests for the TUI state
npm run typecheck    # tsc --noEmit over tui/
```
