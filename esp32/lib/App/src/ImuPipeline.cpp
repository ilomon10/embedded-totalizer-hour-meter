// ImuPipeline.cpp — see header.
#include "ImuPipeline.h"

#include <math.h>

#include "Orientation.h"

namespace {
float axis(const Vec3& v, int i) { return i == 0 ? v.x : (i == 1 ? v.y : v.z); }
bool sameVec(const Vec3& a, const Vec3& b) { return a.x == b.x && a.y == b.y && a.z == b.z; }
Vec3 minEach(const Vec3& a, const Vec3& b) { return vec3(fminf(a.x, b.x), fminf(a.y, b.y), fminf(a.z, b.z)); }
Vec3 maxEach(const Vec3& a, const Vec3& b) { return vec3(fmaxf(a.x, b.x), fmaxf(a.y, b.y), fmaxf(a.z, b.z)); }
}  // namespace

void ImuPipeline::configure(const Settings& s) {
  settings_ = s;
  const Calibration& c = s.cal;
  for (int i = 0; i < 3; i++) {
    accelKf_[i].setNoise(s.kalmanQAccel, axis(c.accelNoiseVar, i));
    gyroKf_[i].setNoise(s.kalmanQGyro, axis(c.gyroNoiseVar, i));
    magKf_[i].setNoise(s.kalmanQMag, kMagNoiseVar);
  }
  const float hz = static_cast<float>(s.imuSampleHz);
  const uint32_t sampleHz = s.imuSampleHz;
  const uint32_t windowMs = s.vibrationWindowMs;
  const uint32_t window = sampleHz * windowMs / 1000U;
  vibMeter_.configure(hz, window == 0 ? 1 : window);
  hasVibration_ = false;
}

void ImuPipeline::process(const ImuSample& sample, bool newMag, const Vec3& magUt, float dtS) {
  updateHealth(sample);
  if (newMag) {
    lastRawMag_ = magUt;
    haveMag_ = true;
  }
  if (calibKind_ != 0) {
    collectCalibration(sample, newMag, magUt);
  }
  updateFilters(sample, dtS);

  const Vec3 accelCorrected = sample.accelG - settings_.cal.accelBiasG;
  VibrationLevel v;
  if (vibMeter_.add(accelCorrected, v)) {
    vibration_ = v;
    hasVibration_ = true;
  }
}

void ImuPipeline::updateHealth(const ImuSample& s) {
  if (s.saturated) {
    saturatedLatch_ = true;
  }
  const bool same = sameVec(s.accelG, previous_.accelG) && sameVec(s.gyroDps, previous_.gyroDps);
  identicalCount_ = same ? identicalCount_ + 1 : 0;
  stuck_ = identicalCount_ >= kStuckSamples;
  previous_ = s;
}

void ImuPipeline::updateFilters(const ImuSample& s, float dtS) {
  const Calibration& c = settings_.cal;
  const Vec3 a = s.accelG - c.accelBiasG;
  const Vec3 g = s.gyroDps - c.gyroBiasDps;
  out_.rawAccelG = s.accelG;
  out_.rawGyroDps = s.gyroDps;
  out_.accelG = vec3(accelKf_[0].update(a.x), accelKf_[1].update(a.y), accelKf_[2].update(a.z));
  out_.gyroDps = vec3(gyroKf_[0].update(g.x), gyroKf_[1].update(g.y), gyroKf_[2].update(g.z));

  // Roll/pitch from bias-corrected accel + gyro (not the smoothed accel: avoids double lag).
  const float accRoll = orientation::rollDeg(a);
  if (fabsf(accRoll - rollKf_.angle()) > 180.0f) {
    rollKf_.reset(accRoll);  // crossed the +-180 seam: restart instead of spinning through
  }
  out_.rollDeg = rollKf_.update(accRoll, g.x, dtS);
  // Pitch is nose-up positive; a right-handed rate about +y lowers the nose, hence -g.y.
  out_.pitchDeg = pitchKf_.update(orientation::pitchDeg(a), -g.y, dtS);

  out_.hasMag = haveMag_;
  out_.headingValid = false;
  if (haveMag_) {
    const Vec3 m = compass::applyCalibration(lastRawMag_, c.mag);
    out_.rawMagUt = lastRawMag_;
    out_.magUt = vec3(magKf_[0].update(m.x), magKf_[1].update(m.y), magKf_[2].update(m.z));
    float heading = 0.0f;
    out_.headingValid =
        compass::headingDeg(out_.magUt, orientation::upVector(out_.rollDeg, out_.pitchDeg), heading);
    out_.headingDeg = heading;
  }
}

AckStatus ImuPipeline::startCalibration(CalibKind kind, uint32_t nowMs, bool hasMag) {
  if (calibKind_ != 0) {
    return AckStatus::Busy;
  }
  if (kind == CalibKind::Magnetometer && !hasMag) {
    return AckStatus::Unsupported;
  }
  if (kind != CalibKind::ImuAtRest && kind != CalibKind::Magnetometer) {
    return AckStatus::InvalidValue;
  }
  calibKind_ = static_cast<uint8_t>(kind);
  calibStartMs_ = nowMs;
  accelStats_.reset();
  gyroStats_.reset();
  magSamples_ = 0;
  return AckStatus::Ok;
}

void ImuPipeline::collectCalibration(const ImuSample& s, bool newMag, const Vec3& magUt) {
  if (calibKind_ == static_cast<uint8_t>(CalibKind::ImuAtRest)) {
    if (accelStats_.count() < kImuCalibSamples) {
      accelStats_.add(s.accelG);
      gyroStats_.add(s.gyroDps);
    }
    return;
  }
  if (newMag) {
    magMin_ = (magSamples_ == 0) ? magUt : minEach(magMin_, magUt);
    magMax_ = (magSamples_ == 0) ? magUt : maxEach(magMax_, magUt);
    magSamples_++;
  }
}

bool ImuPipeline::pollCalibration(uint32_t nowMs, CalibKind& kind, AckStatus& result, Calibration& updated) {
  if (calibKind_ == 0) {
    return false;
  }
  const uint32_t elapsed = nowMs - calibStartMs_;
  kind = static_cast<CalibKind>(calibKind_);
  updated = settings_.cal;
  if (kind == CalibKind::ImuAtRest) {
    if (accelStats_.count() >= kImuCalibSamples) {
      result = finishImuCalibration(updated);
    } else if (elapsed > kImuCalibTimeoutMs) {
      result = AckStatus::Failed;  // no samples arriving
    } else {
      return false;
    }
  } else {
    if (elapsed < kMagCalibDurationMs) {
      return false;
    }
    result = finishMagCalibration(updated);
  }
  calibKind_ = 0;
  return true;
}

AckStatus ImuPipeline::finishImuCalibration(Calibration& c) const {
  const Vec3 accelMean = accelStats_.mean();
  const Vec3 gyroVar = gyroStats_.variance();
  // Board must lie flat, z up, and stay still.
  const bool flat = accelMean.z > 0.9f && accelMean.z < 1.1f && fabsf(accelMean.x) < 0.1f && fabsf(accelMean.y) < 0.1f;
  const bool still = gyroVar.x < 1.0f && gyroVar.y < 1.0f && gyroVar.z < 1.0f;
  if (!flat || !still) {
    return AckStatus::Failed;
  }
  c.accelBiasG = accelMean - vec3(0.0f, 0.0f, 1.0f);
  c.gyroBiasDps = gyroStats_.mean();
  c.accelNoiseVar = accelStats_.variance();
  c.gyroNoiseVar = gyroVar;
  c.flags |= calib_flags::kImu;
  return AckStatus::Ok;
}

AckStatus ImuPipeline::finishMagCalibration(Calibration& c) const {
  MagCalibration mag;
  if (magSamples_ < 100 || !compass::calibrationFromMinMax(magMin_, magMax_, kMagMinSpanUt, mag)) {
    return AckStatus::Failed;  // not rotated enough in every direction
  }
  c.mag = mag;
  c.flags |= calib_flags::kMag;
  return AckStatus::Ok;
}
