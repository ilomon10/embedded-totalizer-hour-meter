// ImuPipeline.h — turns raw MPU9250 samples into useful numbers.
//
//   raw sample ─┬─ minus bias (calibration) ─ Kalman1D per axis ──> filtered accel/gyro/mag
//               ├─ KalmanAngle(accel angle, gyro rate) ───────────> roll, pitch
//               ├─ compass(filtered mag, up from roll/pitch) ─────> heading
//               └─ VibrationMeter(bias-corrected RAW accel) ──────> vibration RMS / peak
//
// Vibration deliberately uses the unfiltered signal: a Kalman filter would
// smooth away exactly the vibration we want to measure.
//
// Also runs the calibration routines (no sample storage; running statistics only)
// and watches sensor health (stuck / saturated).
#pragma once

#include <stdint.h>

#include "Compass.h"
#include "Kalman1D.h"
#include "KalmanAngle.h"
#include "Mpu9250.h"
#include "Protocol.h"
#include "RunningStats.h"
#include "Settings.h"
#include "Vibration.h"

struct ImuOutput {
  Vec3 rawAccelG, rawGyroDps, rawMagUt;   // as read from the chip
  Vec3 accelG, gyroDps, magUt;            // calibrated + Kalman filtered
  bool hasMag = false;
  float rollDeg = 0, pitchDeg = 0, headingDeg = 0;
  bool headingValid = false;
};

class ImuPipeline {
 public:
  static constexpr uint32_t kImuCalibSamples = 512;
  static constexpr uint32_t kImuCalibTimeoutMs = 20000;
  static constexpr uint32_t kMagCalibDurationMs = 20000;
  static constexpr float kMagMinSpanUt = 20.0f;      // each axis must swing at least this much
  static constexpr float kMagNoiseVar = 0.36f;       // uT^2 (AK8963 ~0.6 uT rms)
  static constexpr uint32_t kStuckSamples = 100;     // identical samples => sensor stuck

  // Apply settings (Kalman Q, vibration window) and calibration (bias, R).
  void configure(const Settings& s);

  // Feed one sample. `newMag` false => keep the previous magnetometer value.
  void process(const ImuSample& sample, bool newMag, const Vec3& magUt, float dtS);

  const ImuOutput& output() const { return out_; }

  // Vibration result of the last completed window.
  bool hasVibration() const { return hasVibration_; }
  const VibrationLevel& vibration() const { return vibration_; }

  // Health.
  bool stuck() const { return stuck_; }
  bool saturatedSinceLastCheck() {
    const bool s = saturatedLatch_;
    saturatedLatch_ = false;
    return s;
  }

  // Calibration. Start returns Busy/Unsupported; poll returns true once finished.
  AckStatus startCalibration(CalibKind kind, uint32_t nowMs, bool hasMag);
  bool calibrating() const { return calibKind_ != 0; }
  bool pollCalibration(uint32_t nowMs, CalibKind& kind, AckStatus& result, Calibration& updated);

 private:
  Settings settings_{};
  Kalman1D accelKf_[3], gyroKf_[3], magKf_[3];
  KalmanAngle rollKf_, pitchKf_;
  VibrationMeter vibMeter_;
  VibrationLevel vibration_;
  bool hasVibration_ = false;
  ImuOutput out_;
  Vec3 lastRawMag_;
  bool haveMag_ = false;

  // Health.
  ImuSample previous_;
  uint32_t identicalCount_ = 0;
  bool stuck_ = false;
  bool saturatedLatch_ = false;

  // Calibration state (0 = idle, else CalibKind value).
  uint8_t calibKind_ = 0;
  uint32_t calibStartMs_ = 0;
  RunningStats3 accelStats_, gyroStats_;
  Vec3 magMin_, magMax_;
  uint32_t magSamples_ = 0;

  void updateHealth(const ImuSample& s);
  void updateFilters(const ImuSample& s, float dtS);
  void collectCalibration(const ImuSample& s, bool newMag, const Vec3& magUt);
  AckStatus finishImuCalibration(Calibration& c) const;
  AckStatus finishMagCalibration(Calibration& c) const;
};
