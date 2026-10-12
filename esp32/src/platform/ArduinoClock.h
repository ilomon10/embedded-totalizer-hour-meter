// ArduinoClock.h — IClock backed by millis()/micros()/delay().
#pragma once

#include <Arduino.h>

#include "IClock.h"

class ArduinoClock : public IClock {
 public:
  uint32_t nowMs() const override { return millis(); }
  uint32_t nowUs() const override { return micros(); }
  void delayMs(uint32_t ms) override { delay(ms); }
};
