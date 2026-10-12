// Ds3231.h — driver for the DS3231 real-time clock (I2C 0x68).
//
//   Ds3231 rtc(bus);
//   TRY(rtc.begin());
//   Result<uint32_t> t = rtc.nowEpoch();      // UTC Unix seconds
//   if (t.status == Status::TimeInvalid) { /* ask the host to send setTime */ }
//
// Time validity: the chip sets its OSF flag when the oscillator stopped
// (first power-up, dead battery). Until setTime() clears it, reads return
// Status::TimeInvalid so stale time is never used as if it were real.
#pragma once

#include "DateTime.h"
#include "II2cBus.h"
#include "Result.h"

class Ds3231 {
 public:
  static constexpr uint8_t kAddress = 0x68;

  explicit Ds3231(II2cBus& bus, uint8_t address = kAddress) : bus_(bus), address_(address) {}

  // Probe the chip and make sure the oscillator keeps running on battery.
  Status begin();

  // Current UTC time. Fails with TimeInvalid if the oscillator stopped.
  Result<DateTime> now();
  Result<uint32_t> nowEpoch();

  // Set UTC time and clear the oscillator-stop flag.
  Status setTime(const DateTime& t);
  Status setEpoch(uint32_t epoch);

  // False after power loss without battery, until setTime() is called.
  Result<bool> isTimeValid();

  // Die temperature in quarter degrees C (e.g. 101 = 25.25 C). Updated every 64 s by the chip.
  Result<int16_t> temperatureQuarterC();

 private:
  II2cBus& bus_;
  uint8_t address_;
};

namespace ds3231 {
// Registers (datasheet table 1).
constexpr uint8_t kRegSeconds = 0x00;
constexpr uint8_t kRegControl = 0x0E;
constexpr uint8_t kRegStatus = 0x0F;
constexpr uint8_t kRegTempMsb = 0x11;
constexpr uint8_t kControlEosc = 0x80;  // 1 = oscillator STOPS on battery (must be 0)
constexpr uint8_t kStatusOsf = 0x80;    // oscillator stopped flag
constexpr uint8_t kHour12h = 0x40;
constexpr uint8_t kHourPm = 0x20;

inline uint8_t bcdToBin(uint8_t v) { return static_cast<uint8_t>((v >> 4) * 10 + (v & 0x0F)); }
inline uint8_t binToBcd(uint8_t v) { return static_cast<uint8_t>(((v / 10) << 4) | (v % 10)); }
inline bool isBcd(uint8_t v) { return (v & 0x0F) <= 9 && (v >> 4) <= 9; }

// Decode the 7 time registers. Returns false if any field is malformed.
bool decodeTime(const uint8_t regs[7], DateTime& out);
void encodeTime(const DateTime& t, uint8_t regs[7]);
}  // namespace ds3231
