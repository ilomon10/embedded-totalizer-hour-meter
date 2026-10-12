// Telemetry.h — builds every frame the device SENDS (except ACKs).
// Pure functions: state in, bytes out. Tag meanings: Protocol.h.
#pragma once

#include "ImuPipeline.h"
#include "Protocol.h"
#include "Settings.h"
#include "Snapshots.h"

namespace telemetry {

// Header timestamp: UTC epoch when the RTC is valid, else seconds since boot
// (the frame's timeValid tag says which).
uint32_t headerTimestamp(const DeviceStatus& st);

void begin(FrameWriter& w, uint8_t msgType, uint16_t seq, uint32_t deviceId, const DeviceStatus& st);

// Scaled-integer helpers: round, clamp to the type range, NaN -> 0.
int16_t toI16(float value, float scale);
uint16_t toU16(float value, float scale);

bool appendHourMeter(FrameWriter& w, const HourMeterSnapshot& hm, bool withPersistInfo);
bool appendStatus(FrameWriter& w, const DeviceStatus& st, bool full);
bool appendDerived(FrameWriter& w, const ImuOutput& imu, bool hasVibration, const VibrationLevel& vib);

// 1. Periodic TELEMETRY: hour meter + time + status flags (+ IMU summary if present).
void buildTelemetry(FrameWriter& w, uint16_t seq, uint32_t deviceId, const HourMeterSnapshot& hm,
                    const DeviceStatus& st, const ImuOutput* imu, bool hasVibration, const VibrationLevel& vib);

// 2. IMU stream (msg 128): raw and/or filtered axes, plus roll/pitch/heading when filtered.
void buildImuStream(FrameWriter& w, uint16_t seq, uint32_t deviceId, const DeviceStatus& st, const ImuOutput& imu,
                    StreamMode mode);

// 3. EVENT boot: restored counters, reset reason, firmware version, full status.
void buildBootEvent(FrameWriter& w, uint16_t seq, uint32_t deviceId, const HourMeterSnapshot& hm,
                    const DeviceStatus& st);

// 4. EVENT calibration finished: kind, result, and the new calibration values.
void buildCalibrationEvent(FrameWriter& w, uint16_t seq, uint32_t deviceId, const DeviceStatus& st, CalibKind kind,
                           AckStatus result, const Calibration& cal);

// 5. EVENT devices changed: a module was plugged in or lost while running.
void buildDevicesChangedEvent(FrameWriter& w, uint16_t seq, uint32_t deviceId, const DeviceStatus& st);

}  // namespace telemetry
