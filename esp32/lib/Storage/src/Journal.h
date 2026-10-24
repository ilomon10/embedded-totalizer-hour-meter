// Journal.h — power-safe, wear-levelled storage for the hour-meter counters.
//
// Instead of overwriting one address (which would wear out after ~1M writes,
// i.e. 11 days at one write per second), every save goes to the NEXT slot of
// a 992-slot ring. Each record has a sequence number and a CRC:
//
//   boot:  scan all slots, keep the valid record with the highest seq
//   save:  write seq+1 into the slot after it
//
// A power cut during a write leaves a record with a bad CRC, which the scan
// ignores, so we fall back to the previous record (lose at most one interval).
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "At24c.h"
#include "EepromLayout.h"
#include "Result.h"

struct JournalRecord {
  uint16_t magic;        // kRecordMagic
  uint8_t version;       // kRecordVersion
  uint8_t flags;         // JournalFlags
  uint32_t seq;          // increases by 1 per save
  uint32_t runSeconds;   // hour meter
  uint32_t totalCount;   // totalizer pulses
  uint32_t epoch;        // UTC time of the save (0 if the RTC time was invalid)
  uint32_t lineage;      // which history this is (StorageMirror.h); 0 = written by firmware 2.5.0 or older
  uint8_t reserved[6];   // future fields; written as 0
  uint16_t crc;          // CRC16 of all bytes above
};
static_assert(sizeof(JournalRecord) == layout::kJournalRecordSize, "JournalRecord must be 32 bytes");
static_assert(offsetof(JournalRecord, crc) == sizeof(JournalRecord) - 2, "crc must be the last field");

namespace journal_flags {
constexpr uint8_t kTimeValid = 0x01;      // epoch came from a valid RTC
constexpr uint8_t kManualSet = 0x02;      // values preset by a command
constexpr uint8_t kReset = 0x04;          // counters reset by a command
constexpr uint8_t kRunFromZero = 0x08;    // the hour meter started at 0 with no stored value (StorageMirror.h)
constexpr uint8_t kCountFromZero = 0x10;  // the totalizer likewise
}  // namespace journal_flags

class Journal {
 public:
  static constexpr uint16_t kRecordMagic = 0x524A;  // "JR"
  static constexpr uint8_t kRecordVersion = 1;

  explicit Journal(At24c& eeprom) : eeprom_(eeprom) {}

  // Scan the ring. Ok even when empty (check hasRecord()).
  Status begin();

  // Append a new record after the latest one, with the next seq.
  Status append(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags);
  // The same with a seq chosen by the caller: StorageMirror gives flash and EEPROM the same seq.
  Status append(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags, uint32_t seq);
  // A complete record (StorageMirror: seq and lineage set, CRC filled in by makeRecord).
  Status append(const JournalRecord& r);

  // Erase every slot (used when the EEPROM layout is new or incompatible).
  Status format();

  bool hasRecord() const { return hasRecord_; }
  const JournalRecord& latest() const { return latest_; }
  uint32_t latestSlot() const { return latestSlot_; }
  uint32_t invalidSlotsSeen() const { return invalidSlots_; }

  static bool isValid(const JournalRecord& r);
  // A record ready to store: magic, version and CRC filled in (also used by FlashStore).
  static JournalRecord makeRecord(uint32_t runSeconds, uint32_t totalCount, uint32_t epoch, uint8_t flags,
                                  uint32_t seq, uint32_t lineage = 0);

 private:
  At24c& eeprom_;
  JournalRecord latest_{};
  uint32_t latestSlot_ = layout::kJournalSlots - 1;  // so the first append goes to slot 0
  bool hasRecord_ = false;
  uint32_t invalidSlots_ = 0;

  static uint32_t slotAddress(uint32_t slot) { return layout::kJournalAddr + slot * layout::kJournalRecordSize; }
  static bool isErased(const JournalRecord& r);
};
