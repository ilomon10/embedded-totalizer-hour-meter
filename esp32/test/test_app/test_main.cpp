// App logic tests: hour meter, settings schema, command handler, telemetry, IMU pipeline.
#include <unity.h>

#include "CommandHandler.h"
#include "HourMeter.h"
#include "ImuPipeline.h"
#include "SettingsSchema.h"
#include "Telemetry.h"
#include "TimeKeeper.h"
#include "Presence.h"
#include "AccessGate.h"


void setUp() {}
void tearDown() {}

// ------------------------------------------------------------ HourMeter --

static void test_hourmeter_counts_only_while_running_with_debounce() {
  HourMeter m;
  m.configure(true, 200, 1, 60);
  m.update(0, false);
  for (uint32_t t = 10; t <= 1000; t += 10) m.update(t, t == 500);  // 10 ms glitch: ignored
  TEST_ASSERT_FALSE(m.running());
  TEST_ASSERT_EQUAL_UINT32(0, m.snapshot().runSeconds);

  for (uint32_t t = 1010; t <= 1200; t += 10) m.update(t, true);  // HIGH for 190 ms: not yet
  TEST_ASSERT_FALSE(m.running());
  m.update(1210, true);  // stable for 200 ms -> running
  TEST_ASSERT_TRUE(m.running());
  bool stopped = false;
  for (uint32_t t = 1220; t <= 11210; t += 10) stopped = m.update(t, true) || stopped;
  TEST_ASSERT_FALSE(stopped);
  TEST_ASSERT_EQUAL_UINT32(10, m.snapshot().runSeconds);  // 10 s of running

  for (uint32_t t = 11220; t <= 11420; t += 10) stopped = m.update(t, false) || stopped;
  TEST_ASSERT_TRUE(stopped);  // stop edge reported -> caller saves immediately
  TEST_ASSERT_FALSE(m.running());
}

static void test_hourmeter_active_low_and_restore() {
  HourMeter m;
  m.configure(false, 0, 10, 60);
  m.restore(36000, 1234, 1791376496UL, 77);  // continue after power-up
  m.update(0, false);                         // LOW = running when active-low
  m.update(3000, false);
  const HourMeterSnapshot s = m.snapshot();
  TEST_ASSERT_TRUE(s.running);
  TEST_ASSERT_EQUAL_UINT32(36003, s.runSeconds);
  TEST_ASSERT_EQUAL_UINT32(77, s.journalSeq);
}

static void test_hourmeter_persist_schedule() {
  HourMeter m;
  m.configure(true, 0, 1, 60);
  m.update(0, true);
  TEST_ASSERT_FALSE(m.persistDue(30000));  // nothing changed yet
  m.update(30000, true);
  TEST_ASSERT_FALSE(m.persistDue(30000));  // dirty, but interval not reached
  m.update(60000, true);
  TEST_ASSERT_TRUE(m.persistDue(60000));
  m.markPersisted(60000, 1, 5);
  TEST_ASSERT_FALSE(m.persistDue(60001));
  m.addPulses(3);
  TEST_ASSERT_TRUE(m.dirty());
  TEST_ASSERT_EQUAL_UINT32(3, m.snapshot().totalCount);
}

// ------------------------------------------------------- SettingsSchema --

static void test_schema_table_is_contiguous_and_defaults_valid() {
  const Settings d = defaultSettings();
  for (size_t i = 0; i < settings_schema::kCount; i++) {
    const SettingSpec& s = settings_schema::kSpecs[i];
    TEST_ASSERT_EQUAL_UINT8(tag::kSettingFirst + i, s.tag);
    const double v = settings_schema::read(d, s.tag);
    TEST_ASSERT_TRUE_MESSAGE(v >= s.min && v <= s.max, s.name);
  }
  TEST_ASSERT_EQUAL_UINT8(0, settings_schema::checkCrossField(d));
}

// ---------------------------------------------------- CommandHandler --

class FakeDevice : public IDeviceControl {
 public:
  Settings s = defaultSettings();
  HourMeterSnapshot hm;
  int applyCalls = 0, rebootCalls = 0;
  uint32_t timeSet = 0;
  bool presetRun = false, presetCount = false;
  Status nextApply = Status::Ok;
  DeviceStatus st;

  const Settings& settings() const override { return s; }
  Status applySettings(const Settings& next) override {
    applyCalls++;
    if (nextApply == Status::Ok) s = next;
    return nextApply;
  }
  Status setTimeEpoch(uint32_t e) override { timeSet = e; return Status::Ok; }
  Status presetCounters(bool r, uint32_t run, bool c, uint32_t count) override {
    presetRun = r; presetCount = c;
    if (r) hm.runSeconds = run;
    if (c) hm.totalCount = count;
    return Status::Ok;
  }
  Status resetCounters() override { hm.runSeconds = hm.totalCount = 0; return Status::Ok; }
  AckStatus startCalibration(CalibKind) override { return AckStatus::Ok; }
  void requestReboot() override { rebootCalls++; }
  HourMeterSnapshot hourMeter() const override { return hm; }
  DeviceStatus status() const override { return st; }
};

// Build a COMMAND, run it through the handler, parse the ACK.
struct Exchange {
  FrameWriter cmd, ack;
  SensorFrameView ackView;
  CommandResult result;
  void begin(uint16_t seq) { cmd.begin(msg::kCommand, seq, 0, 0); }
  void run(FakeDevice& dev) {
    SensorFrameView v;
    TEST_ASSERT_EQUAL(SF_OK, SensorFrameView::parse(cmd.finish(), cmd.size(), v));
    CommandHandler h(dev);
    result = h.handle(v, ack, 9, 0x1234);
    TEST_ASSERT_EQUAL(SF_OK, SensorFrameView::parse(ack.finish(), ack.size(), ackView));
  }
  bool find(uint8_t t, SensorFrameRecord& r) { return ackView.find(t, r); }
  uint8_t ackStatus() { SensorFrameRecord r; return find(tag::kAckStatus, r) ? r.data[0] : 255; }
};

static void test_command_set_settings_and_ack_echoes_seq() {
  FakeDevice dev;
  Exchange x;
  x.begin(4242);
  x.cmd.addU16(110, 250);   // telemetryIntervalMs
  x.cmd.addU8(117, 3);      // output both
  x.run(dev);
  TEST_ASSERT_EQUAL_UINT8(msg::kAck, x.ackView.msgType());
  SensorFrameRecord r;
  TEST_ASSERT_TRUE(x.find(tag::kAckSeq, r));
  TEST_ASSERT_EQUAL_UINT32(4242, r.asU32());
  TEST_ASSERT_EQUAL_UINT8(0, x.ackStatus());
  TEST_ASSERT_EQUAL_UINT16(250, dev.s.telemetryIntervalMs);
  TEST_ASSERT_EQUAL_UINT8(3, dev.s.output);
  TEST_ASSERT_EQUAL(1, dev.applyCalls);  // one EEPROM save for the whole batch
}

static void test_command_all_or_nothing() {
  FakeDevice dev;
  Exchange x;
  x.begin(1);
  x.cmd.addU16(110, 250);       // valid
  x.cmd.addU16(114, 5);         // persistIntervalS < 10: invalid
  x.cmd.addU32(tag::kCmdSetRunSeconds, 99);
  x.run(dev);
  TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(AckStatus::InvalidValue), x.ackStatus());
  SensorFrameRecord r;
  TEST_ASSERT_TRUE(x.find(tag::kRejectedTag, r));
  TEST_ASSERT_EQUAL_UINT8(114, r.data[0]);
  TEST_ASSERT_EQUAL_UINT16(1000, dev.s.telemetryIntervalMs);  // untouched
  TEST_ASSERT_EQUAL(0, dev.applyCalls);
  TEST_ASSERT_FALSE(dev.presetRun);
}

static void test_command_rejects_bad_values() {
  struct Case { uint8_t tag; double value; uint8_t fmt; AckStatus expect; };
  const Case cases[] = {
      {118, 12345, SF_U32, AckStatus::InvalidValue},        // non-standard baud
      {112, 200, SF_U8, AckStatus::InvalidValue},           // stream > 100 Hz
      {110, 500.5, SF_F32, AckStatus::InvalidValue},        // integer setting given a fraction
      {tag::kCmdGet, 9, SF_U8, AckStatus::InvalidValue},
      {tag::kCmdSetTime, 100, SF_U32, AckStatus::InvalidValue},  // 1970: outside RTC range
      {tag::kCmdResetCounters, 1, SF_U32, AckStatus::BadMagic},
      {77, 1, SF_U8, AckStatus::UnknownTag},
  };
  for (const Case& c : cases) {
    FakeDevice dev;
    Exchange x;
    x.begin(1);
    if (c.fmt == SF_F32) x.cmd.addF32(c.tag, static_cast<float>(c.value));
    else if (c.fmt == SF_U8) x.cmd.addU8(c.tag, static_cast<uint8_t>(c.value));
    else x.cmd.addU32(c.tag, static_cast<uint32_t>(c.value));
    x.run(dev);
    TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(c.expect), x.ackStatus());
  }
}

static void test_command_cross_field_rule() {
  FakeDevice dev;
  Exchange x;
  x.begin(1);
  x.cmd.addU16(111, 20);  // sample 20 Hz
  x.cmd.addU8(112, 50);   // stream 50 Hz > sample rate
  x.run(dev);
  TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(AckStatus::InvalidValue), x.ackStatus());
}

static void test_command_actions_and_get() {
  FakeDevice dev;
  Exchange x;
  x.begin(7);
  x.cmd.addU32(tag::kCmdSetTime, 1791376496UL);
  x.cmd.addU32(tag::kCmdSetRunSeconds, 4500000UL);  // preset 1250 h
  x.cmd.addU8(tag::kCmdGet, static_cast<uint8_t>(GetWhat::HourMeter));
  x.run(dev);
  TEST_ASSERT_EQUAL_UINT8(0, x.ackStatus());
  TEST_ASSERT_EQUAL_UINT32(1791376496UL, dev.timeSet);
  TEST_ASSERT_TRUE(dev.presetRun);
  TEST_ASSERT_FALSE(dev.presetCount);
  SensorFrameRecord r;
  TEST_ASSERT_TRUE(x.find(tag::kRunSeconds, r));
  TEST_ASSERT_EQUAL_UINT32(4500000UL, r.asU32());
  TEST_ASSERT_TRUE(x.find(tag::kRunHours, r));
  TEST_ASSERT_EQUAL_UINT32(125000, r.asU32());  // 1250.00 h

  Exchange reset;
  reset.begin(8);
  reset.cmd.addU32(tag::kCmdResetCounters, kResetMagic);
  reset.cmd.addU8(tag::kCmdReboot, 1);
  reset.run(dev);
  TEST_ASSERT_EQUAL_UINT8(0, reset.ackStatus());
  TEST_ASSERT_EQUAL_UINT32(0, dev.hm.runSeconds);
  TEST_ASSERT_EQUAL(1, dev.rebootCalls);
}

static void test_command_get_settings_and_calibration_fit() {
  FakeDevice dev;
  Exchange x;
  x.begin(1);
  x.cmd.addU8(tag::kCmdGet, static_cast<uint8_t>(GetWhat::Settings));
  x.run(dev);
  SensorFrameRecord r;
  TEST_ASSERT_TRUE(x.find(126, r));  // last setting present -> all fitted
  TEST_ASSERT_TRUE(x.find(118, r));
  TEST_ASSERT_EQUAL_UINT32(115200, r.asU32());

  Exchange c;
  c.begin(2);
  c.cmd.addU8(tag::kCmdGet, static_cast<uint8_t>(GetWhat::Calibration));
  c.run(dev);
  TEST_ASSERT_TRUE(c.find(tag::kCalFlags, r));
}

static void test_command_storage_failure_reported() {
  FakeDevice dev;
  dev.nextApply = Status::VerifyFailed;
  Exchange x;
  x.begin(1);
  x.cmd.addU16(110, 250);
  x.run(dev);
  TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(AckStatus::StorageError), x.ackStatus());
}

// ----------------------------------------------------------- Telemetry --

static void test_telemetry_scaling_clamps() {
  TEST_ASSERT_EQUAL_INT16(1234, telemetry::toI16(1.234f, 1000.0f));
  TEST_ASSERT_EQUAL_INT16(32767, telemetry::toI16(100.0f, 1000.0f));   // clamped, not wrapped
  TEST_ASSERT_EQUAL_INT16(-32768, telemetry::toI16(-100.0f, 1000.0f));
  TEST_ASSERT_EQUAL_INT16(0, telemetry::toI16(NAN, 10.0f));
  TEST_ASSERT_EQUAL_UINT16(0, telemetry::toU16(-5.0f, 1.0f));
}

static void test_telemetry_frames_fit_and_use_time_flag() {
  HourMeterSnapshot hm;
  hm.runSeconds = 7200;
  hm.totalCount = 1500;
  hm.pulsesPerUnit = 100;
  DeviceStatus st;
  st.uptimeS = 42;
  st.timeValid = false;
  ImuOutput imu;
  imu.hasMag = true;
  imu.headingValid = true;
  VibrationLevel vib;
  vib.rmsMg = 12.4f;
  FrameWriter w;
  telemetry::buildTelemetry(w, 1, 1, hm, st, &imu, true, vib);
  TEST_ASSERT_FALSE(w.overflow());
  SensorFrameView v;
  TEST_ASSERT_EQUAL(SF_OK, SensorFrameView::parse(w.finish(), w.size(), v));
  TEST_ASSERT_EQUAL_UINT32(42, v.timestamp());  // uptime because time invalid
  SensorFrameRecord r;
  TEST_ASSERT_TRUE(v.find(tag::kTotalUnits, r));
  TEST_ASSERT_EQUAL_UINT32(1500, r.asU32());  // 15.00 units
  TEST_ASSERT_TRUE(v.find(tag::kVibRms, r));
  TEST_ASSERT_EQUAL_UINT32(12, r.asU32());

  telemetry::buildImuStream(w, 2, 1, st, imu, StreamMode::Both);
  TEST_ASSERT_FALSE(w.overflow());
  telemetry::buildBootEvent(w, 3, 1, hm, st);
  TEST_ASSERT_FALSE(w.overflow());
  telemetry::buildCalibrationEvent(w, 4, 1, st, CalibKind::Magnetometer, AckStatus::Ok, defaultSettings().cal);
  TEST_ASSERT_FALSE(w.overflow());
}

// --------------------------------------------------------- ImuPipeline --

static ImuSample sampleAt(const Vec3& accel, const Vec3& gyro) {
  ImuSample s;
  s.accelG = accel;
  s.gyroDps = gyro;
  return s;
}

static void test_imu_calibration_at_rest() {
  ImuPipeline p;
  p.configure(defaultSettings());
  TEST_ASSERT_EQUAL(AckStatus::Ok, p.startCalibration(CalibKind::ImuAtRest, 0, false));
  TEST_ASSERT_EQUAL(AckStatus::Busy, p.startCalibration(CalibKind::ImuAtRest, 0, false));
  CalibKind kind;
  AckStatus res;
  Calibration cal;
  for (uint32_t i = 0; i < ImuPipeline::kImuCalibSamples; i++) {
    const float n = (i % 2 == 0) ? 0.001f : -0.001f;
    p.process(sampleAt(vec3(0.02f + n, -0.01f, 1.03f), vec3(0.5f + n, -0.3f, 0.1f)), false, Vec3{}, 0.01f);
  }
  TEST_ASSERT_TRUE(p.pollCalibration(6000, kind, res, cal));
  TEST_ASSERT_EQUAL(AckStatus::Ok, res);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 0.02f, cal.accelBiasG.x);
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 0.03f, cal.accelBiasG.z);  // 1.03 g - 1 g
  TEST_ASSERT_FLOAT_WITHIN(1e-4, 0.5f, cal.gyroBiasDps.x);
  TEST_ASSERT_TRUE((cal.flags & calib_flags::kImu) != 0);
  TEST_ASSERT_FALSE(p.calibrating());
}

static void test_imu_calibration_rejects_tilted_board_and_missing_mag() {
  ImuPipeline p;
  p.configure(defaultSettings());
  TEST_ASSERT_EQUAL(AckStatus::Unsupported, p.startCalibration(CalibKind::Magnetometer, 0, false));
  TEST_ASSERT_EQUAL(AckStatus::Ok, p.startCalibration(CalibKind::ImuAtRest, 0, false));
  for (uint32_t i = 0; i < ImuPipeline::kImuCalibSamples; i++) {
    p.process(sampleAt(vec3(0.5f, 0, 0.86f), vec3(0, 0, 0)), false, Vec3{}, 0.01f);  // 30 deg tilt
  }
  CalibKind kind;
  AckStatus res;
  Calibration cal;
  TEST_ASSERT_TRUE(p.pollCalibration(6000, kind, res, cal));
  TEST_ASSERT_EQUAL(AckStatus::Failed, res);
}

static void test_imu_stuck_detection_and_roll() {
  ImuPipeline p;
  p.configure(defaultSettings());
  for (int i = 0; i < 150; i++) p.process(sampleAt(vec3(0, 0.5f, 0.866f), vec3(0, 0, 0)), false, Vec3{}, 0.01f);
  TEST_ASSERT_TRUE(p.stuck());  // identical samples => sensor frozen
  TEST_ASSERT_FLOAT_WITHIN(1.0f, 30.0f, p.output().rollDeg);
  p.process(sampleAt(vec3(0, 0.5f, 0.867f), vec3(0, 0, 0)), false, Vec3{}, 0.01f);
  TEST_ASSERT_FALSE(p.stuck());
}

// ------------------------------------------------- RTC without battery --

static void test_timekeeper_sources_and_extrapolation() {
  TimeKeeper t;
  TEST_ASSERT_FALSE(t.valid());
  TEST_ASSERT_EQUAL_UINT32(0, t.nowEpoch(5000));  // unknown time is 0, never a fake date
  t.sync(1791376496UL, 1000, TimeSource::Host);
  TEST_ASSERT_TRUE(t.valid());
  TEST_ASSERT_EQUAL(TimeSource::Host, t.source());
  TEST_ASSERT_EQUAL_UINT32(1791376496UL + 60, t.nowEpoch(61000));
  t.invalidate();
  TEST_ASSERT_FALSE(t.valid());
}

static void test_policy_rtc_read_outcomes() {
  using time_policy::RtcAction;
  TEST_ASSERT_EQUAL(RtcAction::UseRtc, time_policy::onRtcRead(Status::Ok, false));
  // No battery / stopped oscillator: repair it if we still know the time, else give up.
  TEST_ASSERT_EQUAL(RtcAction::RepairRtc, time_policy::onRtcRead(Status::TimeInvalid, true));
  TEST_ASSERT_EQUAL(RtcAction::MarkInvalid, time_policy::onRtcRead(Status::TimeInvalid, false));
  // Bus glitch never throws away a good time.
  TEST_ASSERT_EQUAL(RtcAction::KeepExtrapolating, time_policy::onRtcRead(Status::I2cTimeout, true));
}

static void test_policy_battery_lost_detection() {
  TEST_ASSERT_TRUE(time_policy::batteryLost(false, true));    // time was set, now gone -> battery
  TEST_ASSERT_FALSE(time_policy::batteryLost(false, false));  // never set (new device): not a battery fault
  TEST_ASSERT_FALSE(time_policy::batteryLost(true, true));    // battery kept the time
}

// ------------------------------------------------------- Modular / hot-plug --

static void test_presence_needs_consecutive_failures() {
  PresenceTracker p;
  TEST_ASSERT_FALSE(p.present());
  TEST_ASSERT_FALSE(p.recordFailure());  // absent modules are never "lost" again
  p.markPresent();
  TEST_ASSERT_FALSE(p.recordFailure());
  TEST_ASSERT_FALSE(p.recordFailure());
  p.recordSuccess();                      // a good probe resets the count (EEPROM write cycle, glitch)
  TEST_ASSERT_FALSE(p.recordFailure());
  TEST_ASSERT_FALSE(p.recordFailure());
  TEST_ASSERT_TRUE(p.recordFailure());    // 3rd consecutive miss: lost, reported once
  TEST_ASSERT_FALSE(p.present());
  TEST_ASSERT_FALSE(p.recordFailure());
}

static void test_hourmeter_merge_when_eeprom_arrives_late() {
  HourMeter m;
  m.configure(true, 0, 1, 60);
  m.update(0, true);
  m.update(120000, true);  // 120 s counted without storage
  m.addPulses(7);
  m.mergeStored(36000, 1000, 1791376496UL, 50);
  const HourMeterSnapshot s = m.snapshot();
  TEST_ASSERT_EQUAL_UINT32(36120, s.runSeconds);  // stored 10 h + 2 min counted meanwhile
  TEST_ASSERT_EQUAL_UINT32(1007, s.totalCount);
  TEST_ASSERT_EQUAL_UINT32(50, s.journalSeq);
  TEST_ASSERT_TRUE(m.dirty());                    // merged total will be saved

  HourMeter boot;                                  // at boot (nothing counted) merge == restore
  boot.mergeStored(36000, 1000, 1791376496UL, 50);
  TEST_ASSERT_EQUAL_UINT32(36000, boot.snapshot().runSeconds);
  TEST_ASSERT_FALSE(boot.dirty());
}

// ------------------------------------------------------- Bluetooth gate --

static void test_access_gate_pin_and_lockout() {
  AccessGate g;
  TEST_ASSERT_FALSE(g.unlocked());
  TEST_ASSERT_EQUAL(AckStatus::BadPin, g.tryUnlock(1111, 1234, 0));
  TEST_ASSERT_EQUAL(AckStatus::Ok, g.tryUnlock(1234, 1234, 10));
  TEST_ASSERT_TRUE(g.unlocked());
  g.lock();  // client disconnected / new client
  TEST_ASSERT_FALSE(g.unlocked());
  for (int i = 0; i < AccessGate::kMaxFailures; i++) {
    TEST_ASSERT_EQUAL(AckStatus::BadPin, g.tryUnlock(1, 1234, 100));
  }
  // Locked out: even the right PIN is refused until the lockout ends.
  TEST_ASSERT_EQUAL(AckStatus::Locked, g.tryUnlock(1234, 1234, 100 + AccessGate::kLockoutMs - 1));
  TEST_ASSERT_EQUAL(AckStatus::Ok, g.tryUnlock(1234, 1234, 100 + AccessGate::kLockoutMs));
}

static void test_locked_ack_shape_and_unlock_is_a_noop_command() {
  FrameWriter ack;
  DeviceStatus st;
  buildAck(ack, 3, 0x1234, st, 77, AckStatus::Locked, tag::kCmdUnlock);
  SensorFrameView v;
  TEST_ASSERT_EQUAL(SF_OK, SensorFrameView::parse(ack.finish(), ack.size(), v));
  SensorFrameRecord r;
  TEST_ASSERT_TRUE(v.find(tag::kAckSeq, r));
  TEST_ASSERT_EQUAL_UINT32(77, r.asU32());
  TEST_ASSERT_TRUE(v.find(tag::kAckStatus, r));
  TEST_ASSERT_EQUAL_UINT8(static_cast<uint8_t>(AckStatus::Locked), r.data[0]);
  TEST_ASSERT_TRUE(v.find(tag::kRejectedTag, r));
  TEST_ASSERT_EQUAL_UINT8(tag::kCmdUnlock, r.data[0]);

  // On a wired port (or once unlocked) "unlock" is accepted and does nothing.
  FakeDevice dev;
  Exchange x;
  x.begin(5);
  x.cmd.addU16(tag::kCmdUnlock, 1234);
  x.cmd.addU8(tag::kCmdGet, static_cast<uint8_t>(GetWhat::Settings));
  x.run(dev);
  TEST_ASSERT_EQUAL_UINT8(0, x.ackStatus());
  TEST_ASSERT_TRUE(x.find(128, r));  // btPin is part of the settings
  TEST_ASSERT_EQUAL_UINT32(1234, r.asU32());
  TEST_ASSERT_TRUE(x.find(127, r));
  TEST_ASSERT_FALSE(r.asBool());     // Bluetooth off by default
}

// ------------------------------------------------- Golden doc examples --
// These exact bytes are quoted in docs/INTEGRATION-GUIDE.md (checked by scripts/check-docs.js).

static void hexOf(const uint8_t* p, size_t n, char* out) {
  static const char* kHex = "0123456789abcdef";
  for (size_t i = 0; i < n; i++) {
    out[i * 3] = kHex[p[i] >> 4];
    out[i * 3 + 1] = kHex[p[i] & 15];
    out[i * 3 + 2] = (i + 1 == n) ? '\0' : ' ';
  }
}

static void assertFrameHex(FrameWriter& w, const char* expected) {
  uint8_t frame[SF_COBS_MAX(SF_MAX_PACKET) + 1];
  const size_t n = w.encodeFrame(frame, sizeof(frame));
  char hex[sizeof(frame) * 3];
  hexOf(frame, n, hex);
  TEST_MESSAGE(hex);
  TEST_ASSERT_EQUAL_STRING(expected, hex);
}

static const char* const kGoldenTelemetry =
    "04 01 01 01 0e 78 56 34 12 70 3c c6 6a 01 05 20 aa 44 05 02 05 98 3a 01 09 03 08 01 04 05 48 e8 01 05 05 05 98 "
    "3a 01 06 32 08 01 35 05 01 01 01 03 24 ae 00";
static const char* const kGoldenSetTime = "04 01 03 2a 01 01 01 01 01 01 01 01 09 64 05 70 3c c6 6a 05 6a 00";
static const char* const kGoldenAckGetHour =
    "04 01 04 02 0c 78 56 34 12 70 3c c6 6a f2 03 2b 03 f3 01 06 01 05 20 aa 44 05 02 05 98 3a 01 09 03 08 01 04 05 "
    "48 e8 01 05 05 05 98 3a 01 0b 06 05 38 3c c6 6a 07 05 2c 03 01 03 61 1b 00";

static void test_golden_doc_examples() {
  DeviceStatus st;
  st.timeValid = true;
  st.epoch = 1791376496UL;  // 2026-10-07T12:34:56Z
  HourMeterSnapshot hm;
  hm.runSeconds = 4500000;  // 1250.00 h
  hm.totalCount = 15000;
  hm.pulsesPerUnit = 100;
  hm.running = true;
  hm.lastSavedEpoch = 1791376440UL;
  hm.journalSeq = 812;

  FrameWriter w;
  VibrationLevel vib;
  telemetry::buildTelemetry(w, 1, 0x12345678, hm, st, nullptr, false, vib);
  assertFrameHex(w, kGoldenTelemetry);

  FrameWriter cmd;
  cmd.begin(msg::kCommand, 42, 0, 0);
  cmd.addU32(tag::kCmdSetTime, 1791376496UL);
  assertFrameHex(cmd, kGoldenSetTime);

  FakeDevice dev;
  dev.hm = hm;
  dev.st = st;
  FrameWriter get;
  get.begin(msg::kCommand, 43, 0, 0);
  get.addU8(tag::kCmdGet, static_cast<uint8_t>(GetWhat::HourMeter));
  SensorFrameView v;
  TEST_ASSERT_EQUAL(SF_OK, SensorFrameView::parse(get.finish(), get.size(), v));
  CommandHandler h(dev);
  FrameWriter ack;
  (void)h.handle(v, ack, 2, 0x12345678);
  assertFrameHex(ack, kGoldenAckGetHour);
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_hourmeter_counts_only_while_running_with_debounce);
  RUN_TEST(test_hourmeter_active_low_and_restore);
  RUN_TEST(test_hourmeter_persist_schedule);
  RUN_TEST(test_schema_table_is_contiguous_and_defaults_valid);
  RUN_TEST(test_command_set_settings_and_ack_echoes_seq);
  RUN_TEST(test_command_all_or_nothing);
  RUN_TEST(test_command_rejects_bad_values);
  RUN_TEST(test_command_cross_field_rule);
  RUN_TEST(test_command_actions_and_get);
  RUN_TEST(test_command_get_settings_and_calibration_fit);
  RUN_TEST(test_command_storage_failure_reported);
  RUN_TEST(test_telemetry_scaling_clamps);
  RUN_TEST(test_telemetry_frames_fit_and_use_time_flag);
  RUN_TEST(test_imu_calibration_at_rest);
  RUN_TEST(test_imu_calibration_rejects_tilted_board_and_missing_mag);
  RUN_TEST(test_imu_stuck_detection_and_roll);
  RUN_TEST(test_access_gate_pin_and_lockout);
  RUN_TEST(test_locked_ack_shape_and_unlock_is_a_noop_command);
  RUN_TEST(test_presence_needs_consecutive_failures);
  RUN_TEST(test_hourmeter_merge_when_eeprom_arrives_late);
  RUN_TEST(test_timekeeper_sources_and_extrapolation);
  RUN_TEST(test_policy_rtc_read_outcomes);
  RUN_TEST(test_policy_battery_lost_detection);
  RUN_TEST(test_golden_doc_examples);
  return UNITY_END();
}
