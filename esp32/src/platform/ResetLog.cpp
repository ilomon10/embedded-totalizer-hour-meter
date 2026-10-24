// ResetLog.cpp — see header.
#include "ResetLog.h"

#include <esp_attr.h>

#include "Supervisor.h"

namespace {

constexpr uint32_t kMagic = 0x52534C47;  // "RSLG"

struct Record {
  uint32_t magic;
  uint8_t stage;
  uint8_t cause;
  uint8_t consecutive;
  uint8_t check;  // over cause + consecutive; stage is range-checked instead (written often)
};

RTC_NOINIT_ATTR Record record;

uint8_t checkOf(const Record& r) { return static_cast<uint8_t>(r.cause ^ r.consecutive ^ 0xA5U); }

bool valid(const Record& r) {
  return r.magic == kMagic && r.check == checkOf(r) && r.cause <= static_cast<uint8_t>(LastCause::Crash) &&
         r.stage <= static_cast<uint8_t>(Stage::Flash);
}

void seal() { record.check = checkOf(record); }

}  // namespace

namespace reset_log {

BootInfo atBoot(uint8_t resetReason) {
  BootInfo info;
  const bool trusted = valid(record) && !reset_history::freshStart(resetReason);
  const LastCause recorded = trusted ? static_cast<LastCause>(record.cause) : LastCause::None;
  info.lastCause = reset_history::classify(resetReason, recorded);
  info.lastStage = trusted ? static_cast<Stage>(record.stage) : Stage::Unknown;
  info.consecutive = reset_history::nextConsecutive(trusted ? record.consecutive : 0, info.lastCause);
  info.safeMode = reset_history::safeMode(info.consecutive);

  record.magic = kMagic;
  record.stage = static_cast<uint8_t>(Stage::Boot);
  record.cause = static_cast<uint8_t>(LastCause::None);
  record.consecutive = info.consecutive;
  seal();
  return info;
}

void stage(Stage s) { record.stage = static_cast<uint8_t>(s); }

void recordCause(LastCause c) {
  record.cause = static_cast<uint8_t>(c);
  seal();
}

void clearConsecutive() {
  record.consecutive = 0;
  seal();
}

}  // namespace reset_log
