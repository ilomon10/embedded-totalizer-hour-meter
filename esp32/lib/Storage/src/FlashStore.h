// FlashStore.h — the settings and the counters in the ESP32's own flash (partition "hmdata", 64 KB).
//
// The same records as the EEPROM (SettingsRecord, JournalRecord: magic + version + seq + CRC), laid out
// for NOR flash, where a write can only clear bits and only an erase of a whole 4 KB sector sets them again:
//
//   sector 0        settings copy A    save: erase the copy NOT in use, write, read back
//   sector 1        settings copy B
//   sectors 2..15   counter journal    14 x 128 slots of 32 B, a ring like the EEPROM journal
//
// Journal: each save goes to the next slot. Entering a sector erases it first; it holds the oldest
// records, never the newest one, so a power cut can only lose the save being written. A slot that is
// not blank (a write cut short by a power loss) is skipped. Boot scans every slot and keeps the valid
// record with the highest seq. Endurance (100,000 erase cycles per sector, 1,792 slots): saving every
// 10 s around the clock wears a sector out after about 57 years; the default 60 s, after about 340.
//
// The caller picks every seq, so flash and EEPROM can carry the same seq (StorageMirror.h).
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "IFlash.h"
#include "Journal.h"
#include "SettingsStore.h"

class FlashStore {
 public:
  static constexpr uint32_t kSectorSize = IFlash::kSectorSize;
  static constexpr uint32_t kSectors = 16;  // 64 KB used, whatever the partition size
  static constexpr uint32_t kSettingsSectors = 2;
  static constexpr uint32_t kRecordSize = sizeof(JournalRecord);
  static constexpr uint32_t kSlotsPerSector = kSectorSize / kRecordSize;  // 128
  static constexpr uint32_t kJournalSlots = (kSectors - kSettingsSectors) * kSlotsPerSector;  // 1792
  static constexpr uint32_t kJournalStart = kSettingsSectors * kSectorSize;

  explicit FlashStore(IFlash& flash) : flash_(flash) {}

  // Read both settings copies and scan the journal. NotFound if the area is missing or smaller than 64 KB.
  // A scan that fails leaves the store unavailable: a partial scan could point a save at the wrong sector.
  Status begin();
  bool available() const { return available_; }

  // Settings: the valid copy with the higher seq.
  bool hasSettings() const { return available_ && hasSettings_; }
  uint32_t settingsSeq() const { return hasSettings() ? settings_.seq : 0; }
  void loadSettings(Settings& out) const;  // defaults without a valid copy
  SettingsSource settingsSource() const;
  Status saveSettings(const Settings& s, uint32_t seq);

  // Counters: the valid journal record with the highest seq.
  bool hasRecord() const { return available_ && hasRecord_; }
  const JournalRecord& latest() const { return latest_; }
  uint32_t latestSlot() const { return latestSlot_; }
  Status append(const JournalRecord& r);  // seq, lineage and CRC set by the caller (Journal::makeRecord)
  Status append(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags, uint32_t seq);

 private:
  IFlash& flash_;
  bool available_ = false;
  bool hasSettings_ = false;
  uint32_t settingsCopy_ = 0;  // 0 = A, 1 = B: the copy in use
  SettingsRecord settings_{};
  bool hasRecord_ = false;
  uint32_t latestSlot_ = 0;
  JournalRecord latest_{};

  static uint32_t slotOffset(uint32_t slot) { return kJournalStart + slot * kRecordSize; }
  void readSettings();
  Status scanJournal();
  bool slotBlank(uint32_t slot);
  Status writeVerified(uint32_t offset, const uint8_t* data, size_t len);
};
