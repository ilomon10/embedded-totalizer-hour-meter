/// @file sf_types.h
/// SensorFrame wire constants (see SPEC.md). Plain C++, no Arduino dependency.
#pragma once

#include <stddef.h>
#include <stdint.h>

/// Protocol version written in header byte 0.
#define SF_VERSION 1
/// Header size in bytes: version, msgType, seq, deviceId, timestamp.
#define SF_HEADER_SIZE 12
/// CRC16 trailer size in bytes.
#define SF_CRC_SIZE 2
/// Smallest valid packet: header + CRC, zero records.
#define SF_MIN_PACKET (SF_HEADER_SIZE + SF_CRC_SIZE)
/// Largest packet allowed by the spec (fits one ESP-NOW payload).
#define SF_MAX_PACKET 250
/// Default writer/reader buffer size.
#ifndef SF_DEFAULT_PACKET_SIZE
#define SF_DEFAULT_PACKET_SIZE 128
#endif

/// Worst-case COBS output size for @p n input bytes, excluding the 0x00 delimiter.
#define SF_COBS_MAX(n) ((n) + ((n) / 254) + 1)

/// Value encodings (record byte 1).
enum SfFmt : uint8_t {
  SF_U8 = 1,
  SF_I8 = 2,
  SF_U16 = 3,
  SF_I16 = 4,
  SF_U32 = 5,
  SF_I32 = 6,
  SF_F32 = 7,
  SF_BOOL = 8,
  SF_BYTES = 9,  ///< length byte followed by that many bytes
  SF_U64 = 10,
  SF_I64 = 11,
  SF_F64 = 12,
};

/// Message types (header byte 1). 128..255 are free for the application.
enum SfMsgType : uint8_t {
  SF_MSG_TELEMETRY = 1,
  SF_MSG_EVENT = 2,
  SF_MSG_COMMAND = 3,
  SF_MSG_ACK = 4,
  SF_MSG_HEARTBEAT = 5,
  SF_MSG_APP = 128,  ///< first application-defined message type
};

/// Reserved tags (240..255). Application tags use 1..239.
enum SfReservedTag : uint8_t {
  SF_TAG_APP_MAX = 239,
  SF_TAG_ERROR_CODE = 240,  ///< u8/u16 device error code
  SF_TAG_FW_VERSION = 241,  ///< u32 0x00MMmmpp or bytes string
  SF_TAG_ACK_SEQ = 242,     ///< u16 seq of the frame being acknowledged
  SF_TAG_ACK_STATUS = 243,  ///< u8 0 = OK, otherwise an error code
};

/// Result codes shared by writer, parser and reader.
enum SfError : uint8_t {
  SF_OK = 0,
  SF_PENDING,         ///< reader: byte consumed, frame not complete yet
  SF_ERR_TOO_SHORT,   ///< packet shorter than header + CRC
  SF_ERR_CRC,         ///< CRC mismatch
  SF_ERR_VERSION,     ///< unsupported protocol version
  SF_ERR_FORMAT,      ///< unknown fmt code in a record
  SF_ERR_TRUNCATED,   ///< record runs past the end of the packet
  SF_ERR_COBS,        ///< invalid COBS encoding
  SF_ERR_OVERFLOW,    ///< frame larger than the buffer
};

/// Fixed value size for @p fmt, 0 for SF_BYTES (variable), -1 for unknown codes.
static inline int sf_fmt_size(uint8_t fmt) {
  switch (fmt) {
    case SF_U8: case SF_I8: case SF_BOOL: return 1;
    case SF_U16: case SF_I16: return 2;
    case SF_U32: case SF_I32: case SF_F32: return 4;
    case SF_U64: case SF_I64: case SF_F64: return 8;
    case SF_BYTES: return 0;
    default: return -1;
  }
}

/// Short human-readable name for an SfError.
static inline const char* sf_error_str(uint8_t err) {
  switch (err) {
    case SF_OK: return "ok";
    case SF_PENDING: return "pending";
    case SF_ERR_TOO_SHORT: return "too short";
    case SF_ERR_CRC: return "crc mismatch";
    case SF_ERR_VERSION: return "bad version";
    case SF_ERR_FORMAT: return "unknown fmt";
    case SF_ERR_TRUNCATED: return "truncated record";
    case SF_ERR_COBS: return "bad cobs";
    case SF_ERR_OVERFLOW: return "overflow";
    default: return "unknown";
  }
}
