// TimeKeeper.h — UTC time between RTC reads, and what to do when the RTC
// cannot be trusted (no battery, flat battery, chip missing).
//
// Reading the RTC over I2C every time we need a timestamp is wasteful, so we
// read it every rtcSyncIntervalS and extrapolate with millis() in between.
// Time is ALWAYS UTC Unix seconds; the device has no timezone (by design).
//
// Where the time came from matters:
//   Rtc  - read from a DS3231 whose oscillator never stopped (survives power-off)
//   Host - sent by the app with setTime; survives power-off only if the RTC
//          could store it, otherwise it is lost at the next reboot
#pragma once

#include <stdint.h>

#include "Status.h"

enum class TimeSource : uint8_t { None = 0, Rtc = 1, Host = 2 };

class TimeKeeper {
 public:
  void sync(uint32_t epoch, uint32_t nowMs, TimeSource source) {
    epoch_ = epoch;
    syncMs_ = nowMs;
    source_ = source;
  }
  void invalidate() { source_ = TimeSource::None; }
  bool valid() const { return source_ != TimeSource::None; }
  TimeSource source() const { return source_; }

  // 0 when invalid, so callers cannot mistake "unknown" for a real time.
  uint32_t nowEpoch(uint32_t nowMs) const { return valid() ? epoch_ + (nowMs - syncMs_) / 1000UL : 0; }

 private:
  uint32_t epoch_ = 0;
  uint32_t syncMs_ = 0;
  TimeSource source_ = TimeSource::None;
};

namespace time_policy {

// What to do with the result of a periodic RTC read.
enum class RtcAction : uint8_t {
  UseRtc,         // RTC time is good: adopt it
  RepairRtc,      // RTC lost its time but we still know it (RAM): write it back
  MarkInvalid,    // RTC lost its time and we do not know it either
  KeepExtrapolating,  // bus glitch: keep the RAM clock running, retry next sync
};

inline RtcAction onRtcRead(Status readStatus, bool ramTimeValid) {
  if (readStatus == Status::Ok) {
    return RtcAction::UseRtc;
  }
  if (readStatus == Status::TimeInvalid) {
    return ramTimeValid ? RtcAction::RepairRtc : RtcAction::MarkInvalid;
  }
  return RtcAction::KeepExtrapolating;
}

// At boot: the RTC says "oscillator stopped" although the last counter save
// was stamped with a valid time. So the time WAS set and got lost during the
// power-off: no backup battery (or a flat one). A brand-new device (never set)
// is not reported, because its journal has no time-stamped save yet.
inline bool batteryLost(bool rtcTimeValidAtBoot, bool lastSaveHadValidTime) {
  return !rtcTimeValidAtBoot && lastSaveHadValidTime;
}

}  // namespace time_policy
