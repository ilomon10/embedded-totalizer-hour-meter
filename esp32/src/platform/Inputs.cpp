// Inputs.cpp — see header.
#include "Inputs.h"

namespace {
portMUX_TYPE gPulseMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t gPulseCount = 0;
volatile uint32_t gLastPulseUs = 0;
volatile uint32_t gMinIntervalUs = 1000;
}  // namespace

void IRAM_ATTR Inputs::onPulse() {
  const uint32_t now = micros();
  portENTER_CRITICAL_ISR(&gPulseMux);
  if (now - gLastPulseUs >= gMinIntervalUs) {
    gPulseCount++;
    gLastPulseUs = now;
  }
  portEXIT_CRITICAL_ISR(&gPulseMux);
}

void Inputs::begin(int alternatorPin, int pulsePin) {
  alternatorPin_ = alternatorPin;
  pulsePin_ = pulsePin;
  pinMode(alternatorPin_, INPUT_PULLUP);  // backup for the external 10k pull-up (PC817 open collector)
  pinMode(pulsePin_, INPUT_PULLUP);
}

void Inputs::configurePulse(bool risingEdge, uint16_t minIntervalUs) {
  detachInterrupt(digitalPinToInterrupt(pulsePin_));
  portENTER_CRITICAL(&gPulseMux);
  gMinIntervalUs = minIntervalUs;
  portEXIT_CRITICAL(&gPulseMux);
  attachInterrupt(digitalPinToInterrupt(pulsePin_), onPulse, risingEdge ? RISING : FALLING);
}

uint32_t Inputs::takePulses() {
  portENTER_CRITICAL(&gPulseMux);
  const uint32_t n = gPulseCount;
  gPulseCount = 0;
  portEXIT_CRITICAL(&gPulseMux);
  return n;
}
