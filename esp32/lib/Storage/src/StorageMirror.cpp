// StorageMirror.cpp — see header.
#include "StorageMirror.h"

using storage_mirror::nextSeq;

namespace {

constexpr uint8_t kFromZero = journal_flags::kRunFromZero | journal_flags::kCountFromZero;

uint32_t seqOf(bool has, const JournalRecord& r) { return has ? r.seq : 0; }

uint32_t addSaturated(uint32_t a, uint32_t b) { return b > UINT32_MAX - a ? UINT32_MAX : a + b; }

// How far `now` went beyond `base`: never negative (a reset in the other ESP32 subtracts nothing here).
uint32_t beyond(uint32_t now, uint32_t base) { return now > base ? now - base : 0; }

// The same save: same history, same seq, same values.
bool sameRecord(bool has, const JournalRecord& a, const JournalRecord& b) {
  return has && a.lineage == b.lineage && a.seq == b.seq && a.runSeconds == b.runSeconds &&
         a.totalCount == b.totalCount && a.flags == b.flags;
}

}  // namespace

JournalRecord storage_mirror::combine(const JournalRecord& own, const JournalRecord& other) {
  JournalRecord r = own;
  if ((own.flags & journal_flags::kRunFromZero) != 0) {
    r.runSeconds = addSaturated(own.runSeconds, other.runSeconds);
    r.flags = static_cast<uint8_t>(r.flags & ~journal_flags::kRunFromZero);
  }
  if ((own.flags & journal_flags::kCountFromZero) != 0) {
    r.totalCount = addSaturated(own.totalCount, other.totalCount);
    r.flags = static_cast<uint8_t>(r.flags & ~journal_flags::kCountFromZero);
  }
  return r;
}

// ------------------------------------------------------------------------------------------ boot --

StoredState StorageMirror::adopt(bool eeprom, uint32_t freshLineage) {
  StoredState out;
  lastSaveFailed_ = false;
  adoptSettings(eeprom, out);
  adoptCounters(eeprom, freshLineage, out);
  return out;
}

void StorageMirror::adoptSettings(bool eeprom, StoredState& out) {
  Settings fromEeprom;
  const bool eepromHas = eeprom && settings_.load(fromEeprom) == Status::Ok;
  if (flash_.hasSettings()) {
    flash_.loadSettings(out.settings);  // the main store
    settingsSeq_ = flash_.settingsSeq();
    source_ = flash_.settingsSource();
  } else if (eepromHas) {
    out.settings = fromEeprom;  // a new ESP32 board, or the first boot after the update
    settingsSeq_ = settings_.seq();
    source_ = settings_.source();
  } else {
    return;  // defaults
  }
  out.hasSettings = true;
  // By content: settings carry no history id, so another device's EEPROM can have the same seq.
  const bool flashBehind = flash_.available() && !flashHolds(out.settings);
  const bool eepromBehind = eeprom && !(eepromHas && sameSettings(fromEeprom, out.settings));
  if (flashBehind || eepromBehind) {
    lastSaveFailed_ = lastSaveFailed_ || writeSettings(out.settings, eepromBehind).failure != Status::Ok;
  }
}

void StorageMirror::adoptCounters(bool eeprom, uint32_t freshLineage, StoredState& out) {
  const bool eepromHas = eeprom && journal_.hasRecord();
  JournalRecord r;
  if (flash_.hasRecord()) {
    r = flash_.latest();  // the main store
    if (eepromHas) {
      const JournalRecord& e = journal_.latest();
      if (e.lineage != r.lineage) {
        r = storage_mirror::combine(r, e);  // another history: added where we counted from zero
      } else if (e.seq > r.seq) {
        r = e;  // this history went on without this flash: in another ESP32, or while flash writes failed
      }
    }
  } else if (eepromHas) {
    r = journal_.latest();  // a new ESP32 board, or the first boot after the update
  } else {
    lineage_ = freshLineage;  // nothing stored anywhere: a new history, counted from zero
    runFromZero_ = true;
    countFromZero_ = true;
    return;
  }
  lineage_ = r.lineage != 0 ? r.lineage : freshLineage;  // 0: written by firmware 2.5.0 or older
  runFromZero_ = (r.flags & journal_flags::kRunFromZero) != 0;
  countFromZero_ = (r.flags & journal_flags::kCountFromZero) != 0;
  counterSeq_ = r.seq;
  baseRun_ = r.runSeconds;
  baseCount_ = r.totalCount;
  out.hasCounters = true;
  out.counters = r;
  // A store that does not hold exactly these values in this history gets them: one save to both.
  const bool flashBehind = flash_.available() && !sameRecord(flash_.hasRecord(), flash_.latest(), r);
  const bool eepromBehind = eeprom && !sameRecord(journal_.hasRecord(), journal_.latest(), r);
  if (flashBehind || eepromBehind || r.lineage != lineage_) {
    const uint8_t timeFlag = r.flags & journal_flags::kTimeValid;
    const Outcome o = writeCounters(r.runSeconds, r.totalCount, r.epoch, timeFlag, eeprom);
    lastSaveFailed_ = lastSaveFailed_ || o.failure != Status::Ok;
    out.counters.seq = counterSeq_;
    out.counters.lineage = lineage_;
  }
}

// ---------------------------------------------------------------------------------- late EEPROM --

LateEeprom StorageMirror::fromLateEeprom(bool wantSettings, const Settings& inUse) {
  LateEeprom out;
  Settings fromEeprom;
  const bool hasSettings = settings_.load(fromEeprom) == Status::Ok;
  out.settingsBehind = !(hasSettings && sameSettings(fromEeprom, inUse));
  if (wantSettings && hasSettings) {
    out.hasSettings = true;
    out.settings = fromEeprom;
  }
  if (!journal_.hasRecord()) {
    return out;
  }
  const JournalRecord& e = journal_.latest();
  if (e.lineage != lineage_) {
    // Another history (a record of ours carries our lineage): added where we counted from zero.
    if (runFromZero_) {
      out.addRunSeconds = e.runSeconds;
      runFromZero_ = false;
    }
    if (countFromZero_) {
      out.addTotalCount = e.totalCount;
      countFromZero_ = false;
    }
  } else if (e.seq > counterSeq_) {
    // A save of this history the device never made: the EEPROM ran in another ESP32. What that one counted
    // is added to what this one counted meanwhile, except to a counter set by hand since.
    out.addRunSeconds = runSetByHand_ ? 0 : beyond(e.runSeconds, baseRun_);
    out.addTotalCount = countSetByHand_ ? 0 : beyond(e.totalCount, baseCount_);
    baseRun_ = e.runSeconds;  // added once: the same EEPROM adds nothing again, even before the next save
    baseCount_ = e.totalCount;
  }
  return out;
}

void StorageMirror::anchor(bool runSeconds, bool totalCount) {
  runFromZero_ = runFromZero_ && !runSeconds;
  countFromZero_ = countFromZero_ && !totalCount;
  runSetByHand_ = runSetByHand_ || runSeconds;
  countSetByHand_ = countSetByHand_ || totalCount;
}

bool StorageMirror::eepromCountersBehind() const {
  return !journal_.hasRecord() || journal_.latest().lineage != lineage_ || journal_.latest().seq != counterSeq_;
}

// ---------------------------------------------------------------------------------------- saves --

Status StorageMirror::saveCounters(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags,
                                   bool eeprom) {
  if (!anyStore(eeprom)) {
    return Status::NotFound;
  }
  const Outcome o = writeCounters(runSeconds, totalCount, epoch, flags, eeprom);
  lastSaveFailed_ = o.failure != Status::Ok;
  return o.kept ? Status::Ok : o.failure;
}

Status StorageMirror::saveSettings(const Settings& s, bool eeprom) {
  if (!anyStore(eeprom)) {
    return Status::NotFound;
  }
  const Outcome o = writeSettings(s, eeprom);
  lastSaveFailed_ = o.failure != Status::Ok;
  return o.kept ? Status::Ok : o.failure;
}

StorageMirror::Outcome StorageMirror::writeCounters(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch,
                                                    uint8_t flags, bool eeprom) {
  const uint32_t seq = nextSeq(counterSeq_, seqOf(flash_.hasRecord(), flash_.latest()),
                               eeprom ? seqOf(journal_.hasRecord(), journal_.latest()) : 0);
  const uint8_t history = static_cast<uint8_t>((runFromZero_ ? journal_flags::kRunFromZero : 0) |
                                               (countFromZero_ ? journal_flags::kCountFromZero : 0));
  const uint8_t recordFlags = static_cast<uint8_t>((flags & ~kFromZero) | history);
  const JournalRecord r = Journal::makeRecord(runSeconds, totalCount, epoch, recordFlags, seq, lineage_);
  Outcome o;
  if (flash_.available()) {
    o.add(flash_.append(r));
  }
  if (eeprom) {
    const Status s = journal_.append(r);
    o.add(s);
    if (s == Status::Ok) {
      baseRun_ = runSeconds;  // another ESP32 that gets this EEPROM goes on from here
      baseCount_ = totalCount;
      runSetByHand_ = false;
      countSetByHand_ = false;
    }
  }
  if (o.kept) {
    counterSeq_ = seq;
  }
  return o;
}

bool StorageMirror::flashHolds(const Settings& s) const {
  if (!flash_.hasSettings()) {
    return false;
  }
  Settings stored;
  flash_.loadSettings(stored);
  return sameSettings(stored, s);
}

StorageMirror::Outcome StorageMirror::writeSettings(const Settings& s, bool eeprom) {
  const uint32_t seq = nextSeq(settingsSeq_, flash_.settingsSeq(), settings_.seq());
  Outcome o;
  bool wrote = false;
  bool flashKept = flashHolds(s);  // already there when only the EEPROM is behind: no flash erase
  if (flashKept) {
    o.add(Status::Ok);
  } else if (flash_.available()) {
    const Status r = flash_.saveSettings(s, seq);
    o.add(r);
    flashKept = r == Status::Ok;
    wrote = flashKept;
  }
  bool eepromKept = false;
  if (eeprom) {
    const Status r = settings_.save(s, seq);
    o.add(r);
    eepromKept = r == Status::Ok;
    wrote = wrote || eepromKept;
  }
  if (flashKept) {
    source_ = flash_.settingsSource();  // reported when both kept them
  } else if (eepromKept) {
    source_ = settings_.source();
  }
  if (wrote) {
    settingsSeq_ = seq;
  }
  return o;
}
