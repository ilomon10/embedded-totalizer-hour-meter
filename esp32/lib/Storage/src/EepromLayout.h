// EepromLayout.h — where everything lives in the AT24C256 (32 KB, 64-byte pages).
// Full description: docs/EEPROM-LAYOUT.md. Change kLayoutVersion if this map changes.
//
//   page 0        0x0000  Layout header (magic "THM1" + version)
//   pages 1-2     0x0040  Settings copy A (128 B)
//   pages 3-4     0x00C0  Settings copy B (128 B)
//   pages 5-15    0x0140  reserved
//   pages 16-511  0x0400  Counter journal: 992 records x 32 B (wear-levelled ring)
#pragma once

#include <stdint.h>

namespace layout {

constexpr uint32_t kCapacity = 32768;
constexpr uint32_t kPageSize = 64;

constexpr uint32_t kHeaderAddr = 0x0000;
constexpr uint32_t kHeaderMagic = 0x314D4854;  // "THM1" little-endian
constexpr uint16_t kLayoutVersion = 1;

constexpr uint32_t kSettingsAddrA = 0x0040;
constexpr uint32_t kSettingsAddrB = 0x00C0;
constexpr uint32_t kSettingsSlotSize = 128;

constexpr uint32_t kJournalAddr = 0x0400;
constexpr uint32_t kJournalRecordSize = 32;
constexpr uint32_t kJournalSlots = (kCapacity - kJournalAddr) / kJournalRecordSize;  // 992

static_assert(kSettingsAddrA % kPageSize == 0 && kSettingsAddrB % kPageSize == 0, "settings must be page aligned");
static_assert(kSettingsAddrB >= kSettingsAddrA + kSettingsSlotSize, "settings copies overlap");
static_assert(kJournalAddr >= kSettingsAddrB + kSettingsSlotSize, "journal overlaps settings");
static_assert(kPageSize % kJournalRecordSize == 0, "journal records must not cross pages");
static_assert(kJournalSlots == 992, "unexpected journal size");

}  // namespace layout
