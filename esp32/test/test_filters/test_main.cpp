// Filter tests: pure math with synthetic signals (deterministic pseudo-noise).
#include <math.h>
#include <unity.h>

#include "Compass.h"
#include "Kalman1D.h"
#include "KalmanAngle.h"
#include "Orientation.h"
#include "PeriodicTask.h"
#include "RunningStats.h"
#include "Vibration.h"

void setUp() {}
void tearDown() {}

// Small deterministic noise generator (LCG), uniform in [-a, a].
static uint32_t gSeed = 12345;
static float noise(float a) {
  gSeed = gSeed * 1664525u + 1013904223u;
  return ((gSeed >> 8) / 16777216.0f * 2.0f - 1.0f) * a;
}

static void test_kalman1d_reduces_noise() {
  Kalman1D kf(0.0001f, 0.01f);
  float rawErr = 0, filtErr = 0;
  for (int i = 0; i < 2000; i++) {
    const float z = 1.0f + noise(0.2f);
    const float x = kf.update(z);
    if (i > 200) {
      rawErr += (z - 1.0f) * (z - 1.0f);
      filtErr += (x - 1.0f) * (x - 1.0f);
    }
  }
  TEST_ASSERT_TRUE(filtErr < rawErr / 10.0f);  // at least 10x less variance
  TEST_ASSERT_FLOAT_WITHIN(0.03f, 1.0f, kf.value());
}

static void test_kalman1d_follows_step() {
  Kalman1D kf(0.01f, 0.01f);
  for (int i = 0; i < 50; i++) kf.update(0.0f);
  for (int i = 0; i < 50; i++) kf.update(5.0f);
  TEST_ASSERT_FLOAT_WITHIN(0.05f, 5.0f, kf.value());
}

static void test_kalman_angle_tracks_and_learns_gyro_bias() {
  KalmanAngle kf;
  const float dt = 0.01f;
  float trueAngle = 0;
  for (int i = 0; i < 3000; i++) {
    trueAngle = 30.0f * sinf(i * dt * 0.5f);
    const float trueRate = 30.0f * 0.5f * cosf(i * dt * 0.5f);
    kf.update(trueAngle + noise(3.0f), trueRate + 2.0f /* gyro bias */, dt);
  }
  TEST_ASSERT_FLOAT_WITHIN(1.0f, trueAngle, kf.angle());
  TEST_ASSERT_FLOAT_WITHIN(0.5f, 2.0f, kf.bias());
}

static void test_orientation_roll_pitch_and_up_vector() {
  TEST_ASSERT_FLOAT_WITHIN(1e-3, 0.0f, orientation::rollDeg(vec3(0, 0, 1)));
  TEST_ASSERT_FLOAT_WITHIN(1e-3, 90.0f, orientation::rollDeg(vec3(0, 1, 0)));
  TEST_ASSERT_FLOAT_WITHIN(1e-3, 30.0f, orientation::pitchDeg(vec3(-0.5f, 0, 0.8660254f)));
  const Vec3 up = orientation::upVector(20.0f, -15.0f);
  TEST_ASSERT_FLOAT_WITHIN(1e-3, 20.0f, orientation::rollDeg(up));
  TEST_ASSERT_FLOAT_WITHIN(1e-3, -15.0f, orientation::pitchDeg(up));
}

// Earth field in the world frame (East, North, Up): 35 uT north, dipping 30 deg down.
static Vec3 worldToBoard(const Vec3& w, float headingDeg) {
  // Board flat, x axis pointing `headingDeg` clockwise from north.
  const float h = headingDeg * orientation::kDegToRad;
  const Vec3 xAxis = vec3(sinf(h), cosf(h), 0);   // in ENU
  const Vec3 yAxis = vec3(-cosf(h), sinf(h), 0);  // z up x xAxis
  return vec3(dot(w, xAxis), dot(w, yAxis), w.z);
}

static void test_compass_flat_headings() {
  const Vec3 field = vec3(0, 35.0f * cosf(0.5236f), -35.0f * sinf(0.5236f));
  const float headings[] = {0, 45, 90, 180, 270, 359};
  for (float h : headings) {
    float out = -1;
    TEST_ASSERT_TRUE(compass::headingDeg(worldToBoard(field, h), vec3(0, 0, 1), out));
    float diff = fabsf(out - h);
    if (diff > 180) diff = 360 - diff;
    TEST_ASSERT_FLOAT_WITHIN(0.1f, 0.0f, diff);
  }
}

static void test_compass_tilt_compensated() {
  // Board heading 90 deg, then rolled 20 deg about its x axis: heading must stay 90.
  const Vec3 field = vec3(0, 30.0f, -20.0f);
  const Vec3 flat = worldToBoard(field, 90.0f);
  const float r = 20.0f * orientation::kDegToRad;
  // Rotate field into the rolled board frame (rotation about x by -roll).
  const Vec3 rolled = vec3(flat.x, flat.y * cosf(r) + flat.z * sinf(r), -flat.y * sinf(r) + flat.z * cosf(r));
  const Vec3 up = orientation::upVector(20.0f, 0.0f);
  float out = 0;
  TEST_ASSERT_TRUE(compass::headingDeg(rolled, up, out));
  TEST_ASSERT_FLOAT_WITHIN(0.5f, 90.0f, out);
}

static void test_compass_calibration_from_min_max() {
  MagCalibration cal;
  // Offset (10, -5, 3); radii 40, 20, 30 (soft iron).
  TEST_ASSERT_TRUE(compass::calibrationFromMinMax(vec3(-30, -25, -27), vec3(50, 15, 33), 20, cal));
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 10.0f, cal.offset.x);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, -5.0f, cal.offset.y);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 0.75f, cal.scale.x);  // avg 30 / 40
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.5f, cal.scale.y);   // avg 30 / 20
  const Vec3 c = compass::applyCalibration(vec3(50, -5, 3), cal);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 30.0f, c.x);
  // Not rotated enough on z -> rejected.
  TEST_ASSERT_FALSE(compass::calibrationFromMinMax(vec3(-30, -25, 0), vec3(50, 15, 5), 20, cal));
}

static void test_vibration_rms_of_sine() {
  VibrationMeter vm;
  const float hz = 1000.0f;
  vm.configure(hz, 1000);
  VibrationLevel out;
  bool got = false;
  // Gravity on z + 100 mg 50 Hz vibration on x, for 3 s (gravity tracker settles).
  for (int i = 0; i < 3000; i++) {
    const float a = 0.1f * sinf(2.0f * 3.14159265f * 50.0f * i / hz);
    got = vm.add(vec3(a, 0, 1.0f), out) || got;
  }
  TEST_ASSERT_TRUE(got);
  TEST_ASSERT_FLOAT_WITHIN(5.0f, 70.7f, out.rmsMg);  // 100 / sqrt(2)
  TEST_ASSERT_FLOAT_WITHIN(5.0f, 100.0f, out.peakMg);
}

static void test_running_stats() {
  RunningStats3 s;
  const float xs[] = {2, 4, 4, 4, 5, 5, 7, 9};
  for (float x : xs) s.add(vec3(x, -x, 1));
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 5.0f, s.mean().x);
  TEST_ASSERT_FLOAT_WITHIN(1e-5, 32.0f / 7.0f, s.variance().x);  // sample variance
  TEST_ASSERT_FLOAT_WITHIN(1e-6, 0.0f, s.variance().z);
}

static void test_periodic_task_fixed_rate_and_overrun() {
  PeriodicTask t(10000);
  TEST_ASSERT_FALSE(t.due(0));       // arms
  TEST_ASSERT_FALSE(t.due(9999));
  TEST_ASSERT_TRUE(t.due(10000));
  TEST_ASSERT_FALSE(t.due(10001));
  TEST_ASSERT_TRUE(t.due(20500));    // late but within catch-up: keeps the 30000 slot
  TEST_ASSERT_TRUE(t.due(30000));
  TEST_ASSERT_TRUE(t.due(100000));   // big stall: resync, count an overrun
  TEST_ASSERT_EQUAL_UINT32(1, t.overruns());
  TEST_ASSERT_FALSE(t.due(105000));
  TEST_ASSERT_TRUE(t.due(110000));
  // micros() wrap-around
  PeriodicTask w(1000);
  TEST_ASSERT_FALSE(w.due(0xFFFFFF00u));
  TEST_ASSERT_TRUE(w.due(0xFFFFFF00u + 1000u));  // wraps past 0
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_kalman1d_reduces_noise);
  RUN_TEST(test_kalman1d_follows_step);
  RUN_TEST(test_kalman_angle_tracks_and_learns_gyro_bias);
  RUN_TEST(test_orientation_roll_pitch_and_up_vector);
  RUN_TEST(test_compass_flat_headings);
  RUN_TEST(test_compass_tilt_compensated);
  RUN_TEST(test_compass_calibration_from_min_max);
  RUN_TEST(test_vibration_rms_of_sine);
  RUN_TEST(test_running_stats);
  RUN_TEST(test_periodic_task_fixed_rate_and_overrun);
  return UNITY_END();
}
