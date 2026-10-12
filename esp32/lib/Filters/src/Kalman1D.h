// Kalman1D.h — scalar Kalman filter for smoothing one noisy signal.
//
// Model: the true value changes slowly (random walk). Two knobs:
//   R = measurement noise variance  (measured during calibration: sensor noise)
//   Q = process noise variance      (how fast the real value may change; tune)
// Bigger Q/R ratio -> follows changes faster, smooths less.
//
// It only keeps two numbers (estimate x and its variance p): no sample
// history is stored anywhere. TS mental model:
//   update(z) { p += q; const k = p / (p + r); x += k * (z - x); p *= 1 - k; return x; }
#pragma once

class Kalman1D {
 public:
  Kalman1D(float q = 0.001f, float r = 0.01f) : q_(q), r_(r) {}

  void setNoise(float q, float r) {
    q_ = (q > 0.0f) ? q : 1e-9f;
    r_ = (r > 0.0f) ? r : 1e-9f;
  }

  float update(float z) {
    if (!initialized_) {
      x_ = z;  // first sample: trust it, uncertainty = sensor noise
      p_ = r_;
      initialized_ = true;
      return x_;
    }
    p_ += q_;
    const float k = p_ / (p_ + r_);
    x_ += k * (z - x_);
    p_ *= (1.0f - k);
    return x_;
  }

  void reset() { initialized_ = false; }
  float value() const { return x_; }
  float variance() const { return p_; }

 private:
  float q_;
  float r_;
  float x_ = 0.0f;
  float p_ = 1.0f;
  bool initialized_ = false;
};
