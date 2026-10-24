// IFlash.h — a raw area of NOR flash: read anywhere, write only erased bytes, erase whole 4 KB sectors.
//
// TS mental model: a Uint8Array where a write can only turn 1-bits into 0-bits, and the only way
// back to 0xFF is erasing a whole 4096-byte sector. FlashStore builds power-safe records on top.
// On the device it is the "hmdata" partition (platform/PartitionFlash.h); tests use FakeFlash.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "Status.h"

class IFlash {
 public:
  static constexpr uint32_t kSectorSize = 4096;

  virtual ~IFlash() = default;

  // Bytes in the area, a multiple of kSectorSize. 0 when the area does not exist.
  virtual uint32_t size() const = 0;

  virtual Status read(uint32_t offset, uint8_t* out, size_t len) = 0;

  // Program `len` bytes. The bytes must be erased (0xFF) first: a write can only clear bits.
  virtual Status write(uint32_t offset, const uint8_t* data, size_t len) = 0;

  // Set the 4 KB sector starting at `offset` (a multiple of kSectorSize) back to 0xFF.
  virtual Status eraseSector(uint32_t offset) = 0;
};
