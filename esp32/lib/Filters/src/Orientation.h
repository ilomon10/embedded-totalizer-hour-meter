// Orientation.h — roll/pitch from gravity, and the "up" vector from roll/pitch.
//
// Frame: MPU9250 axes, right-handed, z up when the board lies flat
// (a resting accelerometer reads +1 g on z).
#pragma once

#include <math.h>

#include "Vec3.h"

namespace orientation {

constexpr float kRadToDeg = 57.29577951308232f;
constexpr float kDegToRad = 0.017453292519943295f;

// Roll: rotation about x. Range -180..180 deg.
inline float rollDeg(const Vec3& accelG) { return atan2f(accelG.y, accelG.z) * kRadToDeg; }

// Pitch: rotation about y, nose up positive. Range -90..90 deg.
inline float pitchDeg(const Vec3& accelG) {
  return atan2f(-accelG.x, sqrtf(accelG.y * accelG.y + accelG.z * accelG.z)) * kRadToDeg;
}

// Unit "up" vector in the board frame for a given roll/pitch (inverse of the above).
inline Vec3 upVector(float rollDegrees, float pitchDegrees) {
  const float r = rollDegrees * kDegToRad;
  const float p = pitchDegrees * kDegToRad;
  return vec3(-sinf(p), cosf(p) * sinf(r), cosf(p) * cosf(r));
}

}  // namespace orientation
