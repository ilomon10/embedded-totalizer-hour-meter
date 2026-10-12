// RunningStats.h — mean and variance without storing samples (Welford's method).
//
// Used by calibration: feed 512 samples at rest, read mean (= sensor bias)
// and variance (= sensor noise, the Kalman R). Memory: three numbers, not 512.
#pragma once

#include <stdint.h>

#include "Vec3.h"

class RunningStats3 {
 public:
  void reset() {
    n_ = 0;
    mean_ = vec3(0, 0, 0);
    m2_ = vec3(0, 0, 0);
  }

  void add(const Vec3& v) {
    n_++;
    const Vec3 d = v - mean_;
    mean_ = mean_ + d * (1.0f / static_cast<float>(n_));
    m2_ = m2_ + mulEach(d, v - mean_);
  }

  uint32_t count() const { return n_; }
  Vec3 mean() const { return mean_; }
  Vec3 variance() const { return n_ > 1 ? m2_ * (1.0f / static_cast<float>(n_ - 1)) : vec3(0, 0, 0); }

 private:
  uint32_t n_ = 0;
  Vec3 mean_;
  Vec3 m2_;
};
