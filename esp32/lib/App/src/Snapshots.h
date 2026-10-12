// Snapshots.h — read-only views of device state, handed to the telemetry and
// command code. TS mental model: plain DTOs / `Readonly<{...}>`.
#pragma once

#include <stdint.h>

struct HourMeterSnapshot {
  uint32_t runSeconds = 0;
  uint32_t totalCount = 0;
  bool running = false;
  uint16_t pulsesPerUnit = 1;
  uint32_t lastSavedEpoch = 0;
  uint32_t journalSeq = 0;
};

struct DeviceStatus {
  bool timeValid = false;
  uint32_t epoch = 0;
  uint32_t uptimeS = 0;
  uint32_t flags = 0;  // status_flag bits
  bool rtcTempValid = false;
  int16_t rtcTempQuarterC = 0;
  uint8_t devices = 0;  // device_bit mask
  uint32_t i2cErrors = 0;
  uint32_t overruns = 0;
  uint8_t resetReason = 0;
  uint8_t settingsSource = 0;
  uint8_t btState = 0;  // 0 off, 1 on, 2 client locked, 3 client unlocked
};
