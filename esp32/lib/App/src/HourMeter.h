// HourMeter.h — engine run-time + pulse totalizer, pure logic (no pins, no EEPROM).
//
// The firmware calls update() every few ms with the alternator pin level; the
// class debounces it, accumulates run time, and tells the caller WHEN to save:
//
//   if (meter.update(nowMs, pinHigh) || meter.persistDue(nowMs)) {
//     journal.append(...); meter.markPersisted(nowMs, epoch, seq);
//   }
//
// update() returns true on a running -> stopped edge, so the final run time
// of every engine run is saved immediately.
#pragma once

#include <stdint.h>

#include "Snapshots.h"

class HourMeter {
 public:
  void configure(bool activeHigh, uint16_t debounceMs, uint16_t pulsesPerUnit, uint16_t persistIntervalS);

  // Continue from the last saved values (called once at boot).
  void restore(uint32_t runSeconds, uint32_t totalCount, uint32_t savedEpoch, uint32_t journalSeq);

  // The EEPROM appeared AFTER boot: add the stored totals to what was counted
  // so far (engine time without storage is still real engine time). Must be
  // called at most once per boot, or counts would be added twice.
  void mergeStored(uint32_t runSeconds, uint32_t totalCount, uint32_t savedEpoch, uint32_t journalSeq);

  // Feed the raw alternator level, and whether the engine is confirmed running
  // by other means (RunConfirm; true when that is off). The engine counts as
  // running only when both agree; the debounce applies to the combination.
  // Returns true when the engine just stopped.
  bool update(uint32_t nowMs, bool pinHigh, bool confirmed = true);

  // Pulses counted by the interrupt since the last call.
  void addPulses(uint32_t count);

  // Overwrite counters (command). Marks the state dirty so it is saved.
  void preset(bool setRun, uint32_t runSeconds, bool setCount, uint32_t totalCount);

  bool persistDue(uint32_t nowMs) const;
  // Storage came back after being lost: make sure the RAM counters get saved.
  void markDirty() { dirty_ = true; }
  bool dirty() const { return dirty_; }
  void markPersisted(uint32_t nowMs, uint32_t epoch, uint32_t journalSeq);
  // A save failed: keep the data dirty but wait one interval before retrying.
  void deferPersist(uint32_t nowMs) { lastPersistMs_ = nowMs; }

  bool running() const { return running_; }
  HourMeterSnapshot snapshot() const;

 private:
  bool activeHigh_ = true;
  uint16_t debounceMs_ = 200;
  uint16_t pulsesPerUnit_ = 1;
  uint32_t persistIntervalMs_ = 60000;

  uint32_t runSeconds_ = 0;
  uint32_t runMsRemainder_ = 0;
  uint32_t totalCount_ = 0;
  bool running_ = false;
  bool inputActive_ = false;  // raw alternator input, before confirmation
  bool candidate_ = false;
  uint32_t candidateSinceMs_ = 0;
  uint32_t lastUpdateMs_ = 0;
  bool started_ = false;

  bool dirty_ = false;
  uint32_t lastPersistMs_ = 0;
  uint32_t lastSavedEpoch_ = 0;
  uint32_t journalSeq_ = 0;

  void accumulate(uint32_t elapsedMs);
};
