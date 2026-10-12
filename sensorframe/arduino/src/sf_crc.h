/// @file sf_crc.h
/// CRC16-CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
/// Check value: "123456789" -> 0x29B1. Bitwise (no lookup table) to save flash/RAM.
#pragma once

#include <stddef.h>
#include <stdint.h>

/// Update @p crc with @p len bytes. Start with 0xFFFF.
static inline uint16_t sf_crc16_update(uint16_t crc, const uint8_t* data, size_t len) {
  while (len--) {
    crc ^= (uint16_t)(*data++) << 8;
    for (uint8_t i = 0; i < 8; i++) {
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

/// CRC16-CCITT-FALSE of a whole buffer.
static inline uint16_t sf_crc16(const uint8_t* data, size_t len) {
  return sf_crc16_update(0xFFFF, data, len);
}
