/// @file sf_cobs.h
/// Consistent Overhead Byte Stuffing. Removes every 0x00 from a packet so 0x00
/// can mark the end of a frame on a byte stream. Overhead: 1 byte per 254.
#pragma once

#include <stddef.h>
#include <stdint.h>

/// Encode @p len bytes into @p out (capacity SF_COBS_MAX(len)). Does NOT append
/// the 0x00 delimiter. Returns the encoded length.
static inline size_t sf_cobs_encode(const uint8_t* in, size_t len, uint8_t* out) {
  size_t write = 1;     // next output position
  size_t codePos = 0;   // where the current block's code byte goes
  uint8_t code = 1;     // distance to the next zero (or block end)
  for (size_t i = 0; i < len; i++) {
    if (in[i] == 0) {
      out[codePos] = code;
      codePos = write++;
      code = 1;
    } else {
      out[write++] = in[i];
      if (++code == 0xFF) {
        out[codePos] = code;
        codePos = write++;
        code = 1;
      }
    }
  }
  out[codePos] = code;
  return write;
}

/// Decode @p len COBS bytes (delimiter already stripped) into @p out.
/// @p out may equal @p in (in-place decoding is safe). Returns the decoded
/// length, or 0 if the input is malformed or contains a 0x00.
static inline size_t sf_cobs_decode(const uint8_t* in, size_t len, uint8_t* out) {
  size_t read = 0, write = 0;
  while (read < len) {
    uint8_t code = in[read];
    if (code == 0 || read + code > len) return 0;
    read++;
    for (uint8_t i = 1; i < code; i++) {
      if (in[read] == 0) return 0;
      out[write++] = in[read++];
    }
    if (code != 0xFF && read < len) out[write++] = 0;
  }
  return write;
}
