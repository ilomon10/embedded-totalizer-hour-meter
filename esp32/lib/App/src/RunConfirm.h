// RunConfirm.h — "is the engine really running?" from the IMU's vibration.
//
// The engine-running input should come from a wire that is live only while the
// alternator charges (L / D+ at the alternator, or the oil-pressure lamp; see
// docs/WIRING.md). When only a key-on wire is reachable, or as a safety net,
// the `runVibMinMg` setting adds a second condition: run time counts only while
// the vibration RMS shows the engine turning.
//
//   minMg == 0          -> always confirmed (feature off, the input alone decides)
//   no IMU              -> always confirmed (never lose hours to an unplugged IMU)
//   no vibration window -> not confirmed yet (at most vibrationWindowMs after boot)
//   otherwise           -> confirmed at rms >= minMg, released below 70 % of it,
//                          so a quiet moment at idle does not stop the count
//
// TS mental model: a tiny state machine { confirmed: boolean }.
#pragma once

#include <stdint.h>

class RunConfirm {
 public:
  static constexpr uint8_t kReleasePercent = 70;

  bool update(bool imuPresent, bool hasVibration, float rmsMg, uint16_t minMg) {
    if (minMg == 0 || !imuPresent) {
      confirmed_ = true;
      return confirmed_;
    }
    if (!hasVibration) {
      confirmed_ = false;
      return confirmed_;
    }
    const float releaseMg = static_cast<float>(minMg) * kReleasePercent / 100.0f;
    if (rmsMg >= static_cast<float>(minMg)) {
      confirmed_ = true;
    } else if (rmsMg < releaseMg) {
      confirmed_ = false;
    }
    return confirmed_;
  }

  bool confirmed() const { return confirmed_; }

 private:
  bool confirmed_ = false;
};
