// FakeClock.h — IClock for tests: time only moves when the test (or delayMs) says so.
#pragma once

#include "IClock.h"

class FakeClock : public IClock {
 public:
  uint32_t ms = 0;
  uint32_t nowMs() const override { return ms; }
  uint32_t nowUs() const override { return ms * 1000u; }
  void delayMs(uint32_t d) override { ms += d; }
};
