// Protocol.h — every SensorFrame tag and code this device uses.
//
// SINGLE SOURCE OF TRUTH. Mirrored in configurator/src/tags.ts and documented in
// docs/INTEGRATION-GUIDE.md; scripts/check-docs.ts fails if they disagree.
// Rules: never reuse a number for a different meaning; only add.
#pragma once

#include <stdint.h>

#include "SensorFrame.h"

// One writer size for every frame we send (SensorFrame maximum).
using FrameWriter = SensorFrameWriter<SF_MAX_PACKET>;

constexpr uint32_t kFirmwareVersion = 0x00020600;  // 0x00MMmmpp -> 2.6.0

namespace msg {
constexpr uint8_t kTelemetry = SF_MSG_TELEMETRY;  // 1: periodic hour meter + status
constexpr uint8_t kEvent = SF_MSG_EVENT;          // 2: boot, calibration finished, module plugged/unplugged
constexpr uint8_t kCommand = SF_MSG_COMMAND;      // 3: host -> device
constexpr uint8_t kAck = SF_MSG_ACK;              // 4: device reply to a command
constexpr uint8_t kImuStream = 128;               // IMU samples (raw / filtered)
}  // namespace msg

namespace tag {
// --- Hour meter 1..10 ---
constexpr uint8_t kRunSeconds = 1;      // u32  s
constexpr uint8_t kTotalCount = 2;      // u32  pulses
constexpr uint8_t kAlternator = 3;      // bool running now
constexpr uint8_t kRunHours = 4;        // u32  x0.01 h
constexpr uint8_t kTotalUnits = 5;      // u32  x0.01 unit (pulses / pulsesPerUnit)
constexpr uint8_t kLastSavedEpoch = 6;  // u32  UTC s
constexpr uint8_t kJournalSeq = 7;      // u32
constexpr uint8_t kEventKind = 8;       // u8   EventKind
constexpr uint8_t kCalibResult = 9;     // u8   AckStatus of a finished calibration
constexpr uint8_t kAltInput = 10;       // bool engine-running input active (before vibration confirmation)
// --- IMU raw 20..28 / filtered 30..38 (accel mg, gyro 0.1 deg/s, mag 0.1 uT; all i16) ---
constexpr uint8_t kRawAccelX = 20;
constexpr uint8_t kRawGyroX = 23;
constexpr uint8_t kRawMagX = 26;
constexpr uint8_t kFiltAccelX = 30;
constexpr uint8_t kFiltGyroX = 33;
constexpr uint8_t kFiltMagX = 36;
// --- Derived 40..45 ---
constexpr uint8_t kRoll = 40;     // i16 x0.01 deg
constexpr uint8_t kPitch = 41;    // i16 x0.01 deg
constexpr uint8_t kHeading = 42;  // u16 x0.01 deg, 0 = magnetic north, clockwise
constexpr uint8_t kVibRms = 43;   // u16 mg
constexpr uint8_t kVibPeak = 44;  // u16 mg
constexpr uint8_t kSpeed = 45;    // RESERVED: needs a speed sensor or GPS (not from IMU)
// --- Status 50..63 ---
constexpr uint8_t kTimeValid = 50;      // bool RTC time trustworthy
constexpr uint8_t kEpoch = 51;          // u32  UTC s
constexpr uint8_t kUptime = 52;         // u32  s since boot
constexpr uint8_t kStatusFlags = 53;    // u32  StatusFlag bits
constexpr uint8_t kRtcTemp = 54;        // i16  x0.25 C
constexpr uint8_t kDevices = 55;        // u8   DeviceBit mask
constexpr uint8_t kI2cErrors = 56;      // u32
constexpr uint8_t kOverruns = 57;       // u32  scheduler overruns
constexpr uint8_t kResetReason = 58;    // u8   ESP32 esp_reset_reason_t
constexpr uint8_t kRejectedTag = 59;    // u8   which tag made a command fail
constexpr uint8_t kSettingsSource = 60; // u8   0 defaults, 1/2 EEPROM copy A/B, 3/4 flash copy A/B
constexpr uint8_t kBtState = 61;        // u8   0 off, 1 on (no client), 2 client locked, 3 client unlocked
constexpr uint8_t kLastCause = 62;      // u8   LastCause: why the device restarted last time
constexpr uint8_t kLastStage = 63;      // u8   Stage: what it was doing when it restarted
// --- Commands 100..106 (host -> device) ---
constexpr uint8_t kCmdSetTime = 100;       // u32 UTC epoch
constexpr uint8_t kCmdGet = 101;           // u8  GetWhat
constexpr uint8_t kCmdSetRunSeconds = 102; // u32
constexpr uint8_t kCmdSetTotalCount = 103; // u32
constexpr uint8_t kCmdResetCounters = 104; // u32 must equal kResetMagic
constexpr uint8_t kCmdCalibrate = 105;     // u8  CalibKind
constexpr uint8_t kCmdReboot = 106;        // any value
constexpr uint8_t kCmdUnlock = 107;        // u16 PIN: unlocks a Bluetooth session (no-op on wired ports)
// --- Settings 110..129 (see SettingsSchema.cpp for ranges) ---
constexpr uint8_t kSettingFirst = 110;
constexpr uint8_t kSettingLast = 129;
// --- Calibration 130..148 (read-only, f32 unless noted) ---
constexpr uint8_t kCalAccelBiasX = 130;  // g
constexpr uint8_t kCalGyroBiasX = 133;   // deg/s
constexpr uint8_t kCalAccelNoiseX = 136; // g^2
constexpr uint8_t kCalGyroNoiseX = 139;  // (deg/s)^2
constexpr uint8_t kCalMagOffsetX = 142;  // uT
constexpr uint8_t kCalMagScaleX = 145;   // unitless
constexpr uint8_t kCalFlags = 148;       // u8 calib_flags
// --- Reserved by SensorFrame ---
constexpr uint8_t kFwVersion = SF_TAG_FW_VERSION;  // 241 u32
constexpr uint8_t kAckSeq = SF_TAG_ACK_SEQ;        // 242 u16
constexpr uint8_t kAckStatus = SF_TAG_ACK_STATUS;  // 243 u8
}  // namespace tag

constexpr uint32_t kResetMagic = 0x5245534E;  // "RESN": prevents accidental counter resets

enum class GetWhat : uint8_t { HourMeter = 1, Settings = 2, Status = 3, Calibration = 4 };
enum class CalibKind : uint8_t { ImuAtRest = 1, Magnetometer = 2 };
enum class EventKind : uint8_t { Boot = 1, CalibrationDone = 2, DevicesChanged = 3 };

// Why the previous run ended (tag 62). Decided at boot from esp_reset_reason()
// and the cause the firmware recorded just before restarting on purpose.
enum class LastCause : uint8_t {
  None = 0,           // power-on, brown-out, or nothing to report
  Watchdog = 1,       // loop() stalled for kWatchdogTimeoutS (see lastStage for where)
  I2cStuck = 2,       // the I2C bus kept failing for 30 s, even after bus recovery
  UsbStalled = 3,     // the USB serial TX buffer did not drain for 10 s
  PanicSignal = 4,    // a host sent the panic signal (64 zero bytes on USB / UART pins)
  RebootCommand = 5,  // the reboot command (tag 106)
  Crash = 6,          // a firmware exception (panic handler)
};

// What the firmware was doing when the previous run ended (tag 63). A breadcrumb
// written before each step that talks to hardware; most useful after a Watchdog.
enum class Stage : uint8_t {
  Unknown = 0,       // power-on: no previous run
  Boot = 1,          // setup() started
  UsbOpen = 2,       // opening the USB serial port
  I2cInit = 3,       // starting the I2C bus (bus recovery)
  Eeprom = 4,        // EEPROM: attach, format, settings, journal
  UartOpen = 5,      // opening the UART pins / Bluetooth
  Rtc = 6,           // RTC: attach or time sync
  Imu = 7,           // IMU: attach or sample read
  Serial = 8,        // reading serial links / running a command
  Inputs = 9,        // alternator + pulse inputs, saving counters
  Telemetry = 10,    // building and sending frames
  Presence = 11,     // hot-plug check of the I2C modules
  Flash = 12,        // settings + counters in the ESP32's own flash: read, compare with the EEPROM, save
};

// The panic signal: this many 0x00 bytes in a row on a wired port restarts the
// device without any frame or ACK. COBS frames contain 0x00 only as a single
// delimiter, so normal traffic never looks like this.
constexpr uint8_t kPanicZeroRun = 64;

// ackStatus values (also used for calibResult).
enum class AckStatus : uint8_t {
  Ok = 0,
  UnknownTag = 1,     // tag not a command or setting; see rejectedTag
  InvalidValue = 2,   // out of range / wrong type; see rejectedTag
  StorageError = 3,   // saving failed: no store (flash, EEPROM) kept the value
  DeviceMissing = 4,  // RTC / IMU not present
  Busy = 5,           // calibration already running
  BadMagic = 6,       // resetCounters without the magic value
  Unsupported = 7,    // e.g. mag calibration on a board without magnetometer
  Failed = 8,         // other error (e.g. calibration: board moved / not rotated enough)
  Locked = 9,         // Bluetooth session locked: send unlock with the PIN first (or wait out a lockout)
  BadPin = 10,        // unlock with a wrong PIN
};

namespace status_flag {
constexpr uint32_t kEepromMissing = 1u << 0;
constexpr uint32_t kRtcMissing = 1u << 1;
constexpr uint32_t kTimeInvalid = 1u << 2;
constexpr uint32_t kImuMissing = 1u << 3;
constexpr uint32_t kMagMissing = 1u << 4;
constexpr uint32_t kImuNotCalibrated = 1u << 5;
constexpr uint32_t kMagNotCalibrated = 1u << 6;
constexpr uint32_t kSettingsDefaults = 1u << 7;
constexpr uint32_t kJournalEmpty = 1u << 8;
constexpr uint32_t kStorageError = 1u << 9;
constexpr uint32_t kImuStuck = 1u << 10;
constexpr uint32_t kImuSaturated = 1u << 11;
constexpr uint32_t kI2cErrors = 1u << 12;
constexpr uint32_t kEepromFormatted = 1u << 13;
constexpr uint32_t kCalibrating = 1u << 14;
constexpr uint32_t kRtcBatteryLost = 1u << 15;   // RTC lost a previously set time over power-off: no/flat battery
constexpr uint32_t kTimeNotBackedUp = 1u << 16;  // time valid in RAM only (no RTC / RTC not writable): lost at reboot
constexpr uint32_t kSettingsNotSaved = 1u << 17; // settings changed with no store (no flash, no EEPROM): RAM only until one appears
constexpr uint32_t kSafeMode = 1u << 18;         // 3 unplanned restarts in a row: I2C is skipped until the next reboot
constexpr uint32_t kFlashStoreMissing = 1u << 19; // no "hmdata" partition (old partition table): the EEPROM is the only store
}  // namespace status_flag

namespace device_bit {
constexpr uint8_t kEeprom = 0x01;
constexpr uint8_t kRtc = 0x02;
constexpr uint8_t kImu = 0x04;
constexpr uint8_t kMag = 0x08;
}  // namespace device_bit
