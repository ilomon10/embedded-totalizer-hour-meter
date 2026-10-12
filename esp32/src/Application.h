// Application.h — owns every object and runs the main loop.
//
// TS mental model: the composition root of a Node service. It creates the
// drivers, injects them into the logic classes, and polls timers:
//
//   setup(): bus -> EEPROM -> settings + journal -> serial -> RTC -> IMU -> boot event
//   loop():  serial commands | inputs (100 Hz) | IMU (imuSampleHz) | stream | telemetry
//            | RTC sync | presence check (hot-plug of EEPROM / RTC / IMU)
//
// Modular: every I2C module is optional and hot-pluggable. A missing module
// sets a status flag, the rest keeps working, and the module is attached as
// soon as it is plugged in (an EVENT devicesChanged reports every change).
#pragma once

#include <Arduino.h>
#include <Wire.h>

#include "AccessGate.h"
#include "ArduinoI2cBus.h"
#include "At24c.h"
#include "CommandHandler.h"
#include "Ds3231.h"
#include "HourMeter.h"
#include "IDeviceControl.h"
#include "ImuPipeline.h"
#include "Journal.h"
#include "Mpu9250.h"
#include "PeriodicTask.h"
#include "Presence.h"
#include "SettingsStore.h"
#include "TimeKeeper.h"
#include "platform/ArduinoClock.h"
#include "platform/Inputs.h"
#include "platform/SerialLink.h"

class Application : public IDeviceControl {
 public:
  Application();

  void setup();
  void loop();

  // IDeviceControl (used by CommandHandler)
  const Settings& settings() const override { return settings_; }
  Status applySettings(const Settings& next) override;
  Status setTimeEpoch(uint32_t epoch) override;
  Status presetCounters(bool setRun, uint32_t runSeconds, bool setCount, uint32_t totalCount) override;
  Status resetCounters() override;
  AckStatus startCalibration(CalibKind kind) override;
  void requestReboot() override { rebootRequested_ = true; }
  HourMeterSnapshot hourMeter() const override { return meter_.snapshot(); }
  DeviceStatus status() const override;

 private:
  // Drivers
  ArduinoClock clock_;
  ArduinoI2cBus bus_;
  At24c eeprom_;
  Ds3231 rtc_;
  Mpu9250 imu_;
  // Storage + logic
  Journal journal_;
  SettingsStore settingsStore_;
  Settings settings_;
  HourMeter meter_;
  ImuPipeline pipeline_;
  TimeKeeper time_;
  CommandHandler commands_;
  // I/O
  Inputs inputs_;
  SerialLink link_;
  FrameWriter frame_;
  // Retry safety: the last ACK per port is kept so a resent command (same seq)
  // gets the same answer WITHOUT running twice (e.g. no double reset/calibrate).
  struct LastCommand {
    bool valid = false;
    uint16_t seq = 0;
    uint32_t atMs = 0;
    FrameWriter ack;
  };
  LastCommand lastCmd_[kPortCount];  // per link: USB, UART, Bluetooth
  // Bluetooth: radio follows settings_.bluetooth; sessions are PIN-locked.
  AccessGate btGate_;
  bool btHadClient_ = false;
  bool btReconfigPending_ = false;
  // Timers (TS: setInterval equivalents, polled)
  PeriodicTask inputTask_;
  PeriodicTask imuTask_;
  PeriodicTask streamTask_;
  PeriodicTask telemetryTask_;
  PeriodicTask rtcTask_;
  PeriodicTask presenceTask_;
  // Hot-plug state for the optional I2C modules.
  PresenceTracker eepromPresence_;
  PresenceTracker rtcPresence_;
  PresenceTracker imuPresence_;
  bool setupDone_ = false;
  bool devicesChanged_ = false;
  bool storageAdopted_ = false;   // EEPROM contents merged once per boot
  bool settingsNotSaved_ = false; // settings changed while no EEPROM was attached

  uint32_t deviceId_ = 0;
  uint16_t txSeq_ = 0;
  uint8_t devices_ = 0;          // device_bit mask found at boot
  uint32_t bootFlags_ = 0;       // status_flag bits decided at boot
  bool storageError_ = false;
  bool rebootRequested_ = false;
  bool linkReconfigPending_ = false;
  uint32_t lastImuUs_ = 0;
  int16_t rtcTempQ_ = 0;
  bool rtcTempValid_ = false;
  bool imuSaturated_ = false;     // any clipped sample during the last telemetry period

  void setDevice(uint8_t bit, bool present);
  bool attachEeprom();
  void adoptStorage();
  bool attachRtc(bool atBoot);
  bool attachImu();
  void runPresence();
  bool bluetoothGate(SensorFrameView& frame, FrameWriter& ack);
  void updateBluetoothSession();
  void applyBluetooth();
  void applyRuntimeSettings();
  void sendBootEvent();

  void runInputs(uint32_t nowMs);
  void runImu(uint32_t nowUs);
  void runStream();
  void runTelemetry();
  void syncRtc(uint32_t nowMs);
  void finishCalibration(CalibKind kind, AckStatus result, const Calibration& cal);
  void persistCounters(uint32_t nowMs, uint8_t extraFlags);
  void afterCommand();

  static void onCommand(SensorFrameView& frame, Port from, void* ctx);
};
