// Status.h — the error type every fallible function returns.
//
// TypeScript mental model:
//   type Status = 'Ok' | 'I2cNack' | 'I2cTimeout' | ...
// A function that can fail returns a Status (or a Result<T>, see Result.h)
// instead of throwing. [[nodiscard]] makes the compiler reject callers that
// ignore it — like a lint rule "no-floating-promises" for errors.
#pragma once

#include <stdint.h>

enum class [[nodiscard]] Status : uint8_t {
  Ok = 0,
  InvalidArg,     // caller passed a bad parameter (bug or bad command value)
  OutOfRange,     // value outside its allowed range
  I2cNack,        // device did not acknowledge (missing, busy, wrong address)
  I2cTimeout,     // bus stuck or device holding SCL
  I2cBusError,    // other bus failure (arbitration, short read)
  DeviceMissing,  // WHO_AM_I / probe failed at begin()
  NotReady,       // no new data yet (not an error for the caller's logic)
  Crc,            // stored data failed its checksum
  NotFound,       // nothing valid stored yet
  VerifyFailed,   // read-back after write did not match
  TimeInvalid,    // RTC oscillator stopped; time must be set
  Busy,           // operation already running (e.g. calibration)
  Unsupported,    // feature not present on this hardware (e.g. no magnetometer)
};

// Short stable name for logs and docs (order matches the enum above).
inline const char* statusName(Status s) {
  static const char* const kNames[] = {
      "Ok",       "InvalidArg", "OutOfRange",   "I2cNack",     "I2cTimeout",
      "I2cBusError", "DeviceMissing", "NotReady", "Crc",         "NotFound",
      "VerifyFailed", "TimeInvalid", "Busy",     "Unsupported",
  };
  const uint8_t i = static_cast<uint8_t>(s);
  return i < sizeof(kNames) / sizeof(kNames[0]) ? kNames[i] : "Unknown";
}

inline bool isOk(Status s) { return s == Status::Ok; }
