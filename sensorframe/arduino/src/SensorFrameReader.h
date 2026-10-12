/// @file SensorFrameReader.h
/// Parses SensorFrame packets (SensorFrameView) and splits COBS byte streams
/// into packets (SensorFrameReader). No heap.
#pragma once

#include <math.h>
#include <string.h>

#include "sf_cobs.h"
#include "sf_crc.h"
#include "sf_types.h"

#ifdef ARDUINO
#include <Stream.h>
#endif

/// One TLV record. @c data points into the packet buffer: only valid inside the
/// frame callback (or while the source buffer lives).
struct SensorFrameRecord {
  uint8_t tag;
  uint8_t fmt;
  const uint8_t* data;  ///< value bytes (for SF_BYTES: the payload, without length byte)
  uint8_t len;          ///< value length in bytes

  /// Raw little-endian unsigned value (integers, bool, float bits).
  uint64_t raw() const {
    uint64_t v = 0;
    uint8_t n = len > 8 ? 8 : len;
    for (uint8_t i = 0; i < n; i++) v |= (uint64_t)data[i] << (8 * i);
    return v;
  }
  bool asBool() const { return len > 0 && data[0] != 0; }
  uint32_t asU32() const { return (uint32_t)asI64(); }
  int32_t asI32() const { return (int32_t)asI64(); }

  /// Any integer fmt as a sign-correct int64 (floats are truncated).
  int64_t asI64() const {
    switch (fmt) {
      case SF_I8: return (int8_t)data[0];
      case SF_I16: return (int16_t)raw();
      case SF_I32: return (int32_t)raw();
      case SF_F32: case SF_F64: return (int64_t)asDouble();
      default: return (int64_t)raw();
    }
  }

  float asFloat() const { return (float)asDouble(); }

  /// Any numeric fmt as a floating-point number. On AVR (32-bit double) f64
  /// values are converted with reduced precision.
  double asDouble() const {
    switch (fmt) {
      case SF_F32: {
        uint32_t bits = (uint32_t)raw();
        float f;
        memcpy(&f, &bits, 4);
        return f;
      }
      case SF_F64: {
        uint64_t bits = raw();
#if !defined(__SIZEOF_DOUBLE__) || __SIZEOF_DOUBLE__ == 8
        double d;
        memcpy(&d, &bits, 8);
        return d;
#else
        int exp = (int)((bits >> 52) & 0x7FF);
        double mant = (double)(bits & 0xFFFFFFFFFFFFFULL) / 4503599627370496.0;  // 2^52
        double v = exp == 0 ? ldexp(mant, -1022) : ldexp(1.0 + mant, exp - 1023);
        return (bits >> 63) ? -v : v;
#endif
      }
      case SF_U64: return (double)raw();
      case SF_BYTES: return 0;
      default: return (double)asI64();
    }
  }
};

/// Read-only view over one validated packet.
///
/// @code
/// SensorFrameView v;
/// if (SensorFrameView::parse(buf, len, v) == SF_OK) {
///   SensorFrameRecord r;
///   while (v.next(r)) { ... r.tag, r.asDouble() ... }
/// }
/// @endcode
class SensorFrameView {
 public:
  /// Validate @p len bytes (length, CRC, version, every record) and bind @p out.
  static SfError parse(const uint8_t* buf, size_t len, SensorFrameView& out) {
    if (len < SF_MIN_PACKET) return SF_ERR_TOO_SHORT;
    size_t body = len - SF_CRC_SIZE;
    uint16_t crc = (uint16_t)buf[body] | ((uint16_t)buf[body + 1] << 8);
    if (sf_crc16(buf, body) != crc) return SF_ERR_CRC;
    if (buf[0] != SF_VERSION) return SF_ERR_VERSION;
    size_t pos = SF_HEADER_SIZE;
    while (pos < body) {
      if (pos + 2 > body) return SF_ERR_TRUNCATED;
      int size = sf_fmt_size(buf[pos + 1]);
      if (size < 0) return SF_ERR_FORMAT;
      pos += 2;
      if (size == 0) {  // SF_BYTES
        if (pos + 1 > body) return SF_ERR_TRUNCATED;
        size = 1 + buf[pos];
      }
      if (pos + (size_t)size > body) return SF_ERR_TRUNCATED;
      pos += size;
    }
    out._buf = buf;
    out._body = body;
    out._pos = SF_HEADER_SIZE;
    return SF_OK;
  }

  uint8_t version() const { return _buf[0]; }
  uint8_t msgType() const { return _buf[1]; }
  uint16_t seq() const { return (uint16_t)le(2, 2); }
  uint32_t deviceId() const { return le(4, 4); }
  uint32_t timestamp() const { return le(8, 4); }
  /// Packet length without the CRC.
  size_t bodySize() const { return _body; }
  const uint8_t* bytes() const { return _buf; }

  /// Read the next record. Returns false at the end.
  bool next(SensorFrameRecord& r) {
    if (_pos >= _body) return false;
    r.tag = _buf[_pos];
    r.fmt = _buf[_pos + 1];
    _pos += 2;
    int size = sf_fmt_size(r.fmt);
    if (size == 0) {
      r.len = _buf[_pos++];
    } else {
      r.len = (uint8_t)size;
    }
    r.data = _buf + _pos;
    _pos += r.len;
    return true;
  }

  /// Restart iteration from the first record.
  void rewind() { _pos = SF_HEADER_SIZE; }

  /// Find the first record with @p tag. Restarts iteration.
  bool find(uint8_t tag, SensorFrameRecord& r) {
    rewind();
    while (next(r)) {
      if (r.tag == tag) {
        rewind();
        return true;
      }
    }
    rewind();
    return false;
  }

 private:
  const uint8_t* _buf = nullptr;
  size_t _body = 0;
  size_t _pos = 0;

  uint32_t le(size_t off, uint8_t n) const {
    uint32_t v = 0;
    for (uint8_t i = 0; i < n; i++) v |= (uint32_t)_buf[off + i] << (8 * i);
    return v;
  }
};

/// Splits a COBS byte stream (0x00-delimited) into validated packets.
///
/// @tparam N largest packet accepted (header + records + CRC).
///
/// @code
/// SensorFrameReader<> reader;
/// void onFrame(SensorFrameView& f, void*) { ... }
/// void setup() { reader.onFrame(onFrame); }
/// void loop()  { reader.poll(Serial); }
/// @endcode
template <size_t N = SF_DEFAULT_PACKET_SIZE>
class SensorFrameReader {
 public:
  typedef void (*FrameHandler)(SensorFrameView& frame, void* ctx);
  typedef void (*ErrorHandler)(SfError err, void* ctx);

  void onFrame(FrameHandler h, void* ctx = nullptr) {
    _onFrame = h;
    _frameCtx = ctx;
  }
  void onError(ErrorHandler h, void* ctx = nullptr) {
    _onError = h;
    _errorCtx = ctx;
  }

  /// Push one received byte. Returns SF_PENDING mid-frame, SF_OK when a valid
  /// frame was delivered, or an SF_ERR_* when a frame was dropped.
  SfError feed(uint8_t b) {
    if (b != 0x00) {
      if (_len < sizeof(_buf)) {
        _buf[_len++] = b;
      } else {
        _overflow = true;
      }
      return SF_PENDING;
    }
    // Delimiter: complete frame (or empty / noise between frames).
    size_t len = _len;
    bool overflow = _overflow;
    _len = 0;
    _overflow = false;
    if (len == 0) return SF_PENDING;
    if (overflow) return fail(SF_ERR_OVERFLOW);
    size_t n = sf_cobs_decode(_buf, len, _buf);
    if (n == 0) return fail(SF_ERR_COBS);
    SensorFrameView view;
    SfError err = SensorFrameView::parse(_buf, n, view);
    if (err != SF_OK) return fail(err);
    if (_onFrame) _onFrame(view, _frameCtx);
    return SF_OK;
  }

  /// Feed @p len bytes. Returns how many complete valid frames were delivered.
  size_t feed(const uint8_t* data, size_t len) {
    size_t frames = 0;
    for (size_t i = 0; i < len; i++) {
      if (feed(data[i]) == SF_OK) frames++;
    }
    return frames;
  }

#ifdef ARDUINO
  /// Drain everything available on @p in. Call from loop(). Returns frames delivered.
  size_t poll(Stream& in) {
    size_t frames = 0;
    while (in.available() > 0) {
      int c = in.read();
      if (c < 0) break;
      if (feed((uint8_t)c) == SF_OK) frames++;
    }
    return frames;
  }
#endif

  /// Discard a partially received frame.
  void reset() {
    _len = 0;
    _overflow = false;
  }

 private:
  uint8_t _buf[SF_COBS_MAX(N)];
  size_t _len = 0;
  bool _overflow = false;
  FrameHandler _onFrame = nullptr;
  void* _frameCtx = nullptr;
  ErrorHandler _onError = nullptr;
  void* _errorCtx = nullptr;

  SfError fail(SfError err) {
    if (_onError) _onError(err, _errorCtx);
    return err;
  }
};
