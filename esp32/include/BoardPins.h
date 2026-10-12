// BoardPins.h — every pin and I2C address in ONE place. Change wiring here only.
// Wiring diagram and notes: docs/WIRING.md.
#pragma once

#include <stdint.h>

namespace pins {
// I2C bus shared by EEPROM, RTC and IMU (ESP32 default pins).
constexpr int kI2cSda = 21;
constexpr int kI2cScl = 22;
constexpr uint32_t kI2cFrequencyHz = 400000;  // all three chips support 400 kHz

// Engine inputs.
constexpr int kAlternator = 27;  // PC817 output: LOW while the alternator charges (see docs/WIRING.md)
constexpr int kPulse = 26;       // totalizer pulse input (flow meter, speed sensor...)

// UART link (Serial2). USB uses the board's built-in USB-serial (Serial / UART0).
constexpr int kUartRx = 16;
constexpr int kUartTx = 17;
constexpr int kRs485De = -1;  // set a GPIO here if an RS485 transceiver is added
}  // namespace pins

namespace i2c_addr {
constexpr uint8_t kEeprom = 0x50;  // AT24C256, A0..A2 = GND
constexpr uint8_t kRtc = 0x68;     // DS3231 (fixed)
constexpr uint8_t kImu = 0x69;     // MPU9250 with AD0 = HIGH (0x68 would clash with the RTC!)
constexpr uint8_t kMag = 0x0C;     // AK8963 inside the MPU9250 (bypass mode)
constexpr uint8_t kRtcModuleEeprom = 0x57;  // AT24C32 on ZS-042 RTC boards: present but unused
}  // namespace i2c_addr
