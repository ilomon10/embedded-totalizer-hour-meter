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
//
// Time is kept as "microseconds since the last tick" (unsigned), so a task that
// is not polled for a long time (its module was missing for an hour) fires at
// the next poll instead of waiting for the 32-bit clock to come round again,
// and periods up to 71 minutes work.
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
    lastUs_ = nowUs;
    started_ = true;
  }

  uint32_t periodUs() const { return periodUs_; }
  uint32_t overruns() const { return overruns_; }

  // True once per period. Safe across the 71-minute micros() wrap-around.
  bool due(uint32_t nowUs) {
    if (!started_) {
      lastUs_ = nowUs;
      started_ = true;
      return false;
    }
    const uint32_t elapsed = nowUs - lastUs_;  // unsigned: survives the wrap
    if (elapsed < periodUs_) {
      return false;
    }
    if ((elapsed - periodUs_) / kMaxCatchUp >= periodUs_) {  // late by kMaxCatchUp periods or more (no overflow)
      overruns_++;
      lastUs_ = nowUs;  // resynchronise; drop the missed ticks
    } else {
      lastUs_ += periodUs_;
    }
    return true;
  }

 private:
  uint32_t periodUs_;
  uint32_t lastUs_ = 0;  // when the last tick was due
  uint32_t overruns_ = 0;
  bool started_ = false;
};
