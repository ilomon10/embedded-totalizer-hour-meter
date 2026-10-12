// ArduinoI2cBus.cpp — see header. Only compiled for Arduino targets.
#ifdef ARDUINO

#include "ArduinoI2cBus.h"

#include <Arduino.h>

Status ArduinoI2cBus::begin() {
  recoverBus();
  return Status::Ok;
}

Status ArduinoI2cBus::write(uint8_t addr, const uint8_t* data, size_t len) {
  CHECK_ARG(data != nullptr || len == 0);
  CHECK_ARG(len <= kMaxTransfer);
  Status s = Status::I2cBusError;
  for (uint8_t attempt = 0; attempt < kMaxAttempts; attempt++) {
    s = writeOnce(addr, data, len, true);
    if (!isRetryable(s)) {
      break;
    }
    recoverBus();
  }
  if (s != Status::Ok) {
    errors_++;
  }
  return s;
}

Status ArduinoI2cBus::writeRead(uint8_t addr, const uint8_t* tx, size_t txLen, uint8_t* rx, size_t rxLen) {
  CHECK_ARG(tx != nullptr && txLen > 0 && txLen <= kMaxTransfer);
  CHECK_ARG(rx != nullptr && rxLen > 0 && rxLen <= kMaxTransfer);
  Status s = Status::I2cBusError;
  for (uint8_t attempt = 0; attempt < kMaxAttempts; attempt++) {
    s = writeReadOnce(addr, tx, txLen, rx, rxLen);
    if (!isRetryable(s)) {
      break;
    }
    recoverBus();
  }
  if (s != Status::Ok) {
    errors_++;
  }
  return s;
}

Status ArduinoI2cBus::probe(uint8_t addr) {
  // No retries: a NACK here is an answer ("nobody home"), not a fault.
  return writeOnce(addr, nullptr, 0, true);
}

Status ArduinoI2cBus::writeOnce(uint8_t addr, const uint8_t* data, size_t len, bool sendStop) {
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
    return Status::I2cBusError;
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
  wire_.begin(sda_, scl_, freq_);
  wire_.setTimeOut(kTimeoutMs);
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
