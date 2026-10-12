// Presence.h — is a pluggable module (EEPROM, RTC, IMU) there right now?
//
// The firmware is modular: any module may be missing at boot, be plugged in
// later, or be unplugged while running. A module is declared LOST only after
// kLostAfter consecutive failed checks, so a single glitch (or an EEPROM busy
// with a write cycle) never flips it. A missing module is re-probed by the
// application every presence period and attached as soon as it answers.
//
// TS mental model: a tiny state machine { present: boolean; failures: number }.
#pragma once

#include <stdint.h>

class PresenceTracker {
 public:
  static constexpr uint8_t kLostAfter = 3;

  void markPresent() {
    present_ = true;
    failures_ = 0;
  }
  void markAbsent() {
    present_ = false;
    failures_ = 0;
  }
  void recordSuccess() { failures_ = 0; }

  // Returns true exactly once: on the failure that declares the module lost.
  bool recordFailure() {
    if (!present_) {
      return false;
    }
    failures_++;
    if (failures_ < kLostAfter) {
      return false;
    }
    markAbsent();
    return true;
  }

  bool present() const { return present_; }

 private:
  bool present_ = false;
  uint8_t failures_ = 0;
};
