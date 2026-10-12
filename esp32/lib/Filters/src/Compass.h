// Compass.h — magnetometer calibration + tilt-compensated heading.
//
// Calibration removes two distortions caused by nearby metal and electronics:
//   hard iron = constant offset (magnets, steel)  -> subtract `offset`
//   soft iron = axes stretched unevenly           -> multiply by `scale`
//
// Heading uses vectors instead of angle formulas (no sign-convention traps):
//   east  = normalize(mag x up)      (the vertical part of the field drops out)
//   north = up x east
//   heading = atan2(east.x, north.x) -> angle of the board's x axis from north
// Result: 0..360 deg, clockwise, 0 = magnetic north, 90 = east.
#pragma once

#include <math.h>

#include "Orientation.h"
#include "Vec3.h"

struct MagCalibration {
  Vec3 offset = vec3(0.0f, 0.0f, 0.0f);  // uT
  Vec3 scale = vec3(1.0f, 1.0f, 1.0f);   // unitless
};

namespace compass {

inline Vec3 applyCalibration(const Vec3& rawUt, const MagCalibration& cal) {
  return mulEach(rawUt - cal.offset, cal.scale);
}

// Returns false if heading is undefined (field parallel to "up" or zero).
inline bool headingDeg(const Vec3& magUt, const Vec3& up, float& outDeg) {
  const Vec3 east = cross(magUt, up);
  const float eastLen = length(east);
  if (eastLen < 1e-3f) {
    return false;
  }
  const Vec3 e = east * (1.0f / eastLen);
  const Vec3 n = cross(up, e);
  float deg = atan2f(e.x, n.x) * orientation::kRadToDeg;
  if (deg < 0.0f) {
    deg += 360.0f;
  }
  outDeg = deg;
  return true;
}

// Hard/soft-iron from per-axis min/max collected while rotating the board.
// Returns false if any axis moved less than minSpanUt (not rotated enough).
inline bool calibrationFromMinMax(const Vec3& minUt, const Vec3& maxUt, float minSpanUt, MagCalibration& out) {
  const Vec3 half = (maxUt - minUt) * 0.5f;
  if (half.x * 2.0f < minSpanUt || half.y * 2.0f < minSpanUt || half.z * 2.0f < minSpanUt) {
    return false;
  }
  const float avg = (half.x + half.y + half.z) / 3.0f;
  out.offset = (maxUt + minUt) * 0.5f;
  out.scale = vec3(avg / half.x, avg / half.y, avg / half.z);
  return true;
}

}  // namespace compass
