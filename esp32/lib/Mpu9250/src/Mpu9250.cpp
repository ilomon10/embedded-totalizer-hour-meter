// Mpu9250.cpp — see header.
#include "Mpu9250.h"

namespace mpu9250 {

namespace {
int16_t be16(const uint8_t* p) { return static_cast<int16_t>((p[0] << 8) | p[1]); }
int16_t le16(const uint8_t* p) { return static_cast<int16_t>((p[1] << 8) | p[0]); }
float f(int16_t v) { return static_cast<float>(v); }
// Factory sensitivity adjustment: ((ASA - 128) / 256) + 1.
float asaToGain(uint8_t asa) { return (static_cast<float>(asa) - 128.0f) / 256.0f + 1.0f; }
bool atFullScale(int16_t v) { return v == 32767 || v == -32768; }
}  // namespace

ImuSample decodeImu(const uint8_t raw[14]) {
  const int16_t ax = be16(raw + 0), ay = be16(raw + 2), az = be16(raw + 4);
  const int16_t t = be16(raw + 6);
  const int16_t gx = be16(raw + 8), gy = be16(raw + 10), gz = be16(raw + 12);
  ImuSample s;
  s.accelG = vec3(f(ax) / Mpu9250::kAccelLsbPerG, f(ay) / Mpu9250::kAccelLsbPerG, f(az) / Mpu9250::kAccelLsbPerG);
  s.gyroDps = vec3(f(gx) / Mpu9250::kGyroLsbPerDps, f(gy) / Mpu9250::kGyroLsbPerDps, f(gz) / Mpu9250::kGyroLsbPerDps);
  s.tempC = f(t) / 333.87f + 21.0f;
  s.saturated = atFullScale(ax) || atFullScale(ay) || atFullScale(az) || atFullScale(gx) || atFullScale(gy) ||
                atFullScale(gz);
  return s;
}

bool decodeMag(const uint8_t raw[7], const Vec3& adjust, Vec3& out) {
  if ((raw[6] & kMagSt2Overflow) != 0) {
    return false;  // magnetic sensor overflow: reading is meaningless
  }
  const float hx = f(le16(raw + 0)) * Mpu9250::kMagUtPerLsb * adjust.x;
  const float hy = f(le16(raw + 2)) * Mpu9250::kMagUtPerLsb * adjust.y;
  const float hz = f(le16(raw + 4)) * Mpu9250::kMagUtPerLsb * adjust.z;
  // AK8963 axes vs MPU axes: X_mpu = Y_mag, Y_mpu = X_mag, Z_mpu = -Z_mag.
  out = vec3(hy, hx, -hz);
  return true;
}

}  // namespace mpu9250

using namespace mpu9250;

Status Mpu9250::begin() {
  TRY(readReg(bus_, address_, kRegWhoAmI, whoAmI_));
  if (whoAmI_ != kWhoAmI9250 && whoAmI_ != kWhoAmI9255 && whoAmI_ != kWhoAmI6500) {
    return Status::DeviceMissing;
  }
  TRY(writeReg(bus_, address_, kRegPwrMgmt1, 0x80));  // device reset
  clock_.delayMs(100);
  TRY(configureImu());
  hasMag_ = (whoAmI_ != kWhoAmI6500) && (beginMag() == Status::Ok);
  return Status::Ok;
}

Status Mpu9250::configureImu() {
  TRY(writeReg(bus_, address_, kRegPwrMgmt1, 0x01));      // clock = gyro PLL
  clock_.delayMs(10);
  TRY(writeReg(bus_, address_, kRegConfig, 0x03));        // gyro DLPF 41 Hz
  TRY(writeReg(bus_, address_, kRegSmplrtDiv, 0x00));     // 1 kHz internal rate
  TRY(writeReg(bus_, address_, kRegGyroConfig, 0x08));    // +-500 dps
  TRY(writeReg(bus_, address_, kRegAccelConfig, 0x08));   // +-4 g
  TRY(writeReg(bus_, address_, kRegAccelConfig2, 0x03));  // accel DLPF 41 Hz
  TRY(writeReg(bus_, address_, kRegUserCtrl, 0x00));      // internal I2C master off
  TRY(writeReg(bus_, address_, kRegIntPinCfg, 0x02));     // bypass: AK8963 visible on main bus
  return Status::Ok;
}

Status Mpu9250::beginMag() {
  uint8_t wia = 0;
  TRY(readReg(bus_, kMagAddress, kMagRegWia, wia));
  if (wia != kMagWia) {
    return Status::DeviceMissing;
  }
  // Read factory sensitivity adjustment from fuse ROM.
  TRY(writeReg(bus_, kMagAddress, kMagRegCntl1, 0x00));
  clock_.delayMs(10);
  TRY(writeReg(bus_, kMagAddress, kMagRegCntl1, 0x0F));
  clock_.delayMs(10);
  uint8_t asa[3] = {};
  TRY(readRegs(bus_, kMagAddress, kMagRegAsax, asa, sizeof(asa)));
  magAdjust_ = vec3(asaToGain(asa[0]), asaToGain(asa[1]), asaToGain(asa[2]));
  TRY(writeReg(bus_, kMagAddress, kMagRegCntl1, 0x00));
  clock_.delayMs(10);
  TRY(writeReg(bus_, kMagAddress, kMagRegCntl1, 0x16));  // 16-bit, continuous 100 Hz
  clock_.delayMs(10);
  return Status::Ok;
}

Result<ImuSample> Mpu9250::readImu() {
  uint8_t raw[14] = {};
  const Status s = readRegs(bus_, address_, kRegAccelXoutH, raw, sizeof(raw));
  if (s != Status::Ok) {
    return Result<ImuSample>::failure(s);
  }
  return Result<ImuSample>::success(decodeImu(raw));
}

Result<Vec3> Mpu9250::readMag() {
  if (!hasMag_) {
    return Result<Vec3>::failure(Status::Unsupported);
  }
  uint8_t st1 = 0;
  Status s = readReg(bus_, kMagAddress, kMagRegSt1, st1);
  if (s != Status::Ok) {
    return Result<Vec3>::failure(s);
  }
  if ((st1 & 0x01) == 0) {
    return Result<Vec3>::failure(Status::NotReady);
  }
  uint8_t raw[7] = {};  // HXL..HZH + ST2 (reading ST2 releases the data latch)
  s = readRegs(bus_, kMagAddress, kMagRegHxl, raw, sizeof(raw));
  if (s != Status::Ok) {
    return Result<Vec3>::failure(s);
  }
  Vec3 ut;
  if (!decodeMag(raw, magAdjust_, ut)) {
    return Result<Vec3>::failure(Status::OutOfRange);
  }
  return Result<Vec3>::success(ut);
}
