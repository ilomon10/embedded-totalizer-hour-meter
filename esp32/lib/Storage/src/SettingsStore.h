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
  Settings settings;
  uint16_t reserved2;
  uint16_t crc;  // must be the last 2 bytes (checked below)
};
static_assert(sizeof(SettingsRecord) <= layout::kSettingsSlotSize, "SettingsRecord must fit in 128 bytes");
static_assert(offsetof(SettingsRecord, crc) == sizeof(SettingsRecord) - 2, "crc must be the last field, no tail padding");

enum class SettingsSource : uint8_t { Defaults = 0, CopyA = 1, CopyB = 2 };

class SettingsStore {
 public:
  static constexpr uint16_t kMagic = 0x5453;  // "ST"
  static constexpr uint8_t kVersion = 2;  // v2: bluetooth + btPin (were reserved fields)

  explicit SettingsStore(At24c& eeprom) : eeprom_(eeprom) {}

  // Always fills `out` (defaults if nothing valid is stored). Returns the
  // EEPROM status; Status::NotFound means defaults were used.
  Status load(Settings& out);
  Status save(const Settings& s);

  SettingsSource source() const { return source_; }

 private:
  At24c& eeprom_;
  uint32_t seq_ = 0;
  SettingsSource source_ = SettingsSource::Defaults;

  bool readCopy(uint32_t addr, SettingsRecord& out);
};
