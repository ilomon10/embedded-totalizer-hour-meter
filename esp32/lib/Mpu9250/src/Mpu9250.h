// Mpu9250.h — MPU9250 accelerometer + gyroscope, plus its AK8963 magnetometer.
//
//   Mpu9250 imu(bus, clock);                    // AD0 tied HIGH -> 0x69 (0x68 is the RTC)
//   TRY(imu.begin());
//   Result<ImuSample> s = imu.readImu();        // accel in g, gyro in deg/s
//   Result<Vec3> m = imu.readMag();             // micro-tesla, NotReady if no new sample
//
// Units are physical (g, deg/s, uT) as floats; the telemetry layer scales them
// to integers. Magnetometer axes are rotated into the accel/gyro frame here,
// so every consumer sees one consistent right-handed frame (z up when flat).
//
// Many boards sold as "MPU9250" carry an MPU6500 (no magnetometer). begin()
// still succeeds on those and hasMag() returns false.
#pragma once

#include "IClock.h"
#include "II2cBus.h"
#include "Result.h"
#include "Vec3.h"

struct ImuSample {
  Vec3 accelG;      // g (1 g = 9.80665 m/s^2)
  Vec3 gyroDps;     // degrees per second
  float tempC = 0;  // die temperature
  bool saturated = false;  // any axis at full scale: value is clipped, do not trust
};

class Mpu9250 {
 public:
  static constexpr uint8_t kAddressAd0Low = 0x68;
  static constexpr uint8_t kAddressAd0High = 0x69;
  static constexpr uint8_t kMagAddress = 0x0C;

  static constexpr float kAccelRangeG = 4.0f;       // +-4 g
  static constexpr float kGyroRangeDps = 500.0f;    // +-500 deg/s
  static constexpr float kAccelLsbPerG = 8192.0f;
  static constexpr float kGyroLsbPerDps = 65.5f;
  static constexpr float kMagUtPerLsb = 0.15f;      // 16-bit output mode

  Mpu9250(II2cBus& bus, IClock& clock, uint8_t address = kAddressAd0High)
      : bus_(bus), clock_(clock), address_(address) {}

  // Reset, configure ranges + 41 Hz DLPF, and start the magnetometer if present.
  Status begin();

  Result<ImuSample> readImu();
  Result<Vec3> readMag();  // Status::NotReady when no new sample (normal, not an error)

  bool hasMag() const { return hasMag_; }
  uint8_t whoAmI() const { return whoAmI_; }

 private:
  II2cBus& bus_;
  IClock& clock_;
  uint8_t address_;
  uint8_t whoAmI_ = 0;
  bool hasMag_ = false;
  Vec3 magAdjust_ = vec3(1.0f, 1.0f, 1.0f);  // factory sensitivity adjustment (ASA)

  Status configureImu();
  Status beginMag();
};

namespace mpu9250 {
// MPU9250 registers.
constexpr uint8_t kRegSmplrtDiv = 0x19;
constexpr uint8_t kRegConfig = 0x1A;
constexpr uint8_t kRegGyroConfig = 0x1B;
constexpr uint8_t kRegAccelConfig = 0x1C;
constexpr uint8_t kRegAccelConfig2 = 0x1D;
constexpr uint8_t kRegIntPinCfg = 0x37;
constexpr uint8_t kRegAccelXoutH = 0x3B;
constexpr uint8_t kRegUserCtrl = 0x6A;
constexpr uint8_t kRegPwrMgmt1 = 0x6B;
constexpr uint8_t kRegWhoAmI = 0x75;
constexpr uint8_t kWhoAmI9250 = 0x71;
constexpr uint8_t kWhoAmI9255 = 0x73;
constexpr uint8_t kWhoAmI6500 = 0x70;
// AK8963 registers.
constexpr uint8_t kMagRegWia = 0x00;
constexpr uint8_t kMagRegSt1 = 0x02;
constexpr uint8_t kMagRegHxl = 0x03;
constexpr uint8_t kMagRegCntl1 = 0x0A;
constexpr uint8_t kMagRegAsax = 0x10;
constexpr uint8_t kMagWia = 0x48;
constexpr uint8_t kMagSt2Overflow = 0x08;

// Raw 14-byte burst (big-endian) -> physical units. Pure, unit-tested.
ImuSample decodeImu(const uint8_t raw[14]);
// Raw 7-byte burst HXL..ST2 (little-endian) -> uT in the accel frame. False on overflow.
bool decodeMag(const uint8_t raw[7], const Vec3& adjust, Vec3& out);
}  // namespace mpu9250
