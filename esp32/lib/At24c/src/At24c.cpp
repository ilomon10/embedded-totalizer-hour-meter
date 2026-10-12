// At24c.cpp — see header.
#include "At24c.h"

#include <string.h>

namespace {
// Largest page we support (AT24C512 has 128-byte pages; we use 64).
constexpr size_t kMaxPage = 64;
}  // namespace

Status At24c::begin() {
  CHECK_ARG(pageSize_ > 0 && pageSize_ <= kMaxPage);
  CHECK_ARG(capacity_ > 0 && capacity_ <= 65536);  // 2-byte addressing
  return bus_.probe(address_) == Status::Ok ? Status::Ok : Status::DeviceMissing;
}

bool At24c::rangeOk(uint32_t memAddr, size_t len) const {
  return len > 0 && memAddr < capacity_ && len <= capacity_ - memAddr;
}

Status At24c::read(uint32_t memAddr, uint8_t* out, size_t len) {
  CHECK_ARG(out != nullptr);
  CHECK_ARG(rangeOk(memAddr, len));
  size_t done = 0;
  // Bounded: at most capacity / kReadChunk iterations.
  while (done < len) {
    const size_t n = (len - done < kReadChunk) ? (len - done) : kReadChunk;
    TRY(readChunk(memAddr + done, out + done, n));
    done += n;
  }
  return Status::Ok;
}

Status At24c::readChunk(uint32_t memAddr, uint8_t* out, size_t len) {
  const uint8_t addrBytes[2] = {static_cast<uint8_t>(memAddr >> 8), static_cast<uint8_t>(memAddr & 0xFF)};
  return bus_.writeRead(address_, addrBytes, sizeof(addrBytes), out, len);
}

Status At24c::write(uint32_t memAddr, const uint8_t* data, size_t len) {
  CHECK_ARG(data != nullptr);
  CHECK_ARG(rangeOk(memAddr, len));
  size_t done = 0;
  while (done < len) {
    const uint32_t addr = memAddr + done;
    const size_t roomInPage = pageSize_ - (addr % pageSize_);
    const size_t n = (len - done < roomInPage) ? (len - done) : roomInPage;
    TRY(writePage(addr, data + done, n));
    done += n;
  }
  return Status::Ok;
}

Status At24c::fill(uint32_t memAddr, uint8_t value, size_t len) {
  CHECK_ARG(rangeOk(memAddr, len));
  uint8_t block[kMaxPage];
  memset(block, value, sizeof(block));
  size_t done = 0;
  while (done < len) {
    const uint32_t addr = memAddr + done;
    const size_t roomInPage = pageSize_ - (addr % pageSize_);
    const size_t n = (len - done < roomInPage) ? (len - done) : roomInPage;
    TRY(writePage(addr, block, n));
    done += n;
  }
  return Status::Ok;
}

Status At24c::writePage(uint32_t memAddr, const uint8_t* data, size_t len) {
  CHECK_ARG(len > 0 && len <= pageSize_);
  uint8_t tx[2 + kMaxPage];
  tx[0] = static_cast<uint8_t>(memAddr >> 8);
  tx[1] = static_cast<uint8_t>(memAddr & 0xFF);
  memcpy(tx + 2, data, len);
  TRY(bus_.write(address_, tx, 2 + len));
  TRY(waitReady());
  return verify(memAddr, data, len);
}

Status At24c::waitReady() {
  // ACK polling: the chip NACKs while its internal write cycle runs.
  const uint32_t start = clock_.nowMs();
  for (uint32_t i = 0; i <= kWriteCycleTimeoutMs; i++) {
    if (bus_.probe(address_) == Status::Ok) {
      return Status::Ok;
    }
    if (clock_.nowMs() - start > kWriteCycleTimeoutMs) {
      break;
    }
    clock_.delayMs(1);
  }
  return Status::I2cTimeout;
}

Status At24c::verify(uint32_t memAddr, const uint8_t* expected, size_t len) {
  uint8_t back[kMaxPage];
  TRY(readChunk(memAddr, back, len));
  return memcmp(back, expected, len) == 0 ? Status::Ok : Status::VerifyFailed;
}
