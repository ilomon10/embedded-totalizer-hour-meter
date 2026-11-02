// HourMeter.cpp — see header.
#include "HourMeter.h"

void HourMeter::configure(bool activeHigh, uint16_t debounceMs, uint16_t pulsesPerUnit, uint16_t persistIntervalS) {
  activeHigh_ = activeHigh;
  if (debounceMs != debounceMs_) {
    levelMs_ = running_ ? debounceMs : 0;  // the counter's range changed: restart it from the current state
  }
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

// Over the last kToggleWindowTicks calls: enough level changes per second, with the pin really spending time at
// its running level, mean an AC signal (W/P terminal), not spikes on a steady level.
bool HourMeter::toggling(uint16_t edges, bool levelActive, uint32_t elapsedMs) {
  Tick& slot = window_[windowNext_];
  windowEdges_ -= slot.edges;
  windowMs_ -= slot.ms;
  windowActive_ = static_cast<uint8_t>(windowActive_ - (slot.levelActive ? 1 : 0));
  slot.edges = edges;
  slot.ms = static_cast<uint16_t>(elapsedMs > kMaxTickMs ? kMaxTickMs : elapsedMs);
  slot.levelActive = levelActive;
  windowEdges_ += slot.edges;
  windowMs_ += slot.ms;
  windowActive_ = static_cast<uint8_t>(windowActive_ + (slot.levelActive ? 1 : 0));
  windowNext_ = static_cast<uint8_t>((windowNext_ + 1) % kToggleWindowTicks);
  return windowMs_ > 0 && windowEdges_ * 1000U >= kMinToggleEdgesPerS * windowMs_ &&
         windowActive_ >= kMinToggleActiveTicks;
}

// The time since the previous call counts for the input that call saw (it held until now).
void HourMeter::integrate(bool active, uint32_t elapsedMs) {
  if (active) {
    levelMs_ = (elapsedMs >= debounceMs_ - levelMs_) ? debounceMs_ : levelMs_ + elapsedMs;
  } else {
    levelMs_ = (elapsedMs >= levelMs_) ? 0 : levelMs_ - elapsedMs;
  }
}

bool HourMeter::update(uint32_t nowMs, bool pinHigh, bool confirmed, uint16_t edges) {
  const bool levelActive = (pinHigh == activeHigh_);
  if (!started_) {
    started_ = true;
    lastUpdateMs_ = nowMs;
    inputActive_ = levelActive;  // edges counted before the first call have no time base: not used
    const bool active = inputActive_ && confirmed;
    lastActive_ = active;
    running_ = active;  // trust the first reading; debounce applies to changes
    levelMs_ = active ? debounceMs_ : 0;
    return false;
  }
  const uint32_t elapsed = nowMs - lastUpdateMs_;
  lastUpdateMs_ = nowMs;
  inputActive_ = toggling(edges, levelActive, elapsed) || levelActive;
  const bool active = inputActive_ && confirmed;
  if (running_) {
    accumulate(elapsed);
  }
  integrate(lastActive_, elapsed);
  lastActive_ = active;
  bool next = running_;
  if (debounceMs_ == 0) {
    next = active;  // no debounce: follow the input
  } else if (levelMs_ >= debounceMs_) {
    next = true;
  } else if (levelMs_ == 0) {
    next = false;
  }
  if (next != running_) {
    running_ = next;
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
  s.inputActive = inputActive_;
  s.pulsesPerUnit = pulsesPerUnit_;
  s.lastSavedEpoch = lastSavedEpoch_;
  s.journalSeq = journalSeq_;
  return s;
}
