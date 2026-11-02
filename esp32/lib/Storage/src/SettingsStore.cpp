// SettingsStore.cpp — see header.
#include "SettingsStore.h"

#include <string.h>

#include "Crc.h"

bool SettingsStore::isValid(const SettingsRecord& r) {
  return r.magic == kMagic && r.version == kVersion && r.crc == crcOfStructWithoutTail(r);
}

bool SettingsStore::readCopy(uint32_t addr, SettingsRecord& out) {
  return eeprom_.get(addr, out) == Status::Ok && isValid(out);
}

void SettingsStore::fromRecord(const SettingsRecord& r, Settings& out) {
  static_cast<StoredSettings&>(out) = r.settings;
  out.runVibMinMg = r.runVibMinMg;
  out.i2cOff = (r.options & settings_options::kI2cOff) != 0 ? 1 : 0;
  out.pulseOff = (r.options & settings_options::kPulseOff) != 0 ? 1 : 0;
}

Status SettingsStore::load(Settings& out) {
  SettingsRecord a;
  SettingsRecord b;
  const bool okA = readCopy(layout::kSettingsAddrA, a);
  const bool okB = readCopy(layout::kSettingsAddrB, b);
  if (okA && (!okB || a.seq >= b.seq)) {
    fromRecord(a, out);
    seq_ = a.seq;
    source_ = SettingsSource::CopyA;
    return Status::Ok;
  }
  if (okB) {
    fromRecord(b, out);
    seq_ = b.seq;
    source_ = SettingsSource::CopyB;
    return Status::Ok;
  }
  out = defaultSettings();
  seq_ = 0;
  source_ = SettingsSource::Defaults;
  return Status::NotFound;
}

SettingsRecord SettingsStore::makeRecord(const Settings& s, uint32_t seq) {
  SettingsRecord r;
  // Zero every byte (incl. any padding) so the CRC is deterministic. The cast is
  // fine: SettingsRecord is trivially copyable, it just has default initialisers.
  memset(static_cast<void*>(&r), 0, sizeof(r));
  r.magic = kMagic;
  r.version = kVersion;
  r.seq = seq;
  r.settings = s;  // the StoredSettings part
  r.runVibMinMg = s.runVibMinMg;
  r.options = static_cast<uint8_t>((s.i2cOff != 0 ? settings_options::kI2cOff : 0) |
                                   (s.pulseOff != 0 ? settings_options::kPulseOff : 0));
  r.crc = crcOfStructWithoutTail(r);
  return r;
}

Status SettingsStore::save(const Settings& s) { return save(s, seq_ + 1); }

Status SettingsStore::save(const Settings& s, uint32_t seq) {
  const SettingsRecord r = makeRecord(s, seq);
  // Overwrite the copy we did NOT load from (the older one).
  const bool writeB = (source_ == SettingsSource::CopyA);
  TRY(eeprom_.put(writeB ? layout::kSettingsAddrB : layout::kSettingsAddrA, r));
  seq_ = r.seq;
  source_ = writeB ? SettingsSource::CopyB : SettingsSource::CopyA;
  return Status::Ok;
}
