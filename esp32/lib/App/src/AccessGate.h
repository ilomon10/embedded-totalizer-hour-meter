// AccessGate.h — PIN lock for remote (Bluetooth) sessions.
//
// Bluetooth pairing on the ESP32 Arduino core uses Simple Secure Pairing
// ("just works"), so a pairing PIN cannot be enforced. Access is protected in
// the protocol instead: a Bluetooth session starts LOCKED; the app must send
// COMMAND unlock=<PIN>. While locked the device accepts nothing else and sends
// no telemetry over Bluetooth. Wired ports (USB, UART pins) need physical
// access and are never locked.
//
// Brute force protection: after kMaxFailures wrong PINs, every unlock is
// refused for kLockoutMs (10 000 PINs x 60 s / 5 tries is about 33 hours).
#pragma once

#include <stdint.h>

#include "Protocol.h"

class AccessGate {
 public:
  static constexpr uint8_t kMaxFailures = 5;
  static constexpr uint32_t kLockoutMs = 60000;

  bool unlocked() const { return unlocked_; }

  // New client or disconnect: lock again (failure count survives, so
  // reconnecting does not reset the brute-force counter).
  void lock() { unlocked_ = false; }

  // Check a PIN. Ok unlocks; BadPin counts a failure; Locked during lockout.
  AckStatus tryUnlock(uint32_t pin, uint32_t expectedPin, uint32_t nowMs) {
    if (lockedOut_ && static_cast<int32_t>(nowMs - lockoutUntilMs_) < 0) {
      return AckStatus::Locked;
    }
    lockedOut_ = false;
    if (pin == expectedPin) {
      unlocked_ = true;
      failures_ = 0;
      return AckStatus::Ok;
    }
    failures_++;
    if (failures_ >= kMaxFailures) {
      failures_ = 0;
      lockedOut_ = true;
      lockoutUntilMs_ = nowMs + kLockoutMs;
    }
    return AckStatus::BadPin;
  }

 private:
  bool unlocked_ = false;
  bool lockedOut_ = false;
  uint8_t failures_ = 0;
  uint32_t lockoutUntilMs_ = 0;
};
