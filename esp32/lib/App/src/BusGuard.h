// BusGuard.h — when to stop using the I2C bus, and when to try it again.
//
// Every I2C module (EEPROM, RTC, IMU) is optional: the hour meter counts and
// saves without them (ESP32 flash). So a bad bus is never a reason to restart.
// Firmware <= 2.6.0 restarted after 30 s of bus trouble; on a vehicle, where
// every key-on is a power-on, that meant a reboot loop on every trip.
//
// Instead the bus is PARKED: Wire stopped, both pins released, every module
// counted as missing. It is tried again after a pause that doubles each time
// the bus is still bad (10 s, 20 s, 40 s ... 5 min), and starts again at 10 s
// once the bus has worked for 10 minutes.
//
//   park when: transfers kept failing (timeouts / bus errors; never a NACK,
//              which is a working bus saying "nobody home") for kParkAfterMs,
//              or a bus recovery found SDA or SCL still held low.
//
// TS mental model: a tiny state machine { parked, parkedAt, pauseMs }, no hardware.
#pragma once

#include <stdint.h>

class BusGuard {
 public:
  static constexpr uint32_t kParkAfterMs = 5000;
  static constexpr uint32_t kFirstPauseMs = 10000;
  static constexpr uint32_t kMaxPauseMs = 300000;  // 5 min
  static constexpr uint32_t kHealthyMs = 600000;   // in use this long: the next pause is kFirstPauseMs again

  // Call every loop while the bus is in use. True when it must be parked now.
  bool shouldPark(uint32_t nowMs, bool failing, bool lineHeldLow) {
    if (lineHeldLow) {
      return true;  // no transfer can work until the module or short is removed
    }
    if (!failing) {
      failingActive_ = false;
      return false;
    }
    if (!failingActive_) {
      failingActive_ = true;
      failingSinceMs_ = nowMs;
    }
    return (nowMs - failingSinceMs_) >= kParkAfterMs;  // unsigned: survives the millis() wrap
  }

  // The bus was parked: by shouldPark(), or because starting it found a line held low.
  void parked(uint32_t nowMs) {
    const bool soonAgain = everParked_ && (nowMs - inUseSinceMs_) < kHealthyMs;
    pauseMs_ = soonAgain ? doubled(pauseMs_) : kFirstPauseMs;
    everParked_ = true;
    parked_ = true;
    parkedAtMs_ = nowMs;
    failingActive_ = false;
  }

  bool isParked() const { return parked_; }

  // While parked: time to start the bus again?
  bool retryDue(uint32_t nowMs) const { return parked_ && (nowMs - parkedAtMs_) >= pauseMs_; }

  // The retry found a line still held low: stay parked, wait twice as long.
  void retryFailed(uint32_t nowMs) {
    pauseMs_ = doubled(pauseMs_);
    parkedAtMs_ = nowMs;
  }

  // The retry found both lines free: the bus is in use again (modules re-attach by the presence check).
  void resumed(uint32_t nowMs) {
    parked_ = false;
    inUseSinceMs_ = nowMs;
    failingActive_ = false;
  }

  // As at boot (the `i2c` setting was switched): no pause history.
  void reset() { *this = BusGuard(); }

  uint32_t pauseMs() const { return pauseMs_; }

 private:
  bool parked_ = false;
  bool everParked_ = false;
  bool failingActive_ = false;
  uint32_t failingSinceMs_ = 0;
  uint32_t parkedAtMs_ = 0;
  uint32_t inUseSinceMs_ = 0;
  uint32_t pauseMs_ = kFirstPauseMs;

  static uint32_t doubled(uint32_t ms) { return ms >= kMaxPauseMs / 2 ? kMaxPauseMs : ms * 2; }
};
