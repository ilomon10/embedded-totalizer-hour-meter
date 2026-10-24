// PartitionFlash.cpp — see header.
#include "PartitionFlash.h"

#include "Check.h"

namespace {
Status fromEsp(esp_err_t err) { return err == ESP_OK ? Status::Ok : Status::VerifyFailed; }
}  // namespace

bool PartitionFlash::begin() {
  part_ = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, label_);
  return part_ != nullptr;
}

Status PartitionFlash::read(uint32_t offset, uint8_t* out, size_t len) {
  CHECK_ARG(out != nullptr);
  if (part_ == nullptr) {
    return Status::NotFound;
  }
  return fromEsp(esp_partition_read(part_, offset, out, len));
}

Status PartitionFlash::write(uint32_t offset, const uint8_t* data, size_t len) {
  CHECK_ARG(data != nullptr);
  if (part_ == nullptr) {
    return Status::NotFound;
  }
  return fromEsp(esp_partition_write(part_, offset, data, len));
}

Status PartitionFlash::eraseSector(uint32_t offset) {
  CHECK_ARG(offset % kSectorSize == 0);
  if (part_ == nullptr) {
    return Status::NotFound;
  }
  return fromEsp(esp_partition_erase_range(part_, offset, kSectorSize));
}
