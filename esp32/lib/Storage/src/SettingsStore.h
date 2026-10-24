// SettingsStore.h — keeps two copies (A/B) of Settings in EEPROM.
//
// save():  write to the OLDER copy with seq+1 (the newer one stays intact,
//          so a power cut mid-write never destroys the last good settings)
// load():  pick the valid copy with the higher seq; if both are bad, defaults.
#pragma once

#include <stddef.h>

#include "At24c.h"
#include "EepromLayout.h"
#include "Result.h"
#include "Settings.h"

struct SettingsRecord {
  uint16_t magic;
  uint8_t version;
  uint8_t reserved;
  uint32_t seq;
  StoredSettings settings;
  uint16_t runVibMinMg;  // Settings::runVibMinMg; reserved (always 0) before firmware 2.5.0
  uint16_t crc;  // must be the last 2 bytes (checked below)
};
static_assert(sizeof(SettingsRecord) <= layout::kSettingsSlotSize, "SettingsRecord must fit in 128 bytes");
static_assert(offsetof(SettingsRecord, crc) == sizeof(SettingsRecord) - 2, "crc must be the last field, no tail padding");

// Where the settings in use were read from (status tag 60): EEPROM copies 1/2, flash copies 3/4 (FlashStore.h).
enum class SettingsSource : uint8_t { Defaults = 0, CopyA = 1, CopyB = 2, FlashA = 3, FlashB = 4 };

class SettingsStore {
 public:
  static constexpr uint16_t kMagic = 0x5453;  // "ST"
  // v2: bluetooth + btPin (were reserved fields). Firmware 2.5.0 added runVibMinMg in a
  // byte pair that v2 records already had as 0, so the version stays 2: no reset on upgrade.
  static constexpr uint8_t kVersion = 2;

  explicit SettingsStore(At24c& eeprom) : eeprom_(eeprom) {}

  // Always fills `out` (defaults if nothing valid is stored). Returns the
  // EEPROM status; Status::NotFound means defaults were used.
  Status load(Settings& out);
  Status save(const Settings& s);  // seq + 1
  // The same with a seq chosen by the caller: StorageMirror gives flash and EEPROM the same seq.
  Status save(const Settings& s, uint32_t seq);

  SettingsSource source() const { return source_; }
  uint32_t seq() const { return seq_; }  // of the copy last loaded or saved; 0 = none

  // Shared with FlashStore: build, check and unpack a record.
  static SettingsRecord makeRecord(const Settings& s, uint32_t seq);
  static bool isValid(const SettingsRecord& r);
  static void fromRecord(const SettingsRecord& r, Settings& out);

 private:
  At24c& eeprom_;
  uint32_t seq_ = 0;
  SettingsSource source_ = SettingsSource::Defaults;

  bool readCopy(uint32_t addr, SettingsRecord& out);
};
