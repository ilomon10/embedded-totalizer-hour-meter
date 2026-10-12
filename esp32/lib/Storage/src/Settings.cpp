// Settings.cpp — factory defaults.
#include "Settings.h"

Settings defaultSettings() {
  Settings s{};
  s.telemetryIntervalMs = 1000;
  s.imuSampleHz = 100;
  s.persistIntervalS = 60;
  s.vibrationWindowMs = 1000;
  s.rtcSyncIntervalS = 60;
  s.imuStreamHz = 10;
  s.streamMode = static_cast<uint8_t>(StreamMode::Filtered);
  s.output = static_cast<uint8_t>(OutputPort::Usb);
  s.altActiveHigh = 0;  // PC817 optocoupler input: engine running pulls GPIO27 LOW
  s.altDebounceMs = 200;
  s.baud = 115200;
  s.pulseRisingEdge = 0;
  s.pulseMinIntervalUs = 1000;
  s.pulsesPerUnit = 1;
  s.bluetooth = 0;   // off until enabled over USB / TUI
  s.btPin = 1234;    // CHANGE at installation
  s.kalmanQAccel = 0.0005f;
  s.kalmanQGyro = 0.01f;
  s.kalmanQMag = 0.05f;
  s.cal = Calibration{};
  // Until calibrated: no bias, typical MPU9250 noise as R.
  s.cal.accelNoiseVar = vec3(0.0004f, 0.0004f, 0.0004f);
  s.cal.gyroNoiseVar = vec3(0.01f, 0.01f, 0.01f);
  return s;
}
