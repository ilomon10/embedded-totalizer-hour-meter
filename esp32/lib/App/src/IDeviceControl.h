// IDeviceControl.h — what the command handler is allowed to do to the device.
//
// TS mental model: an interface injected into a request handler, so the
// handler can be unit-tested with a fake implementation:
//   interface IDeviceControl { setTimeEpoch(e: number): Status; ... }
// The real implementation is the Application class in src/.
#pragma once

#include "Protocol.h"
#include "Settings.h"
#include "Snapshots.h"
#include "Status.h"

class IDeviceControl {
 public:
  virtual ~IDeviceControl() = default;

  virtual const Settings& settings() const = 0;
  // Persist + apply. Called only with settings that passed validation.
  virtual Status applySettings(const Settings& next) = 0;

  virtual Status setTimeEpoch(uint32_t epoch) = 0;
  virtual Status presetCounters(bool setRun, uint32_t runSeconds, bool setCount, uint32_t totalCount) = 0;
  virtual Status resetCounters() = 0;
  virtual AckStatus startCalibration(CalibKind kind) = 0;
  virtual void requestReboot() = 0;

  virtual HourMeterSnapshot hourMeter() const = 0;
  virtual DeviceStatus status() const = 0;
};
