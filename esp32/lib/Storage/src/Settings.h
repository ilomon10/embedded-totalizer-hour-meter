// Settings.h — everything the user can configure, plus sensor calibration.
//
// TS mental model: `interface Settings { telemetryIntervalMs: number; ... }`
// with `defaultSettings()` as the default object and `validateSettings()` as
// the schema check. Ranges live in ONE table (settingsSchema in SettingsSchema.h)
// so firmware, docs and the command handler agree.
#pragma once

#include <stdint.h>

#include "Compass.h"
#include "Vec3.h"

enum class OutputPort : uint8_t { Usb = 1, Uart = 2, Both = 3 };
enum class StreamMode : uint8_t { Off = 0, Raw = 1, Filtered = 2, Both = 3 };

namespace calib_flags {
constexpr uint8_t kImu = 0x01;  // accel/gyro bias + noise measured
constexpr uint8_t kMag = 0x02;  // hard/soft iron measured
}  // namespace calib_flags

struct Calibration {
  Vec3 accelBiasG;
  Vec3 gyroBiasDps;
  Vec3 accelNoiseVar;  // g^2      -> Kalman R for accel
  Vec3 gyroNoiseVar;   // (deg/s)^2 -> Kalman R for gyro
  MagCalibration mag;
  uint8_t flags = 0;
  uint8_t reserved[3] = {0, 0, 0};
};

// The part of Settings stored byte for byte in EEPROM. Its layout is frozen:
// the 128-byte settings slot is full, so it can't grow (see SettingsRecord).
struct StoredSettings {
  // Event timing
  uint16_t telemetryIntervalMs;
  uint16_t imuSampleHz;
  uint16_t persistIntervalS;
  uint16_t vibrationWindowMs;
  uint16_t rtcSyncIntervalS;
  uint8_t imuStreamHz;  // 0 = stream off
  uint8_t streamMode;   // StreamMode
  // Serial output
  uint8_t output;       // OutputPort
  // Alternator input
  uint8_t altActiveHigh;  // 1 = HIGH means running
  uint16_t altDebounceMs;
  uint32_t baud;
  // Pulse (totalizer) input
  uint8_t pulseRisingEdge;  // 1 = count rising edges, 0 = falling
  uint8_t bluetooth;        // 1 = Bluetooth SPP on (off by default)
  uint16_t pulseMinIntervalUs;  // debounce: ignore edges closer than this
  uint16_t pulsesPerUnit;       // e.g. pulses per litre
  uint16_t btPin;               // 0..9999, unlocks a Bluetooth session
  // Filter tuning (Kalman process noise Q)
  float kalmanQAccel;
  float kalmanQGyro;
  float kalmanQMag;
  // Sensor calibration (written by the calibrate command)
  Calibration cal;
};

static_assert(sizeof(StoredSettings) == 116, "StoredSettings layout changed: bump SettingsStore::kVersion and docs");

// Everything the user can configure. Fields beyond StoredSettings live in bytes
// of SettingsRecord that older firmware kept reserved and wrote as 0, so 0 must
// mean "off / old behaviour" for each of them.
struct Settings : StoredSettings {
  // Engine-running confirmation: count run time only while the IMU vibration RMS
  // is at least this (mg). 0 = off (the alternator input alone decides).
  uint16_t runVibMinMg;
};

Settings defaultSettings();

// Every field equal: the frozen StoredSettings bytes (no padding inside) and the newer fields.
bool sameSettings(const Settings& a, const Settings& b);
