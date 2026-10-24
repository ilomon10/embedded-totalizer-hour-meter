// Storage tests: journal (wear levelling, power-cut recovery), settings A/B, layout header, the flash
// store (NOR-flash journal + settings) and the mirror that keeps flash and EEPROM in step.
#include <unity.h>

#include "FakeClock.h"
#include "FakeFlash.h"
#include "FakeI2cBus.h"
#include "FlashStore.h"
#include "Journal.h"
#include "LayoutHeader.h"
#include "Crc.h"
#include "SettingsStore.h"
#include "StorageMirror.h"

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

static void test_journal_and_settings_take_a_seq_from_the_caller() {
  Rig rig;
  Journal j(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, j.begin());
  TEST_ASSERT_EQUAL(Status::Ok, j.append(10, 1, 0, 0, 500));
  TEST_ASSERT_EQUAL(Status::Ok, j.append(20, 2, 0, 0));  // the next one continues from it
  TEST_ASSERT_EQUAL_UINT32(501, j.latest().seq);

  SettingsStore store(rig.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, store.save(defaultSettings(), 77));
  TEST_ASSERT_EQUAL_UINT32(77, store.seq());
  SettingsStore reboot(rig.eeprom);
  Settings s;
  TEST_ASSERT_EQUAL(Status::Ok, reboot.load(s));
  TEST_ASSERT_EQUAL_UINT32(77, reboot.seq());
}

// ------------------------------------------------------------- flash store --

using Flash = FakeFlash<>;

static void test_flash_store_needs_its_partition() {
  Flash flash;
  flash.missing = true;  // an app-only update kept a partition table without "hmdata"
  FlashStore fs(flash);
  TEST_ASSERT_EQUAL(Status::NotFound, fs.begin());
  TEST_ASSERT_FALSE(fs.available());
  TEST_ASSERT_EQUAL(Status::NotFound, fs.append(1, 1, 0, 0, 1));
  TEST_ASSERT_EQUAL(Status::NotFound, fs.saveSettings(defaultSettings(), 1));
}

static void test_flash_store_append_and_reload_on_unerased_flash() {
  Flash flash;  // 0xA5 everywhere: whatever the partition held before
  FlashStore fs(flash);
  TEST_ASSERT_EQUAL(Status::Ok, fs.begin());
  TEST_ASSERT_FALSE(fs.hasRecord());
  TEST_ASSERT_FALSE(fs.hasSettings());
  TEST_ASSERT_EQUAL(Status::Ok, fs.append(3600, 10, 1791376496UL, journal_flags::kTimeValid, 7));
  TEST_ASSERT_EQUAL(Status::Ok, fs.append(3660, 12, 1791376556UL, journal_flags::kTimeValid, 8));
  TEST_ASSERT_EQUAL(1, flash.erases[FlashStore::kSettingsSectors]);  // the first journal sector, once

  FlashStore reboot(flash);
  TEST_ASSERT_EQUAL(Status::Ok, reboot.begin());
  TEST_ASSERT_TRUE(reboot.hasRecord());
  TEST_ASSERT_EQUAL_UINT32(8, reboot.latest().seq);
  TEST_ASSERT_EQUAL_UINT32(3660, reboot.latest().runSeconds);
  TEST_ASSERT_EQUAL_UINT32(12, reboot.latest().totalCount);
  TEST_ASSERT_EQUAL_UINT32(1, reboot.latestSlot());
}

static void test_flash_store_ring_wraps_with_bounded_wear() {
  Flash flash;
  FlashStore fs(flash);
  TEST_ASSERT_EQUAL(Status::Ok, fs.begin());
  const uint32_t total = 2 * FlashStore::kJournalSlots + 5;  // twice round and a bit
  for (uint32_t i = 1; i <= total; i++) {
    TEST_ASSERT_EQUAL(Status::Ok, fs.append(i, i * 2, 0, 0, i));
  }
  FlashStore reboot(flash);
  TEST_ASSERT_EQUAL(Status::Ok, reboot.begin());
  TEST_ASSERT_EQUAL_UINT32(total, reboot.latest().runSeconds);
  TEST_ASSERT_EQUAL_UINT32(4, reboot.latestSlot());
  // Wear levelling: 3589 saves erase no journal sector more than 3 times, the settings sectors never.
  TEST_ASSERT_EQUAL(0, flash.erases[0] + flash.erases[1]);
  TEST_ASSERT_EQUAL(3, flash.maxErases());
}

static void test_flash_store_power_cut_during_a_save() {
  Flash flash;
  FlashStore fs(flash);
  TEST_ASSERT_EQUAL(Status::Ok, fs.begin());
  for (uint32_t i = 1; i <= 3; i++) {
    TEST_ASSERT_EQUAL(Status::Ok, fs.append(i * 100, i, 0, 0, i));
  }
  flash.cutNextWriteAfter = 10;  // power lost 10 bytes into save #4
  TEST_ASSERT_NOT_EQUAL(Status::Ok, fs.append(400, 4, 0, 0, 4));

  flash.powerOn();
  FlashStore reboot(flash);
  TEST_ASSERT_EQUAL(Status::Ok, reboot.begin());
  TEST_ASSERT_EQUAL_UINT32(3, reboot.latest().seq);  // the last complete save
  TEST_ASSERT_EQUAL_UINT32(300, reboot.latest().runSeconds);
  // The half-written slot is skipped, never written over.
  TEST_ASSERT_EQUAL(Status::Ok, reboot.append(450, 5, 0, 0, 4));
  TEST_ASSERT_EQUAL_UINT32(4, reboot.latestSlot());
  FlashStore again(flash);
  TEST_ASSERT_EQUAL(Status::Ok, again.begin());
  TEST_ASSERT_EQUAL_UINT32(450, again.latest().runSeconds);
}

static void test_flash_store_power_cut_while_erasing_the_next_sector() {
  Flash flash;
  FlashStore fs(flash);
  TEST_ASSERT_EQUAL(Status::Ok, fs.begin());
  const uint32_t perSector = FlashStore::kSlotsPerSector;
  for (uint32_t i = 1; i <= perSector; i++) {  // fill the first journal sector
    TEST_ASSERT_EQUAL(Status::Ok, fs.append(i, i, 0, 0, i));
  }
  flash.cutNextEraseAfter = 1000;  // power lost while erasing the next sector
  TEST_ASSERT_NOT_EQUAL(Status::Ok, fs.append(999, 999, 0, 0, perSector + 1));

  flash.powerOn();
  FlashStore reboot(flash);
  TEST_ASSERT_EQUAL(Status::Ok, reboot.begin());
  TEST_ASSERT_EQUAL_UINT32(perSector, reboot.latest().seq);  // the sector with the newest record was not touched
  TEST_ASSERT_EQUAL(Status::Ok, reboot.append(999, 999, 0, 0, perSector + 1));
  TEST_ASSERT_EQUAL_UINT32(perSector, reboot.latestSlot());  // first slot of the next sector
}

static void test_flash_settings_alternate_and_survive_a_cut_save() {
  Flash flash;
  FlashStore fs(flash);
  TEST_ASSERT_EQUAL(Status::Ok, fs.begin());
  Settings s = defaultSettings();
  s.telemetryIntervalMs = 500;
  TEST_ASSERT_EQUAL(Status::Ok, fs.saveSettings(s, 1));  // copy A
  TEST_ASSERT_EQUAL(SettingsSource::FlashA, fs.settingsSource());
  s.telemetryIntervalMs = 250;
  TEST_ASSERT_EQUAL(Status::Ok, fs.saveSettings(s, 2));  // copy B; A keeps 500
  TEST_ASSERT_EQUAL(SettingsSource::FlashB, fs.settingsSource());

  s.telemetryIntervalMs = 125;
  flash.cutNextEraseAfter = 100;  // power lost while erasing copy A for save 3
  TEST_ASSERT_NOT_EQUAL(Status::Ok, fs.saveSettings(s, 3));
  flash.powerOn();
  FlashStore reboot(flash);
  TEST_ASSERT_EQUAL(Status::Ok, reboot.begin());
  Settings loaded;
  reboot.loadSettings(loaded);
  TEST_ASSERT_EQUAL_UINT16(250, loaded.telemetryIntervalMs);  // copy B, untouched
  TEST_ASSERT_EQUAL_UINT32(2, reboot.settingsSeq());
  TEST_ASSERT_EQUAL(SettingsSource::FlashB, reboot.settingsSource());
}

static void test_flash_store_reports_a_failing_flash() {
  Flash flash;
  FlashStore fs(flash);
  TEST_ASSERT_EQUAL(Status::Ok, fs.begin());
  flash.failWrites = true;
  TEST_ASSERT_NOT_EQUAL(Status::Ok, fs.append(1, 1, 0, 0, 1));
  TEST_ASSERT_FALSE(fs.hasRecord());
}

// ------------------------------------------------------------------ mirror --

constexpr uint32_t kLineageA = 0xA1A1A1A1;  // "random" history ids handed to adopt()
constexpr uint32_t kLineageB = 0xB2B2B2B2;

// The device's two stores. Every Boot builds fresh objects over the same flash and EEPROM chip.
struct Media {
  Flash flash;
  FakeI2cBus bus;
  FakeClock clock;
  FakeAt24c chip;
  At24c eeprom{bus, clock};
  Media() {
    chip.busyProbes = 0;
    bus.attach(0x50, &chip);
  }
};

struct Boot {
  FlashStore fs;
  Journal journal;
  SettingsStore settings;
  StorageMirror mirror;
  StoredState state;
  Boot(Media& m, bool eepromFitted, uint32_t freshLineage = kLineageA) : Boot(m, m.flash, eepromFitted, freshLineage) {}
  // Another ESP32 board (its own flash) with the same EEPROM chip.
  Boot(Media& m, Flash& board, bool eepromFitted, uint32_t freshLineage)
      : fs(board), journal(m.eeprom), settings(m.eeprom), mirror(fs, journal, settings) {
    (void)fs.begin();  // NotFound when the test removed the partition
    if (eepromFitted) {
      TEST_ASSERT_TRUE(layout_header::ensure(m.eeprom, journal).ok());
      TEST_ASSERT_EQUAL(Status::Ok, journal.begin());
    }
    state = mirror.adopt(eepromFitted, freshLineage);
  }
  // The EEPROM answers while running: scan it, ask what it gives.
  LateEeprom eepromArrives(bool wantSettings = false) {
    TEST_ASSERT_EQUAL(Status::Ok, journal.begin());
    return mirror.fromLateEeprom(wantSettings, state.hasSettings ? state.settings : defaultSettings());
  }
};

// What firmware 2.5.0 left in an EEPROM: 40 counter saves (lineage 0), 5 settings saves.
static void fillEepromLikeOldFirmware(Media& m, uint32_t runSecondsPerSave = 60, uint32_t countPerSave = 1) {
  Journal j(m.eeprom);
  TEST_ASSERT_TRUE(layout_header::ensure(m.eeprom, j).ok());
  TEST_ASSERT_EQUAL(Status::Ok, j.begin());
  for (uint32_t i = 1; i <= 40; i++) {
    TEST_ASSERT_EQUAL(Status::Ok, j.append(i * runSecondsPerSave, i * countPerSave, 0, journal_flags::kTimeValid));
  }
  SettingsStore st(m.eeprom);
  Settings s = defaultSettings();
  s.pulsesPerUnit = 42;
  for (int i = 0; i < 5; i++) {
    TEST_ASSERT_EQUAL(Status::Ok, st.save(s));
  }
}

static void test_mirror_combine_adds_only_to_counters_counted_from_zero() {
  using journal_flags::kCountFromZero;
  using journal_flags::kRunFromZero;
  const JournalRecord other = Journal::makeRecord(5000, 300, 0, 0, 40, 0);
  JournalRecord own = Journal::makeRecord(100, 7, 0, kRunFromZero | kCountFromZero, 3, kLineageA);
  JournalRecord r = storage_mirror::combine(own, other);
  TEST_ASSERT_EQUAL_UINT32(5100, r.runSeconds);
  TEST_ASSERT_EQUAL_UINT32(307, r.totalCount);
  TEST_ASSERT_EQUAL_UINT8(0, r.flags & (kRunFromZero | kCountFromZero));  // known now: never added twice
  TEST_ASSERT_EQUAL_UINT32(kLineageA, r.lineage);

  own = Journal::makeRecord(100, 7, 0, kCountFromZero, 3, kLineageA);  // the hour meter was preset
  r = storage_mirror::combine(own, other);
  TEST_ASSERT_EQUAL_UINT32(100, r.runSeconds);
  TEST_ASSERT_EQUAL_UINT32(307, r.totalCount);
  TEST_ASSERT_EQUAL_UINT32(UINT32_MAX, storage_mirror::nextSeq(UINT32_MAX, 0, 0));
}

// The first boot after the update copies the EEPROM into the flash at once; when the EEPROM dies
// afterwards, the device carries on from the flash alone.
static void test_mirror_copies_the_eeprom_to_flash_and_survives_a_dead_eeprom() {
  Media m;
  fillEepromLikeOldFirmware(m);
  {
    Boot first(m, true);
    TEST_ASSERT_TRUE(first.state.hasCounters);
    TEST_ASSERT_EQUAL_UINT32(2400, first.state.counters.runSeconds);
    TEST_ASSERT_EQUAL_UINT32(kLineageA, first.mirror.lineage());  // 2.5.0 records have none: a new id
    TEST_ASSERT_FALSE(first.mirror.runFromZero());                 // a real, known history
    TEST_ASSERT_TRUE(first.state.hasSettings);
    TEST_ASSERT_EQUAL_UINT16(42, first.state.settings.pulsesPerUnit);
    TEST_ASSERT_FALSE(first.mirror.lastSaveFailed());
  }
  Boot noEeprom(m, false, kLineageB);  // the EEPROM is dead or unplugged
  TEST_ASSERT_TRUE(noEeprom.state.hasCounters);
  TEST_ASSERT_EQUAL_UINT32(2400, noEeprom.state.counters.runSeconds);
  TEST_ASSERT_EQUAL_UINT8(journal_flags::kTimeValid, noEeprom.state.counters.flags);
  TEST_ASSERT_EQUAL_UINT32(kLineageA, noEeprom.mirror.lineage());  // the same history continues
  TEST_ASSERT_EQUAL_UINT16(42, noEeprom.state.settings.pulsesPerUnit);
  TEST_ASSERT_EQUAL(SettingsSource::FlashA, noEeprom.mirror.settingsSource());
  TEST_ASSERT_EQUAL(Status::Ok, noEeprom.mirror.saveCounters(2460, 41, 0, 0, false));
}

// Every save goes to both stores with one seq, so either store alone has the newest values.
static void test_mirror_saves_to_both_stores() {
  Media m;
  {
    Boot b(m, true);
    TEST_ASSERT_FALSE(b.state.hasCounters);  // a new device
    TEST_ASSERT_TRUE(b.mirror.runFromZero());
    TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(100, 5, 0, 0, true));
    TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(160, 6, 0, 0, true));
    Settings s = defaultSettings();
    s.persistIntervalS = 30;
    TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveSettings(s, true));
    TEST_ASSERT_EQUAL_UINT32(2, b.mirror.counterSeq());
    TEST_ASSERT_EQUAL(SettingsSource::FlashA, b.mirror.settingsSource());
  }
  {
    Boot flashOnly(m, false);
    TEST_ASSERT_EQUAL_UINT32(160, flashOnly.state.counters.runSeconds);
    TEST_ASSERT_EQUAL_UINT16(30, flashOnly.state.settings.persistIntervalS);
  }
  m.flash.missing = true;  // as if an app-only update kept the old partition table: the EEPROM alone
  Boot eepromOnly(m, true);
  TEST_ASSERT_EQUAL_UINT32(160, eepromOnly.state.counters.runSeconds);
  TEST_ASSERT_EQUAL_UINT16(30, eepromOnly.state.settings.persistIntervalS);
}

// An EEPROM that missed saves is brought up to date; so is a new blank one.
static void test_mirror_refills_a_stale_or_replaced_eeprom() {
  Media m;
  {
    Boot b(m, true);
    TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(500, 50, 0, 0, true));
  }
  {
    Boot alone(m, false);  // EEPROM unplugged for a while: three saves to the flash only
    for (uint32_t i = 2; i <= 4; i++) {
      TEST_ASSERT_EQUAL(Status::Ok, alone.mirror.saveCounters(500 * i, 50 * i, 0, 0, false));
    }
  }
  {
    Boot back(m, true);  // the stale EEPROM is back: same history, the flash is ahead
    TEST_ASSERT_EQUAL_UINT32(2000, back.state.counters.runSeconds);
    TEST_ASSERT_EQUAL_UINT32(2000, back.journal.latest().runSeconds);  // and the EEPROM got a copy
  }
  memset(m.chip.mem, 0xFF, sizeof(m.chip.mem));  // a new, blank EEPROM
  {
    Boot fresh(m, true);
    TEST_ASSERT_EQUAL_UINT32(2000, fresh.state.counters.runSeconds);
    TEST_ASSERT_EQUAL_UINT32(2000, fresh.journal.latest().runSeconds);
  }
  m.flash.missing = true;
  Boot eepromOnly(m, true);  // that EEPROM alone carries the device now
  TEST_ASSERT_EQUAL_UINT32(2000, eepromOnly.state.counters.runSeconds);
}

// A record the device wrote itself is never added again: the EEPROM drops out and comes back (review
// finding: blank stores at boot, 1000 counted, then the hour meter doubled).
static void test_mirror_never_adds_its_own_records() {
  Media m;
  memset(m.chip.mem, 0xFF, sizeof(m.chip.mem));
  {
    Boot b(m, true);  // blank flash, blank EEPROM: counting from zero
    TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(3600, 1000, 0, 0, true));
    const LateEeprom back = b.eepromArrives();  // contact lost for 6 s, then back
    TEST_ASSERT_EQUAL_UINT32(0, back.addRunSeconds);
    TEST_ASSERT_EQUAL_UINT32(0, back.addTotalCount);
  }
  Boot reboot(m, true, kLineageB);
  TEST_ASSERT_EQUAL_UINT32(1000, reboot.state.counters.totalCount);  // not 2000
  TEST_ASSERT_EQUAL_UINT32(kLineageA, reboot.mirror.lineage());
}

// The first boot of 2.6.0 could not read the EEPROM (bad contact), so the device counted from zero.
// The EEPROM's history is added, and the answer is the same at boot and when it answers while running.
static void test_mirror_adds_an_unread_eeprom_history_the_same_way_at_boot_and_later() {
  Media atBoot;
  fillEepromLikeOldFirmware(atBoot, 126, 0);  // 40 saves: 5040 s on the EEPROM
  {
    Boot first(atBoot, false);  // the EEPROM does not answer
    TEST_ASSERT_TRUE(first.mirror.runFromZero());
    TEST_ASSERT_EQUAL(Status::Ok, first.mirror.saveCounters(1000, 0, 0, 0, false));
  }
  Boot second(atBoot, true, kLineageB);  // power cycle, now it answers
  TEST_ASSERT_EQUAL_UINT32(6040, second.state.counters.runSeconds);
  TEST_ASSERT_FALSE(second.mirror.runFromZero());
  TEST_ASSERT_EQUAL_UINT32(6040, second.journal.latest().runSeconds);  // both stores agree
  TEST_ASSERT_EQUAL_UINT32(6040, second.fs.latest().runSeconds);

  Media later;
  fillEepromLikeOldFirmware(later, 126, 0);
  {
    Boot first(later, false);
    TEST_ASSERT_EQUAL(Status::Ok, first.mirror.saveCounters(1000, 0, 0, 0, false));
  }
  Boot second2(later, false, kLineageB);  // it answers only 2 s after boot
  const LateEeprom late = second2.eepromArrives();
  TEST_ASSERT_EQUAL_UINT32(5040, late.addRunSeconds);  // 1000 + 5040, as at boot
  TEST_ASSERT_FALSE(second2.mirror.runFromZero());
  TEST_ASSERT_EQUAL_UINT32(0, second2.eepromArrives().addRunSeconds);  // and only once
}

// Counters the device knows win over an EEPROM from another history, whatever its seq: here an old
// EEPROM (seq 40) comes back after the hour meter was set by hand on the flash.
static void test_mirror_known_counters_win_over_an_old_eeprom() {
  Media m;
  fillEepromLikeOldFirmware(m);  // 2400 s, seq 40
  {
    Boot dead(m, false);  // the EEPROM failed
    dead.mirror.anchor(true, true);  // the user set the real values
    TEST_ASSERT_EQUAL(Status::Ok, dead.mirror.saveCounters(36000, 900, 0, journal_flags::kManualSet, false));
    TEST_ASSERT_EQUAL(Status::Ok, dead.mirror.saveCounters(36060, 905, 0, 0, false));
  }
  {
    Boot back(m, true, kLineageB);  // it answers again at boot, with its higher seq
    TEST_ASSERT_EQUAL_UINT32(36060, back.state.counters.runSeconds);
    TEST_ASSERT_EQUAL_UINT32(36060, back.journal.latest().runSeconds);  // and gets the device's values
  }
  Media m2;
  fillEepromLikeOldFirmware(m2);
  Boot dead(m2, false);
  dead.mirror.anchor(true, true);
  TEST_ASSERT_EQUAL(Status::Ok, dead.mirror.saveCounters(36000, 900, 0, journal_flags::kManualSet, false));
  const LateEeprom late = dead.eepromArrives();  // ...or while running
  TEST_ASSERT_EQUAL_UINT32(0, late.addRunSeconds);
  TEST_ASSERT_EQUAL_UINT32(0, late.addTotalCount);
  TEST_ASSERT_TRUE(dead.mirror.eepromCountersBehind());
}

// A preset of the hour meter alone leaves the totalizer counting from zero: only that is added.
static void test_mirror_preset_knows_only_that_counter() {
  Media m;
  fillEepromLikeOldFirmware(m, 60, 10);  // 2400 s, 400 pulses
  Boot b(m, false);
  b.mirror.anchor(true, false);  // setRunSeconds only
  TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(50000, 7, 0, journal_flags::kManualSet, false));
  const LateEeprom late = b.eepromArrives();
  TEST_ASSERT_EQUAL_UINT32(0, late.addRunSeconds);
  TEST_ASSERT_EQUAL_UINT32(400, late.addTotalCount);
}

// Board X saved 3599 s / 10 pulses to both stores; then its EEPROM went to board Y (blank flash), which
// carried on for 100 h, while X was out of service.
static void runEepromInAnotherBoard(Media& m, Flash& boardY) {
  {
    Boot x(m, true);
    TEST_ASSERT_EQUAL(Status::Ok, x.mirror.saveCounters(3599, 10, 0, 0, true));
  }
  Boot y(m, boardY, true, kLineageB);
  TEST_ASSERT_EQUAL_UINT32(3599, y.state.counters.runSeconds);  // carried over by the EEPROM
  TEST_ASSERT_EQUAL_UINT32(kLineageA, y.mirror.lineage());      // the same history goes on
  for (uint32_t i = 1; i <= 100; i++) {
    TEST_ASSERT_EQUAL(Status::Ok, y.mirror.saveCounters(3599 + i * 3600, 10 + i, 0, 0, true));
  }
}

// Within one history the newest save wins, in either store (review: board X swapped back in after board Y
// ran with its EEPROM rolled the hour meter back 100 h).
static void test_mirror_newest_save_wins_within_one_history() {
  {
    Media m;
    Flash boardY;
    runEepromInAnotherBoard(m, boardY);
    Boot back(m, true, kLineageB);  // X is back, with the EEPROM
    TEST_ASSERT_EQUAL_UINT32(363599, back.state.counters.runSeconds);
    TEST_ASSERT_EQUAL_UINT32(110, back.state.counters.totalCount);
    TEST_ASSERT_EQUAL_UINT32(363599, back.fs.latest().runSeconds);  // X's flash is brought up to date
    TEST_ASSERT_EQUAL_UINT32(kLineageA, back.mirror.lineage());
  }
  {
    Media m;  // saves that reached only the EEPROM while flash writes failed
    {
      Boot b(m, true);
      TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(4405, 0, 0, 0, true));
      m.flash.failWrites = true;
      TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(4408, 0, 0, 0, true));
      TEST_ASSERT_TRUE(b.mirror.lastSaveFailed());
      m.flash.failWrites = false;
    }
    Boot back(m, true);
    TEST_ASSERT_EQUAL_UINT32(4408, back.state.counters.runSeconds);
    TEST_ASSERT_EQUAL_UINT32(4408, back.fs.latest().runSeconds);
  }
  // A fork cannot be merged at boot: after the saves above, a boot without the EEPROM moved the flash on
  // (4414 s, seq 2) apart from the EEPROM (4408 s, seq 3). The newer save wins; the flash's branch is lost.
  Media m;
  {
    Boot b(m, true);
    TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(4405, 0, 0, 0, true));
    m.flash.failWrites = true;
    TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(4406, 0, 0, 0, true));
    TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(4408, 0, 0, 0, true));
    m.flash.failWrites = false;
  }
  {
    Boot noEeprom(m, false);
    TEST_ASSERT_EQUAL(Status::Ok, noEeprom.mirror.saveCounters(4414, 0, 0, 0, false));
  }
  Boot back(m, true);
  TEST_ASSERT_EQUAL_UINT32(4408, back.state.counters.runSeconds);
}

// The same EEPROM answering only while board X runs: what Y counted is added to what X counted meanwhile,
// once, and never to a counter set by hand since X last saved to that EEPROM.
static void test_mirror_late_eeprom_adds_what_another_board_counted() {
  {
    Media m;
    Flash boardY;
    runEepromInAnotherBoard(m, boardY);
    Boot x(m, false, kLineageB);
    TEST_ASSERT_EQUAL_UINT32(3599, x.state.counters.runSeconds);
    TEST_ASSERT_EQUAL(Status::Ok, x.mirror.saveCounters(3659, 11, 0, 0, false));  // X ran 60 s meanwhile
    const LateEeprom late = x.eepromArrives();
    TEST_ASSERT_EQUAL_UINT32(360000, late.addRunSeconds);  // 3659 + 360000: both boards' engine time
    TEST_ASSERT_EQUAL_UINT32(100, late.addTotalCount);
    TEST_ASSERT_TRUE(x.mirror.eepromCountersBehind());
    const LateEeprom again = x.eepromArrives();  // contact lost and back before the next save
    TEST_ASSERT_EQUAL_UINT32(0, again.addRunSeconds);
    TEST_ASSERT_EQUAL_UINT32(0, again.addTotalCount);
  }
  {
    Media m;  // the EEPROM left a running board X after X had saved to it: Y goes on from that save
    Flash boardY;
    Boot x(m, true);
    TEST_ASSERT_EQUAL(Status::Ok, x.mirror.saveCounters(3599, 10, 0, 0, true));
    {
      Boot y(m, boardY, true, kLineageB);
      TEST_ASSERT_EQUAL(Status::Ok, y.mirror.saveCounters(3599 + 7200, 15, 0, 0, true));
      TEST_ASSERT_EQUAL(Status::Ok, y.mirror.saveCounters(3599 + 14400, 20, 0, 0, true));
    }
    TEST_ASSERT_EQUAL(Status::Ok, x.mirror.saveCounters(3659, 11, 0, 0, false));
    const LateEeprom late = x.eepromArrives();
    TEST_ASSERT_EQUAL_UINT32(14400, late.addRunSeconds);
    TEST_ASSERT_EQUAL_UINT32(10, late.addTotalCount);
  }
  Media m;
  Flash boardY;
  runEepromInAnotherBoard(m, boardY);
  Boot x(m, false, kLineageB);
  x.mirror.anchor(true, false);  // the hour meter set by hand while the EEPROM was away
  TEST_ASSERT_EQUAL(Status::Ok, x.mirror.saveCounters(500000, 10, 0, journal_flags::kManualSet, false));
  const LateEeprom late = x.eepromArrives();
  TEST_ASSERT_EQUAL_UINT32(0, late.addRunSeconds);
  TEST_ASSERT_EQUAL_UINT32(100, late.addTotalCount);
}

// Settings carry no history id: an EEPROM from another device with the same seq still gets the device's
// settings, at boot and when it answers while running (review). Only the store that lacks them is written.
static void test_mirror_settings_are_compared_by_content() {
  Media m;
  Settings mine = defaultSettings();
  mine.pulsesPerUnit = 11;
  {
    Boot a(m, true);
    TEST_ASSERT_EQUAL(Status::Ok, a.mirror.saveSettings(mine, true));  // seq 1 in both stores
  }
  Settings theirs = defaultSettings();
  theirs.pulsesPerUnit = 78;
  memset(m.chip.mem, 0xFF, sizeof(m.chip.mem));  // another device's EEPROM, its settings also at seq 1
  {
    Journal j(m.eeprom);
    TEST_ASSERT_TRUE(layout_header::ensure(m.eeprom, j).ok());
    SettingsStore other(m.eeprom);
    TEST_ASSERT_EQUAL(Status::Ok, other.save(theirs, 1));
  }
  const int flashErases = m.flash.erases[0] + m.flash.erases[1];
  {
    Boot b(m, true, kLineageB);
    TEST_ASSERT_EQUAL_UINT16(11, b.state.settings.pulsesPerUnit);
    TEST_ASSERT_FALSE(b.mirror.lastSaveFailed());
  }
  Settings check;
  SettingsStore eeprom(m.eeprom);
  TEST_ASSERT_EQUAL(Status::Ok, eeprom.load(check));
  TEST_ASSERT_EQUAL_UINT16(11, check.pulsesPerUnit);
  TEST_ASSERT_EQUAL_INT(flashErases, m.flash.erases[0] + m.flash.erases[1]);  // the flash had them

  TEST_ASSERT_EQUAL(Status::Ok, eeprom.save(theirs, eeprom.seq()));  // and once more, plugged in later
  Boot c(m, false);
  TEST_ASSERT_TRUE(c.eepromArrives().settingsBehind);
  TEST_ASSERT_EQUAL(Status::Ok, c.mirror.saveSettings(mine, true));
  TEST_ASSERT_FALSE(c.eepromArrives().settingsBehind);
}

// A settings save the EEPROM missed is retried by saving the same settings again; the flash, which kept
// them, is not erased again (review: a resend could not clear storageError).
static void test_mirror_settings_retry_writes_only_the_store_that_missed_them() {
  Media m;
  Boot b(m, true);
  Settings s = defaultSettings();
  s.persistIntervalS = 30;
  m.chip.corruptNextWrite = 3;  // one bad EEPROM write
  TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveSettings(s, true));
  TEST_ASSERT_TRUE(b.mirror.lastSaveFailed());
  const int flashErases = m.flash.erases[0] + m.flash.erases[1];
  TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveSettings(s, true));
  TEST_ASSERT_FALSE(b.mirror.lastSaveFailed());
  TEST_ASSERT_EQUAL_INT(flashErases, m.flash.erases[0] + m.flash.erases[1]);
  Settings check;
  TEST_ASSERT_EQUAL(Status::Ok, b.settings.load(check));
  TEST_ASSERT_EQUAL_UINT16(30, check.persistIntervalS);
}

// A failing store does not stop the saves; the failure is reported.
static void test_mirror_keeps_saving_when_one_store_fails() {
  Media m;
  Boot b(m, true);
  m.chip.stuckBusy = true;  // the EEPROM stops answering
  TEST_ASSERT_EQUAL(Status::Ok, b.mirror.saveCounters(10, 1, 0, 0, true));
  TEST_ASSERT_TRUE(b.mirror.lastSaveFailed());
  TEST_ASSERT_EQUAL_UINT32(10, b.fs.latest().runSeconds);
  m.flash.failWrites = true;  // the flash too: nothing kept
  TEST_ASSERT_NOT_EQUAL(Status::Ok, b.mirror.saveCounters(20, 2, 0, 0, true));
  TEST_ASSERT_EQUAL_UINT32(1, b.mirror.counterSeq());  // unchanged
  TEST_ASSERT_NOT_EQUAL(Status::Ok, b.mirror.saveSettings(defaultSettings(), true));
}

static void test_mirror_without_any_store() {
  Media m;
  m.flash.missing = true;
  Boot b(m, false);
  TEST_ASSERT_FALSE(b.mirror.anyStore(false));
  TEST_ASSERT_EQUAL(Status::NotFound, b.mirror.saveCounters(1, 1, 0, 0, false));
  TEST_ASSERT_EQUAL(Status::NotFound, b.mirror.saveSettings(defaultSettings(), false));
}

// A scan cut short must not be trusted: it could aim the next save at the sector with the newest record.
static void test_flash_store_unavailable_after_a_failed_scan() {
  Flash flash;
  {
    FlashStore fs(flash);
    TEST_ASSERT_EQUAL(Status::Ok, fs.begin());
    for (uint32_t i = 1; i <= 300; i++) {
      TEST_ASSERT_EQUAL(Status::Ok, fs.append(i, i, 0, 0, i));
    }
  }
  flash.failReadAt = static_cast<long>(FlashStore::kJournalStart + 200 * FlashStore::kRecordSize);
  FlashStore fs(flash);
  TEST_ASSERT_NOT_EQUAL(Status::Ok, fs.begin());
  TEST_ASSERT_FALSE(fs.available());
  TEST_ASSERT_FALSE(fs.hasRecord());
  TEST_ASSERT_EQUAL(Status::NotFound, fs.append(301, 301, 0, 0, 301));
}

static void test_same_settings() {
  Settings a = defaultSettings();
  Settings b = defaultSettings();
  TEST_ASSERT_TRUE(sameSettings(a, b));
  b.runVibMinMg = 30;
  TEST_ASSERT_FALSE(sameSettings(a, b));
  b = a;
  b.cal.gyroBiasDps.x = 0.5f;
  TEST_ASSERT_FALSE(sameSettings(a, b));
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
  RUN_TEST(test_journal_and_settings_take_a_seq_from_the_caller);
  RUN_TEST(test_flash_store_needs_its_partition);
  RUN_TEST(test_flash_store_append_and_reload_on_unerased_flash);
  RUN_TEST(test_flash_store_ring_wraps_with_bounded_wear);
  RUN_TEST(test_flash_store_power_cut_during_a_save);
  RUN_TEST(test_flash_store_power_cut_while_erasing_the_next_sector);
  RUN_TEST(test_flash_settings_alternate_and_survive_a_cut_save);
  RUN_TEST(test_flash_store_reports_a_failing_flash);
  RUN_TEST(test_mirror_combine_adds_only_to_counters_counted_from_zero);
  RUN_TEST(test_mirror_copies_the_eeprom_to_flash_and_survives_a_dead_eeprom);
  RUN_TEST(test_mirror_saves_to_both_stores);
  RUN_TEST(test_mirror_refills_a_stale_or_replaced_eeprom);
  RUN_TEST(test_mirror_never_adds_its_own_records);
  RUN_TEST(test_mirror_adds_an_unread_eeprom_history_the_same_way_at_boot_and_later);
  RUN_TEST(test_mirror_known_counters_win_over_an_old_eeprom);
  RUN_TEST(test_mirror_preset_knows_only_that_counter);
  RUN_TEST(test_mirror_newest_save_wins_within_one_history);
  RUN_TEST(test_mirror_late_eeprom_adds_what_another_board_counted);
  RUN_TEST(test_mirror_settings_are_compared_by_content);
  RUN_TEST(test_mirror_settings_retry_writes_only_the_store_that_missed_them);
  RUN_TEST(test_mirror_keeps_saving_when_one_store_fails);
  RUN_TEST(test_mirror_without_any_store);
  RUN_TEST(test_flash_store_unavailable_after_a_failed_scan);
  RUN_TEST(test_same_settings);
  return UNITY_END();
}
