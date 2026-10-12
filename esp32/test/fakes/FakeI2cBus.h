// FakeI2cBus.h — an in-memory I2C bus with pluggable fake chips and fault injection.
#pragma once

#include <string.h>

#include "II2cBus.h"

// A simulated chip. Register-style devices: first written byte(s) set a pointer.
class FakeDevice {
 public:
  virtual ~FakeDevice() = default;
  virtual bool ack() { return true; }  // false => NACK (busy / absent)
  virtual void onWrite(const uint8_t* data, size_t len) = 0;
  virtual void onRead(uint8_t* out, size_t len) = 0;
};

class FakeI2cBus : public II2cBus {
 public:
  static constexpr int kMaxDevices = 8;

  void attach(uint8_t addr, FakeDevice* dev) {
    for (int i = 0; i < kMaxDevices; i++) {
      if (devices_[i] == nullptr) {
        addrs_[i] = addr;
        devices_[i] = dev;
        return;
      }
    }
  }

  // Fault injection: the next `count` transfers fail with `status`.
  void failNext(int count, Status status) {
    failCount_ = count;
    failStatus_ = status;
  }

  int writes = 0;
  int reads = 0;

  Status write(uint8_t addr, const uint8_t* data, size_t len) override {
    FakeDevice* d = find(addr);
    if (Status f = injected(); f != Status::Ok) return f;
    if (d == nullptr || !d->ack()) return Status::I2cNack;
    writes++;
    d->onWrite(data, len);
    return Status::Ok;
  }

  Status writeRead(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen) override {
    FakeDevice* d = find(addr);
    if (Status f = injected(); f != Status::Ok) return f;
    if (d == nullptr || !d->ack()) return Status::I2cNack;
    reads++;
    d->onWrite(tx, txLen);
    d->onRead(rx, rxLen);
    return Status::Ok;
  }

  Status probe(uint8_t addr) override {
    FakeDevice* d = find(addr);
    return (d != nullptr && d->ack()) ? Status::Ok : Status::I2cNack;
  }

 private:
  uint8_t addrs_[kMaxDevices] = {};
  FakeDevice* devices_[kMaxDevices] = {};
  int failCount_ = 0;
  Status failStatus_ = Status::Ok;

  FakeDevice* find(uint8_t addr) {
    for (int i = 0; i < kMaxDevices; i++) {
      if (devices_[i] != nullptr && addrs_[i] == addr) return devices_[i];
    }
    return nullptr;
  }
  Status injected() {
    if (failCount_ > 0) {
      failCount_--;
      return failStatus_;
    }
    return Status::Ok;
  }
};

// AT24C256 model: 2-byte address pointer, page-wrap on write (like the real
// chip), busy (NACK) for `busyProbes` polls after each write.
class FakeAt24c : public FakeDevice {
 public:
  static constexpr size_t kSize = 32768;
  static constexpr size_t kPage = 64;
  uint8_t mem[kSize];
  int busyProbes = 2;      // NACKs after each write cycle
  bool stuckBusy = false;  // never finishes a write
  int corruptNextWrite = -1;  // >=0: flip this byte index of the next write (bad cell)
  int pageWrites = 0;

  FakeAt24c() { memset(mem, 0xFF, sizeof(mem)); }

  bool ack() override {
    if (stuckBusy) return false;
    if (busyLeft_ > 0) {
      busyLeft_--;
      return false;
    }
    return true;
  }

  void onWrite(const uint8_t* d, size_t len) override {
    if (len < 2) return;
    ptr_ = static_cast<uint16_t>(((d[0] << 8) | d[1]) % kSize);
    if (len == 2) return;  // address set only (start of a read)
    const uint16_t pageStart = static_cast<uint16_t>(ptr_ - (ptr_ % kPage));
    for (size_t i = 2; i < len; i++) {
      uint8_t v = d[i];
      if (corruptNextWrite == static_cast<int>(i - 2)) v ^= 0xFF;
      mem[pageStart + ((ptr_ - pageStart + (i - 2)) % kPage)] = v;  // wraps inside the page
    }
    corruptNextWrite = -1;
    pageWrites++;
    busyLeft_ = busyProbes;
  }

  void onRead(uint8_t* out, size_t len) override {
    for (size_t i = 0; i < len; i++) out[i] = mem[(ptr_ + i) % kSize];
    ptr_ = static_cast<uint16_t>((ptr_ + len) % kSize);
  }

 private:
  uint16_t ptr_ = 0;
  int busyLeft_ = 0;
};

// Generic 8-bit register file (DS3231, MPU9250, AK8963).
class FakeRegisterDevice : public FakeDevice {
 public:
  uint8_t regs[256] = {};
  int writesToReg[256] = {};

  void onWrite(const uint8_t* d, size_t len) override {
    if (len == 0) return;
    ptr_ = d[0];
    for (size_t i = 1; i < len; i++) {
      regs[ptr_] = d[i];
      writesToReg[ptr_]++;
      ptr_++;
    }
  }
  void onRead(uint8_t* out, size_t len) override {
    for (size_t i = 0; i < len; i++) out[i] = regs[static_cast<uint8_t>(ptr_ + i)];
    ptr_ = static_cast<uint8_t>(ptr_ + len);
  }

 private:
  uint8_t ptr_ = 0;
};
