// Driver tests: AT24C256, DS3231, MPU9250 against fake chips on a fake bus.
#include <unity.h>

#include "At24c.h"
#include "Ds3231.h"
#include "FakeClock.h"
#include "FakeI2cBus.h"
#include "Mpu9250.h"

void setUp() {}
void tearDown() {}

// ------------------------------------------------------------------ AT24C --

static void test_at24c_write_read_across_page_boundary() {
  FakeI2cBus bus;
  FakeClock clock;
  FakeAt24c chip;
  bus.attach(0x50, &chip);
  At24c eeprom(bus, clock);
  TEST_ASSERT_EQUAL(Status::Ok, eeprom.begin());

  uint8_t data[100];
  for (int i = 0; i < 100; i++) data[i] = static_cast<uint8_t>(i + 1);
  // 60..159 crosses the page edges at 64 and 128: must be split into 3 page writes.
  TEST_ASSERT_EQUAL(Status::Ok, eeprom.write(60, data, sizeof(data)));
  TEST_ASSERT_EQUAL(3, chip.pageWrites);
  TEST_ASSERT_EQUAL_UINT8_ARRAY(data, chip.mem + 60, 100);
  TEST_ASSERT_EQUAL_HEX8(0xFF, chip.mem[59]);   // neighbours untouched
  TEST_ASSERT_EQUAL_HEX8(0xFF, chip.mem[160]);

  uint8_t back[100] = {};
  TEST_ASSERT_EQUAL(Status::Ok, eeprom.read(60, back, sizeof(back)));
  TEST_ASSERT_EQUAL_UINT8_ARRAY(data, back, 100);
}

static void test_at24c_put_get_struct() {
  FakeI2cBus bus;
  FakeClock clock;
  FakeAt24c chip;
  bus.attach(0x50, &chip);
  At24c eeprom(bus, clock);
  struct Pair { uint32_t a; float b; } in{123456, 1.5f}, out{};
  TEST_ASSERT_EQUAL(Status::Ok, eeprom.put(1000, in));
  TEST_ASSERT_EQUAL(Status::Ok, eeprom.get(1000, out));
  TEST_ASSERT_EQUAL_UINT32(123456, out.a);
  TEST_ASSERT_EQUAL_FLOAT(1.5f, out.b);
}

static void test_at24c_ack_polling_waits_for_write_cycle() {
  FakeI2cBus bus;
  FakeClock clock;
  FakeAt24c chip;
  chip.busyProbes = 4;
  bus.attach(0x50, &chip);
  At24c eeprom(bus, clock);
  const uint8_t b = 0x42;
  TEST_ASSERT_EQUAL(Status::Ok, eeprom.write(5, &b, 1));
  TEST_ASSERT_EQUAL_UINT32(4, clock.ms);  // polled with 1 ms waits, no blind 5 ms delay
}

static void test_at24c_errors() {
  FakeI2cBus bus;
  FakeClock clock;
  FakeAt24c chip;
  bus.attach(0x50, &chip);
  At24c eeprom(bus, clock);
  uint8_t buf[4] = {1, 2, 3, 4};

  TEST_ASSERT_EQUAL(Status::InvalidArg, eeprom.write(32766, buf, 4));  // past the end
  TEST_ASSERT_EQUAL(Status::InvalidArg, eeprom.read(0, nullptr, 4));
  TEST_ASSERT_EQUAL(Status::InvalidArg, eeprom.read(0, buf, 0));

  chip.corruptNextWrite = 2;  // bad cell
  TEST_ASSERT_EQUAL(Status::VerifyFailed, eeprom.write(0, buf, 4));

  chip.stuckBusy = true;      // chip never finishes
  TEST_ASSERT_EQUAL(Status::I2cNack, eeprom.write(0, buf, 4));
  chip.stuckBusy = false;

  bus.failNext(1, Status::I2cTimeout);
  TEST_ASSERT_EQUAL(Status::I2cTimeout, eeprom.read(0, buf, 4));

  FakeI2cBus empty;
  At24c missing(empty, clock);
  TEST_ASSERT_EQUAL(Status::DeviceMissing, missing.begin());
}

static void test_at24c_write_cycle_timeout() {
  FakeI2cBus bus;
  FakeClock clock;
  FakeAt24c chip;
  chip.busyProbes = 1000;  // ACKs the data, then never becomes ready
  bus.attach(0x50, &chip);
  At24c eeprom(bus, clock);
  const uint8_t b = 1;
  TEST_ASSERT_EQUAL(Status::I2cTimeout, eeprom.write(0, &b, 1));
  TEST_ASSERT_TRUE(clock.ms <= At24c::kWriteCycleTimeoutMs + 2);  // bounded wait
}

// ----------------------------------------------------------------- DS3231 --

static void test_datetime_known_epochs() {
  DateTime t;
  t.year = 2026; t.month = 10; t.day = 7; t.hour = 12; t.minute = 34; t.second = 56;
  TEST_ASSERT_EQUAL_UINT32(1791376496UL, datetime::toEpoch(t));
  TEST_ASSERT_EQUAL_UINT32(datetime::kEpoch2000, datetime::toEpoch(DateTime{}));
  const DateTime leap = datetime::fromEpoch(951782400UL);  // 2000-02-29
  TEST_ASSERT_EQUAL(2000, leap.year);
  TEST_ASSERT_EQUAL(2, leap.month);
  TEST_ASSERT_EQUAL(29, leap.day);
}

static void test_datetime_roundtrip_every_day_2000_to_2099() {
  uint32_t days = 0;
  for (uint32_t e = datetime::kEpoch2000; e < datetime::kEpoch2100; e += 86400UL + 3661UL) {
    const DateTime t = datetime::fromEpoch(e);
    TEST_ASSERT_TRUE(datetime::isValid(t));
    TEST_ASSERT_EQUAL_UINT32(e, datetime::toEpoch(t));
    days++;
  }
  TEST_ASSERT_TRUE(days > 30000);
}

static void test_ds3231_set_and_read() {
  FakeI2cBus bus;
  FakeRegisterDevice chip;
  chip.regs[ds3231::kRegStatus] = ds3231::kStatusOsf;  // fresh chip: oscillator stopped
  chip.regs[ds3231::kRegControl] = ds3231::kControlEosc;
  bus.attach(0x68, &chip);
  Ds3231 rtc(bus);
  TEST_ASSERT_EQUAL(Status::Ok, rtc.begin());
  TEST_ASSERT_EQUAL_HEX8(0, chip.regs[ds3231::kRegControl] & ds3231::kControlEosc);  // runs on battery

  TEST_ASSERT_EQUAL(Status::TimeInvalid, rtc.nowEpoch().status);  // never use stale time
  TEST_ASSERT_EQUAL(Status::OutOfRange, rtc.setEpoch(100));       // 1970: outside chip range
  TEST_ASSERT_EQUAL(Status::Ok, rtc.setEpoch(1791376496UL));
  TEST_ASSERT_EQUAL_HEX8(0, chip.regs[ds3231::kRegStatus] & ds3231::kStatusOsf);
  TEST_ASSERT_EQUAL_HEX8(0x56, chip.regs[0]);  // seconds in BCD
  TEST_ASSERT_EQUAL_HEX8(0x26, chip.regs[6]);  // year 26 in BCD
  TEST_ASSERT_EQUAL_HEX8(3, chip.regs[3]);     // 2026-10-07 is a Wednesday (1 = Monday)

  const Result<uint32_t> now = rtc.nowEpoch();
  TEST_ASSERT_TRUE(now.ok());
  TEST_ASSERT_EQUAL_UINT32(1791376496UL, now.value);
}

static void test_ds3231_decode_12h_and_garbage() {
  // 2026-01-02 11:05:09 PM in 12-hour mode.
  const uint8_t pm[7] = {0x09, 0x05, static_cast<uint8_t>(ds3231::kHour12h | ds3231::kHourPm | 0x11), 5, 0x02, 0x01, 0x26};
  DateTime t;
  TEST_ASSERT_TRUE(ds3231::decodeTime(pm, t));
  TEST_ASSERT_EQUAL(23, t.hour);
  const uint8_t midnight[7] = {0, 0, static_cast<uint8_t>(ds3231::kHour12h | 0x12), 1, 0x01, 0x01, 0x26};
  TEST_ASSERT_TRUE(ds3231::decodeTime(midnight, t));
  TEST_ASSERT_EQUAL(0, t.hour);  // 12 AM = 00
  const uint8_t bad[7] = {0x5A, 0, 0, 1, 0x31, 0x02, 0x26};  // invalid BCD seconds, Feb 31
  TEST_ASSERT_FALSE(ds3231::decodeTime(bad, t));
}

static void test_ds3231_temperature_and_missing() {
  FakeI2cBus bus;
  FakeRegisterDevice chip;
  bus.attach(0x68, &chip);
  Ds3231 rtc(bus);
  chip.regs[ds3231::kRegTempMsb] = 25;
  chip.regs[ds3231::kRegTempMsb + 1] = 0x40;  // +0.25
  TEST_ASSERT_EQUAL_INT16(101, rtc.temperatureQuarterC().value);
  chip.regs[ds3231::kRegTempMsb] = 0xFF;      // -1 + 0.75 = -0.25
  chip.regs[ds3231::kRegTempMsb + 1] = 0xC0;
  TEST_ASSERT_EQUAL_INT16(-1, rtc.temperatureQuarterC().value);

  FakeI2cBus empty;
  Ds3231 missing(empty);
  TEST_ASSERT_EQUAL(Status::DeviceMissing, missing.begin());
}

// ---------------------------------------------------------------- MPU9250 --

static void test_mpu_decode_units_and_saturation() {
  // ax = +1 g (8192), ay = -0.5 g, az = 0; temp raw 0 -> 21 C; gx = 65 LSB = 65/65.5 dps.
  const uint8_t raw[14] = {0x20, 0x00, 0xF0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x41, 0x00, 0x00, 0x7F, 0xFF};
  const ImuSample s = mpu9250::decodeImu(raw);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 1.0f, s.accelG.x);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, -0.5f, s.accelG.y);
  TEST_ASSERT_FLOAT_WITHIN(1e-3, 65.0f / 65.5f, s.gyroDps.x);
  TEST_ASSERT_FLOAT_WITHIN(1e-3, 21.0f, s.tempC);
  TEST_ASSERT_TRUE(s.saturated);  // gz = 32767 is full scale
}

static void test_mpu_decode_mag_axes_and_overflow() {
  // HX = 100, HY = 200, HZ = 300 LSB (little-endian), ST2 ok.
  const uint8_t raw[7] = {100, 0, 200, 0, 0x2C, 0x01, 0x10};
  Vec3 ut;
  TEST_ASSERT_TRUE(mpu9250::decodeMag(raw, vec3(1, 1, 1), ut));
  TEST_ASSERT_FLOAT_WITHIN(1e-3, 30.0f, ut.x);   // X_mpu = Y_mag
  TEST_ASSERT_FLOAT_WITHIN(1e-3, 15.0f, ut.y);   // Y_mpu = X_mag
  TEST_ASSERT_FLOAT_WITHIN(1e-3, -45.0f, ut.z);  // Z_mpu = -Z_mag
  const uint8_t overflow[7] = {0, 0, 0, 0, 0, 0, mpu9250::kMagSt2Overflow};
  TEST_ASSERT_FALSE(mpu9250::decodeMag(overflow, vec3(1, 1, 1), ut));
}

static void test_mpu_begin_detects_mpu6500_without_mag() {
  FakeI2cBus bus;
  FakeClock clock;
  FakeRegisterDevice mpu;
  mpu.regs[mpu9250::kRegWhoAmI] = mpu9250::kWhoAmI6500;
  bus.attach(0x69, &mpu);
  Mpu9250 imu(bus, clock);
  TEST_ASSERT_EQUAL(Status::Ok, imu.begin());
  TEST_ASSERT_FALSE(imu.hasMag());
  TEST_ASSERT_EQUAL(Status::Unsupported, imu.readMag().status);
  TEST_ASSERT_EQUAL_HEX8(0x08, mpu.regs[mpu9250::kRegAccelConfig]);  // +-4 g
}

static void test_mpu_begin_with_mag_and_wrong_chip() {
  FakeI2cBus bus;
  FakeClock clock;
  FakeRegisterDevice mpu, mag;
  mpu.regs[mpu9250::kRegWhoAmI] = mpu9250::kWhoAmI9250;
  mag.regs[mpu9250::kMagRegWia] = mpu9250::kMagWia;
  mag.regs[mpu9250::kMagRegAsax] = 128;
  mag.regs[mpu9250::kMagRegAsax + 1] = 128;
  mag.regs[mpu9250::kMagRegAsax + 2] = 128;
  bus.attach(0x69, &mpu);
  bus.attach(0x0C, &mag);
  Mpu9250 imu(bus, clock);
  TEST_ASSERT_EQUAL(Status::Ok, imu.begin());
  TEST_ASSERT_TRUE(imu.hasMag());
  TEST_ASSERT_EQUAL_HEX8(0x16, mag.regs[mpu9250::kMagRegCntl1]);  // 16-bit continuous 100 Hz
  TEST_ASSERT_EQUAL(Status::NotReady, imu.readMag().status);       // ST1.DRDY = 0

  FakeRegisterDevice other;
  other.regs[mpu9250::kRegWhoAmI] = 0x12;
  FakeI2cBus bus2;
  bus2.attach(0x69, &other);
  Mpu9250 wrong(bus2, clock);
  TEST_ASSERT_EQUAL(Status::DeviceMissing, wrong.begin());
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_at24c_write_read_across_page_boundary);
  RUN_TEST(test_at24c_put_get_struct);
  RUN_TEST(test_at24c_ack_polling_waits_for_write_cycle);
  RUN_TEST(test_at24c_errors);
  RUN_TEST(test_at24c_write_cycle_timeout);
  RUN_TEST(test_datetime_known_epochs);
  RUN_TEST(test_datetime_roundtrip_every_day_2000_to_2099);
  RUN_TEST(test_ds3231_set_and_read);
  RUN_TEST(test_ds3231_decode_12h_and_garbage);
  RUN_TEST(test_ds3231_temperature_and_missing);
  RUN_TEST(test_mpu_decode_units_and_saturation);
  RUN_TEST(test_mpu_decode_mag_axes_and_overflow);
  RUN_TEST(test_mpu_begin_detects_mpu6500_without_mag);
  RUN_TEST(test_mpu_begin_with_mag_and_wrong_chip);
  return UNITY_END();
}
