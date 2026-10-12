// DateTime.h — calendar date/time <-> Unix epoch, pure math (no hardware).
//
// ALWAYS UTC. The device never stores or applies a timezone: Unix epoch
// seconds mean the same instant everywhere, and apps convert to local time
// only for display (TS: new Date(epoch * 1000).toLocaleString()).
//
// Valid range: 2000-01-01 00:00:00 .. 2099-12-31 23:59:59 (the DS3231's range).
#pragma once

#include <stdint.h>

struct DateTime {
  uint16_t year = 2000;  // 2000..2099
  uint8_t month = 1;     // 1..12
  uint8_t day = 1;       // 1..31
  uint8_t hour = 0;      // 0..23
  uint8_t minute = 0;    // 0..59
  uint8_t second = 0;    // 0..59
};

namespace datetime {

constexpr uint32_t kEpoch2000 = 946684800UL;   // 2000-01-01T00:00:00Z
constexpr uint32_t kEpoch2100 = 4102444800UL;  // 2100-01-01T00:00:00Z (exclusive)

inline bool isLeapYear(uint16_t y) { return (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0); }

inline uint8_t daysInMonth(uint16_t year, uint8_t month) {
  static const uint8_t kDays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (month < 1 || month > 12) {
    return 0;
  }
  return (month == 2 && isLeapYear(year)) ? 29 : kDays[month - 1];
}

inline bool isValid(const DateTime& t) {
  return t.year >= 2000 && t.year <= 2099 && t.month >= 1 && t.month <= 12 && t.day >= 1 &&
         t.day <= daysInMonth(t.year, t.month) && t.hour <= 23 && t.minute <= 59 && t.second <= 59;
}

inline bool isEpochInRange(uint32_t epoch) { return epoch >= kEpoch2000 && epoch < kEpoch2100; }

// Days since 1970-01-01 (Howard Hinnant's days_from_civil; no loops).
inline int32_t daysFromCivil(int32_t y, uint32_t m, uint32_t d) {
  y -= (m <= 2) ? 1 : 0;
  const int32_t era = (y >= 0 ? y : y - 399) / 400;
  const uint32_t yoe = static_cast<uint32_t>(y - era * 400);
  const uint32_t doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
  const uint32_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int32_t>(doe) - 719468;
}

// Caller must pass a valid DateTime (see isValid).
inline uint32_t toEpoch(const DateTime& t) {
  const int32_t days = daysFromCivil(t.year, t.month, t.day);
  return static_cast<uint32_t>(days) * 86400UL + t.hour * 3600UL + t.minute * 60UL + t.second;
}

// Inverse of toEpoch (Hinnant's civil_from_days).
inline DateTime fromEpoch(uint32_t epoch) {
  const int32_t z = static_cast<int32_t>(epoch / 86400UL) + 719468;
  const uint32_t secs = epoch % 86400UL;
  const int32_t era = z / 146097;
  const uint32_t doe = static_cast<uint32_t>(z - era * 146097);
  const uint32_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const uint32_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const uint32_t mp = (5 * doy + 2) / 153;
  DateTime t;
  t.day = static_cast<uint8_t>(doy - (153 * mp + 2) / 5 + 1);
  t.month = static_cast<uint8_t>(mp < 10 ? mp + 3 : mp - 9);
  t.year = static_cast<uint16_t>(static_cast<int32_t>(yoe) + era * 400 + (t.month <= 2 ? 1 : 0));
  t.hour = static_cast<uint8_t>(secs / 3600);
  t.minute = static_cast<uint8_t>((secs % 3600) / 60);
  t.second = static_cast<uint8_t>(secs % 60);
  return t;
}

}  // namespace datetime
