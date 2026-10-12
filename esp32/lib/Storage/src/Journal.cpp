// Journal.cpp — see header.
#include "Journal.h"

#include <string.h>

#include "Crc.h"

namespace {
constexpr uint32_t kRecordsPerRead = layout::kPageSize / layout::kJournalRecordSize;  // 2
}  // namespace

bool Journal::isValid(const JournalRecord& r) {
  return r.magic == kRecordMagic && r.version == kRecordVersion && r.crc == crcOfStructWithoutTail(r);
}

bool Journal::isErased(const JournalRecord& r) {
  const uint8_t* p = reinterpret_cast<const uint8_t*>(&r);
  for (size_t i = 0; i < sizeof(r); i++) {
    if (p[i] != 0xFF) {
      return false;
    }
  }
  return true;
}

Status Journal::begin() {
  hasRecord_ = false;
  invalidSlots_ = 0;
  latestSlot_ = layout::kJournalSlots - 1;
  JournalRecord batch[kRecordsPerRead];
  // Bounded scan: exactly kJournalSlots / 2 page reads.
  for (uint32_t slot = 0; slot < layout::kJournalSlots; slot += kRecordsPerRead) {
    TRY(eeprom_.get(slotAddress(slot), batch));
    for (uint32_t i = 0; i < kRecordsPerRead; i++) {
      const JournalRecord& r = batch[i];
      if (!isValid(r)) {
        invalidSlots_ += isErased(r) ? 0 : 1;
        continue;
      }
      if (!hasRecord_ || r.seq > latest_.seq) {
        latest_ = r;
        latestSlot_ = slot + i;
        hasRecord_ = true;
      }
    }
  }
  return Status::Ok;
}

Status Journal::append(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags) {
  JournalRecord r;
  memset(&r, 0, sizeof(r));
  r.magic = kRecordMagic;
  r.version = kRecordVersion;
  r.flags = flags;
  r.seq = hasRecord_ ? latest_.seq + 1 : 1;
  r.runSeconds = runSeconds;
  r.totalCount = totalCount;
  r.epoch = epoch;
  r.crc = crcOfStructWithoutTail(r);
  const uint32_t slot = (latestSlot_ + 1) % layout::kJournalSlots;
  TRY(eeprom_.put(slotAddress(slot), r));  // At24c verifies the write
  latest_ = r;
  latestSlot_ = slot;
  hasRecord_ = true;
  return Status::Ok;
}

Status Journal::format() {
  TRY(eeprom_.fill(layout::kJournalAddr, 0xFF, layout::kJournalSlots * layout::kJournalRecordSize));
  hasRecord_ = false;
  latestSlot_ = layout::kJournalSlots - 1;
  invalidSlots_ = 0;
  return Status::Ok;
}
