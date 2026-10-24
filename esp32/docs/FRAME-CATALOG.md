# Frame Catalog: every frame, byte for byte

**Audience:** developers writing their own driver (any language) who want to see exactly what goes over the wire.
**Covers:** firmware **2.6.0**, SensorFrame v1. For each frame: when it is sent, the records in wire order, which records are optional, and a real hex dump you can feed to your decoder.
**Read with:** [INTEGRATION-GUIDE.md](INTEGRATION-GUIDE.md) for ports, commands and flows, and [SensorFrame SPEC.md](../../sensorframe/SPEC.md) for the encoding rules. This page does not repeat them.

> **No hardware?** The [simulator](../../simulator/README.md) sends these same frames on a virtual serial port and answers your commands. Start it with `cd simulator && deno task start`, then point your driver at `/tmp/ttyHourMeter`.

Every hex dump below comes from fixed inputs (`simulator/tools/catalog.ts`). The simulator's tests check that each dump matches its generator, and that the generator reproduces the firmware's own golden frames, so the dumps on this page are bytes the device really sends.

| Section | Frames |
|---|---|
| [1. Rules for every frame](#1-rules-for-every-frame) | Framing, header, record order, sizes |
| [2. Anatomy of one frame](#2-anatomy-of-one-frame) | A 23-byte ACK taken apart byte by byte |
| [3. TELEMETRY](#3-telemetry-msgtype-1) | Periodic hour meter + status + motion |
| [4. EVENT](#4-event-msgtype-2) | Boot, calibration done, modules changed |
| [5. IMU stream](#5-imu-stream-msgtype-128) | Raw / filtered / both |
| [6. ACK](#6-ack-msgtype-4) | Ok, errors, get=1…4, Locked |
| [7. COMMAND](#7-command-msgtype-3-host--device) | What your driver sends |
| [8. Frame sizes](#8-frame-sizes) | Buffer sizing |

---

## 1. Rules for every frame

- **Framing:** each frame on the wire is `COBS(packet)` followed by one `0x00`. Split on `0x00`, COBS-decode, check the CRC16, and drop the frame if the CRC fails. A frame never contains `0x00`, so you can resync at the next one.
- **Packet:** a 12-byte header, then records, then a CRC16 (CCITT-FALSE, little-endian) over everything before it. All multi-byte numbers are **little-endian**.
- **Header:** `version (u8, always 1)`, `msgType (u8)`, `seq (u16)`, `deviceId (u32)`, `timestamp (u32)`.
  - `seq` counts every frame the device sends (all types together). It wraps 65535 → 0 and restarts at 0 on boot.
  - `timestamp` is UTC Unix seconds when the time is valid, otherwise seconds since boot. Any value below `946684800` is uptime.
- **Record:** `tag (u8)`, `fmt (u8)`, then the value: 1 byte (`u8`, `bool`), 2 bytes (`u16`, `i16`), or 4 bytes (`u32`, `f32`).
- **Raw values are scaled integers.** The tables below give the raw wire value and its meaning. Scales and units come from the [tag dictionary](INTEGRATION-GUIDE.md#5-tag-dictionary).
- **Order:** firmware 2.6.0 always writes records in the order shown here. **Decode by tag, not by position.** Later firmware may add records or optional ones may be missing, and unknown tags must be skipped (their size follows from `fmt`).

fmt codes used by this device: `01` u8 · `03` u16 · `04` i16 · `05` u32 · `07` f32 · `08` bool.

## 2. Anatomy of one frame

The device's ACK to a `setTime` command (Section [6](#6-ack-msgtype-4)), as 23 bytes on the wire:

```text
04 01 04 82 0c 4d 3c 2b 1a 70 3c c6 6a f2 03 2a 03 f3 01 03 86 eb 00
```

**COBS-decoded**, it becomes a 21-byte packet. Each COBS code byte (`04`, `0c`, `03`, `03`) says how far away the next `00` is; the final `00` is the delimiter.

```text
01 04 82 00 4d 3c 2b 1a 70 3c c6 6a f2 03 2a 00 f3 01 00 86 eb
```

| Bytes | Field | Value |
|---|---|---|
| `01` | version | 1 |
| `04` | msgType | 4 = ACK |
| `82 00` | seq | 130 |
| `4d 3c 2b 1a` | deviceId | 0x1a2b3c4d |
| `70 3c c6 6a` | timestamp | 1791376496 = 2026-10-07T12:34:56Z |
| `f2 03 2a 00` | record: tag 242 `ackSeq`, u16 | 42: answers the COMMAND with seq 42 |
| `f3 01 00` | record: tag 243 `ackStatus`, u8 | 0 = Ok |
| `86 eb` | CRC16 | 0xeb86 over the 19 bytes before it |

---

## 3. TELEMETRY (msgType 1)

**When:** every `telemetryIntervalMs` (default 1000 ms), on the ports chosen by `output` (default USB), and over Bluetooth once a session is unlocked.

| Tag | Name | Type | Present | Example raw | Meaning |
|---:|---|---|---|---:|---|
| 1 | `runSeconds` | u32 | always | 4500000 | engine run time, s |
| 2 | `totalCount` | u32 | always | 15000 | totalizer pulses |
| 3 | `alternator` | bool | always | 1 | engine running now: the input is active and, if `runVibMinMg` > 0, the vibration confirms it |
| 10 | `altInput` | bool | always | 1 | raw engine-running input (before the vibration check) |
| 4 | `runHours` | u32 | always | 125000 | 1250.00 h (×0.01) |
| 5 | `totalUnits` | u32 | always | 1500000 | 15000.00 units (×0.01, pulses ÷ `pulsesPerUnit`) |
| 50 | `timeValid` | bool | always | 1 | header timestamp is UTC |
| 53 | `statusFlags` | u32 | always | 0 | [flag bits](INTEGRATION-GUIDE.md#55-status-flags-tag-53) |
| 40 | `roll` | i16 | IMU fitted | 250 | 2.50° (×0.01) |
| 41 | `pitch` | i16 | IMU fitted | -48 | -0.48° (×0.01) |
| 42 | `heading` | u16 | magnetometer gives a heading | 3350 | 33.50° from magnetic north (×0.01) |
| 43 | `vibRms` | u16 | after the first vibration window | 37 | 37 mg |
| 44 | `vibPeak` | u16 | after the first vibration window | 103 | 103 mg |

Example with every record (seq 120, 73-byte packet):

<!-- frame:telemetry -->
```text
04 01 01 78 0e 4d 3c 2b 1a 70 3c c6 6a 01 05 20
aa 44 05 02 05 98 3a 01 0c 03 08 01 0a 08 01 04
05 48 e8 01 06 05 05 60 e3 16 06 32 08 01 35 05
01 01 01 04 28 04 fa 0c 29 04 d0 ff 2a 03 16 0d
2b 03 25 04 2c 03 67 03 9b a6 00
```

Without an IMU, the frame stops after tag 53, and `statusFlags` = 24 (`imuMissing` + `magMissing`):

<!-- frame:telemetry-no-imu -->
```text
04 01 01 78 0e 4d 3c 2b 1a 70 3c c6 6a 01 05 20
aa 44 05 02 05 98 3a 01 0c 03 08 01 0a 08 01 04
05 48 e8 01 06 05 05 60 e3 16 07 32 08 01 35 05
18 01 01 03 88 e6 00
```

---

## 4. EVENT (msgType 2)

The first record is always tag 8 `eventKind`. Switch on it.

### 4.1 Boot (`eventKind` 1)

**When:** once after every start: power-on, reboot command, watchdog, or the reset many ESP32 boards do when the USB port is opened. Wait for it before sending commands.

| Tag | Name | Type | Present | Example raw | Meaning |
|---:|---|---|---|---:|---|
| 8 | `eventKind` | u8 | always | 1 | boot |
| 1–5, 10 | hour meter | | always | | as in [TELEMETRY](#3-telemetry-msgtype-1): the counters restored from EEPROM |
| 6 | `lastSavedEpoch` | u32 | always | 1791376440 | UTC s of the last EEPROM save (0 = never) |
| 7 | `journalSeq` | u32 | always | 812 | EEPROM journal record number |
| 50 | `timeValid` | bool | always | 1 | |
| 53 | `statusFlags` | u32 | always | 0 | |
| 51 | `epoch` | u32 | always | 1791376496 | device clock, UTC s (0 while invalid) |
| 52 | `uptime` | u32 | always | 3600 | s since boot |
| 55 | `devices` | u8 | always | 15 | modules present: 1 EEPROM, 2 RTC, 4 IMU, 8 magnetometer |
| 56 | `i2cErrors` | u32 | always | 0 | |
| 57 | `overruns` | u32 | always | 0 | scheduler overruns |
| 58 | `resetReason` | u8 | always | 1 | ESP32 reset reason: 1 power-on, 3 software, 4 panic, 5–7 watchdog, 9 brown-out |
| 60 | `settingsSource` | u8 | always | 3 | 0 defaults, 1/2 EEPROM copy A/B, 3/4 flash copy A/B |
| 61 | `btState` | u8 | always | 0 | 0 off, 1 on, 2 client locked, 3 client unlocked |
| 62 | `lastCause` | u8 | always | 0 | why the previous run ended: 0 none, 1 watchdog, 2 i2cStuck, 3 usbStalled, 4 panicSignal, 5 rebootCommand, 6 crash |
| 63 | `lastStage` | u8 | always | 0 | what the device was doing then (breadcrumb, 0 unknown, 7 IMU, 8 serial / command) |
| 241 | `fwVersion` | u32 | always | 132608 | 0x00020600 = 2.6.0 |
| 54 | `rtcTemp` | i16 | RTC fitted | 117 | 29.25 °C (×0.25) |

<!-- frame:event-boot -->
```text
03 01 02 01 11 4d 3c 2b 1a 70 3c c6 6a 08 01 01
01 05 20 aa 44 05 02 05 98 3a 01 0c 03 08 01 0a
08 01 04 05 48 e8 01 06 05 05 60 e3 16 0b 06 05
38 3c c6 6a 07 05 2c 03 01 06 32 08 01 35 05 01
01 01 0b 33 05 70 3c c6 6a 34 05 10 0e 01 06 37
01 0f 38 05 01 01 01 03 39 05 01 01 01 09 3a 01
01 3c 01 01 3d 01 03 3e 01 03 3f 01 03 f1 05 03
06 02 04 36 04 75 03 eb 6b 00
```

### 4.2 Calibration done (`eventKind` 2)

**When:** a `calibrate` command finished, about 5 s after the command for the IMU and 20 s for the magnetometer.

| Tag | Name | Type | Present | Example raw | Meaning |
|---:|---|---|---|---:|---|
| 8 | `eventKind` | u8 | always | 2 | calibration done |
| 105 | `calibrate` | u8 | always | 1 | which one: 1 IMU at rest, 2 magnetometer |
| 9 | `calibResult` | u8 | always | 0 | an [ackStatus](INTEGRATION-GUIDE.md#63-ackstatus-codes) code: 0 Ok, 8 Failed (moved / not rotated enough) |
| 130–147 | `cal…` | f32 | result Ok | 0.012 … | all 18 calibration values, see [ACK to get=4](#64-ack-to-get4-calibration) |
| 148 | `calFlags` | u8 | result Ok | 3 | 1 IMU calibrated, 2 magnetometer calibrated |

<!-- frame:event-calibration -->
```text
04 01 02 39 11 4d 3c 2b 1a 70 3c c6 6a 08 01 02
69 01 01 09 01 4b 82 07 a6 9b 44 3c 83 07 6f 12
83 bb 84 07 31 08 ac 3c 85 07 85 eb d1 3e 86 07
ae 47 61 be 87 07 ec 51 b8 3d 88 07 ac c5 27 38
89 07 17 b7 51 38 8a 07 f7 cc 92 38 8b 07 27 a0
09 3b 8c 07 6c 09 f9 3a 8d 07 52 49 1d 3b 8e 07
01 05 48 41 8f 07 01 05 04 c1 90 07 01 1a f8 41
91 07 5c 8f 82 3f 92 07 ec 51 78 3f 93 07 ae 47
81 3f 94 01 03 6a bf 00
```

A failed magnetometer calibration has only the first three records (`calibrate` 2, `calibResult` 8):

<!-- frame:event-calibration-failed -->
```text
04 01 02 39 14 4d 3c 2b 1a 70 3c c6 6a 08 01 02
69 01 02 09 01 08 eb f2 00
```

### 4.3 Modules changed (`eventKind` 3)

**When:** a module was plugged in, or lost while running. A module counts as lost after 3 failed checks, 2 s apart. The frame carries the full status block: the same records as the boot EVENT from tag 50 on.

| Tag | Name | Type | Present | Example raw | Meaning |
|---:|---|---|---|---:|---|
| 8 | `eventKind` | u8 | always | 3 | modules changed |
| 50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 62, 63, 241 | status | | always | | as in the [boot EVENT](#41-boot-eventkind-1). Here `devices` = 3 (IMU gone) and `statusFlags` = 24 |
| 54 | `rtcTemp` | i16 | RTC fitted | 117 | |

<!-- frame:event-devices-changed -->
```text
16 01 02 2c 01 4d 3c 2b 1a 70 3c c6 6a 08 01 03
32 08 01 35 05 18 01 01 0b 33 05 70 3c c6 6a 34
05 10 0e 01 06 37 01 03 38 05 01 01 01 03 39 05
01 01 01 09 3a 01 01 3c 01 01 3d 01 03 3e 01 03
3f 01 03 f1 05 03 06 02 04 36 04 75 03 93 64 00
```

---

## 5. IMU stream (msgType 128)

**When:** every 1/`imuStreamHz` s (default 10 Hz) while `streamMode` ≠ 0 and an IMU is fitted. It goes to the same ports as TELEMETRY.

| Tags | Content | Type | Present | Scale |
|---|---|---|---|---|
| 20, 21, 22 | `rawAccelX/Y/Z` | i16 | `streamMode` 1 or 3 | mg (×0.001 g) |
| 23, 24, 25 | `rawGyroX/Y/Z` | i16 | `streamMode` 1 or 3 | ×0.1 °/s |
| 26, 27, 28 | `rawMagX/Y/Z` | i16 | `streamMode` 1 or 3, magnetometer fitted | ×0.1 µT |
| 30, 31, 32 | `accelX/Y/Z` (filtered) | i16 | `streamMode` 2 or 3 | mg |
| 33, 34, 35 | `gyroX/Y/Z` (filtered) | i16 | `streamMode` 2 or 3 | ×0.1 °/s |
| 36, 37, 38 | `magX/Y/Z` (calibrated, filtered) | i16 | `streamMode` 2 or 3, magnetometer fitted | ×0.1 µT |
| 40, 41 | `roll`, `pitch` | i16 | `streamMode` 2 or 3 | ×0.01° |
| 42 | `heading` | u16 | `streamMode` 2 or 3, heading available | ×0.01° |

Raw only (`streamMode` 1). Example values: accel 21 / -12 / 1004 mg, gyro 0.6 / -0.4 / 0.1 °/s, mag 30.4 / -5.2 / -40.1 µT.

<!-- frame:imu-raw -->
```text
04 01 80 79 0c 4d 3c 2b 1a 70 3c c6 6a 14 04 15
0c 15 04 f4 ff 16 04 ec 03 17 04 06 08 18 04 fc
ff 19 04 01 0f 1a 04 30 01 1b 04 cc ff 1c 04 6f
fe db a4 00
```

Filtered (`streamMode` 2, the default). Example values: accel 8 / -4 / 998 mg, roll 2.50°, pitch -0.48°, heading 33.50°.

<!-- frame:imu-filtered -->
```text
04 01 80 79 0c 4d 3c 2b 1a 70 3c c6 6a 1e 04 08
0c 1f 04 fc ff 20 04 e6 03 21 04 01 07 22 04 ff
ff 23 04 01 10 24 04 2d 01 25 04 ce ff 26 04 70
fe 28 04 fa 0b 29 04 d0 ff 2a 03 16 0d 08 ff 00
```

Both (`streamMode` 3): raw records first, then filtered.

<!-- frame:imu-both -->
```text
04 01 80 79 0c 4d 3c 2b 1a 70 3c c6 6a 14 04 15
0c 15 04 f4 ff 16 04 ec 03 17 04 06 08 18 04 fc
ff 19 04 01 10 1a 04 30 01 1b 04 cc ff 1c 04 6f
fe 1e 04 08 0c 1f 04 fc ff 20 04 e6 03 21 04 01
07 22 04 ff ff 23 04 01 10 24 04 2d 01 25 04 ce
ff 26 04 70 fe 28 04 fa 0b 29 04 d0 ff 2a 03 16
0d 75 63 00
```

---

## 6. ACK (msgType 4)

**When:** one ACK for every COMMAND, on the port the command came from. Match it to your command by `ackSeq`. A command you retry with the same `seq` within 10 s gets the same ACK again and is **not** run twice.

| Tag | Name | Type | Present | Meaning |
|---:|---|---|---|---|
| 242 | `ackSeq` | u16 | always | `seq` of the COMMAND this answers |
| 243 | `ackStatus` | u8 | always | [ackStatus code](INTEGRATION-GUIDE.md#63-ackstatus-codes) |
| 59 | `rejectedTag` | u8 | `ackStatus` ≠ 0 | the command record that failed |
| … | requested data | | `ackStatus` = 0 and the command had `get` | sections 6.1–6.4, in the order of the `get` records |

Ok, nothing requested (the answer to `setTime`, ackSeq 42):

<!-- frame:ack-ok -->
```text
04 01 04 82 0c 4d 3c 2b 1a 70 3c c6 6a f2 03 2a
03 f3 01 03 86 eb 00
```

Error: `InvalidValue` (2) on tag 111 (`imuSampleHz` out of range). Nothing in that command ran:

<!-- frame:ack-error -->
```text
04 01 04 83 0c 4d 3c 2b 1a 70 3c c6 6a f2 03 2c
09 f3 01 02 3b 01 6f c2 22 00
```

Bluetooth session not unlocked yet: `Locked` (9), `rejectedTag` 107 (`unlock`):

<!-- frame:ack-locked -->
```text
04 01 04 88 0c 4d 3c 2b 1a 70 3c c6 6a f2 03 30
09 f3 01 09 3b 01 6b 36 b3 00
```

### 6.1 ACK to get=1 (hour meter)

`ackSeq`, `ackStatus`, then tags **1, 2, 3, 10, 4, 5, 6, 7**, with the same meaning as in the [boot EVENT](#41-boot-eventkind-1).

<!-- frame:ack-get-hour -->
```text
04 01 04 84 0c 4d 3c 2b 1a 70 3c c6 6a f2 03 2b
03 f3 01 06 01 05 20 aa 44 05 02 05 98 3a 01 0c
03 08 01 0a 08 01 04 05 48 e8 01 06 05 05 60 e3
16 0b 06 05 38 3c c6 6a 07 05 2c 03 01 03 04 99
00
```

### 6.2 ACK to get=2 (settings)

`ackSeq`, `ackStatus`, then all 20 settings, tags **110 to 129** in order, with the wire types from [Settings reference](INTEGRATION-GUIDE.md#7-settings-reference). This example has the factory defaults:

| Tag | Name | Type | Default |
|---:|---|---|---:|
| 110 | `telemetryIntervalMs` | u16 | 1000 |
| 111 | `imuSampleHz` | u16 | 100 |
| 112 | `imuStreamHz` | u8 | 10 |
| 113 | `streamMode` | u8 | 2 |
| 114 | `persistIntervalS` | u16 | 60 |
| 115 | `vibrationWindowMs` | u16 | 1000 |
| 116 | `rtcSyncIntervalS` | u16 | 60 |
| 117 | `output` | u8 | 1 |
| 118 | `uartBaud` | u32 | 115200 |
| 119 | `altActiveHigh` | bool | 0 |
| 120 | `altDebounceMs` | u16 | 200 |
| 121 | `pulseRisingEdge` | bool | 0 |
| 122 | `pulseMinIntervalUs` | u16 | 1000 |
| 123 | `pulsesPerUnit` | u16 | 1 |
| 124 | `kalmanQAccel` | f32 | 0.0005 |
| 125 | `kalmanQGyro` | f32 | 0.01 |
| 126 | `kalmanQMag` | f32 | 0.05 |
| 127 | `bluetooth` | bool | 0 |
| 128 | `btPin` | u16 | 1234 |
| 129 | `runVibMinMg` | u16 | 0 |

<!-- frame:ack-get-settings -->
```text
04 01 04 85 0c 4d 3c 2b 1a 70 3c c6 6a f2 03 2d
03 f3 01 08 6e 03 e8 03 6f 03 64 0a 70 01 0a 71
01 02 72 03 3c 08 73 03 e8 03 74 03 3c 06 75 01
01 76 05 03 c2 01 03 77 08 04 78 03 c8 03 79 08
08 7a 03 e8 03 7b 03 01 15 7c 07 6f 12 03 3a 7d
07 0a d7 23 3c 7e 07 cd cc 4c 3d 7f 08 07 80 03
d2 04 81 03 01 03 98 7f 00
```

### 6.3 ACK to get=3 (status)

`ackSeq`, `ackStatus`, then the full status block, **50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 62, 63, 241**, plus **54** when an RTC is fitted, exactly as in the [boot EVENT](#41-boot-eventkind-1).

<!-- frame:ack-get-status -->
```text
04 01 04 86 0c 4d 3c 2b 1a 70 3c c6 6a f2 03 2e
03 f3 01 06 32 08 01 35 05 01 01 01 0b 33 05 70
3c c6 6a 34 05 10 0e 01 06 37 01 0f 38 05 01 01
01 03 39 05 01 01 01 09 3a 01 01 3c 01 01 3d 01
03 3e 01 03 3f 01 03 f1 05 03 06 02 04 36 04 75
03 e9 7a 00
```

### 6.4 ACK to get=4 (calibration)

`ackSeq`, `ackStatus`, then 18 `f32` values and `calFlags`:

| Tags | Name | Unit | Example |
|---|---|---|---|
| 130–132 | `calAccelBiasX/Y/Z` | g | 0.012, -0.004, 0.021 |
| 133–135 | `calGyroBiasX/Y/Z` | °/s | 0.41, -0.22, 0.09 |
| 136–138 | `calAccelNoiseX/Y/Z` | g² | 0.00004, 0.00005, 0.00007 |
| 139–141 | `calGyroNoiseX/Y/Z` | (°/s)² | 0.0021, 0.0019, 0.0024 |
| 142–144 | `calMagOffsetX/Y/Z` | µT | 12.5, -8.25, 31 |
| 145–147 | `calMagScaleX/Y/Z` | – | 1.02, 0.97, 1.01 |
| 148 | `calFlags` (u8) | bits | 3 = IMU and magnetometer calibrated |

<!-- frame:ack-get-calibration -->
```text
04 01 04 87 0c 4d 3c 2b 1a 70 3c c6 6a f2 03 2f
03 f3 01 4b 82 07 a6 9b 44 3c 83 07 6f 12 83 bb
84 07 31 08 ac 3c 85 07 85 eb d1 3e 86 07 ae 47
61 be 87 07 ec 51 b8 3d 88 07 ac c5 27 38 89 07
17 b7 51 38 8a 07 f7 cc 92 38 8b 07 27 a0 09 3b
8c 07 6c 09 f9 3a 8d 07 52 49 1d 3b 8e 07 01 05
48 41 8f 07 01 05 04 c1 90 07 01 1a f8 41 91 07
5c 8f 82 3f 92 07 ec 51 78 3f 93 07 ae 47 81 3f
94 01 03 be e1 00
```

---

## 7. COMMAND (msgType 3, host → device)

Your driver sends these. Set `deviceId` and `timestamp` to 0; the device ignores both. Use a new `seq` for each command and **the same `seq` for a retry**. One COMMAND can carry several records. All records are checked first, and if any is invalid nothing runs ([how commands work](INTEGRATION-GUIDE.md#61-how-commands-work)). These dumps are byte-exact. Any encoder that writes the same records (tag, fmt, value) produces the same bytes.

| Example | Records | Answer |
|---|---|---|
| Set the clock (seq 42) | 100 `setTime` u32 = 1791376496 | [ACK Ok](#6-ack-msgtype-4) |
| Read the hour meter (seq 43) | 101 `get` u8 = 1 | [ACK to get=1](#61-ack-to-get1-hour-meter) |
| Write two settings (seq 44) | 110 `telemetryIntervalMs` u16 = 500, 113 `streamMode` u8 = 0 | ACK Ok, the new values apply at once |
| Preset counters (seq 49) | 102 `setRunSeconds` u32 = 4500000, 103 `setTotalCount` u32 = 0, 101 `get` = 1 | ACK Ok + the new hour meter |
| Reset counters (seq 50) | 104 `resetCounters` u32 = 0x5245534E ("RESN") | ACK Ok; any other value gives `BadMagic` (6) |
| Calibrate the IMU (seq 51) | 105 `calibrate` u8 = 1 | ACK Ok now, then [EVENT kind 2](#42-calibration-done-eventkind-2) |
| Unlock Bluetooth (seq 52) | 107 `unlock` u16 = 1234 | ACK Ok, or `BadPin` (10) / `Locked` (9) |

<!-- frame:cmd-set-time -->
```text
04 01 03 2a 01 01 01 01 01 01 01 01 09 64 05 70
3c c6 6a 05 6a 00
```

<!-- frame:cmd-get-hour -->
```text
04 01 03 2b 01 01 01 01 01 01 01 01 06 65 01 01
80 d7 00
```

<!-- frame:cmd-settings -->
```text
04 01 03 2c 01 01 01 01 01 01 01 01 07 6e 03 f4
01 71 01 03 09 c6 00
```

<!-- frame:cmd-preset -->
```text
04 01 03 31 01 01 01 01 01 01 01 01 06 66 05 20
aa 44 03 67 05 01 01 01 06 65 01 01 ff b4 00
```

<!-- frame:cmd-reset -->
```text
04 01 03 32 01 01 01 01 01 01 01 01 09 68 05 4e
53 45 52 10 93 00
```

<!-- frame:cmd-calibrate -->
```text
04 01 03 33 01 01 01 01 01 01 01 01 06 69 01 01
0f bf 00
```

<!-- frame:cmd-unlock -->
```text
04 01 03 34 01 01 01 01 01 01 01 01 07 6b 03 d2
04 ca aa 00
```

The run of `01` bytes is COBS encoding the zero `deviceId` and `timestamp`.

---

## 8. Frame sizes

Packet sizes from "fewest optional records" to "all of them". On the wire, add 2 bytes: 1 for COBS and 1 for the delimiter.

| Frame | Packet | On the wire |
|---|---:|---:|
| TELEMETRY | 50–70 | 52–72 |
| EVENT boot | 107–111 | 109–113 |
| EVENT calibration done | 23–134 | 25–136 |
| EVENT modules changed | 68–72 | 70–74 |
| IMU stream (raw / filtered / both) | ≤ 50 / ≤ 62 / ≤ 98 | ≤ 52 / ≤ 64 / ≤ 100 |
| ACK | 21–24, up to 132 with `get=4` | 23–26, up to 134 |
| Largest possible (SensorFrame limit) | 250 | 252 |

A **256-byte receive buffer** per frame is enough for anything this device sends.

Several `get` records in one COMMAND share one ACK. The groups add 42 (`get=1`), 82 (`get=2`), 55 (`get=3`) and 111 (`get=4`) bytes to the 21-byte ACK, and the total must stay within 250 bytes. For example `get=1` + `get=2` + `get=3` (200) fits, but `get=1` + `get=2` + `get=4` (256), `get=2` + `get=3` + `get=4` (269) and all four (311) do not. The device then **cuts the last group short** without an error, so split such requests over two commands.
