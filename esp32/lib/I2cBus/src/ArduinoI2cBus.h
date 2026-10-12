// ArduinoI2cBus.h — II2cBus on top of the Arduino `Wire` library (ESP32).
//
// Adds what plain Wire lacks:
//  - a timeout on every transfer (a stuck bus cannot hang the firmware),
//  - bounded retries for transient errors,
//  - bus recovery: 9 SCL pulses + STOP, the standard fix when a slave was
//    reset mid-transfer and is holding SDA low.
#pragma once

#ifdef ARDUINO

#include <Wire.h>

#include "II2cBus.h"

class ArduinoI2cBus : public II2cBus {
 public:
  static constexpr uint8_t kMaxAttempts = 3;     // 1 try + 2 retries
  static constexpr uint16_t kTimeoutMs = 20;

  ArduinoI2cBus(TwoWire& wire, int sdaPin, int sclPin, uint32_t frequencyHz)
      : wire_(wire), sda_(sdaPin), scl_(sclPin), freq_(frequencyHz) {}

  // Call once in setup(). Recovers a stuck bus before starting Wire.
  Status begin();

  Status write(uint8_t addr, const uint8_t* data, size_t len) override;
  Status writeRead(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen) override;
  Status probe(uint8_t addr) override;

  // Total failed transfers since boot (reported in status telemetry).
  uint32_t errorCount() const { return errors_; }

 private:
  TwoWire& wire_;
  int sda_;
  int scl_;
  uint32_t freq_;
  uint32_t errors_ = 0;

  Status writeOnce(uint8_t addr, const uint8_t* data, size_t len, bool sendStop);
  Status writeReadOnce(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen);
  void recoverBus();
  static Status mapEndTransmission(uint8_t code);
  static bool isRetryable(Status s);
};

#endif  // ARDUINO
