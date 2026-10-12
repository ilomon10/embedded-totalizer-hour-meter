// At24c.h — driver for AT24C-series I2C EEPROMs (default: AT24C256, 32 KB).
//
// Usage (TS mental model: an async-free key/value store addressed by byte offset):
//   At24c eeprom(bus, clock);                  // 0x50, 32 KB, 64-byte pages
//   TRY(eeprom.begin());
//   TRY(eeprom.put(0x0100, mySettingsStruct)); // write any plain struct
//   TRY(eeprom.get(0x0100, mySettingsStruct)); // read it back
//
// What it takes care of:
//  - Page boundaries: the chip silently wraps a write that crosses a 64-byte
//    page edge back to the page start. write() splits transfers at page edges.
//  - Write cycle: after each page write the chip is busy for up to 5 ms and
//    NACKs everything. We poll for ACK (bounded) instead of a blind delay.
//  - Verify: every written chunk is read back and compared.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <type_traits>

#include "IClock.h"
#include "II2cBus.h"

class At24c {
 public:
  static constexpr uint8_t kDefaultAddress = 0x50;
  static constexpr uint32_t kAt24c256Capacity = 32768;
  static constexpr uint16_t kAt24c256PageSize = 64;
  static constexpr uint32_t kWriteCycleTimeoutMs = 10;  // datasheet max is 5 ms
  static constexpr size_t kReadChunk = 64;

  At24c(II2cBus& bus, IClock& clock, uint8_t address = kDefaultAddress,
        uint32_t capacity = kAt24c256Capacity, uint16_t pageSize = kAt24c256PageSize)
      : bus_(bus), clock_(clock), address_(address), capacity_(capacity), pageSize_(pageSize) {}

  // Check the chip answers on the bus.
  Status begin();

  // Read `len` bytes starting at `memAddr`.
  Status read(uint32_t memAddr, uint8_t* out, size_t len);

  // Write `len` bytes starting at `memAddr`, split at page boundaries, each
  // page waited for and verified.
  Status write(uint32_t memAddr, const uint8_t* data, size_t len);

  // Fill a range with one byte value (used to erase/format regions).
  Status fill(uint32_t memAddr, uint8_t value, size_t len);

  // Typed helpers for plain structs (like the old UnifiedEEPROM::put/get).
  template <typename T>
  Status put(uint32_t memAddr, const T& obj) {
    static_assert(std::is_trivially_copyable<T>::value, "put() needs a plain struct");
    return write(memAddr, reinterpret_cast<const uint8_t*>(&obj), sizeof(T));
  }

  template <typename T>
  Status get(uint32_t memAddr, T& obj) {
    static_assert(std::is_trivially_copyable<T>::value, "get() needs a plain struct");
    return read(memAddr, reinterpret_cast<uint8_t*>(&obj), sizeof(T));
  }

  uint32_t capacity() const { return capacity_; }
  uint16_t pageSize() const { return pageSize_; }

 private:
  II2cBus& bus_;
  IClock& clock_;
  uint8_t address_;
  uint32_t capacity_;
  uint16_t pageSize_;

  bool rangeOk(uint32_t memAddr, size_t len) const;
  Status readChunk(uint32_t memAddr, uint8_t* out, size_t len);
  Status writePage(uint32_t memAddr, const uint8_t* data, size_t len);
  Status waitReady();
  Status verify(uint32_t memAddr, const uint8_t* expected, size_t len);
};
