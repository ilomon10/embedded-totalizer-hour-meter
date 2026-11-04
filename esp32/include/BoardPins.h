// BoardPins.h — every pin, I2C address and board fact in ONE place. Change wiring here only.
//
// One firmware runs on two boards. platformio.ini sets HM_BOARD for each build, and
// every constant below takes that board's value:
//   HM_BOARD=0  env:esp32dev   the devboard: ESP32 DevKit with plug-in modules,
//                              schematic/hour-meter-devboard/ (wiring: docs/WIRING.md)
//   HM_BOARD=1  env:can-board  the main board, called the CAN board below,
//                              schematic/hour-meter-board/
#pragma once

#include <stdint.h>

#include "Vec3.h"

namespace board {
enum class Id : uint8_t { DevKit = 0, CanBoard = 1 };
constexpr Id kId = static_cast<Id>(HM_BOARD);
static_assert(kId == Id::DevKit || kId == Id::CanBoard, "HM_BOARD must be 0 (DevKit) or 1 (CAN board)");
constexpr bool kCanBoard = kId == Id::CanBoard;

// How the IMU chip is turned on the board, as KiCad shows it. The driver turns every
// reading back into the board's axes, which are the chip's axes at 0 degrees:
//   DevKit: 0 degrees, the axes printed on the GY-9250 module.
//   CAN board: U601 sits at 180 degrees (pin 1 at the bottom right). The board's x points
//   from J1 toward the USB-C edge, y toward the ESP32's antenna edge, z up out of the
//   component side. U602 (LIS3MDL, not read yet) sits at 0 degrees, but at the same angle
//   its axes point the opposite way to the MPU's: it lines up with U601, so a driver for it
//   needs this same 180-degree turn.
constexpr ChipRotation kImuRotation = kCanBoard ? ChipRotation::Deg180 : ChipRotation::Deg0;
}  // namespace board

namespace pins {
// I2C bus shared by EEPROM, RTC and IMU (ESP32 default pins, both boards).
constexpr int kI2cSda = 21;
constexpr int kI2cScl = 22;
// 100 kHz (standard mode): more margin for long wires and weak pull-ups on a
// vehicle than 400 kHz. The cost: an IMU sample with the magnetometer takes
// ~3 ms (imuSampleHz above ~300 Hz overruns), an EEPROM journal scan ~3 s.
constexpr uint32_t kI2cFrequencyHz = 100000;

// Engine inputs, on the same pins on both boards (the CAN board's DIN1 and DIN2).
constexpr int kAlternator = 27;  // PC817 output: LOW while the alternator charges (see docs/WIRING.md)
constexpr int kPulse = 26;       // totalizer pulse input (flow meter, speed sensor...)

// UART link (Serial2). USB uses the board's built-in USB-serial (Serial / UART0).
//   DevKit: 3.3 V TTL on GPIO16 (RX) and GPIO17 (TX).
//   CAN board: its RS232 port (MAX13223E U1101; J1 pin 3 TX, pin 12 RX). Its GPIO16/17 go
//   to the GPS socket J802, where GPIO17 receives from the GPS: driving it would fight the
//   GPS's output, so this build leaves both pins alone.
constexpr int kUartRx = board::kCanBoard ? 34 : 16;
constexpr int kUartTx = board::kCanBoard ? 32 : 17;
// Driver enable for an RS485 transceiver on the UART link; -1 = none. The CAN board's
// RS485 port is a separate one (below), not the UART link.
constexpr int kRs485De = -1;

// CAN board pins the firmware does not use yet (GPIO map in
// schematic/hour-meter-board/README.md): CAN TX 33 / RX 15; RS485 TX 14 /
// RX 35 / DE 25; GPS TX 16 / RX 17 / PPS 4; DOUT1 23; STATUS LED 2; VIN_SENSE 36;
// IMU_INT 39; RTC_INT 13. While they are left alone, pull-downs on the board (R703, R905)
// keep the RS485 driver and DOUT1 off, and the TJA1051's own pull-up keeps CAN TX recessive.
}  // namespace pins

namespace i2c_addr {
constexpr uint8_t kEeprom = 0x50;  // AT24C256, A0..A2 = GND
constexpr uint8_t kRtc = 0x68;     // DS3231 (fixed)
constexpr uint8_t kImu = 0x69;     // MPU9250/MPU6500 with AD0 = HIGH (0x68 would clash with the RTC!)
constexpr uint8_t kMag = 0x0C;     // AK8963 inside the MPU9250 (bypass mode)
constexpr uint8_t kRtcModuleEeprom = 0x57;  // AT24C32 on ZS-042 RTC boards: present but unused
}  // namespace i2c_addr
