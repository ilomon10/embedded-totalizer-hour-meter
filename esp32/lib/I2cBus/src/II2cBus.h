// II2cBus.h — the I2C bus as an interface, plus register helpers.
//
// TS mental model:
//   interface II2cBus {
//     write(addr, bytes): Status;                    // START addr+W bytes STOP
//     writeRead(addr, tx, rx): Status;               // START addr+W tx RESTART addr+R rx STOP
//     probe(addr): Status;                           // does a device ACK this address?
//   }
// Every driver (EEPROM, RTC, IMU) takes an II2cBus& in its constructor
// (dependency injection), so tests can pass a FakeI2cBus.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "Check.h"
#include "Status.h"

class II2cBus {
 public:
  // Largest single transfer any driver may request (ESP32 Wire buffer is 128 B).
  static constexpr size_t kMaxTransfer = 120;

  virtual ~II2cBus() = default;
  virtual Status write(uint8_t addr, const uint8_t* data, size_t len) = 0;
  virtual Status writeRead(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen) = 0;
  virtual Status probe(uint8_t addr) = 0;
};

// ---- Register helpers for chips with 8-bit register addresses (RTC, IMU) ----

inline Status readRegs(II2cBus& bus, uint8_t addr, uint8_t reg, uint8_t* out, size_t len) {
  CHECK_ARG(out != nullptr && len > 0 && len <= II2cBus::kMaxTransfer);
  return bus.writeRead(addr, &reg, 1, out, len);
}

inline Status readReg(II2cBus& bus, uint8_t addr, uint8_t reg, uint8_t& out) {
  return readRegs(bus, addr, reg, &out, 1);
}

inline Status writeReg(II2cBus& bus, uint8_t addr, uint8_t reg, uint8_t value) {
  const uint8_t tx[2] = {reg, value};
  return bus.write(addr, tx, sizeof(tx));
}
