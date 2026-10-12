// KalmanAngle.h — 2-state Kalman filter fusing an accelerometer angle with a
// gyro rate (the classic roll/pitch estimator).
//
// Why fuse? The accelerometer angle is right on average but noisy and is
// disturbed by vibration; the gyro is smooth but drifts. State = [angle, gyroBias]:
//   predict: angle += (rate - bias) * dt          (gyro, smooth)
//   correct: angle  -> pulled toward accelAngle   (accelerometer, drift-free)
// The filter also learns the gyro bias online.
#pragma once

#include <math.h>

class KalmanAngle {
 public:
  // Defaults are the widely used values for MPU-class sensors.
  float qAngle = 0.001f;   // process noise: angle
  float qBias = 0.003f;    // process noise: gyro bias
  float rMeasure = 0.03f;  // measurement noise: accelerometer angle (deg^2)

  // All angles in degrees, rate in deg/s, dt in seconds. Returns the new angle.
  float update(float accelAngleDeg, float gyroRateDps, float dt) {
    if (!initialized_ || !(dt > 0.0f) || dt > 1.0f) {
      reset(accelAngleDeg);  // first sample or a time gap too big to integrate
      return angle_;
    }
    // Predict.
    const float rate = gyroRateDps - bias_;
    angle_ += dt * rate;
    p_[0][0] += dt * (dt * p_[1][1] - p_[0][1] - p_[1][0] + qAngle);
    p_[0][1] -= dt * p_[1][1];
    p_[1][0] -= dt * p_[1][1];
    p_[1][1] += qBias * dt;
    // Correct.
    const float s = p_[0][0] + rMeasure;
    const float k0 = p_[0][0] / s;
    const float k1 = p_[1][0] / s;
    const float y = accelAngleDeg - angle_;
    angle_ += k0 * y;
    bias_ += k1 * y;
    const float p00 = p_[0][0];
    const float p01 = p_[0][1];
    p_[0][0] -= k0 * p00;
    p_[0][1] -= k0 * p01;
    p_[1][0] -= k1 * p00;
    p_[1][1] -= k1 * p01;
    return angle_;
  }

  void reset(float angleDeg) {
    angle_ = angleDeg;
    bias_ = 0.0f;
    p_[0][0] = p_[0][1] = p_[1][0] = p_[1][1] = 0.0f;
    initialized_ = true;
  }

  float angle() const { return angle_; }
  float bias() const { return bias_; }

 private:
  float angle_ = 0.0f;
  float bias_ = 0.0f;
  float p_[2][2] = {{0.0f, 0.0f}, {0.0f, 0.0f}};
  bool initialized_ = false;
};
