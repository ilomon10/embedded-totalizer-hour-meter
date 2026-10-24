# Firmware Architecture

How the hour-meter firmware is organised, how data flows, and where to change things. For the external protocol see [INTEGRATION-GUIDE.md](INTEGRATION-GUIDE.md). For coding rules see [CODING-STANDARD.md](CODING-STANDARD.md). New to C++? Read [CPP-FOR-TYPESCRIPT.md](CPP-FOR-TYPESCRIPT.md) first.

## 1. Layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ src/            Arduino glue: knows pins, Serial, Wire, FreeRTOS          │
│   main.cpp ──► Application (composition root, main loop, IDeviceControl) │
│   platform/      ArduinoClock · Inputs (pins + pulse ISR) · SerialLink    │
│                  (USB, UART pins, Bluetooth SPP; AccessGate PIN lock)     │
│                  · ResetLog (breadcrumbs that survive a reset)            │
├──────────────────────────────────────────────────────────────────────────┤
│ lib/App         Business logic, NO hardware access (unit-tested on PC)   │
│   Protocol.h (all tags) · SettingsSchema · HourMeter · ImuPipeline       │
│   CommandHandler · Telemetry · TimeKeeper · Snapshots · Supervisor       │
├──────────────────────────────────────────────────────────────────────────┤
│ lib/Storage     Journal · SettingsStore (EEPROM) · FlashStore · Mirror    │
│ lib/Filters     Kalman1D · KalmanAngle · Compass · Vibration · Stats      │
├──────────────────────────────────────────────────────────────────────────┤
│ lib/At24c  lib/Ds3231  lib/Mpu9250    chip drivers (talk only via II2cBus)│
│ lib/I2cBus      II2cBus interface + ArduinoI2cBus (timeouts, recovery)    │
│ lib/Core        Status · Result<T> · CHECK_ARG/TRY · IClock · PeriodicTask│
├──────────────────────────────────────────────────────────────────────────┤
│ ../sensorframe  wire format: SensorFrameWriter / Reader, CRC16, COBS      │
└──────────────────────────────────────────────────────────────────────────┘
```

**Dependency rule:** arrows only point down. Nothing in `lib/` includes `Arduino.h` except `ArduinoI2cBus` (guarded by `#ifdef ARDUINO`). That is why every library runs in the native unit tests with fake chips (`test/fakes/`).

## 2. Boot sequence (`Application::setup`)

| Step | What | If it fails |
|---|---|---|
| 1 | Enable the 5 s task watchdog | |
| 2 | `ResetLog`: read why and where the last run ended (`lastCause`, `lastStage`); count unplanned restarts | 3 in a row: **safe mode**, steps 5, 6, 9, 10 are skipped |
| 3 | Open USB (115200 fixed) | |
| 4 | Flash store: find partition `hmdata`, read both settings copies, scan the counter journal | Flag `flashStoreMissing`: the EEPROM is the only store |
| 5 | I2C bus recovery + start (400 kHz) | |
| 6 | EEPROM probe → layout header check (format if blank/foreign; watchdog raised to 30 s) → scan journal | Flag `eepromMissing`: the flash alone keeps the values |
| 7 | `StorageMirror.adopt()`: settings from the flash, else the EEPROM; counters: the newest save of this history in either store, with an EEPROM from another history added to the counters counted from zero → `HourMeter.restore()`; the store that is behind is brought up to date ([STORAGE.md](STORAGE.md)) | Run on defaults; flags `settingsDefaults` / `journalEmpty` |
| 8 | Open UART (`uartBaud`), Bluetooth if enabled; inputs: alternator pin, pulse interrupt | |
| 9 | RTC probe, enable battery oscillator, read time | Flag `rtcMissing`; timestamps become uptime |
| 10 | IMU WHO_AM_I, configure, magnetometer if present | Flag `imuMissing` / `magMissing` |
| 10 | Apply settings to every component, start timers | |
| 11 | Send boot EVENT | |

Every step that can touch hardware first writes a breadcrumb (`reset_log::stage`), so a watchdog reset during, say, step 9 is reported as `lastStage` = IMU on the next boot. USB comes before I2C on purpose: a stuck sensor bus can't keep the recovery port silent.

A missing chip never stops the device. The hour meter works even with no sensors attached, and every module can be plugged in later: boot uses the same `attachX()` functions as the presence check.

## 3. Main loop (`Application::loop`)

Cooperative and non-blocking. Each task is a `PeriodicTask` (a polled `setInterval`):

| Task | Period | Work |
|---|---|---|
| serial | every loop | Read both ports. Complete COMMAND frames go to `CommandHandler`, the ACK goes back to the sender, then deferred actions run (port change, reboot) |
| inputs | 10 ms | Collect pulses, debounce the alternator, accumulate run time, save to the journal when due or on engine stop |
| imu | 1/`imuSampleHz` | Read the IMU (+ mag), `ImuPipeline.process()`, finish calibration if done |
| stream | 1/`imuStreamHz` | IMU stream frame (raw / filtered / both) |
| telemetry | `telemetryIntervalMs` | TELEMETRY frame |
| rtc | `rtcSyncIntervalS` | Re-read the RTC; `TimeKeeper` extrapolates with `millis()` in between; repairs an RTC that lost its time |
| presence | 2 s | Hot-plug: probe present I2C modules (lost after 3 misses, `PresenceTracker`), try to attach missing ones (`attachEeprom/Rtc/Imu`), report changes as EVENT kind 3. Not in safe mode |
| supervisor | every loop | `Supervisor`: restart when the I2C bus has failed for 30 s or USB TX has not drained for 10 s; restart on the panic signal (64 × `0x00` on a wired port, seen by `SerialLink`). After 10 min of normal running, the restart counter clears |

Every restart the firmware decides on goes through `Application::restart(cause)`: record the cause in `ResetLog`, save the counters (best effort), restart.

The watchdog is fed at the top of every loop. Nothing in the loop waits for longer than one bounded I2C transfer (≤ 20 ms timeout × 3 attempts) or one EEPROM page write (≤ 10 ms).

## 4. Data flow: hour meter

```
alternator pin ──► HourMeter.update(now, level)  (debounce, add elapsed ms while running)
pulse ISR ───────► Inputs.takePulses() ─► HourMeter.addPulses(n)
                         │
       engine stopped OR persistDue (dirty && interval elapsed)
                         ▼
      StorageMirror.saveCounters(runSeconds, totalCount, epoch)   one new seq for both:
             ├──► FlashStore.append   ──► flash ring slot n+1   (erase on entering a sector)
             └──► Journal.append      ──► AT24C256 ring slot m+1 (when fitted)
                         │                (CRC + read-back verify in both)
       a store kept it ─► markPersisted     none did ─► deferPersist;  any failure ─► storageError
```

At boot both stores are scanned, and in each the valid record with the highest `seq` is its newest. Within one history the newer of the two wins: normally the flash's, which gets every save. An EEPROM from another history is only added to the counters counted from zero. See [STORAGE.md](STORAGE.md) and [EEPROM-LAYOUT.md](EEPROM-LAYOUT.md).

## 5. Data flow: IMU

```
MPU9250 ─► ImuSample (g, °/s) ─┬─ − bias ─► Kalman1D ×3 ─────────────► filtered accel/gyro
AK8963  ─► mag (µT, MPU axes) ─┼─ hard/soft iron ─► Kalman1D ×3 ─────► filtered mag ─┐
                               ├─ accel angle + gyro rate ─► KalmanAngle ─► roll, pitch ─┤
                               │                                     up vector ◄─────────┘
                               │                                        └─► Compass ─► heading
                               └─ − bias (unfiltered!) ─► VibrationMeter ─► RMS, peak (mg)
```

Calibration runs inside the same pipeline using running statistics (Welford): no samples are stored. See [CALIBRATION.md](CALIBRATION.md).

## 6. Commands

`SerialLink` → `Application::onCommand` → duplicate check (same seq within 10 s replays the cached ACK) → `CommandHandler::handle`:

1. **validate**: every record must be a known setting or action with a valid value. One failure rejects the whole command.
2. **apply settings**: one `SettingsStore.save()` for all settings in the command, then `applyRuntimeSettings()`.
3. **actions** in frame order (setTime, preset, reset, calibrate, reboot).
4. **ACK** with `ackSeq`, `ackStatus`, `rejectedTag`, and `get` data.

`CommandHandler` only sees the `IDeviceControl` interface, so it is tested with a fake device (`test/test_app`).

## 7. Where to change things

| I want to… | Change |
|---|---|
| Move a pin / I2C address | `include/BoardPins.h` |
| Add a setting | `Settings` struct (bump `SettingsStore::kVersion`) → `SettingsSchema.cpp` row + `read`/`write` cases → `configurator/src/tags.ts` → INTEGRATION-GUIDE §7 → `./scripts/check-docs.ts` |
| Add a telemetry value | new tag in `Protocol.h` → `Telemetry.cpp` → `configurator/src/tags.ts` → INTEGRATION-GUIDE §5 (+ `simulator/src/frames.ts`) |
| Add a command | tag in `Protocol.h` → `checkAction` + `runAction` in `CommandHandler.cpp` → `IDeviceControl` if it needs hardware → docs |
| Change the EEPROM map | `EepromLayout.h` + bump `kLayoutVersion` (the device reformats the EEPROM once, then refills it from the flash) → [EEPROM-LAYOUT.md](EEPROM-LAYOUT.md) |
| Change the flash store | `FlashStore.h` (+ `partitions.csv` for its size) → [STORAGE.md](STORAGE.md) |
| Support another IMU | new driver in `lib/` producing `ImuSample`; the pipeline is chip-agnostic |
| Test a module on the bench | `src/bench/BenchMain.cpp` (env `bench`), see [TESTING-MODULES.md](TESTING-MODULES.md) |
