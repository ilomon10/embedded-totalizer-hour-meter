// CommandHandler.cpp — see header.
#include "CommandHandler.h"

#include "SettingsSchema.h"
#include "Telemetry.h"

namespace {

bool isAction(uint8_t t) { return t >= tag::kCmdSetTime && t <= tag::kCmdUnlock; }

CommandResult fail(AckStatus s, uint8_t t) {
  CommandResult r;
  r.status = s;
  r.rejectedTag = t;
  return r;
}

// Integer value of a command record, rejecting floats/bytes/out-of-range.
bool readUint(const SensorFrameRecord& r, uint32_t maxValue, uint32_t& out) {
  if (r.fmt == SF_BYTES || r.fmt == SF_F32 || r.fmt == SF_F64) {
    return false;
  }
  const int64_t v = r.asI64();
  if (v < 0 || static_cast<uint64_t>(v) > maxValue) {
    return false;
  }
  out = static_cast<uint32_t>(v);
  return true;
}

// Validate an action's value without executing it (all-or-nothing rule).
AckStatus checkAction(const SensorFrameRecord& r) {
  constexpr uint32_t kEpochMin = 946684800UL;   // 2000-01-01T00:00:00Z
  constexpr uint32_t kEpochMax = 4102444799UL;  // 2099-12-31T23:59:59Z (RTC range)
  uint32_t v = 0;
  switch (r.tag) {
    case tag::kCmdSetTime:
      return readUint(r, kEpochMax, v) && v >= kEpochMin ? AckStatus::Ok : AckStatus::InvalidValue;
    case tag::kCmdGet:
      return readUint(r, 4, v) && v >= 1 ? AckStatus::Ok : AckStatus::InvalidValue;
    case tag::kCmdSetRunSeconds:
    case tag::kCmdSetTotalCount:
      return readUint(r, 0xFFFFFFFFUL, v) ? AckStatus::Ok : AckStatus::InvalidValue;
    case tag::kCmdResetCounters:
      return readUint(r, 0xFFFFFFFFUL, v) && v == kResetMagic ? AckStatus::Ok : AckStatus::BadMagic;
    case tag::kCmdCalibrate:
      return readUint(r, 2, v) && v >= 1 ? AckStatus::Ok : AckStatus::InvalidValue;
    case tag::kCmdReboot:
    case tag::kCmdUnlock:  // checked by the AccessGate before we get here
      return AckStatus::Ok;
    default:
      return AckStatus::UnknownTag;
  }
}

}  // namespace

AckStatus toAckStatus(Status s) {
  switch (s) {
    case Status::Ok: return AckStatus::Ok;
    case Status::InvalidArg:
    case Status::OutOfRange: return AckStatus::InvalidValue;
    case Status::DeviceMissing:
    case Status::I2cNack: return AckStatus::DeviceMissing;
    case Status::Busy: return AckStatus::Busy;
    case Status::Unsupported: return AckStatus::Unsupported;
    case Status::VerifyFailed:
    case Status::Crc: return AckStatus::StorageError;
    default: return AckStatus::Failed;
  }
}

void buildAck(FrameWriter& ack, uint16_t ackFrameSeq, uint32_t deviceId, const DeviceStatus& st, uint16_t cmdSeq,
              AckStatus status, uint8_t rejectedTag) {
  telemetry::begin(ack, msg::kAck, ackFrameSeq, deviceId, st);
  (void)ack.addU16(tag::kAckSeq, cmdSeq);
  (void)ack.addU8(tag::kAckStatus, static_cast<uint8_t>(status));
  if (rejectedTag != 0) {
    (void)ack.addU8(tag::kRejectedTag, rejectedTag);
  }
}

CommandResult CommandHandler::handle(SensorFrameView& cmd, FrameWriter& ack, uint16_t ackFrameSeq, uint32_t deviceId) {
  Settings next = device_.settings();
  bool hasSettings = false;
  CommandResult result = validate(cmd, next, hasSettings);
  if (result.status == AckStatus::Ok && hasSettings) {
    result.status = toAckStatus(device_.applySettings(next));
    result.settingsChanged = (result.status == AckStatus::Ok);
  }
  if (result.status == AckStatus::Ok) {
    const bool changed = result.settingsChanged;
    result = runActions(cmd);
    result.settingsChanged = changed;
  }

  buildAck(ack, ackFrameSeq, deviceId, device_.status(), cmd.seq(), result.status, result.rejectedTag);
  if (result.status == AckStatus::Ok) {
    appendRequested(cmd, ack);
  }
  return result;
}

CommandResult CommandHandler::validate(SensorFrameView& cmd, Settings& next, bool& hasSettings) const {
  hasSettings = false;
  SensorFrameRecord r;
  cmd.rewind();
  while (cmd.next(r)) {
    const SettingSpec* spec = settings_schema::find(r.tag);
    if (spec != nullptr) {
      double v = 0;
      const AckStatus s = settings_schema::checkValue(*spec, r, v);
      if (s != AckStatus::Ok) {
        return fail(s, r.tag);
      }
      (void)settings_schema::write(next, r.tag, v);
      hasSettings = true;
    } else {
      const AckStatus s = checkAction(r);  // UnknownTag for anything else
      if (s != AckStatus::Ok) {
        return fail(s, r.tag);
      }
    }
  }
  const uint8_t crossTag = settings_schema::checkCrossField(next);
  if (crossTag != 0) {
    return fail(AckStatus::InvalidValue, crossTag);
  }
  return CommandResult{};
}

CommandResult CommandHandler::runActions(SensorFrameView& cmd) {
  SensorFrameRecord r;
  cmd.rewind();
  // Presets are collected so run + count in one frame become one EEPROM write.
  bool setRun = false, setCount = false;
  uint32_t run = 0, count = 0;
  while (cmd.next(r)) {
    if (r.tag == tag::kCmdSetRunSeconds || r.tag == tag::kCmdSetTotalCount) {
      uint32_t v = 0;
      if (!readUint(r, 0xFFFFFFFFUL, v)) {
        return fail(AckStatus::InvalidValue, r.tag);
      }
      (r.tag == tag::kCmdSetRunSeconds ? setRun : setCount) = true;
      (r.tag == tag::kCmdSetRunSeconds ? run : count) = v;
      continue;
    }
    if (isAction(r.tag)) {
      const CommandResult res = runAction(r);
      if (res.status != AckStatus::Ok) {
        return res;
      }
    }
  }
  if (setRun || setCount) {
    const AckStatus s = toAckStatus(device_.presetCounters(setRun, run, setCount, count));
    if (s != AckStatus::Ok) {
      return fail(s, setRun ? tag::kCmdSetRunSeconds : tag::kCmdSetTotalCount);
    }
  }
  return CommandResult{};
}

CommandResult CommandHandler::runAction(const SensorFrameRecord& r) {
  uint32_t v = 0;
  switch (r.tag) {
    case tag::kCmdSetTime: {
      if (!readUint(r, 0xFFFFFFFFUL, v)) {
        return fail(AckStatus::InvalidValue, r.tag);
      }
      const AckStatus s = toAckStatus(device_.setTimeEpoch(v));
      return s == AckStatus::Ok ? CommandResult{} : fail(s, r.tag);
    }
    case tag::kCmdGet:
      if (!readUint(r, 4, v) || v < 1) {
        return fail(AckStatus::InvalidValue, r.tag);
      }
      return CommandResult{};  // answered in appendRequested()
    case tag::kCmdResetCounters: {
      if (!readUint(r, 0xFFFFFFFFUL, v) || v != kResetMagic) {
        return fail(AckStatus::BadMagic, r.tag);
      }
      const AckStatus s = toAckStatus(device_.resetCounters());
      return s == AckStatus::Ok ? CommandResult{} : fail(s, r.tag);
    }
    case tag::kCmdCalibrate: {
      if (!readUint(r, 2, v) || v < 1) {
        return fail(AckStatus::InvalidValue, r.tag);
      }
      const AckStatus s = device_.startCalibration(static_cast<CalibKind>(v));
      return s == AckStatus::Ok ? CommandResult{} : fail(s, r.tag);
    }
    case tag::kCmdReboot:
      device_.requestReboot();
      return CommandResult{};
    case tag::kCmdUnlock:
      return CommandResult{};
    default:
      return fail(AckStatus::UnknownTag, r.tag);
  }
}

void CommandHandler::appendRequested(SensorFrameView& cmd, FrameWriter& ack) const {
  SensorFrameRecord r;
  cmd.rewind();
  while (cmd.next(r)) {
    if (r.tag != tag::kCmdGet) {
      continue;
    }
    switch (static_cast<GetWhat>(r.asU32())) {
      case GetWhat::HourMeter: (void)telemetry::appendHourMeter(ack, device_.hourMeter(), true); break;
      case GetWhat::Settings: (void)settings_schema::appendAll(ack, device_.settings()); break;
      case GetWhat::Status: (void)telemetry::appendStatus(ack, device_.status(), true); break;
      case GetWhat::Calibration: (void)settings_schema::appendCalibration(ack, device_.settings().cal); break;
    }
  }
}
