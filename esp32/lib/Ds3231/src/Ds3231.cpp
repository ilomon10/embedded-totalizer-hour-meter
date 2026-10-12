// Ds3231.cpp — see header.
#include "Ds3231.h"

namespace ds3231 {

namespace {
uint8_t decodeHour(uint8_t reg) {
  if ((reg & kHour12h) == 0) {
    return bcdToBin(reg & 0x3F);  // 24-hour mode
  }
  // 12-hour mode (set by another tool): 12 AM = 0, 12 PM = 12.
  const uint8_t h12 = bcdToBin(reg & 0x1F);
  const bool pm = (reg & kHourPm) != 0;
  return static_cast<uint8_t>((h12 % 12) + (pm ? 12 : 0));
}
}  // namespace

bool decodeTime(const uint8_t regs[7], DateTime& out) {
  const uint8_t hourBcd = (regs[2] & kHour12h) ? (regs[2] & 0x1F) : (regs[2] & 0x3F);
  if (!isBcd(regs[0] & 0x7F) || !isBcd(regs[1] & 0x7F) || !isBcd(hourBcd) || !isBcd(regs[4] & 0x3F) ||
      !isBcd(regs[5] & 0x1F) || !isBcd(regs[6])) {
    return false;
  }
  DateTime t;
  t.second = bcdToBin(regs[0] & 0x7F);
  t.minute = bcdToBin(regs[1] & 0x7F);
  t.hour = decodeHour(regs[2]);
  // regs[3] is day-of-week: not needed, derived from the date when required.
  t.day = bcdToBin(regs[4] & 0x3F);
  t.month = bcdToBin(regs[5] & 0x1F);  // bit 7 = century, ignored (2000..2099)
  t.year = static_cast<uint16_t>(2000 + bcdToBin(regs[6]));
  if (!datetime::isValid(t)) {
    return false;
  }
  out = t;
  return true;
}

void encodeTime(const DateTime& t, uint8_t regs[7]) {
  const int32_t days = datetime::daysFromCivil(t.year, t.month, t.day);
  const uint8_t weekday = static_cast<uint8_t>(((days % 7) + 11) % 7);  // 1970-01-01 was Thursday; 1 = Monday
  regs[0] = binToBcd(t.second);
  regs[1] = binToBcd(t.minute);
  regs[2] = binToBcd(t.hour);  // 24-hour mode
  regs[3] = static_cast<uint8_t>(weekday == 0 ? 7 : weekday);
  regs[4] = binToBcd(t.day);
  regs[5] = binToBcd(t.month);
  regs[6] = binToBcd(static_cast<uint8_t>(t.year - 2000));
}

}  // namespace ds3231

Status Ds3231::begin() {
  if (bus_.probe(address_) != Status::Ok) {
    return Status::DeviceMissing;
  }
  uint8_t control = 0;
  TRY(readReg(bus_, address_, ds3231::kRegControl, control));
  if ((control & ds3231::kControlEosc) != 0) {
    TRY(writeReg(bus_, address_, ds3231::kRegControl, control & static_cast<uint8_t>(~ds3231::kControlEosc)));
  }
  return Status::Ok;
}

Result<bool> Ds3231::isTimeValid() {
  uint8_t status = 0;
  const Status s = readReg(bus_, address_, ds3231::kRegStatus, status);
  if (s != Status::Ok) {
    return Result<bool>::failure(s);
  }
  return Result<bool>::success((status & ds3231::kStatusOsf) == 0);
}

Result<DateTime> Ds3231::now() {
  const Result<bool> valid = isTimeValid();
  if (!valid.ok()) {
    return Result<DateTime>::failure(valid.status);
  }
  if (!valid.value) {
    return Result<DateTime>::failure(Status::TimeInvalid);
  }
  uint8_t regs[7] = {};
  const Status s = readRegs(bus_, address_, ds3231::kRegSeconds, regs, sizeof(regs));
  if (s != Status::Ok) {
    return Result<DateTime>::failure(s);
  }
  DateTime t;
  if (!ds3231::decodeTime(regs, t)) {
    return Result<DateTime>::failure(Status::TimeInvalid);
  }
  return Result<DateTime>::success(t);
}

Result<uint32_t> Ds3231::nowEpoch() {
  const Result<DateTime> t = now();
  if (!t.ok()) {
    return Result<uint32_t>::failure(t.status);
  }
  return Result<uint32_t>::success(datetime::toEpoch(t.value));
}

Status Ds3231::setTime(const DateTime& t) {
  CHECK_ARG(datetime::isValid(t));
  uint8_t tx[8] = {ds3231::kRegSeconds};
  ds3231::encodeTime(t, tx + 1);
  TRY(bus_.write(address_, tx, sizeof(tx)));
  uint8_t status = 0;
  TRY(readReg(bus_, address_, ds3231::kRegStatus, status));
  return writeReg(bus_, address_, ds3231::kRegStatus, status & static_cast<uint8_t>(~ds3231::kStatusOsf));
}

Status Ds3231::setEpoch(uint32_t epoch) {
  if (!datetime::isEpochInRange(epoch)) {
    return Status::OutOfRange;
  }
  return setTime(datetime::fromEpoch(epoch));
}

Result<int16_t> Ds3231::temperatureQuarterC() {
  uint8_t regs[2] = {};
  const Status s = readRegs(bus_, address_, ds3231::kRegTempMsb, regs, sizeof(regs));
  if (s != Status::Ok) {
    return Result<int16_t>::failure(s);
  }
  // MSB is a signed integer degree, top 2 bits of LSB are quarter degrees.
  const int16_t quarters = static_cast<int16_t>(static_cast<int8_t>(regs[0]) * 4 + (regs[1] >> 6));
  return Result<int16_t>::success(quarters);
}
