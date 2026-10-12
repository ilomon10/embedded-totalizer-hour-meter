// LayoutHeader.h — recognises "our" EEPROM. A blank or foreign chip (or an
// older layout version) gets formatted once; afterwards the header matches.
#pragma once

#include <stddef.h>

#include "At24c.h"
#include "EepromLayout.h"
#include "Journal.h"
#include "Result.h"

struct LayoutHeaderRecord {
  uint32_t magic;
  uint16_t layoutVersion;
  uint16_t crc;
};
static_assert(offsetof(LayoutHeaderRecord, crc) == sizeof(LayoutHeaderRecord) - 2, "crc must be the last field");

namespace layout_header {
// Ok(true) if the EEPROM had to be formatted (journal erased, settings cleared).
Result<bool> ensure(At24c& eeprom, Journal& journal);
}  // namespace layout_header
