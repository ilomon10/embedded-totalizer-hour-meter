// Inputs.h — alternator level + edge counter, and the interrupt-driven pulse counter.
//
// The ISRs only increment counters (keep ISRs tiny); the main loop collects
// them with takeAltEdges() / takePulses(). Pulse debounce: edges closer than
// pulseMinIntervalUs are ignored (contact bounce / electrical noise).
//
// Alternator edges: an L/D+ wire gives a steady level and almost no edges; a
// W/P phase terminal toggles hundreds of times a second while the engine runs.
// HourMeter turns the level and the edge count into "engine running".
#pragma once

#include <Arduino.h>

class Inputs {
 public:
  void begin(int alternatorPin, int pulsePin);
  // Re-attach the pulse interrupt with new settings. Not enabled: GPIO26 is
  // ignored (no interrupt) and pulses not yet collected are dropped.
  void configurePulse(bool enabled, bool risingEdge, uint16_t minIntervalUs);

  bool alternatorHigh() const { return digitalRead(alternatorPin_) == HIGH; }

  // Alternator level changes since the previous call (atomic read-and-clear, capped at 65535).
  uint16_t takeAltEdges();

  // Pulses since the previous call (atomic read-and-clear).
  uint32_t takePulses();

 private:
  int alternatorPin_ = -1;
  int pulsePin_ = -1;
  static void IRAM_ATTR onPulse();
  static void IRAM_ATTR onAltEdge();
};
