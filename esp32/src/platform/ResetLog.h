// ResetLog.h — a few bytes that survive a software, watchdog or crash reset.
//
// Lives in RTC slow memory that the bootloader does not clear (RTC_NOINIT_ATTR).
// After power-on it holds garbage, so it is only trusted when its magic and
// check byte match. The decisions (what counts, when to enter safe mode) are the
// pure functions in lib/App/src/Supervisor.h (reset_history).
//
//   stage(s):        breadcrumb, written before each step that talks to hardware
//   recordCause(c):  written just before a deliberate restart
//   atBoot(reason):  reads what the previous run left, then starts a new record
#pragma once

#include <stdint.h>

#include "Protocol.h"

namespace reset_log {

struct BootInfo {
  LastCause lastCause = LastCause::None;
  Stage lastStage = Stage::Unknown;
  uint8_t consecutive = 0;  // unplanned restarts in a row, including the last one
  bool safeMode = false;
};

// Call first thing in setup(), with esp_reset_reason().
BootInfo atBoot(uint8_t resetReason);

void stage(Stage s);
void recordCause(LastCause c);
void clearConsecutive();  // after kHealthyUptimeMs of normal running

}  // namespace reset_log
