// FakeFlash.h — NOR flash in RAM, with fault injection.
//
// Like the real chip: a write can only clear bits (data is ANDed in), and only eraseSector() sets a
// 4 KB sector back to 0xFF. A new FakeFlash is NOT erased (0xA5 everywhere), like a partition that
// held something else before. A power cut programs only part of a write (or erase); after it every
// operation fails, like a dead CPU, until the test "reboots" with powerOn().
#pragma once

#include <string.h>

#include "IFlash.h"

template <uint32_t kBytes = 64 * 1024>
class FakeFlash : public IFlash {
 public:
  static constexpr uint32_t kSectors = kBytes / kSectorSize;

  uint8_t mem[kBytes];
  int erases[kSectors] = {};  // per sector: wear
  int writes = 0;
  int cutNextWriteAfter = -1;  // >= 0: power is lost after this many bytes of the next write
  int cutNextEraseAfter = -1;  // >= 0: power is lost after this many bytes of the next erase
  bool dead = false;           // power was lost: everything fails until powerOn()
  bool failWrites = false;     // every write fails (a worn-out or broken flash)
  long failReadAt = -1;        // >= 0: a read covering this offset fails (a scan cut short)
  bool missing = false;        // no such partition

  FakeFlash() { memset(mem, 0xA5, sizeof(mem)); }

  void powerOn() { dead = false; }

  uint32_t size() const override { return missing ? 0 : kBytes; }

  Status read(uint32_t offset, uint8_t* out, size_t len) override {
    if (dead || missing || offset + len > kBytes) return Status::OutOfRange;
    if (failReadAt >= static_cast<long>(offset) && failReadAt < static_cast<long>(offset + len)) {
      return Status::VerifyFailed;
    }
    memcpy(out, mem + offset, len);
    return Status::Ok;
  }

  Status write(uint32_t offset, const uint8_t* data, size_t len) override {
    if (dead || missing || offset + len > kBytes) return Status::OutOfRange;
    if (failWrites) return Status::VerifyFailed;
    size_t n = len;
    if (cutNextWriteAfter >= 0) {
      n = static_cast<size_t>(cutNextWriteAfter) < len ? static_cast<size_t>(cutNextWriteAfter) : len;
      cutNextWriteAfter = -1;
      dead = true;
    }
    for (size_t i = 0; i < n; i++) mem[offset + i] &= data[i];  // NOR: 1 -> 0 only
    writes++;
    return dead ? Status::VerifyFailed : Status::Ok;
  }

  Status eraseSector(uint32_t offset) override {
    if (dead || missing || offset % kSectorSize != 0 || offset >= kBytes) return Status::OutOfRange;
    size_t n = kSectorSize;
    if (cutNextEraseAfter >= 0) {
      n = static_cast<size_t>(cutNextEraseAfter);
      cutNextEraseAfter = -1;
      dead = true;
    }
    memset(mem + offset, 0xFF, n);
    erases[offset / kSectorSize]++;
    return dead ? Status::VerifyFailed : Status::Ok;
  }

  int maxErases() const {
    int m = 0;
    for (uint32_t i = 0; i < kSectors; i++) m = erases[i] > m ? erases[i] : m;
    return m;
  }
};
