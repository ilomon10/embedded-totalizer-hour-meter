// PartitionFlash.h — IFlash on an ESP32 flash partition, found by its label in the partition table
// ("hmdata", see partitions.csv). Used by FlashStore for the flash copy of settings and counters.
//
// While a write or erase runs, the flash cache is off and interrupts that are not in IRAM wait: the
// pulse interrupt counts edges that arrive meanwhile as one (see docs/STORAGE.md, "Pulse input").
#pragma once

#include <esp_partition.h>

#include "IFlash.h"

class PartitionFlash : public IFlash {
 public:
  explicit PartitionFlash(const char* label) : label_(label) {}

  // Find the partition. False when the table has none: an older table, kept by an app-only update.
  bool begin();

  uint32_t size() const override { return part_ == nullptr ? 0 : part_->size; }
  Status read(uint32_t offset, uint8_t* out, size_t len) override;
  Status write(uint32_t offset, const uint8_t* data, size_t len) override;
  Status eraseSector(uint32_t offset) override;

 private:
  const char* label_;
  const esp_partition_t* part_ = nullptr;
};
