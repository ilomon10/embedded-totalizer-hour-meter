// SettingsSchema.cpp — see header. To add a setting: add a field to Settings,
// a row here, a case in read()/write(), and a line in node/tags.js + docs.
#include "SettingsSchema.h"

#include <math.h>

namespace settings_schema {

const SettingSpec kSpecs[] = {
    {110, "telemetryIntervalMs", SF_U16, 100, 60000},
    {111, "imuSampleHz", SF_U16, 10, 500},
    {112, "imuStreamHz", SF_U8, 0, 100},
    {113, "streamMode", SF_U8, 0, 3},
    {114, "persistIntervalS", SF_U16, 10, 3600},
    {115, "vibrationWindowMs", SF_U16, 100, 10000},
    {116, "rtcSyncIntervalS", SF_U16, 1, 3600},
    {117, "output", SF_U8, 1, 3},
    {118, "uartBaud", SF_U32, 9600, 921600},
    {119, "altActiveHigh", SF_BOOL, 0, 1},
    {120, "altDebounceMs", SF_U16, 0, 5000},
    {121, "pulseRisingEdge", SF_BOOL, 0, 1},
    {122, "pulseMinIntervalUs", SF_U16, 0, 65535},
    {123, "pulsesPerUnit", SF_U16, 1, 65535},
    {124, "kalmanQAccel", SF_F32, 1e-7, 1.0},
    {125, "kalmanQGyro", SF_F32, 1e-7, 10.0},
    {126, "kalmanQMag", SF_F32, 1e-7, 10.0},
    {127, "bluetooth", SF_BOOL, 0, 1},
    {128, "btPin", SF_U16, 0, 9999},
};
const size_t kCount = sizeof(kSpecs) / sizeof(kSpecs[0]);
static_assert(sizeof(kSpecs) / sizeof(kSpecs[0]) == tag::kSettingLast - tag::kSettingFirst + 1,
              "every tag in 110..126 needs a spec row");

namespace {
constexpr uint32_t kBauds[] = {9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600};

bool isStandardBaud(uint32_t b) {
  for (size_t i = 0; i < sizeof(kBauds) / sizeof(kBauds[0]); i++) {
    if (kBauds[i] == b) {
      return true;
    }
  }
  return false;
}

bool isIntegerFmt(uint8_t fmt) { return fmt != SF_F32 && fmt != SF_F64; }
}  // namespace

const SettingSpec* find(uint8_t t) {
  if (t < tag::kSettingFirst || t > tag::kSettingLast) {
    return nullptr;
  }
  return &kSpecs[t - tag::kSettingFirst];
}

double read(const Settings& s, uint8_t t) {
  switch (t) {
    case 110: return s.telemetryIntervalMs;
    case 111: return s.imuSampleHz;
    case 112: return s.imuStreamHz;
    case 113: return s.streamMode;
    case 114: return s.persistIntervalS;
    case 115: return s.vibrationWindowMs;
    case 116: return s.rtcSyncIntervalS;
    case 117: return s.output;
    case 118: return s.baud;
    case 119: return s.altActiveHigh;
    case 120: return s.altDebounceMs;
    case 121: return s.pulseRisingEdge;
    case 122: return s.pulseMinIntervalUs;
    case 123: return s.pulsesPerUnit;
    case 124: return s.kalmanQAccel;
    case 125: return s.kalmanQGyro;
    case 126: return s.kalmanQMag;
    case 127: return s.bluetooth;
    case 128: return s.btPin;
    default: return 0;
  }
}

bool write(Settings& s, uint8_t t, double v) {
  switch (t) {
    case 110: s.telemetryIntervalMs = static_cast<uint16_t>(v); return true;
    case 111: s.imuSampleHz = static_cast<uint16_t>(v); return true;
    case 112: s.imuStreamHz = static_cast<uint8_t>(v); return true;
    case 113: s.streamMode = static_cast<uint8_t>(v); return true;
    case 114: s.persistIntervalS = static_cast<uint16_t>(v); return true;
    case 115: s.vibrationWindowMs = static_cast<uint16_t>(v); return true;
    case 116: s.rtcSyncIntervalS = static_cast<uint16_t>(v); return true;
    case 117: s.output = static_cast<uint8_t>(v); return true;
    case 118: s.baud = static_cast<uint32_t>(v); return true;
    case 119: s.altActiveHigh = static_cast<uint8_t>(v); return true;
    case 120: s.altDebounceMs = static_cast<uint16_t>(v); return true;
    case 121: s.pulseRisingEdge = static_cast<uint8_t>(v); return true;
    case 122: s.pulseMinIntervalUs = static_cast<uint16_t>(v); return true;
    case 123: s.pulsesPerUnit = static_cast<uint16_t>(v); return true;
    case 124: s.kalmanQAccel = static_cast<float>(v); return true;
    case 125: s.kalmanQGyro = static_cast<float>(v); return true;
    case 126: s.kalmanQMag = static_cast<float>(v); return true;
    case 127: s.bluetooth = static_cast<uint8_t>(v); return true;
    case 128: s.btPin = static_cast<uint16_t>(v); return true;
    default: return false;
  }
}

AckStatus checkValue(const SettingSpec& spec, const SensorFrameRecord& rec, double& out) {
  if (rec.fmt == SF_BYTES) {
    return AckStatus::InvalidValue;
  }
  const double v = rec.asDouble();
  if (!(v >= spec.min && v <= spec.max)) {  // also rejects NaN
    return AckStatus::InvalidValue;
  }
  if (isIntegerFmt(spec.fmt) && floor(v) != v) {
    return AckStatus::InvalidValue;
  }
  if (spec.tag == 118 && !isStandardBaud(static_cast<uint32_t>(v))) {
    return AckStatus::InvalidValue;
  }
  out = v;
  return AckStatus::Ok;
}

uint8_t checkCrossField(const Settings& s) {
  if (s.imuStreamHz > s.imuSampleHz) {
    return 112;  // cannot stream faster than we sample
  }
  return 0;
}

bool appendAll(FrameWriter& w, const Settings& s) {
  bool ok = true;
  for (size_t i = 0; i < kCount; i++) {
    const SettingSpec& spec = kSpecs[i];
    const double v = read(s, spec.tag);
    switch (spec.fmt) {
      case SF_U8: ok = ok && w.addU8(spec.tag, static_cast<uint8_t>(v)); break;
      case SF_U16: ok = ok && w.addU16(spec.tag, static_cast<uint16_t>(v)); break;
      case SF_U32: ok = ok && w.addU32(spec.tag, static_cast<uint32_t>(v)); break;
      case SF_BOOL: ok = ok && w.addBool(spec.tag, v != 0.0); break;
      default: ok = ok && w.addF32(spec.tag, static_cast<float>(v)); break;
    }
  }
  return ok;
}

namespace {
bool addVec(FrameWriter& w, uint8_t firstTag, const Vec3& v) {
  return w.addF32(firstTag, v.x) && w.addF32(firstTag + 1, v.y) && w.addF32(firstTag + 2, v.z);
}
}  // namespace

bool appendCalibration(FrameWriter& w, const Calibration& c) {
  return addVec(w, tag::kCalAccelBiasX, c.accelBiasG) && addVec(w, tag::kCalGyroBiasX, c.gyroBiasDps) &&
         addVec(w, tag::kCalAccelNoiseX, c.accelNoiseVar) && addVec(w, tag::kCalGyroNoiseX, c.gyroNoiseVar) &&
         addVec(w, tag::kCalMagOffsetX, c.mag.offset) && addVec(w, tag::kCalMagScaleX, c.mag.scale) &&
         w.addU8(tag::kCalFlags, c.flags);
}

}  // namespace settings_schema
