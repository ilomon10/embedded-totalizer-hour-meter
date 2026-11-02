// HourMeter.h — engine run-time + pulse totalizer, pure logic (no pins, no EEPROM).
//
// The firmware calls update() every 10 ms with the alternator pin level and the
// level changes counted on that pin; the class decides whether the engine runs,
// accumulates run time, and tells the caller WHEN to save:
//
//   if (meter.update(nowMs, pinHigh, confirmed, edges) || meter.persistDue(nowMs)) {
//     journal.append(...); meter.markPersisted(nowMs, epoch, seq);
//   }
//
// update() returns true on a running -> stopped edge, so the final run time
// of every engine run is saved immediately.
//
// Engine-running input: active when the pin is at its "running" level (L/D+ or
// the oil-pressure switch: a steady level) OR when it toggles (a W/P phase
// terminal: an AC signal at hundreds of Hz, which 100 Hz sampling sees as a
// random level). Toggling means, over the last kToggleWindowTicks calls: at
// least kMinToggleEdgesPerS level changes per second AND the pin seen at its
// running level in at least kMinToggleActiveTicks samples. Noise spikes on a
// steady level are too short to be sampled, so they never count as toggling.
//
// Debounce: integrating. A counter between 0 and debounceMs goes up while the
// input is active and down while it is not; the engine starts at the top and
// stops at 0. A clean signal switches after debounceMs, as before; a flickering
// one follows the level it has most of the time instead of never settling.
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

  // A W/P terminal at engine idle gives >= 150 Hz (300 edges/s), the pin at its running level about half the time.
  static constexpr uint8_t kToggleWindowTicks = 10;     // update() calls: 100 ms at the 100 Hz input rate
  static constexpr uint32_t kMinToggleEdgesPerS = 80;   // 40 Hz
  static constexpr uint8_t kMinToggleActiveTicks = 2;   // samples at the running level, of the window's
  static constexpr uint32_t kMaxTickMs = 60000;         // a longer call gap counts as this long (no overflow)

  // Feed the alternator pin level, whether the engine is confirmed running by
  // other means (RunConfirm; true when that is off), and the pin's level changes
  // since the previous call. The engine counts as running only when the input
  // and the confirmation agree; the debounce applies to the combination.
  // Returns true when the engine just stopped.
  bool update(uint32_t nowMs, bool pinHigh, bool confirmed = true, uint16_t edges = 0);

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
  bool inputActive_ = false;  // engine-running input (level or toggling), before confirmation
  bool lastActive_ = false;   // input and confirmation at the previous call
  uint32_t levelMs_ = 0;      // integrating debounce, 0..debounceMs_
  uint32_t lastUpdateMs_ = 0;
  bool started_ = false;
  // The toggling window: one slot per update() call.
  struct Tick {
    uint16_t edges = 0;
    uint16_t ms = 0;
    bool levelActive = false;
  };
  Tick window_[kToggleWindowTicks] = {};
  uint32_t windowEdges_ = 0;
  uint32_t windowMs_ = 0;
  uint8_t windowActive_ = 0;
  uint8_t windowNext_ = 0;

  bool dirty_ = false;
  uint32_t lastPersistMs_ = 0;
  uint32_t lastSavedEpoch_ = 0;
  uint32_t journalSeq_ = 0;

  void accumulate(uint32_t elapsedMs);
  bool toggling(uint16_t edges, bool levelActive, uint32_t elapsedMs);
  void integrate(bool active, uint32_t elapsedMs);
};
