// Telemetry.cpp — see header.
#include "Telemetry.h"

#include <math.h>

#include "SettingsSchema.h"

namespace telemetry {

uint32_t headerTimestamp(const DeviceStatus& st) { return st.timeValid ? st.epoch : st.uptimeS; }

void begin(FrameWriter& w, uint8_t msgType, uint16_t seq, uint32_t deviceId, const DeviceStatus& st) {
  w.begin(msgType, seq, deviceId, headerTimestamp(st));
}

int16_t toI16(float value, float scale) {
  const float v = roundf(value * scale);
  if (!(v == v)) {
    return 0;  // NaN
  }
  if (v > 32767.0f) {
    return 32767;
  }
  if (v < -32768.0f) {
    return -32768;
  }
  return static_cast<int16_t>(v);
}

uint16_t toU16(float value, float scale) {
  const float v = roundf(value * scale);
  if (!(v == v) || v < 0.0f) {
    return 0;
  }
  return v > 65535.0f ? 65535 : static_cast<uint16_t>(v);
}

bool appendHourMeter(FrameWriter& w, const HourMeterSnapshot& hm, bool withPersistInfo) {
  const uint32_t ppu = (hm.pulsesPerUnit == 0) ? 1 : hm.pulsesPerUnit;
  const uint32_t runHoursX100 = hm.runSeconds / 36UL;  // 3600 s / 100
  const uint32_t unitsX100 = static_cast<uint32_t>((static_cast<uint64_t>(hm.totalCount) * 100ULL) / ppu);
  bool ok = w.addU32(tag::kRunSeconds, hm.runSeconds) && w.addU32(tag::kTotalCount, hm.totalCount) &&
            w.addBool(tag::kAlternator, hm.running) && w.addBool(tag::kAltInput, hm.inputActive) &&
            w.addU32(tag::kRunHours, runHoursX100) &&
            w.addU32(tag::kTotalUnits, unitsX100);
  if (withPersistInfo) {
    ok = ok && w.addU32(tag::kLastSavedEpoch, hm.lastSavedEpoch) && w.addU32(tag::kJournalSeq, hm.journalSeq);
  }
  return ok;
}

bool appendStatus(FrameWriter& w, const DeviceStatus& st, bool full) {
  bool ok = w.addBool(tag::kTimeValid, st.timeValid) && w.addU32(tag::kStatusFlags, st.flags);
  if (full) {
    ok = ok && w.addU32(tag::kEpoch, st.epoch) && w.addU32(tag::kUptime, st.uptimeS) &&
         w.addU8(tag::kDevices, st.devices) && w.addU32(tag::kI2cErrors, st.i2cErrors) &&
         w.addU32(tag::kOverruns, st.overruns) && w.addU8(tag::kResetReason, st.resetReason) &&
         w.addU8(tag::kSettingsSource, st.settingsSource) && w.addU8(tag::kBtState, st.btState) &&
         w.addU8(tag::kLastCause, st.lastCause) && w.addU8(tag::kLastStage, st.lastStage) &&
         w.addU32(tag::kFwVersion, kFirmwareVersion);
    if (st.rtcTempValid) {
      ok = ok && w.addI16(tag::kRtcTemp, st.rtcTempQuarterC);
    }
  }
  return ok;
}

bool appendDerived(FrameWriter& w, const ImuOutput& imu, bool hasVibration, const VibrationLevel& vib) {
  bool ok = w.addI16(tag::kRoll, toI16(imu.rollDeg, 100.0f)) && w.addI16(tag::kPitch, toI16(imu.pitchDeg, 100.0f));
  if (imu.headingValid) {
    ok = ok && w.addU16(tag::kHeading, toU16(imu.headingDeg, 100.0f));
  }
  if (hasVibration) {
    ok = ok && w.addU16(tag::kVibRms, toU16(vib.rmsMg, 1.0f)) && w.addU16(tag::kVibPeak, toU16(vib.peakMg, 1.0f));
  }
  return ok;
}

void buildTelemetry(FrameWriter& w, uint16_t seq, uint32_t deviceId, const HourMeterSnapshot& hm,
                    const DeviceStatus& st, const ImuOutput* imu, bool hasVibration, const VibrationLevel& vib) {
  begin(w, msg::kTelemetry, seq, deviceId, st);
  (void)appendHourMeter(w, hm, false);
  (void)appendStatus(w, st, false);
  if (imu != nullptr) {
    (void)appendDerived(w, *imu, hasVibration, vib);
  }
}

namespace {
bool addAxes(FrameWriter& w, uint8_t firstTag, const Vec3& v, float scale) {
  return w.addI16(firstTag, toI16(v.x, scale)) && w.addI16(firstTag + 1, toI16(v.y, scale)) &&
         w.addI16(firstTag + 2, toI16(v.z, scale));
}
}  // namespace

void buildImuStream(FrameWriter& w, uint16_t seq, uint32_t deviceId, const DeviceStatus& st, const ImuOutput& imu,
                    StreamMode mode) {
  begin(w, msg::kImuStream, seq, deviceId, st);
  const bool raw = (mode == StreamMode::Raw || mode == StreamMode::Both);
  const bool filtered = (mode == StreamMode::Filtered || mode == StreamMode::Both);
  // Scales: accel g -> mg (x1000), gyro deg/s -> 0.1 deg/s (x10), mag uT -> 0.1 uT (x10).
  if (raw) {
    (void)addAxes(w, tag::kRawAccelX, imu.rawAccelG, 1000.0f);
    (void)addAxes(w, tag::kRawGyroX, imu.rawGyroDps, 10.0f);
    if (imu.hasMag) {
      (void)addAxes(w, tag::kRawMagX, imu.rawMagUt, 10.0f);
    }
  }
  if (filtered) {
    (void)addAxes(w, tag::kFiltAccelX, imu.accelG, 1000.0f);
    (void)addAxes(w, tag::kFiltGyroX, imu.gyroDps, 10.0f);
    if (imu.hasMag) {
      (void)addAxes(w, tag::kFiltMagX, imu.magUt, 10.0f);
    }
    VibrationLevel none;
    (void)appendDerived(w, imu, false, none);
  }
}

void buildBootEvent(FrameWriter& w, uint16_t seq, uint32_t deviceId, const HourMeterSnapshot& hm,
                    const DeviceStatus& st) {
  begin(w, msg::kEvent, seq, deviceId, st);
  (void)w.addU8(tag::kEventKind, static_cast<uint8_t>(EventKind::Boot));
  (void)appendHourMeter(w, hm, true);
  (void)appendStatus(w, st, true);
}

void buildCalibrationEvent(FrameWriter& w, uint16_t seq, uint32_t deviceId, const DeviceStatus& st, CalibKind kind,
                           AckStatus result, const Calibration& cal) {
  begin(w, msg::kEvent, seq, deviceId, st);
  (void)w.addU8(tag::kEventKind, static_cast<uint8_t>(EventKind::CalibrationDone));
  (void)w.addU8(tag::kCmdCalibrate, static_cast<uint8_t>(kind));
  (void)w.addU8(tag::kCalibResult, static_cast<uint8_t>(result));
  if (result == AckStatus::Ok) {
    (void)settings_schema::appendCalibration(w, cal);
  }
}

void buildDevicesChangedEvent(FrameWriter& w, uint16_t seq, uint32_t deviceId, const DeviceStatus& st) {
  begin(w, msg::kEvent, seq, deviceId, st);
  (void)w.addU8(tag::kEventKind, static_cast<uint8_t>(EventKind::DevicesChanged));
  (void)appendStatus(w, st, true);
}

}  // namespace telemetry
