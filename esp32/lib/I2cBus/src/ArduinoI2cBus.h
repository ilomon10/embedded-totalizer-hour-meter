// ArduinoI2cBus.h — II2cBus on top of the Arduino `Wire` library (ESP32).
//
// Adds what plain Wire lacks:
//  - a timeout on every transfer (a stuck bus cannot hang the firmware),
//  - bounded retries for transient errors,
//  - bus recovery: 9 SCL pulses + STOP, the standard fix when a slave was
//    reset mid-transfer and is holding SDA low,
//  - parking: a bus that stays bad is switched off (Wire stopped, pins
//    released) until begin() is called again (BusGuard.h decides when).
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

  // Recovers a stuck bus, then starts Wire. Called in setup() and to retry a
  // parked bus. I2cBusError when SDA or SCL is still held low afterwards
  // (see linesLow()): the bus stays parked then.
  Status begin();

  // Stop using the bus: Wire off, both pins released. Until begin() succeeds,
  // every transfer fails at once (I2cBusError, not counted) without touching
  // the pins. The bus starts out parked: nothing works before begin().
  void park();
  bool parked() const { return parked_; }

  Status write(uint8_t addr, const uint8_t* data, size_t len) override;
  Status writeRead(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen) override;
  Status probe(uint8_t addr) override;

  // Total failed transfers since boot (reported in status telemetry).
  uint32_t errorCount() const { return errors_; }

  // True while the last finished transfer timed out or hit a bus error (after
  // retries and recovery). A NACK clears it: "nobody at that address" is an
  // answer from a working bus, not a bus fault.
  bool failing() const { return failing_; }

  // The lines the last bus recovery found still held low (i2c_lines bits).
  uint8_t linesLow() const { return linesLow_; }

 private:
  TwoWire& wire_;
  int sda_;
  int scl_;
  uint32_t freq_;
  uint32_t errors_ = 0;
  bool failing_ = false;
  bool parked_ = true;
  bool wireUp_ = false;  // Wire.begin() succeeded: a transfer on a Wire without buffers would block for good
  uint8_t linesLow_ = 0;

  void track(Status s);

  Status writeOnce(uint8_t addr, const uint8_t* data, size_t len, bool sendStop);
  Status writeReadOnce(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen);
  void recoverBus();
  uint8_t readLinesLow() const;
  static Status mapEndTransmission(uint8_t code);
  static bool isRetryable(Status s);
};

#endif  // ARDUINO
