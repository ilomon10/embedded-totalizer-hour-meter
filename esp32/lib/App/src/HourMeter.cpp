// HourMeter.cpp — see header.
#include "HourMeter.h"

void HourMeter::configure(bool activeHigh, uint16_t debounceMs, uint16_t pulsesPerUnit, uint16_t persistIntervalS) {
  activeHigh_ = activeHigh;
  debounceMs_ = debounceMs;
  pulsesPerUnit_ = (pulsesPerUnit == 0) ? 1 : pulsesPerUnit;
  persistIntervalMs_ = static_cast<uint32_t>(persistIntervalS) * 1000UL;
}

void HourMeter::restore(uint32_t runSeconds, uint32_t totalCount, uint32_t savedEpoch, uint32_t journalSeq) {
  runSeconds_ = runSeconds;
  totalCount_ = totalCount;
  runMsRemainder_ = 0;
  lastSavedEpoch_ = savedEpoch;
  journalSeq_ = journalSeq;
  dirty_ = false;
}

void HourMeter::mergeStored(uint32_t runSeconds, uint32_t totalCount, uint32_t savedEpoch, uint32_t journalSeq) {
  const bool countedSomething = (runSeconds_ != 0) || (totalCount_ != 0) || (runMsRemainder_ != 0);
  runSeconds_ += runSeconds;
  totalCount_ += totalCount;
  lastSavedEpoch_ = savedEpoch;
  journalSeq_ = journalSeq;
  dirty_ = dirty_ || countedSomething;  // save the merged total soon
}

void HourMeter::accumulate(uint32_t elapsedMs) {
  runMsRemainder_ += elapsedMs;
  const uint32_t whole = runMsRemainder_ / 1000UL;
  if (whole > 0) {
    runSeconds_ += whole;
    runMsRemainder_ -= whole * 1000UL;
    dirty_ = true;
  }
}

bool HourMeter::update(uint32_t nowMs, bool pinHigh) {
  const bool active = (pinHigh == activeHigh_);
  if (!started_) {
    started_ = true;
    lastUpdateMs_ = nowMs;
    candidate_ = active;
    candidateSinceMs_ = nowMs;
    running_ = active;  // trust the first reading; debounce applies to changes
    return false;
  }
  const uint32_t elapsed = nowMs - lastUpdateMs_;
  lastUpdateMs_ = nowMs;
  if (running_) {
    accumulate(elapsed);
  }
  if (active != candidate_) {
    candidate_ = active;
    candidateSinceMs_ = nowMs;
  }
  const bool stable = (nowMs - candidateSinceMs_) >= debounceMs_;
  if (stable && candidate_ != running_) {
    running_ = candidate_;
    return !running_;  // true only on running -> stopped
  }
  return false;
}

void HourMeter::addPulses(uint32_t count) {
  if (count == 0) {
    return;
  }
  totalCount_ += count;
  dirty_ = true;
}

void HourMeter::preset(bool setRun, uint32_t runSeconds, bool setCount, uint32_t totalCount) {
  if (setRun) {
    runSeconds_ = runSeconds;
    runMsRemainder_ = 0;
  }
  if (setCount) {
    totalCount_ = totalCount;
  }
  dirty_ = dirty_ || setRun || setCount;
}

bool HourMeter::persistDue(uint32_t nowMs) const {
  return dirty_ && (nowMs - lastPersistMs_) >= persistIntervalMs_;
}

void HourMeter::markPersisted(uint32_t nowMs, uint32_t epoch, uint32_t journalSeq) {
  dirty_ = false;
  lastPersistMs_ = nowMs;
  lastSavedEpoch_ = epoch;
  journalSeq_ = journalSeq;
}

HourMeterSnapshot HourMeter::snapshot() const {
  HourMeterSnapshot s;
  s.runSeconds = runSeconds_;
  s.totalCount = totalCount_;
  s.running = running_;
  s.pulsesPerUnit = pulsesPerUnit_;
  s.lastSavedEpoch = lastSavedEpoch_;
  s.journalSeq = journalSeq_;
  return s;
}
