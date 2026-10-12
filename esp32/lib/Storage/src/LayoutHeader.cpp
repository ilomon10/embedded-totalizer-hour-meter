// LayoutHeader.cpp — see header.
#include "LayoutHeader.h"

#include <string.h>

#include "Crc.h"

Result<bool> layout_header::ensure(At24c& eeprom, Journal& journal) {
  LayoutHeaderRecord h;
  Status s = eeprom.get(layout::kHeaderAddr, h);
  if (s != Status::Ok) {
    return Result<bool>::failure(s);
  }
  const bool valid = h.magic == layout::kHeaderMagic && h.layoutVersion == layout::kLayoutVersion &&
                     h.crc == crcOfStructWithoutTail(h);
  if (valid) {
    return Result<bool>::success(false);
  }
  // Unknown content: wipe settings + journal, then stamp the header last so an
  // interrupted format is simply redone on the next boot.
  s = eeprom.fill(layout::kSettingsAddrA, 0xFF, layout::kJournalAddr - layout::kSettingsAddrA);
  if (s == Status::Ok) {
    s = journal.format();
  }
  if (s != Status::Ok) {
    return Result<bool>::failure(s);
  }
  memset(&h, 0, sizeof(h));
  h.magic = layout::kHeaderMagic;
  h.layoutVersion = layout::kLayoutVersion;
  h.crc = crcOfStructWithoutTail(h);
  s = eeprom.put(layout::kHeaderAddr, h);
  return s == Status::Ok ? Result<bool>::success(true) : Result<bool>::failure(s);
}
