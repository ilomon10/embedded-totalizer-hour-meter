// SettingsStore.cpp — see header.
#include "SettingsStore.h"

#include <string.h>

#include "Crc.h"

bool SettingsStore::readCopy(uint32_t addr, SettingsRecord& out) {
  if (eeprom_.get(addr, out) != Status::Ok) {
    return false;
  }
  return out.magic == kMagic && out.version == kVersion && out.crc == crcOfStructWithoutTail(out);
}

Status SettingsStore::load(Settings& out) {
  SettingsRecord a;
  SettingsRecord b;
  const bool okA = readCopy(layout::kSettingsAddrA, a);
  const bool okB = readCopy(layout::kSettingsAddrB, b);
  if (okA && (!okB || a.seq >= b.seq)) {
    out = a.settings;
    seq_ = a.seq;
    source_ = SettingsSource::CopyA;
    return Status::Ok;
  }
  if (okB) {
    out = b.settings;
    seq_ = b.seq;
    source_ = SettingsSource::CopyB;
    return Status::Ok;
  }
  out = defaultSettings();
  seq_ = 0;
  source_ = SettingsSource::Defaults;
  return Status::NotFound;
}

Status SettingsStore::save(const Settings& s) {
  SettingsRecord r;
  // Zero every byte (incl. any padding) so the CRC is deterministic. The cast is
  // fine: SettingsRecord is trivially copyable, it just has default initialisers.
  memset(static_cast<void*>(&r), 0, sizeof(r));
  r.magic = kMagic;
  r.version = kVersion;
  r.seq = seq_ + 1;
  r.settings = s;
  r.crc = crcOfStructWithoutTail(r);
  // Overwrite the copy we did NOT load from (the older one).
  const bool writeB = (source_ == SettingsSource::CopyA);
  TRY(eeprom_.put(writeB ? layout::kSettingsAddrB : layout::kSettingsAddrA, r));
  seq_ = r.seq;
  source_ = writeB ? SettingsSource::CopyB : SettingsSource::CopyA;
  return Status::Ok;
}
