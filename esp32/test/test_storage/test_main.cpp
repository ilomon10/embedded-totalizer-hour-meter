// Storage tests: journal (wear levelling, power-cut recovery), settings A/B, layout header.
#include <unity.h>

#include "FakeClock.h"
#include "FakeI2cBus.h"
#include "Journal.h"
#include "LayoutHeader.h"
#include "Crc.h"
#include "SettingsStore.h"

void setUp() {}
void tearDown() {}

struct Rig {
  FakeI2cBus bus;
  FakeClock clock;
  FakeAt24c chip;
  At24c eeprom{bus, clock};
  Rig() {
    chip.busyProbes = 0;  // keep the tests fast
    bus.attach(0x50, &chip);
  }
};

static void test_journal_empty_then_append_and_reload() {
  Rig rig;
  Journal j(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, j.begin());
  TEST_ASSERT_FALSE(j.hasRecord());

  TEST_ASSERT_EQUAL(Status::Ok, j.append(3600, 10, 1791376496UL, journal_flags::kTimeValid));
  TEST_ASSERT_EQUAL(Status::Ok, j.append(3660, 12, 1791376556UL, journal_flags::kTimeValid));
  TEST_ASSERT_EQUAL_UINT32(1, j.latestSlot());

  Journal afterReboot(rig.eeprom);  // a new object = power cycle
  TEST_ASSERT_EQUAL(Status::Ok, afterReboot.begin());
  TEST_ASSERT_TRUE(afterReboot.hasRecord());
  TEST_ASSERT_EQUAL_UINT32(3660, afterReboot.latest().runSeconds);
  TEST_ASSERT_EQUAL_UINT32(12, afterReboot.latest().totalCount);
  TEST_ASSERT_EQUAL_UINT32(2, afterReboot.latest().seq);
}

static void test_journal_wraps_around_ring() {
  Rig rig;
  Journal j(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, j.begin());
  const uint32_t total = layout::kJournalSlots + 5;  // go round once and a bit
  for (uint32_t i = 1; i <= total; i++) {
    TEST_ASSERT_EQUAL(Status::Ok, j.append(i, i * 2, 0, 0));
  }
  TEST_ASSERT_EQUAL_UINT32(4, j.latestSlot());  // slots 0..991, then 0..4

  Journal reboot(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, reboot.begin());
  TEST_ASSERT_EQUAL_UINT32(total, reboot.latest().runSeconds);
  TEST_ASSERT_EQUAL_UINT32(4, reboot.latestSlot());
  // Wear levelling: each slot written at most twice, not 997 times.
  TEST_ASSERT_TRUE(rig.chip.pageWrites <= static_cast<int>(total) + 1);
}

static void test_journal_power_cut_during_write_falls_back() {
  Rig rig;
  Journal j(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, j.begin());
  TEST_ASSERT_EQUAL(Status::Ok, j.append(100, 1, 0, 0));
  TEST_ASSERT_EQUAL(Status::Ok, j.append(200, 2, 0, 0));
  // Simulate a torn write of record #2: damage bytes in its slot.
  const uint32_t addr = layout::kJournalAddr + 1 * layout::kJournalRecordSize;
  rig.chip.mem[addr + 8] ^= 0x5A;  // inside runSeconds

  Journal reboot(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, reboot.begin());
  TEST_ASSERT_EQUAL_UINT32(100, reboot.latest().runSeconds);  // previous good record
  TEST_ASSERT_EQUAL_UINT32(1, reboot.invalidSlotsSeen());
  // The next save overwrites the damaged slot and continues the sequence.
  TEST_ASSERT_EQUAL(Status::Ok, reboot.append(150, 1, 0, 0));
  TEST_ASSERT_EQUAL_UINT32(1, reboot.latestSlot());
  TEST_ASSERT_EQUAL_UINT32(2, reboot.latest().seq);
}

static void test_journal_reports_write_failure() {
  Rig rig;
  Journal j(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, j.begin());
  rig.chip.corruptNextWrite = 0;
  TEST_ASSERT_EQUAL(Status::VerifyFailed, j.append(1, 1, 0, 0));
  TEST_ASSERT_FALSE(j.hasRecord());  // state not advanced on failure
}

static void test_settings_defaults_then_ab_alternation() {
  Rig rig;
  SettingsStore store(rig.eeprom);
  Settings s;
  TEST_ASSERT_EQUAL(Status::NotFound, store.load(s));
  TEST_ASSERT_EQUAL(SettingsSource::Defaults, store.source());
  TEST_ASSERT_EQUAL_UINT16(1000, s.telemetryIntervalMs);

  s.telemetryIntervalMs = 500;
  TEST_ASSERT_EQUAL(Status::Ok, store.save(s));  // -> A
  TEST_ASSERT_EQUAL(SettingsSource::CopyA, store.source());
  s.telemetryIntervalMs = 250;
  TEST_ASSERT_EQUAL(Status::Ok, store.save(s));  // -> B (A keeps 500)
  TEST_ASSERT_EQUAL(SettingsSource::CopyB, store.source());

  SettingsStore reboot(rig.eeprom);
  Settings loaded;
  TEST_ASSERT_EQUAL(Status::Ok, reboot.load(loaded));
  TEST_ASSERT_EQUAL_UINT16(250, loaded.telemetryIntervalMs);
  TEST_ASSERT_EQUAL(SettingsSource::CopyB, reboot.source());
}

// runVibMinMg lives in record bytes that firmware < 2.5.0 kept reserved (0): an
// old record must load unchanged, with the new setting off.
static void test_settings_new_field_round_trips_and_old_records_read_as_off() {
  Rig rig;
  SettingsStore store(rig.eeprom);
  Settings s = defaultSettings();
  s.pulsesPerUnit = 42;
  s.cal.flags = calib_flags::kImu;
  s.runVibMinMg = 35;
  TEST_ASSERT_EQUAL(Status::Ok, store.save(s));  // -> A
  SettingsStore reboot(rig.eeprom);
  Settings loaded;
  TEST_ASSERT_EQUAL(Status::Ok, reboot.load(loaded));
  TEST_ASSERT_EQUAL_UINT16(35, loaded.runVibMinMg);
  TEST_ASSERT_EQUAL_UINT16(42, loaded.pulsesPerUnit);

  // What 2.4.0 wrote: same record, those two bytes zero, CRC over all of it.
  SettingsRecord old;
  TEST_ASSERT_EQUAL(Status::Ok, rig.eeprom.get(layout::kSettingsAddrA, old));
  old.runVibMinMg = 0;
  old.crc = crcOfStructWithoutTail(old);
  TEST_ASSERT_EQUAL(Status::Ok, rig.eeprom.put(layout::kSettingsAddrA, old));
  SettingsStore upgraded(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, upgraded.load(loaded));
  TEST_ASSERT_EQUAL(SettingsSource::CopyA, upgraded.source());  // not reset to defaults
  TEST_ASSERT_EQUAL_UINT16(0, loaded.runVibMinMg);
  TEST_ASSERT_EQUAL_UINT16(42, loaded.pulsesPerUnit);
  TEST_ASSERT_EQUAL_UINT8(calib_flags::kImu, loaded.cal.flags);
}

static void test_settings_corrupt_newest_uses_older_copy() {
  Rig rig;
  SettingsStore store(rig.eeprom);
  Settings s = defaultSettings();
  s.persistIntervalS = 30;
  TEST_ASSERT_EQUAL(Status::Ok, store.save(s));  // A
  s.persistIntervalS = 90;
  TEST_ASSERT_EQUAL(Status::Ok, store.save(s));  // B (newest)
  rig.chip.mem[layout::kSettingsAddrB + 20] ^= 0xFF;

  SettingsStore reboot(rig.eeprom);
  Settings loaded;
  TEST_ASSERT_EQUAL(Status::Ok, reboot.load(loaded));
  TEST_ASSERT_EQUAL(SettingsSource::CopyA, reboot.source());
  TEST_ASSERT_EQUAL_UINT16(30, loaded.persistIntervalS);

  rig.chip.mem[layout::kSettingsAddrA + 20] ^= 0xFF;  // both bad
  SettingsStore reboot2(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::NotFound, reboot2.load(loaded));
  TEST_ASSERT_EQUAL_UINT16(60, loaded.persistIntervalS);  // factory default
}

static void test_layout_header_formats_foreign_eeprom_once() {
  Rig rig;
  for (size_t i = 0; i < FakeAt24c::kSize; i++) rig.chip.mem[i] = static_cast<uint8_t>(i * 7);  // garbage
  Journal j(rig.eeprom);
  Result<bool> r = layout_header::ensure(rig.eeprom, j);
  TEST_ASSERT_TRUE(r.ok());
  TEST_ASSERT_TRUE(r.value);  // formatted
  TEST_ASSERT_EQUAL_HEX8(0xFF, rig.chip.mem[layout::kJournalAddr + 100]);
  TEST_ASSERT_EQUAL_HEX8(0xFF, rig.chip.mem[layout::kSettingsAddrA]);

  r = layout_header::ensure(rig.eeprom, j);
  TEST_ASSERT_TRUE(r.ok());
  TEST_ASSERT_FALSE(r.value);  // second boot: recognised, untouched
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_journal_empty_then_append_and_reload);
  RUN_TEST(test_journal_wraps_around_ring);
  RUN_TEST(test_journal_power_cut_during_write_falls_back);
  RUN_TEST(test_journal_reports_write_failure);
  RUN_TEST(test_settings_defaults_then_ab_alternation);
  RUN_TEST(test_settings_new_field_round_trips_and_old_records_read_as_off);
  RUN_TEST(test_settings_corrupt_newest_uses_older_copy);
  RUN_TEST(test_layout_header_formats_foreign_eeprom_once);
  return UNITY_END();
}
