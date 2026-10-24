// StorageMirror.h — the settings and the counters kept twice: in the ESP32's own flash (FlashStore, always)
// and in the I2C EEPROM (Journal + SettingsStore, when one is fitted).
//
//   save     to both stores, with one new seq above anything either holds
//   boot     the flash is the main store: it gets every save. The EEPROM's values are taken when the flash
//            has none (a new ESP32 board, the first boot after the update). A store that does not hold the
//            values in use is brought up to date at once.
//   history  every counter record carries a history id (`lineage`). Within one history the seqs order the
//            saves, so the newest save wins in either store: the EEPROM is ahead of the flash only when the
//            history went on without this flash (the EEPROM ran in another ESP32, or flash writes failed).
//            An EEPROM from ANOTHER history (an older chip, another device's, or one the device could not
//            read at boot) is ADDED to the counters the device counted from zero without knowing their
//            value: the engine time in both is real. Counters the device knows (stored, preset, reset,
//            merged once) keep their value, and the EEPROM is given the device's values.
//   late     an EEPROM plugged in while running follows the same rules. When it holds a save of this
//            history the device never made, what the other ESP32 counted (beyond the counters this device
//            last gave the EEPROM) is added to what this device counted meanwhile. A record the device wrote
//            itself is never added again.
//   settings carry no history id: the flash's win, and the EEPROM's are used when the flash has none. The
//            stores are compared by content, so another device's EEPROM with the same seq is still updated.
//
// Seqs are only compared within one history. A fork (both stores saved apart after a split, e.g. the EEPROM
// ran in another ESP32 while this one ran without it) cannot be merged exactly: at boot the newer save wins.
// TS mental model: the flash is the database, the EEPROM a replica that can also seed an empty database.
#pragma once

#include <stdint.h>

#include "FlashStore.h"
#include "Journal.h"
#include "SettingsStore.h"

namespace storage_mirror {

// The seq for the next save: above every seq given, so the new record is the newest in every store.
inline uint32_t nextSeq(uint32_t a, uint32_t b, uint32_t c) {
  uint32_t m = a > b ? a : b;
  m = m > c ? m : c;
  return m == UINT32_MAX ? m : m + 1;  // 4 billion saves: never reached, but never wrap to 0
}

// The device's history `own` with another history `other` added to the counters `own` counted from zero.
// Those counters are known from then on, so the same history is never added twice.
JournalRecord combine(const JournalRecord& own, const JournalRecord& other);

}  // namespace storage_mirror

// What the stores hold at boot: the settings and counters in use, each of which may be missing.
struct StoredState {
  bool hasSettings = false;
  Settings settings{};
  bool hasCounters = false;
  JournalRecord counters{};  // seq: the newest save of these values
};

// What an EEPROM plugged in while running gives.
struct LateEeprom {
  uint32_t addRunSeconds = 0;   // add to the hour meter (counted from zero, or counted on in another ESP32)
  uint32_t addTotalCount = 0;   // add to the totalizer, likewise
  bool hasSettings = false;     // its settings, when they were asked for
  Settings settings{};
  bool settingsBehind = false;  // it does not hold the settings in use
};

class StorageMirror {
 public:
  StorageMirror(FlashStore& flash, Journal& journal, SettingsStore& settings)
      : flash_(flash), journal_(journal), settings_(settings) {}

  // Boot. `eeprom`: the EEPROM is attached and its journal scanned. `freshLineage`: a random non-zero id for
  // a new history (no counters stored anywhere, or the EEPROM's are from firmware 2.5.0 or older).
  StoredState adopt(bool eeprom, uint32_t freshLineage);

  // An EEPROM attached while running: what it adds (see the header comment), and its settings when
  // `wantSettings`. `inUse`: the device's settings, to tell whether the EEPROM holds them. Reads its
  // settings copies either way, so later saves alternate A/B right.
  LateEeprom fromLateEeprom(bool wantSettings, const Settings& inUse);

  // A preset or a reset: these counters are known from now on, and set by hand.
  void anchor(bool runSeconds, bool totalCount);

  // The attached EEPROM does not hold the device's newest counters.
  bool eepromCountersBehind() const;

  // Save to the flash and, when `eeprom`, to the EEPROM, with one new seq. Ok when at least one store kept
  // it; NotFound when there is no store at all. A store that failed shows in lastSaveFailed(). Settings the
  // flash already holds are not written to it again (a retry for the EEPROM erases nothing).
  Status saveCounters(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags, bool eeprom);
  Status saveSettings(const Settings& s, bool eeprom);

  bool anyStore(bool eeprom) const { return flash_.available() || eeprom; }
  uint32_t counterSeq() const { return counterSeq_; }
  uint32_t settingsSeq() const { return settingsSeq_; }
  SettingsSource settingsSource() const { return source_; }
  bool lastSaveFailed() const { return lastSaveFailed_; }
  uint32_t lineage() const { return lineage_; }
  bool runFromZero() const { return runFromZero_; }
  bool countFromZero() const { return countFromZero_; }

 private:
  // The result of one save to several stores.
  struct Outcome {
    bool kept = false;            // at least one store has it
    Status failure = Status::Ok;  // the first store that failed
    void add(Status s) {
      if (s == Status::Ok) {
        kept = true;
      } else if (failure == Status::Ok) {
        failure = s;
      }
    }
  };

  FlashStore& flash_;
  Journal& journal_;
  SettingsStore& settings_;
  uint32_t counterSeq_ = 0;   // the newest counter save of this history
  uint32_t settingsSeq_ = 0;  // the settings in use
  SettingsSource source_ = SettingsSource::Defaults;
  bool lastSaveFailed_ = false;
  uint32_t lineage_ = 0;        // this device's history
  bool runFromZero_ = false;    // the hour meter started at 0, its real value unknown
  bool countFromZero_ = false;  // the totalizer likewise
  // The counters this device last gave the EEPROM (or booted with): where another ESP32 that got the
  // EEPROM went on from.
  uint32_t baseRun_ = 0;
  uint32_t baseCount_ = 0;
  bool runSetByHand_ = false;  // preset or reset since the EEPROM last got a save: nothing is added to it
  bool countSetByHand_ = false;

  void adoptSettings(bool eeprom, StoredState& out);
  void adoptCounters(bool eeprom, uint32_t freshLineage, StoredState& out);
  bool flashHolds(const Settings& s) const;
  Outcome writeSettings(const Settings& s, bool eeprom);
  Outcome writeCounters(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags, bool eeprom);
};
