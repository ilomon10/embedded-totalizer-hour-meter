// Snapshots.h — read-only views of device state, handed to the telemetry and
// command code. TS mental model: plain DTOs / `Readonly<{...}>`.
#pragma once

#include <stdint.h>

struct HourMeterSnapshot {
  uint32_t runSeconds = 0;
  uint32_t totalCount = 0;
  bool running = false;      // engine running (input, and confirmed when runVibMinMg is set)
  bool inputActive = false;  // engine-running input (level active or toggling), before debounce and confirmation
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
  uint8_t lastCause = 0;  // LastCause of the previous run
  uint8_t lastStage = 0;  // Stage the previous run ended in
  bool i2cParked = false; // the I2C bus is parked after trouble (BusGuard.h)
  uint8_t i2cLines = 0;   // i2c_lines: the lines the bus recovery found held low (sent only while parked)
};
