// Vibration.h — engine vibration level from the accelerometer.
//
// 1. Remove gravity with a slow low-pass "gravity tracker" per axis
//    (what remains is the dynamic part: vibration + motion).
// 2. Over a window (e.g. 1 s) compute RMS and peak of |dynamic accel|.
// RMS ~ overall vibration energy (trend it for engine health);
// peak ~ knocks and impacts. Output in milli-g.
#pragma once

#include <math.h>
#include <stdint.h>

#include "Vec3.h"

struct VibrationLevel {
  float rmsMg = 0.0f;
  float peakMg = 0.0f;
};

class VibrationMeter {
 public:
  static constexpr float kGravityCutoffHz = 0.5f;

  // windowSamples: samples per result (sampleHz * windowMs / 1000), >= 1.
  void configure(float sampleHz, uint32_t windowSamples) {
    const float dt = 1.0f / (sampleHz > 0.0f ? sampleHz : 100.0f);
    const float rc = 1.0f / (2.0f * 3.14159265f * kGravityCutoffHz);
    alpha_ = dt / (rc + dt);
    window_ = (windowSamples == 0) ? 1 : windowSamples;
    count_ = 0;
    sumSq_ = 0.0f;
    peak_ = 0.0f;
  }

  // Feed one sample (g). Returns true when a window completed; result in `out`.
  bool add(const Vec3& accelG, VibrationLevel& out) {
    if (!gravityInit_) {
      gravity_ = accelG;
      gravityInit_ = true;
    }
    gravity_ = gravity_ + (accelG - gravity_) * alpha_;
    const float mg = length(accelG - gravity_) * 1000.0f;
    sumSq_ += mg * mg;
    peak_ = (mg > peak_) ? mg : peak_;
    count_++;
    if (count_ < window_) {
      return false;
    }
    out.rmsMg = sqrtf(sumSq_ / static_cast<float>(count_));
    out.peakMg = peak_;
    count_ = 0;
    sumSq_ = 0.0f;
    peak_ = 0.0f;
    return true;
  }

 private:
  float alpha_ = 0.03f;
  uint32_t window_ = 100;
  uint32_t count_ = 0;
  float sumSq_ = 0.0f;
  float peak_ = 0.0f;
  Vec3 gravity_;
  bool gravityInit_ = false;
};
