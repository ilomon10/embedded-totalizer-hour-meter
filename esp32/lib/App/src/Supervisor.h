// Supervisor.h — when should the firmware restart itself, and what to report.
//
// The task watchdog (5 s) catches a loop() that stops. These cover the cases
// where loop() still runs but the device is useless to its host:
//
//   I2C stuck:   the bus kept timing out / erroring for kI2cStuckMs, even after
//                bus recovery. A NACK is not a failure (the module is absent).
//   USB stalled: the USB TX buffer did not drain for kUsbStallMs.
//   panic signal: kPanicZeroRun 0x00 bytes in a row on a wired port (PanicDetector).
//
// A restart loop is bounded: restarts that were not asked for are counted
// across resets (reset_history), and after kSafeModeAfter in a row the device
// boots in safe mode (no I2C at all), so USB always stays readable.
//
// TS mental model: pure functions and two tiny state machines, no hardware.
#pragma once

#include <stdint.h>

#include "Protocol.h"

class Supervisor {
 public:
  static constexpr uint32_t kI2cStuckMs = 30000;
  static constexpr uint32_t kUsbStallMs = 10000;
  static constexpr uint32_t kHealthyUptimeMs = 600000;  // 10 min without trouble clears the restart count

  // Call every loop. Returns the reason to restart now, or LastCause::None.
  LastCause update(uint32_t nowMs, bool i2cFailing, bool usbBlocked) {
    if (stuckFor(i2c_, i2cFailing, nowMs, kI2cStuckMs)) {
      return LastCause::I2cStuck;
    }
    if (stuckFor(usb_, usbBlocked, nowMs, kUsbStallMs)) {
      return LastCause::UsbStalled;
    }
    return LastCause::None;
  }

  // True exactly once, when the device has run kHealthyUptimeMs since boot.
  bool healthyUptimeReached(uint32_t uptimeMs) {
    if (healthyReported_ || uptimeMs < kHealthyUptimeMs) {
      return false;
    }
    healthyReported_ = true;
    return true;
  }

 private:
  struct Condition {
    bool active = false;
    uint32_t sinceMs = 0;
  };
  Condition i2c_;
  Condition usb_;
  bool healthyReported_ = false;

  static bool stuckFor(Condition& c, bool bad, uint32_t nowMs, uint32_t limitMs) {
    if (!bad) {
      c.active = false;
      return false;
    }
    if (!c.active) {
      c.active = true;
      c.sinceMs = nowMs;
    }
    return (nowMs - c.sinceMs) >= limitMs;  // unsigned: survives the millis() wrap
  }
};

// Counts consecutive 0x00 bytes on one port; true once the run reaches kPanicZeroRun.
class PanicDetector {
 public:
  bool feed(uint8_t b) {
    if (b != 0) {
      run_ = 0;
      return false;
    }
    if (run_ < kPanicZeroRun) {
      run_++;
    }
    return run_ >= kPanicZeroRun;
  }
  void reset() { run_ = 0; }

 private:
  uint8_t run_ = 0;
};

namespace reset_history {

constexpr uint8_t kSafeModeAfter = 3;

// esp_reset_reason_t values (ESP-IDF; also documented for tag 58).
constexpr uint8_t kResetPowerOn = 1;
constexpr uint8_t kResetExternal = 2;
constexpr uint8_t kResetPanic = 4;
constexpr uint8_t kResetIntWdt = 5;
constexpr uint8_t kResetTaskWdt = 6;
constexpr uint8_t kResetOtherWdt = 7;
constexpr uint8_t kResetBrownout = 9;

// A fresh start: nothing from the previous run is meaningful (or RAM is gone).
inline bool freshStart(uint8_t resetReason) {
  return resetReason == kResetPowerOn || resetReason == kResetExternal || resetReason == kResetBrownout;
}

// Why the previous run ended. `recorded` is what the firmware wrote just before
// restarting on purpose (LastCause::None if it did not).
inline LastCause classify(uint8_t resetReason, LastCause recorded) {
  if (freshStart(resetReason)) {
    return LastCause::None;
  }
  if (recorded != LastCause::None) {
    return recorded;
  }
  if (resetReason == kResetIntWdt || resetReason == kResetTaskWdt || resetReason == kResetOtherWdt) {
    return LastCause::Watchdog;
  }
  return resetReason == kResetPanic ? LastCause::Crash : LastCause::None;
}

// Restarts nobody asked for: these count towards safe mode.
inline bool unplanned(LastCause c) {
  return c == LastCause::Watchdog || c == LastCause::Crash || c == LastCause::I2cStuck ||
         c == LastCause::UsbStalled;
}

inline uint8_t nextConsecutive(uint8_t previous, LastCause c) {
  if (!unplanned(c)) {
    return 0;
  }
  return previous < 255 ? static_cast<uint8_t>(previous + 1) : previous;
}

inline bool safeMode(uint8_t consecutive) { return consecutive >= kSafeModeAfter; }

}  // namespace reset_history
