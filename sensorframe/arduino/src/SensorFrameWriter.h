/// @file SensorFrameWriter.h
/// Builds a SensorFrame packet in a fixed buffer. No heap, no exceptions.
#pragma once

#include <string.h>

#include "sf_cobs.h"
#include "sf_crc.h"
#include "sf_types.h"

#ifdef ARDUINO
#include <Print.h>
#endif

/// Writes one packet: header, TLV records, CRC16.
///
/// @tparam N packet buffer size in bytes (header + records + CRC), 14..250.
///
/// @code
/// SensorFrameWriter<> w;
/// w.begin(SF_MSG_TELEMETRY, seq++, deviceId, millis() / 1000);
/// w.addU32(TAG_RUN_SECONDS, runSeconds);
/// w.addI16(TAG_TEMP_X10, 234);
/// w.send(Serial);              // COBS + 0x00, for UART / RS485 / USB
/// // or: mqtt.publish(topic, w.finish(), w.size());   // raw packet
/// @endcode
template <size_t N = SF_DEFAULT_PACKET_SIZE>
class SensorFrameWriter {
  static_assert(N >= SF_MIN_PACKET, "SensorFrameWriter: N must be >= 14");
  static_assert(N <= SF_MAX_PACKET, "SensorFrameWriter: N must be <= 250 (SPEC max packet)");

 public:
  /// Start a new packet. Clears any previous content.
  void begin(uint8_t msgType, uint16_t seq, uint32_t deviceId, uint32_t timestamp) {
    _len = 0;
    _finished = false;
    _overflow = false;
    put8(SF_VERSION);
    put8(msgType);
    putLE(seq, 2);
    putLE(deviceId, 4);
    putLE(timestamp, 4);
  }

  bool addU8(uint8_t tag, uint8_t v) { return rec(tag, SF_U8, 1) && put8(v); }
  bool addI8(uint8_t tag, int8_t v) { return rec(tag, SF_I8, 1) && put8((uint8_t)v); }
  bool addU16(uint8_t tag, uint16_t v) { return rec(tag, SF_U16, 2) && putLE(v, 2); }
  bool addI16(uint8_t tag, int16_t v) { return rec(tag, SF_I16, 2) && putLE((uint16_t)v, 2); }
  bool addU32(uint8_t tag, uint32_t v) { return rec(tag, SF_U32, 4) && putLE(v, 4); }
  bool addI32(uint8_t tag, int32_t v) { return rec(tag, SF_I32, 4) && putLE((uint32_t)v, 4); }
  bool addBool(uint8_t tag, bool v) { return rec(tag, SF_BOOL, 1) && put8(v ? 1 : 0); }
  bool addU64(uint8_t tag, uint64_t v) { return rec(tag, SF_U64, 8) && putLE(v, 8); }
  bool addI64(uint8_t tag, int64_t v) { return rec(tag, SF_I64, 8) && putLE((uint64_t)v, 8); }

  bool addF32(uint8_t tag, float v) {
    static_assert(sizeof(float) == 4, "float must be 32-bit");
    uint32_t bits;
    memcpy(&bits, &v, 4);
    return rec(tag, SF_F32, 4) && putLE(bits, 4);
  }

#if !defined(__SIZEOF_DOUBLE__) || __SIZEOF_DOUBLE__ == 8
  /// Not available where double is 32-bit (e.g. AVR). Use addF32 there.
  bool addF64(uint8_t tag, double v) {
    uint64_t bits;
    memcpy(&bits, &v, 8);
    return rec(tag, SF_F64, 8) && putLE(bits, 8);
  }
#endif

  /// Variable-length bytes (max 255). Handy for strings: addBytes(tag, (const uint8_t*)s, strlen(s)).
  bool addBytes(uint8_t tag, const uint8_t* data, uint8_t len) {
    if (!rec(tag, SF_BYTES, 1 + (size_t)len)) return false;
    put8(len);
    memcpy(_buf + _len, data, len);
    _len += len;
    return true;
  }

  /// Append the CRC (once) and return the raw packet. Use with size() for
  /// packet transports (MQTT, WebSocket, ESP-NOW, LoRa).
  const uint8_t* finish() {
    if (!_finished) {
      uint16_t crc = sf_crc16(_buf, _len);
      _buf[_len++] = (uint8_t)(crc & 0xFF);
      _buf[_len++] = (uint8_t)(crc >> 8);
      _finished = true;
    }
    return _buf;
  }

  /// Final packet length in bytes, CRC included, even before finish() runs.
  /// So `publish(w.finish(), w.size())` is safe in either evaluation order.
  size_t size() const { return _finished ? _len : _len + SF_CRC_SIZE; }

  /// True if any add*() call was rejected because the buffer was full.
  bool overflow() const { return _overflow; }

  /// Finish and COBS-encode into @p out, appending the 0x00 delimiter.
  /// @p cap must be >= SF_COBS_MAX(N) + 1. Returns bytes written, 0 if too small.
  size_t encodeFrame(uint8_t* out, size_t cap) {
    finish();
    if (cap < SF_COBS_MAX(_len) + 1) return 0;
    size_t n = sf_cobs_encode(_buf, _len, out);
    out[n++] = 0x00;
    return n;
  }

#ifdef ARDUINO
  /// Finish, COBS-encode and write one frame to any Print/Stream
  /// (Serial, Serial2, SoftwareSerial, WiFiClient...). Returns bytes written.
  size_t send(Print& out) {
    uint8_t frame[SF_COBS_MAX(N) + 1];
    size_t n = encodeFrame(frame, sizeof(frame));
    return out.write(frame, n);
  }
#endif

 private:
  uint8_t _buf[N];
  size_t _len = 0;
  bool _finished = false;
  bool _overflow = false;

  // Reserve room for tag + fmt + value + CRC before writing anything.
  bool rec(uint8_t tag, uint8_t fmt, size_t valueLen) {
    if (_finished || _len + 2 + valueLen + SF_CRC_SIZE > N) {
      _overflow = true;
      return false;
    }
    _buf[_len++] = tag;
    _buf[_len++] = fmt;
    return true;
  }
  bool put8(uint8_t v) {
    _buf[_len++] = v;
    return true;
  }
  bool putLE(uint64_t v, uint8_t bytes) {
    for (uint8_t i = 0; i < bytes; i++) _buf[_len++] = (uint8_t)(v >> (8 * i));
    return true;
  }
};
