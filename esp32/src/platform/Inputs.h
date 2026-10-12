// Inputs.h — alternator level + interrupt-driven pulse counter.
//
// The pulse ISR only increments a counter (keep ISRs tiny); the main loop
// collects the count with takePulses(). Debounce: edges closer than
// pulseMinIntervalUs are ignored (contact bounce / electrical noise).
#pragma once

#include <Arduino.h>

class Inputs {
 public:
  void begin(int alternatorPin, int pulsePin);
  // Re-attach the interrupt with new edge/debounce settings.
  void configurePulse(bool risingEdge, uint16_t minIntervalUs);

  bool alternatorHigh() const { return digitalRead(alternatorPin_) == HIGH; }

  // Pulses since the previous call (atomic read-and-clear).
  uint32_t takePulses();

 private:
  int alternatorPin_ = -1;
  int pulsePin_ = -1;
  static void IRAM_ATTR onPulse();
};
