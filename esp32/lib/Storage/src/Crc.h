// Crc.h — CRC16 over a struct, skipping its trailing `crc` field.
// Reuses the SensorFrame CRC16-CCITT-FALSE implementation.
// Every record type static_asserts that `crc` is its last field.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "sf_crc.h"

template <typename T>
uint16_t crcOfStructWithoutTail(const T& obj) {
  static_assert(sizeof(T) > 2, "struct too small");
  return sf_crc16(reinterpret_cast<const uint8_t*>(&obj), sizeof(T) - 2);
}
