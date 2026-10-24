// FlashStore.cpp — see header.
#include "FlashStore.h"

#include <string.h>

#include "Check.h"

namespace {
constexpr uint32_t kScanRecords = 8;  // records per read while scanning: 256 B on the stack
static_assert(FlashStore::kSlotsPerSector % kScanRecords == 0, "scan reads must not cross sectors");
}  // namespace

Status FlashStore::begin() {
  available_ = false;
  hasSettings_ = false;
  hasRecord_ = false;
  if (flash_.size() < kSectors * kSectorSize) {
    return Status::NotFound;  // no "hmdata" partition (an older partition table): EEPROM only
  }
  readSettings();
  const Status scanned = scanJournal();
  available_ = scanned == Status::Ok;
  return scanned;
}

// ---------------------------------------------------------------- settings ---

void FlashStore::readSettings() {
  SettingsRecord a;
  SettingsRecord b;
  const bool okA = flash_.read(0, reinterpret_cast<uint8_t*>(&a), sizeof(a)) == Status::Ok && SettingsStore::isValid(a);
  const bool okB =
      flash_.read(kSectorSize, reinterpret_cast<uint8_t*>(&b), sizeof(b)) == Status::Ok && SettingsStore::isValid(b);
  if (okA && (!okB || a.seq >= b.seq)) {
    settings_ = a;
    settingsCopy_ = 0;
    hasSettings_ = true;
  } else if (okB) {
    settings_ = b;
    settingsCopy_ = 1;
    hasSettings_ = true;
  }
}

void FlashStore::loadSettings(Settings& out) const {
  if (!hasSettings()) {
    out = defaultSettings();
    return;
  }
  SettingsStore::fromRecord(settings_, out);
}

SettingsSource FlashStore::settingsSource() const {
  if (!hasSettings()) {
    return SettingsSource::Defaults;
  }
  return settingsCopy_ == 0 ? SettingsSource::FlashA : SettingsSource::FlashB;
}

Status FlashStore::saveSettings(const Settings& s, uint32_t seq) {
  if (!available_) {
    return Status::NotFound;
  }
  const SettingsRecord r = SettingsStore::makeRecord(s, seq);
  // Never touch the copy in use: a power cut during erase or write leaves it intact.
  const uint32_t target = (hasSettings_ && settingsCopy_ == 0) ? 1 : 0;
  TRY(flash_.eraseSector(target * kSectorSize));
  TRY(writeVerified(target * kSectorSize, reinterpret_cast<const uint8_t*>(&r), sizeof(r)));
  settings_ = r;
  settingsCopy_ = target;
  hasSettings_ = true;
  return Status::Ok;
}

// ----------------------------------------------------------------- journal ---

Status FlashStore::scanJournal() {
  JournalRecord batch[kScanRecords];
  // Bounded scan: kJournalSlots / kScanRecords reads of 256 B.
  for (uint32_t slot = 0; slot < kJournalSlots; slot += kScanRecords) {
    TRY(flash_.read(slotOffset(slot), reinterpret_cast<uint8_t*>(batch), sizeof(batch)));
    for (uint32_t i = 0; i < kScanRecords; i++) {
      const JournalRecord& r = batch[i];
      if (Journal::isValid(r) && (!hasRecord_ || r.seq > latest_.seq)) {
        latest_ = r;
        latestSlot_ = slot + i;
        hasRecord_ = true;
      }
    }
  }
  return Status::Ok;
}

bool FlashStore::slotBlank(uint32_t slot) {
  uint8_t bytes[kRecordSize];
  if (flash_.read(slotOffset(slot), bytes, sizeof(bytes)) != Status::Ok) {
    return false;
  }
  for (uint32_t i = 0; i < kRecordSize; i++) {
    if (bytes[i] != 0xFF) {
      return false;
    }
  }
  return true;
}

Status FlashStore::append(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags, uint32_t seq) {
  return append(Journal::makeRecord(runSeconds, totalCount, epoch, flags, seq));
}

Status FlashStore::append(const JournalRecord& r) {
  if (!available_) {
    return Status::NotFound;
  }
  uint32_t slot = hasRecord_ ? (latestSlot_ + 1) % kJournalSlots : 0;
  // Bounded: at most the rest of this sector plus the first slot of the next one.
  for (uint32_t tries = 0; tries <= kSlotsPerSector; tries++) {
    if (slot % kSlotsPerSector == 0) {
      TRY(flash_.eraseSector(slotOffset(slot)));  // a new sector: its records are the oldest ones
    } else if (!slotBlank(slot)) {
      slot = (slot + 1) % kJournalSlots;  // left dirty by a cut write: skip it
      continue;
    }
    if (writeVerified(slotOffset(slot), reinterpret_cast<const uint8_t*>(&r), sizeof(r)) == Status::Ok) {
      latest_ = r;
      latestSlot_ = slot;
      hasRecord_ = true;
      return Status::Ok;
    }
    slot = (slot + 1) % kJournalSlots;  // the failed write left the slot dirty: try the next one
  }
  return Status::VerifyFailed;
}

Status FlashStore::writeVerified(uint32_t offset, const uint8_t* data, size_t len) {
  uint8_t back[sizeof(SettingsRecord)];  // the biggest record written here
  static_assert(sizeof(SettingsRecord) >= sizeof(JournalRecord), "read-back buffer too small");
  CHECK_ARG(len <= sizeof(back));
  TRY(flash_.write(offset, data, len));
  TRY(flash_.read(offset, back, len));
  return memcmp(back, data, len) == 0 ? Status::Ok : Status::VerifyFailed;
}
