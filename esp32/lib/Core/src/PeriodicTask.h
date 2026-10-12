// PeriodicTask.h — a polled fixed-rate timer.
//
// TS mental model: setInterval(fn, period), except we poll instead of using
// callbacks (NASA rule: no function pointers in control flow):
//
//   if (imuTask.due(clock.nowUs())) { sampleImu(); }
//
// The schedule is fixed-rate (next = previous + period), so it does not drift.
// If the loop falls far behind, it skips ahead instead of firing a burst and
// counts the miss in overruns().
#pragma once

#include <stdint.h>

class PeriodicTask {
 public:
  // At most this many periods may be caught up after a stall before skipping.
  static constexpr uint32_t kMaxCatchUp = 2;

  explicit PeriodicTask(uint32_t periodUs = 1000000) : periodUs_(periodUs == 0 ? 1 : periodUs) {}

  // Change the period at runtime (e.g. a new setting). Takes effect from now.
  void setPeriodUs(uint32_t periodUs, uint32_t nowUs) {
    periodUs_ = (periodUs == 0) ? 1 : periodUs;
    nextUs_ = nowUs + periodUs_;
    started_ = true;
  }

  uint32_t periodUs() const { return periodUs_; }
  uint32_t overruns() const { return overruns_; }

  // True once per period. Safe across the 71-minute micros() wrap-around.
  bool due(uint32_t nowUs) {
    if (!started_) {
      nextUs_ = nowUs + periodUs_;
      started_ = true;
      return false;
    }
    const int32_t late = static_cast<int32_t>(nowUs - nextUs_);
    if (late < 0) {
      return false;
    }
    if (static_cast<uint32_t>(late) >= periodUs_ * kMaxCatchUp) {
      overruns_++;
      nextUs_ = nowUs + periodUs_;  // resynchronise; drop the missed ticks
    } else {
      nextUs_ += periodUs_;
    }
    return true;
  }

 private:
  uint32_t periodUs_;
  uint32_t nextUs_ = 0;
  uint32_t overruns_ = 0;
  bool started_ = false;
};
