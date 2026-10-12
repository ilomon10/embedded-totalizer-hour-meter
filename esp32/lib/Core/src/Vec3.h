// Vec3.h — tiny 3-axis vector used by the IMU code.
// TS mental model: `type Vec3 = { x: number; y: number; z: number }` plus helpers.
#pragma once

#include <math.h>

struct Vec3 {
  float x = 0.0f;
  float y = 0.0f;
  float z = 0.0f;
};

inline Vec3 vec3(float x, float y, float z) {
  Vec3 v;
  v.x = x;
  v.y = y;
  v.z = z;
  return v;
}
inline Vec3 operator+(const Vec3& a, const Vec3& b) { return vec3(a.x + b.x, a.y + b.y, a.z + b.z); }
inline Vec3 operator-(const Vec3& a, const Vec3& b) { return vec3(a.x - b.x, a.y - b.y, a.z - b.z); }
inline Vec3 operator*(const Vec3& a, float k) { return vec3(a.x * k, a.y * k, a.z * k); }
inline Vec3 mulEach(const Vec3& a, const Vec3& b) { return vec3(a.x * b.x, a.y * b.y, a.z * b.z); }
inline float dot(const Vec3& a, const Vec3& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline Vec3 cross(const Vec3& a, const Vec3& b) {
  return vec3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}
inline float length(const Vec3& a) { return sqrtf(dot(a, a)); }
