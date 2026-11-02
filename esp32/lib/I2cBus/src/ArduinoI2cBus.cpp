// ArduinoI2cBus.cpp — see header. Only compiled for Arduino targets.
#ifdef ARDUINO

#include "ArduinoI2cBus.h"

#include <Arduino.h>

Status ArduinoI2cBus::begin() {
  recoverBus();
  failing_ = false;
  if (linesLow_ != 0 || !wireUp_) {
    park();  // a module (or a short) holds a line, or Wire did not start: nothing on this bus can work
    return Status::I2cBusError;
  }
  parked_ = false;
  return Status::Ok;
}

void ArduinoI2cBus::park() {
  wire_.end();
  wireUp_ = false;
  pinMode(sda_, INPUT);
  pinMode(scl_, INPUT);
  parked_ = true;
  failing_ = false;  // nothing is tried while parked
}

Status ArduinoI2cBus::write(uint8_t addr, const uint8_t* data, size_t len) {
  CHECK_ARG(data != nullptr || len == 0);
  CHECK_ARG(len <= kMaxTransfer);
  if (parked_) {
    return Status::I2cBusError;
  }
  Status s = Status::I2cBusError;
  for (uint8_t attempt = 0; attempt < kMaxAttempts; attempt++) {
    s = writeOnce(addr, data, len, true);
    if (!isRetryable(s)) {
      break;
    }
    recoverBus();
  }
  track(s);
  return s;
}

Status ArduinoI2cBus::writeRead(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen) {
  CHECK_ARG(tx != nullptr && txLen > 0 && txLen <= kMaxTransfer);
  CHECK_ARG(rx != nullptr && rxLen > 0 && rxLen <= kMaxTransfer);
  if (parked_) {
    return Status::I2cBusError;
  }
  Status s = Status::I2cBusError;
  for (uint8_t attempt = 0; attempt < kMaxAttempts; attempt++) {
    s = writeReadOnce(addr, tx, txLen, rx, rxLen);
    if (!isRetryable(s)) {
      break;
    }
    recoverBus();
  }
  track(s);
  return s;
}

Status ArduinoI2cBus::probe(uint8_t addr) {
  if (parked_) {
    return Status::I2cBusError;
  }
  // No retries: a NACK here is an answer ("nobody home"), not a fault.
  const Status s = writeOnce(addr, nullptr, 0, true);
  failing_ = isRetryable(s);
  if (!failing_) {
    linesLow_ = 0;  // the bus answered: both lines are free
  }
  return s;
}

// A NACK also proves the bus works (the address phase completed cleanly), so
// only timeouts and bus errors keep the bus marked as failing.
void ArduinoI2cBus::track(Status s) {
  if (s != Status::Ok) {
    errors_++;
  }
  failing_ = isRetryable(s);
  if (!failing_) {
    linesLow_ = 0;
  }
}

Status ArduinoI2cBus::writeOnce(uint8_t addr, const uint8_t* data, size_t len, bool sendStop) {
  if (!wireUp_) {
    // Wire takes its lock in beginTransmission() and, without buffers, never gives it back: the next
    // transfer would wait forever. A bus error instead: retried after a recovery, or the bus gets parked.
    return Status::I2cBusError;
  }
  wire_.beginTransmission(addr);
  if (len > 0 && wire_.write(data, len) != len) {
    return Status::I2cBusError;
  }
  return mapEndTransmission(wire_.endTransmission(sendStop));
}

Status ArduinoI2cBus::writeReadOnce(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen) {
  TRY(writeOnce(addr, tx, txLen, false));  // repeated START, no STOP
  const size_t got = wire_.requestFrom(addr, rxLen, true);
  if (got != rxLen) {
    // Arduino-ESP32 2.0.x sends the write part only here, and returns 0 bytes for an address NACK and for a
    // bus fault alike. Ask the address once more: a NACK is an answer ("nobody home"), not a bus fault.
    const Status answer = writeOnce(addr, nullptr, 0, true);
    return answer == Status::Ok ? Status::I2cBusError : answer;
  }
  for (size_t i = 0; i < rxLen; i++) {
    const int b = wire_.read();
    if (b < 0) {
      return Status::I2cBusError;
    }
    rx[i] = static_cast<uint8_t>(b);
  }
  return Status::Ok;
}

void ArduinoI2cBus::recoverBus() {
  wire_.end();
  pinMode(sda_, INPUT_PULLUP);
  pinMode(scl_, OUTPUT_OPEN_DRAIN);
  // Clock out up to 9 bits so a slave stuck mid-byte releases SDA.
  for (uint8_t i = 0; i < 9 && digitalRead(sda_) == LOW; i++) {
    digitalWrite(scl_, LOW);
    delayMicroseconds(5);
    digitalWrite(scl_, HIGH);
    delayMicroseconds(5);
  }
  // STOP condition: SDA low -> high while SCL is high.
  pinMode(sda_, OUTPUT_OPEN_DRAIN);
  digitalWrite(sda_, LOW);
  delayMicroseconds(5);
  digitalWrite(scl_, HIGH);
  delayMicroseconds(5);
  digitalWrite(sda_, HIGH);
  delayMicroseconds(5);
  linesLow_ = readLinesLow();
  wireUp_ = wire_.begin(sda_, scl_, freq_);
  if (wireUp_) {
    wire_.setTimeOut(kTimeoutMs);
  }
}

// Both lines released (with the pull-ups Wire uses too): a line that still reads LOW is held by a module or a
// short, and no transfer can work until that is fixed.
uint8_t ArduinoI2cBus::readLinesLow() const {
  pinMode(sda_, INPUT_PULLUP);
  pinMode(scl_, INPUT_PULLUP);
  delayMicroseconds(20);  // a released line rises through the pull-ups and the wiring's capacitance
  uint8_t low = 0;
  if (digitalRead(sda_) == LOW) {
    low |= i2c_lines::kSdaLow;
  }
  if (digitalRead(scl_) == LOW) {
    low |= i2c_lines::kSclLow;
  }
  return low;
}

Status ArduinoI2cBus::mapEndTransmission(uint8_t code) {
  switch (code) {
    case 0: return Status::Ok;
    case 2:                         // address NACK
    case 3: return Status::I2cNack; // data NACK
    case 5: return Status::I2cTimeout;
    default: return Status::I2cBusError;
  }
}

bool ArduinoI2cBus::isRetryable(Status s) {
  // NACK is a real answer (device busy/absent); timeouts and bus errors are glitches.
  return s == Status::I2cTimeout || s == Status::I2cBusError;
}

#endif  // ARDUINO
