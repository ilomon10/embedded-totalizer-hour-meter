// Application.cpp — see header.
#include "Application.h"

#include <esp_system.h>
#include <esp_task_wdt.h>

#include "AppConfig.h"
#include "BoardPins.h"
#include "LayoutHeader.h"
#include "Telemetry.h"
#include "platform/ResetLog.h"

namespace {
uint32_t hzToUs(uint32_t hz) { return hz == 0 ? 1000000UL : 1000000UL / hz; }
}  // namespace

Application::Application()
    : bus_(Wire, pins::kI2cSda, pins::kI2cScl, pins::kI2cFrequencyHz),
      eeprom_(bus_, clock_, i2c_addr::kEeprom),
      rtc_(bus_, i2c_addr::kRtc),
      imu_(bus_, clock_, i2c_addr::kImu),
      journal_(eeprom_),
      settingsStore_(eeprom_),
      settings_(defaultSettings()),
      commands_(*this),
      link_(Serial, Serial2),
      inputTask_(app_config::kInputPeriodUs) {}

// ---------------------------------------------------------------- setup ----

// Boot order matters for recovery: the watchdog first (a hang anywhere below
// reboots), then USB (fixed baud, needs no settings), and only then I2C. After
// kSafeModeAfter unplanned restarts in a row, I2C is skipped entirely.
void Application::setup() {
  esp_task_wdt_init(app_config::kWatchdogTimeoutS, true);  // panic + reboot on stall
  esp_task_wdt_add(nullptr);
  const reset_log::BootInfo boot = reset_log::atBoot(static_cast<uint8_t>(esp_reset_reason()));
  lastCause_ = boot.lastCause;
  lastStage_ = boot.lastStage;
  safeMode_ = boot.safeMode;
  deviceId_ = sf_device_id();

  reset_log::stage(Stage::UsbOpen);
  link_.beginUsb(app_config::kUsbBaud);
  link_.onCommand(onCommand, this);

  bool eepromOk = false;
  if (!safeMode_) {
    reset_log::stage(Stage::I2cInit);
    (void)bus_.begin();
    eepromOk = attachEepromWatched();  // settings must be known before the UART pins open
  }
  if (!eepromOk) {
    bootFlags_ |= status_flag::kSettingsDefaults | status_flag::kJournalEmpty;
  }
  reset_log::stage(Stage::UartOpen);
  link_.beginUart(settings_.baud, pins::kUartRx, pins::kUartTx, static_cast<OutputPort>(settings_.output));
  applyBluetooth();  // off unless the `bluetooth` setting is on
  inputs_.begin(pins::kAlternator, pins::kPulse);
  if (!safeMode_) {
    reset_log::stage(Stage::Rtc);
    (void)attachRtc(true);
    reset_log::stage(Stage::Imu);
    (void)attachImu();
  }
  applyRuntimeSettings();
  presenceTask_.setPeriodUs(app_config::kPresencePeriodUs, clock_.nowUs());
  setupDone_ = true;
  devicesChanged_ = false;  // the boot event already reports the initial set
  reset_log::stage(Stage::Telemetry);
  sendBootEvent();
}

// attachEeprom() with a longer watchdog: the first-time format of a new EEPROM
// can take a few seconds. A hang is still caught, just later.
bool Application::attachEepromWatched() {
  reset_log::stage(Stage::Eeprom);
  esp_task_wdt_init(app_config::kWatchdogFormatTimeoutS, true);
  const bool ok = attachEeprom();
  esp_task_wdt_init(app_config::kWatchdogTimeoutS, true);
  return ok;
}

// ------------------------------------------------------ modules (hot-plug) --
// Every module is optional. attachX() is used at boot AND whenever the presence
// check finds a module that was missing; losing one only clears its device bit.

void Application::setDevice(uint8_t bit, bool present) {
  const uint8_t before = devices_;
  devices_ = present ? static_cast<uint8_t>(devices_ | bit) : static_cast<uint8_t>(devices_ & ~bit);
  if (devices_ != before && setupDone_) {
    devicesChanged_ = true;  // reported with an EVENT from loop()
  }
}

bool Application::attachEeprom() {
  if (eeprom_.begin() != Status::Ok) {
    return false;
  }
  const Result<bool> formatted = layout_header::ensure(eeprom_, journal_);
  if (!formatted.ok()) {
    storageError_ = true;
    return false;
  }
  if (formatted.value) {
    bootFlags_ |= status_flag::kEepromFormatted;
  }
  if (journal_.begin() != Status::Ok) {
    storageError_ = true;
  }
  eepromPresence_.markPresent();
  setDevice(device_bit::kEeprom, true);
  if (storageAdopted_) {
    meter_.markDirty();  // came back after a loss: save the RAM counters soon
  } else {
    adoptStorage();      // first EEPROM seen this boot: take its settings + counters
    storageAdopted_ = true;
  }
  if (settingsNotSaved_) {
    settingsNotSaved_ = settingsStore_.save(settings_) != Status::Ok;  // changes made without EEPROM
  }
  return true;
}

void Application::adoptStorage() {
  Settings stored;
  if (!settingsNotSaved_ && settingsStore_.load(stored) == Status::Ok) {
    const bool linkChanged = (stored.baud != settings_.baud) || (stored.output != settings_.output);
    settings_ = stored;
    bootFlags_ &= ~status_flag::kSettingsDefaults;
    if (setupDone_) {  // EEPROM plugged in while running: apply now
      applyRuntimeSettings();
      if (linkChanged) {
        link_.reconfigure(settings_.baud, static_cast<OutputPort>(settings_.output));
      }
      applyBluetooth();
    }
  } else if (!settingsNotSaved_) {
    bootFlags_ |= status_flag::kSettingsDefaults;
  }
  if (journal_.hasRecord()) {
    const JournalRecord& r = journal_.latest();
    meter_.mergeStored(r.runSeconds, r.totalCount, r.epoch, r.seq);  // continue where we stopped
    bootFlags_ &= ~status_flag::kJournalEmpty;
  } else {
    bootFlags_ |= status_flag::kJournalEmpty;
  }
}

bool Application::attachRtc(bool atBoot) {
  if (rtc_.begin() != Status::Ok) {
    return false;  // setTime still works, kept in RAM (timeNotBackedUp)
  }
  rtcPresence_.markPresent();
  setDevice(device_bit::kRtc, true);
  syncRtc(clock_.nowMs());  // a RAM time set while the RTC was absent is written to it
  if (atBoot) {
    // Runs after the EEPROM: the journal tells us whether time had been set before.
    const bool lastSaveHadTime = journal_.hasRecord() && (journal_.latest().flags & journal_flags::kTimeValid) != 0;
    if (time_policy::batteryLost(time_.valid(), lastSaveHadTime)) {
      bootFlags_ |= status_flag::kRtcBatteryLost;
    }
  }
  return true;
}

bool Application::attachImu() {
  if (imu_.begin() != Status::Ok) {
    return false;
  }
  imuPresence_.markPresent();
  setDevice(device_bit::kImu, true);
  setDevice(device_bit::kMag, imu_.hasMag());
  pipeline_.configure(settings_);
  lastImuUs_ = 0;
  return true;
}

// Every kPresencePeriodUs: probe present modules (lost after 3 misses) and try
// to attach missing ones. A probe is one address byte: cheap and non-invasive.
void Application::runPresence() {
  if (eepromPresence_.present()) {
    if (bus_.probe(i2c_addr::kEeprom) == Status::Ok) {
      eepromPresence_.recordSuccess();
    } else if (eepromPresence_.recordFailure()) {
      setDevice(device_bit::kEeprom, false);  // counters keep running in RAM
    }
  } else {
    (void)attachEepromWatched();
  }
  if (rtcPresence_.present()) {
    if (bus_.probe(i2c_addr::kRtc) == Status::Ok) {
      rtcPresence_.recordSuccess();
    } else if (rtcPresence_.recordFailure()) {
      setDevice(device_bit::kRtc, false);
      if (time_.valid()) {  // keep the time, but it is now RAM-only
        const uint32_t nowMs = clock_.nowMs();
        time_.sync(time_.nowEpoch(nowMs), nowMs, TimeSource::Host);
      }
    }
  } else {
    (void)attachRtc(false);
  }
  if (imuPresence_.present()) {
    if (bus_.probe(i2c_addr::kImu) == Status::Ok) {
      imuPresence_.recordSuccess();
    } else if (imuPresence_.recordFailure()) {
      setDevice(device_bit::kImu | device_bit::kMag, false);
    }
  } else {
    (void)attachImu();
  }
}

// Push settings into every component. Safe to call any time.
void Application::applyRuntimeSettings() {
  const uint32_t nowUs = clock_.nowUs();
  meter_.configure(settings_.altActiveHigh != 0, settings_.altDebounceMs, settings_.pulsesPerUnit,
                   settings_.persistIntervalS);
  inputs_.configurePulse(settings_.pulseRisingEdge != 0, settings_.pulseMinIntervalUs);
  pipeline_.configure(settings_);
  imuTask_.setPeriodUs(hzToUs(settings_.imuSampleHz), nowUs);
  streamTask_.setPeriodUs(hzToUs(settings_.imuStreamHz), nowUs);
  telemetryTask_.setPeriodUs(settings_.telemetryIntervalMs * 1000UL, nowUs);
  rtcTask_.setPeriodUs(settings_.rtcSyncIntervalS * 1000000UL, nowUs);
}

void Application::sendBootEvent() {
  telemetry::buildBootEvent(frame_, txSeq_++, deviceId_, meter_.snapshot(), status());
  link_.sendTelemetry(frame_);
}

// ----------------------------------------------------------------- loop ----

// Each step first leaves a breadcrumb (reset_log::stage): if the watchdog fires,
// the next boot EVENT reports where (tag 63).
void Application::loop() {
  esp_task_wdt_reset();
  reset_log::stage(Stage::Serial);
  updateBluetoothSession();
  link_.poll();  // may run commands (see onCommand)
  if (link_.panicRequested()) {
    restart(LastCause::PanicSignal);
  }
  const uint32_t nowUs = clock_.nowUs();
  const uint32_t nowMs = clock_.nowMs();
  if (inputTask_.due(nowUs)) {
    reset_log::stage(Stage::Inputs);
    runInputs(nowMs);
  }
  if ((devices_ & device_bit::kImu) != 0 && imuTask_.due(nowUs)) {
    reset_log::stage(Stage::Imu);
    runImu(nowUs);
  }
  reset_log::stage(Stage::Telemetry);
  if (settings_.imuStreamHz > 0 && streamTask_.due(nowUs)) {
    runStream();
  }
  if (telemetryTask_.due(nowUs)) {
    runTelemetry();
  }
  if (rtcTask_.due(nowUs)) {
    reset_log::stage(Stage::Rtc);
    syncRtc(nowMs);
  }
  if (!safeMode_ && presenceTask_.due(nowUs)) {
    reset_log::stage(Stage::Presence);
    runPresence();
  }
  supervise(nowMs);
  if (devicesChanged_) {
    devicesChanged_ = false;
    telemetry::buildDevicesChangedEvent(frame_, txSeq_++, deviceId_, status());
    link_.sendTelemetry(frame_);
  }
}

void Application::runInputs(uint32_t nowMs) {
  meter_.addPulses(inputs_.takePulses());
  const bool engineStopped = meter_.update(nowMs, inputs_.alternatorHigh());
  if (engineStopped || meter_.persistDue(nowMs)) {
    persistCounters(nowMs, 0);
  }
}

void Application::persistCounters(uint32_t nowMs, uint8_t extraFlags) {
  if ((devices_ & device_bit::kEeprom) == 0) {
    return;
  }
  const HourMeterSnapshot hm = meter_.snapshot();
  const uint32_t epoch = time_.nowEpoch(nowMs);
  const uint8_t flags = static_cast<uint8_t>(extraFlags | (time_.valid() ? journal_flags::kTimeValid : 0));
  if (journal_.append(hm.runSeconds, hm.totalCount, epoch, flags) == Status::Ok) {
    meter_.markPersisted(nowMs, epoch, journal_.latest().seq);
    storageError_ = false;
  } else {
    storageError_ = true;
    meter_.deferPersist(nowMs);  // retry after one persist interval, not every 10 ms
  }
}

void Application::runImu(uint32_t nowUs) {
  const Result<ImuSample> s = imu_.readImu();
  if (!s.ok()) {
    return;  // counted in bus error stats; next tick retries
  }
  const Result<Vec3> mag = imu_.readMag();
  const float dt = (lastImuUs_ == 0) ? 0.0f : static_cast<float>(nowUs - lastImuUs_) * 1e-6f;
  lastImuUs_ = nowUs;
  pipeline_.process(s.value, mag.ok(), mag.value, dt);

  CalibKind kind = CalibKind::ImuAtRest;
  AckStatus result = AckStatus::Ok;
  Calibration cal;
  if (pipeline_.pollCalibration(clock_.nowMs(), kind, result, cal)) {
    finishCalibration(kind, result, cal);
  }
}

void Application::finishCalibration(CalibKind kind, AckStatus result, const Calibration& cal) {
  if (result == AckStatus::Ok) {
    Settings next = settings_;
    next.cal = cal;
    result = toAckStatus(applySettings(next));
  }
  telemetry::buildCalibrationEvent(frame_, txSeq_++, deviceId_, status(), kind, result, settings_.cal);
  link_.sendTelemetry(frame_);
}

void Application::runStream() {
  const StreamMode mode = static_cast<StreamMode>(settings_.streamMode);
  if (mode == StreamMode::Off || (devices_ & device_bit::kImu) == 0) {
    return;
  }
  telemetry::buildImuStream(frame_, txSeq_++, deviceId_, status(), pipeline_.output(), mode);
  link_.sendTelemetry(frame_);
}

void Application::runTelemetry() {
  const bool hasImu = (devices_ & device_bit::kImu) != 0;
  imuSaturated_ = pipeline_.saturatedSinceLastCheck();
  telemetry::buildTelemetry(frame_, txSeq_++, deviceId_, meter_.snapshot(), status(),
                            hasImu ? &pipeline_.output() : nullptr, pipeline_.hasVibration(),
                            pipeline_.vibration());
  link_.sendTelemetry(frame_);
}

void Application::syncRtc(uint32_t nowMs) {
  if ((devices_ & device_bit::kRtc) == 0) {
    return;
  }
  const Result<uint32_t> epoch = rtc_.nowEpoch();
  switch (time_policy::onRtcRead(epoch.status, time_.valid())) {
    case time_policy::RtcAction::UseRtc:
      time_.sync(epoch.value, nowMs, TimeSource::Rtc);
      break;
    case time_policy::RtcAction::RepairRtc: {
      // RTC lost its time (e.g. supply dip, no battery) but the RAM clock still has it.
      const uint32_t now = time_.nowEpoch(nowMs);
      const bool stored = rtc_.setEpoch(now) == Status::Ok;
      time_.sync(now, nowMs, stored ? TimeSource::Rtc : TimeSource::Host);
      break;
    }
    case time_policy::RtcAction::MarkInvalid:
      time_.invalidate();
      break;
    case time_policy::RtcAction::KeepExtrapolating:
      break;  // bus glitch: keep the RAM clock, retry at the next sync
  }
  const Result<int16_t> t = rtc_.temperatureQuarterC();
  rtcTempValid_ = t.ok();
  rtcTempQ_ = t.value;
}

// ------------------------------------------------------------- commands ----

void Application::onCommand(SensorFrameView& frame, Port from, void* ctx) {
  Application* self = static_cast<Application*>(ctx);
  if (frame.msgType() != msg::kCommand) {
    return;  // only COMMAND frames are handled; anything else is ignored
  }
  LastCommand& last = self->lastCmd_[portIndex(from)];
  const uint32_t nowMs = self->clock_.nowMs();
  if (last.valid && last.seq == frame.seq() && (nowMs - last.atMs) < app_config::kDuplicateWindowMs) {
    self->link_.sendTo(from, last.ack);  // retry of a command we already ran: replay its ACK
    return;
  }
  if (from == Port::Bluetooth && !self->bluetoothGate(frame, last.ack)) {
    // Locked session: ACK with Locked / BadPin, run nothing.
  } else {
    (void)self->commands_.handle(frame, last.ack, self->txSeq_++, self->deviceId_);
  }
  last.valid = true;
  last.seq = frame.seq();
  last.atMs = nowMs;
  self->link_.sendTo(from, last.ack);  // reply on the port that asked
  self->afterCommand();
}

// A Bluetooth session must be unlocked with the PIN before anything else runs.
// Returns true when the command may proceed; otherwise `ack` holds the refusal.
bool Application::bluetoothGate(SensorFrameView& frame, FrameWriter& ack) {
  if (btGate_.unlocked()) {
    return true;
  }
  SensorFrameRecord r;
  AckStatus result = AckStatus::Locked;
  if (frame.find(tag::kCmdUnlock, r)) {
    result = btGate_.tryUnlock(r.asU32(), settings_.btPin, clock_.nowMs());
  }
  if (result == AckStatus::Ok) {
    link_.setBluetoothTelemetry(true);  // unlocked: live data may flow over Bluetooth now
    return true;
  }
  buildAck(ack, txSeq_++, deviceId_, status(), frame.seq(), result, tag::kCmdUnlock);
  return false;
}

// Track Bluetooth clients: every new connection (and every disconnect) re-locks.
void Application::updateBluetoothSession() {
  const bool client = link_.bluetoothClient();
  if (client != btHadClient_) {
    btHadClient_ = client;
    btGate_.lock();
    link_.setBluetoothTelemetry(false);
    lastCmd_[portIndex(Port::Bluetooth)].valid = false;
  }
}

// Turn the Bluetooth radio on/off to match settings_.bluetooth.
void Application::applyBluetooth() {
  if (settings_.bluetooth != 0) {
    char name[24];
    (void)snprintf(name, sizeof(name), "HourMeter-%04X", static_cast<unsigned>(deviceId_ & 0xFFFFU));
    (void)link_.startBluetooth(name);
  } else {
    link_.stopBluetooth();
    btGate_.lock();
    btHadClient_ = false;
  }
}

// Things that must happen AFTER the ACK left (so the reply uses the old link settings).
void Application::afterCommand() {
  if (linkReconfigPending_) {
    link_.flush();
    link_.reconfigure(settings_.baud, static_cast<OutputPort>(settings_.output));
    linkReconfigPending_ = false;
  }
  if (btReconfigPending_) {  // e.g. "bluetooth=false" sent over Bluetooth: the ACK went out first
    link_.flush();
    applyBluetooth();
    btReconfigPending_ = false;
  }
  if (rebootRequested_) {
    restart(LastCause::RebootCommand);
  }
}

// ----------------------------------------------------------- supervisor ----

void Application::supervise(uint32_t nowMs) {
  const LastCause why = supervisor_.update(nowMs, !safeMode_ && bus_.failing(), link_.usbTxBlocked());
  if (why != LastCause::None) {
    restart(why);
  }
  if (supervisor_.healthyUptimeReached(nowMs)) {
    reset_log::clearConsecutive();  // ran long enough: earlier restarts no longer count
  }
}

// Every deliberate restart goes through here, so the next boot can say why.
void Application::restart(LastCause cause) {
  reset_log::recordCause(cause);
  if (cause != LastCause::I2cStuck && meter_.dirty()) {
    persistCounters(clock_.nowMs(), 0);  // best effort; skipped without an EEPROM
  }
  if (cause == LastCause::RebootCommand) {
    link_.flush();  // the ACK must leave first (a stalled USB is never flushed: it would block)
  }
  clock_.delayMs(app_config::kRebootDelayMs);
  ESP.restart();
}

// Settings always apply immediately. Without an EEPROM they live in RAM
// (statusFlags.settingsNotSaved) and are written as soon as one is attached.
Status Application::applySettings(const Settings& next) {
  if ((devices_ & device_bit::kEeprom) != 0) {
    TRY(settingsStore_.save(next));
    settingsNotSaved_ = false;
  } else {
    settingsNotSaved_ = true;
  }
  linkReconfigPending_ = (next.baud != settings_.baud) || (next.output != settings_.output);
  btReconfigPending_ = btReconfigPending_ || (next.bluetooth != settings_.bluetooth);
  settings_ = next;
  applyRuntimeSettings();
  return Status::Ok;
}

// The time is always accepted: with a working RTC it survives power-off; without
// one (missing, or write failed) it is kept in RAM and statusFlags reports
// timeNotBackedUp, so the app knows to send it again after the next reboot.
Status Application::setTimeEpoch(uint32_t epoch) {
  const uint32_t nowMs = clock_.nowMs();
  bool stored = false;
  if ((devices_ & device_bit::kRtc) != 0) {
    const Status s = rtc_.setEpoch(epoch);
    if (s == Status::OutOfRange) {
      return s;
    }
    stored = (s == Status::Ok);
  }
  time_.sync(epoch, nowMs, stored ? TimeSource::Rtc : TimeSource::Host);
  return Status::Ok;
}

Status Application::presetCounters(bool setRun, uint32_t runSeconds, bool setCount, uint32_t totalCount) {
  if ((devices_ & device_bit::kEeprom) == 0) {
    return Status::DeviceMissing;
  }
  meter_.preset(setRun, runSeconds, setCount, totalCount);
  persistCounters(clock_.nowMs(), journal_flags::kManualSet);
  return storageError_ ? Status::VerifyFailed : Status::Ok;
}

Status Application::resetCounters() {
  if ((devices_ & device_bit::kEeprom) == 0) {
    return Status::DeviceMissing;
  }
  meter_.preset(true, 0, true, 0);
  persistCounters(clock_.nowMs(), journal_flags::kReset);
  return storageError_ ? Status::VerifyFailed : Status::Ok;
}

AckStatus Application::startCalibration(CalibKind kind) {
  if ((devices_ & device_bit::kImu) == 0) {
    return AckStatus::DeviceMissing;
  }
  return pipeline_.startCalibration(kind, clock_.nowMs(), imu_.hasMag());
}

DeviceStatus Application::status() const {
  DeviceStatus st;
  const uint32_t nowMs = clock_.nowMs();
  st.timeValid = time_.valid();
  st.epoch = time_.nowEpoch(nowMs);
  st.uptimeS = nowMs / 1000UL;
  st.devices = devices_;
  st.i2cErrors = bus_.errorCount();
  st.overruns = inputTask_.overruns() + imuTask_.overruns() + streamTask_.overruns() + telemetryTask_.overruns();
  st.resetReason = static_cast<uint8_t>(esp_reset_reason());
  st.settingsSource = static_cast<uint8_t>(settingsStore_.source());
  st.btState = !link_.bluetoothOn() ? 0 : !btHadClient_ ? 1 : btGate_.unlocked() ? 3 : 2;
  st.lastCause = static_cast<uint8_t>(lastCause_);
  st.lastStage = static_cast<uint8_t>(lastStage_);
  st.rtcTempValid = rtcTempValid_;
  st.rtcTempQuarterC = rtcTempQ_;
  uint32_t f = bootFlags_;
  f |= (devices_ & device_bit::kEeprom) == 0 ? status_flag::kEepromMissing : 0;
  f |= (devices_ & device_bit::kRtc) == 0 ? status_flag::kRtcMissing : 0;
  f |= (devices_ & device_bit::kImu) == 0 ? status_flag::kImuMissing : 0;
  f |= (devices_ & device_bit::kMag) == 0 ? status_flag::kMagMissing : 0;
  f |= settingsNotSaved_ ? status_flag::kSettingsNotSaved : 0;
  f |= !time_.valid() ? status_flag::kTimeInvalid : 0;
  f |= (time_.source() == TimeSource::Host) ? status_flag::kTimeNotBackedUp : 0;
  f |= (settings_.cal.flags & calib_flags::kImu) == 0 ? status_flag::kImuNotCalibrated : 0;
  f |= ((devices_ & device_bit::kMag) != 0 && (settings_.cal.flags & calib_flags::kMag) == 0)
           ? status_flag::kMagNotCalibrated : 0;
  f |= storageError_ ? status_flag::kStorageError : 0;
  f |= pipeline_.stuck() ? status_flag::kImuStuck : 0;
  f |= imuSaturated_ ? status_flag::kImuSaturated : 0;
  f |= st.i2cErrors > 0 ? status_flag::kI2cErrors : 0;
  f |= pipeline_.calibrating() ? status_flag::kCalibrating : 0;
  f |= safeMode_ ? status_flag::kSafeMode : 0;
  st.flags = f;
  return st;
}
