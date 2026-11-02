// Inputs.cpp — see header.
#include "Inputs.h"

namespace {
portMUX_TYPE gPulseMux = portMUX_INITIALIZER_UNLOCKED;
volatile uint32_t gPulseCount = 0;
volatile uint32_t gLastPulseUs = 0;
volatile uint32_t gMinIntervalUs = 1000;
volatile uint32_t gAltEdges = 0;
volatile uint32_t gLastAltEdgeUs = 0;
// Ringing and spike pairs count once; a W/P terminal's half-period is above 250 us even at full engine speed.
constexpr uint32_t kMinAltEdgeIntervalUs = 100;
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

void IRAM_ATTR Inputs::onAltEdge() {
  const uint32_t now = micros();
  portENTER_CRITICAL_ISR(&gPulseMux);
  if (now - gLastAltEdgeUs >= kMinAltEdgeIntervalUs) {
    gAltEdges++;
    gLastAltEdgeUs = now;
  }
  portEXIT_CRITICAL_ISR(&gPulseMux);
}

void Inputs::begin(int alternatorPin, int pulsePin) {
  alternatorPin_ = alternatorPin;
  pulsePin_ = pulsePin;
  pinMode(alternatorPin_, INPUT_PULLUP);  // backup for the external 10k pull-up (PC817 open collector)
  pinMode(pulsePin_, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(alternatorPin_), onAltEdge, CHANGE);
}

void Inputs::configurePulse(bool enabled, bool risingEdge, uint16_t minIntervalUs) {
  detachInterrupt(digitalPinToInterrupt(pulsePin_));
  portENTER_CRITICAL(&gPulseMux);
  gMinIntervalUs = minIntervalUs;
  if (!enabled) {
    gPulseCount = 0;
  }
  portEXIT_CRITICAL(&gPulseMux);
  if (enabled) {
    attachInterrupt(digitalPinToInterrupt(pulsePin_), onPulse, risingEdge ? RISING : FALLING);
  }
}

uint16_t Inputs::takeAltEdges() {
  portENTER_CRITICAL(&gPulseMux);
  const uint32_t n = gAltEdges;
  gAltEdges = 0;
  portEXIT_CRITICAL(&gPulseMux);
  return n > 0xFFFFU ? 0xFFFFU : static_cast<uint16_t>(n);
}

uint32_t Inputs::takePulses() {
  portENTER_CRITICAL(&gPulseMux);
  const uint32_t n = gPulseCount;
  gPulseCount = 0;
  portEXIT_CRITICAL(&gPulseMux);
  return n;
}
