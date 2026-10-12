# Hour meter simulator

**A fake hour-meter device on a virtual serial port.** It speaks the real protocol (SensorFrame v1, firmware 2.3.0): it sends TELEMETRY, IMU stream and EVENT frames and answers your COMMANDs with the same ACKs, error codes and quirks as the firmware. Use it to write and test a driver without the hardware.

```bash
cd simulator
deno task start                 # creates /tmp/ttyHourMeter (needs socat)
```

Then open `/tmp/ttyHourMeter` in your driver like any serial port (any baud rate, 8N1). Try it with the project's own tools:

```bash
cd node && npm install
node reader.js /tmp/ttyHourMeter                     # live telemetry
node commands.js get hour --port /tmp/ttyHourMeter   # one command, one ACK
npm run tui -- /tmp/ttyHourMeter                     # full configurator
```

Needs [Deno](https://deno.com) 2 and, for the virtual tty, `socat` (`apt install socat` / `pacman -S socat` / `brew install socat`). Without socat, use `--tcp`.

## What you get

| | Same as the real device |
|---|---|
| **Frames** | Byte-identical to the firmware. The tests rebuild the firmware's golden frames from `esp32/test/test_app` and every dump in [FRAME-CATALOG.md](../esp32/docs/FRAME-CATALOG.md) |
| **Timing** | TELEMETRY every `telemetryIntervalMs`, IMU stream at `imuStreamHz`, module checks every 2 s, calibration 5 s (IMU) / 20 s (magnetometer) |
| **Commands** | All-or-nothing validation, `rejectedTag`, setting ranges and the `imuStreamHz ≤ imuSampleHz` rule, `resetCounters` magic, `get=1…4`, a retried `seq` within 10 s replays the ACK, reboot 100 ms after the ACK |
| **Port open** | Opening the tty reboots the device (boot EVENT, `seq` back to 0), like an ESP32 DevKit whose DTR line resets it. `--no-reset` turns this off |
| **State** | The engine runs 40 s on / 40 s off, the hour meter and totalizer count up, and counters are saved every `persistIntervalS`. Settings and time persist across reboots, as with EEPROM and the RTC |
| **Not simulated** | Real sensor physics (motion is a gentle sine plus noise), `i2cErrors`/`overruns` (always 0), the UART pins (the simulated port is the USB port) |

## Options

```text
deno task start [options]

Port (pick one)
  --pty <path>         virtual tty made by socat (default /tmp/ttyHourMeter)
  --tcp <port>         serve on 127.0.0.1:<port> instead (no socat needed)
  --stdio              frames on stdout, commands on stdin

Device
  --bt                 act as a Bluetooth SPP session: locked until COMMAND unlock=<PIN>
  --pin <0-9999>       btPin setting (default 1234)
  --engine <on|off>    hold the alternator on or off (default: 40 s on / 40 s off cycle)
  --run-hours <h>      hour meter at power-on (default 1250)
  --total <pulses>     totalizer at power-on (default 15000)
  --pulse-hz <n>       totalizer pulses per second while the engine runs (default 3.5)
  --device-id <n>      deviceId in every header (default 0x1a2b3c4d)
  --no-reset           do not reboot when a client opens the tty
  --seed <n>           random seed for sensor noise and faults (default 1)

Output
  -v, --verbose        log every frame with all its records (stderr)
  -q, --quiet          log nothing but errors
```

The log on stderr shows each session, every COMMAND and its ACK, and every EVENT (`-v` adds TELEMETRY and IMU):

```text
09:44:02.237 client connected on /tmp/ttyHourMeter
09:44:02.237 -> EVENT #0 boot devices=0xf flags=imuNotCalibrated,magNotCalibrated
09:44:05.930 <- COMMAND #23383 get=1
09:44:05.932 -> ACK #1 ackSeq=23383 Ok +7 records
```

## Fault scenarios

Test the paths your driver will meet in the field. Combine as many as you like; `--seed` makes random faults repeatable.

```bash
deno task start --scenario no-rtc-battery --scenario corrupt=5
```

| Scenario | What happens | What your driver should do |
|---|---|---|
| `engine-cycle[=onS,offS]` | Alternator on/off cycle (the default, 40,40) | Show `alternator`; run hours only grow while on |
| `no-rtc-battery` | Time lost at power-on: `timeValid` false, `rtcBatteryLost` + `timeInvalid`, header timestamp = uptime | Send `setTime` (UTC) |
| `no-rtc` | No RTC: `rtcMissing`; after `setTime`, `timeNotBackedUp` | Send `setTime` after every boot |
| `no-eeprom` | No EEPROM: presets answer `DeviceMissing`, settings set `settingsNotSaved` | Warn that counters are not persistent |
| `no-imu`, `no-mag` | Module absent: its records disappear from TELEMETRY | Treat missing tags as "no data", not as zero |
| `module-flap[=module,periodS]` | Unplug/replug `imu` (default), `eeprom` or `rtc` every period (default 30 s) → EVENT kind 3. Lost after 3 missed checks (~6 s), so shorter periods are ignored, as on the device | Update the module list on EVENT kind 3 |
| `reboot[=periodS]` | Watchdog reset every period (default 120 s): boot EVENT, `resetReason` 6, `seq` restarts at 0 | Log unexpected reboots; don't treat a `seq` jump as lost frames |
| `noise[=p]` | Random junk bytes (zeros included) before a fraction `p` of frames (default 0.2) | Drop bad frames, resync on the next `0x00` |
| `corrupt[=N]` | One byte flipped in 1 of N frames (default 10) → CRC / COBS errors | Count and drop; never crash |

## Bluetooth mode

`--bt` makes the port behave like a Bluetooth SPP session: every command answers `Locked` (9) and no live data flows until `unlock` (tag 107) carries the PIN. A wrong PIN gives `BadPin` (10), and 5 wrong PINs lock out unlocking for 60 s. Each new connection starts locked again, and connecting does not reboot the device.

```bash
deno task start --bt --pin 4821
node ../node/commands.js get status --port /tmp/ttyHourMeter --pin 4821
```

## TCP and stdio

No socat (Windows, Docker), or a driver that already talks TCP to a serial gateway:

```bash
deno task start --tcp 5555        # one client at a time; each connection is a new session
deno task start --stdio | xxd     # raw frames on stdout, logs on stderr
```

## Notes for driver tests

- Between sessions the tty link disappears for a few milliseconds while socat restarts. An automated test that closes and reopens the port immediately should retry `open` once.
- Every frame takes the next `seq`, including frames that were not delivered (no client, Bluetooth locked, `output` set to UART). Gaps in `seq` are normal.
- Writing `output=2` (UART) stops periodic data on this port, exactly as on the device. Commands still work: send `output=1` to get it back.

## Development

```bash
deno task test         # 27 tests: firmware golden frames, catalog dumps, command rules, Bluetooth lock
deno task check        # type-check
deno lint && deno fmt --check
deno task gen-catalog  # print the FRAME-CATALOG.md frames after a protocol change
```

```
simulator/
├── main.ts               CLI: flags → device + scenarios + transport
├── src/
│   ├── protocol.ts       the only bridge to ../sensorframe/js (codec) and ../node/tags.js (tag table)
│   ├── frames.ts         frame builders, a port of esp32/lib/App/src/Telemetry.cpp (same record order)
│   ├── commands.ts       command validation, a port of CommandHandler.cpp + SettingsSchema.cpp
│   ├── device.ts         the simulated Application: scheduler, counters, time, modules, calibration
│   ├── access-gate.ts    Bluetooth PIN lock, a port of AccessGate.h
│   ├── scenarios.ts      fault injection
│   ├── splitter.ts       bytes → frames (split on 0x00, COBS, CRC)
│   ├── clock.ts          injected clock + seeded RNG
│   ├── log.ts            human log on stderr
│   └── transport/        pty (socat), tcp, stdio
├── tools/                catalog.ts + gen-catalog.ts (FRAME-CATALOG.md frames)
└── test/
```

The protocol tables are not copied: `src/protocol.ts` loads the same codec and tag table the Node tools use, and `node esp32/scripts/check-docs.js` keeps those in sync with the firmware's `Protocol.h`. When the firmware changes a frame, port the change to `src/frames.ts` / `src/device.ts`, then run `deno task test`. The golden-frame tests fail until the simulator matches again.
