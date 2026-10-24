// AppConfig.h — fixed firmware constants (things that are NOT user settings).
// User-configurable values live in lib/Storage/src/Settings.cpp (defaults)
// and lib/App/src/SettingsSchema.cpp (ranges).
#pragma once

#include <stdint.h>

namespace app_config {
constexpr uint32_t kUsbBaud = 115200;       // fixed so USB is always a recovery path
constexpr uint32_t kInputPeriodUs = 10000;  // alternator sampling + persistence check: 100 Hz
constexpr uint32_t kWatchdogTimeoutS = 5;   // reboot if loop() stalls this long
constexpr uint32_t kWatchdogFormatTimeoutS = 30;  // while attaching (maybe formatting) an EEPROM
constexpr uint32_t kRebootDelayMs = 100;    // let the ACK leave the UART before restarting
constexpr uint32_t kDuplicateWindowMs = 10000;   // a repeated command seq within this window is a retry
constexpr uint32_t kPresencePeriodUs = 2000000;  // hot-plug check of EEPROM / RTC / IMU every 2 s
constexpr const char* kFlashPartition = "hmdata";  // flash copy of settings + counters (partitions.csv)
}  // namespace app_config
