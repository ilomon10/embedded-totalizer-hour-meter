# Arduino / C++ API

`#include <SensorFrame.h>` brings in everything. All of it is header-only, never allocates on the heap, and does not use exceptions or RTTI. The core (`sf_*.h`, writer, view) has no Arduino dependency, so it also builds on desktop C++ for tests.

For the bytes these classes produce, see [SPEC.md](../SPEC.md). For a guided start, see the [README](../README.md#quick-start).

**Contents:** [Memory cost](#memory-cost) · [SensorFrameWriter](#sensorframewritern) · [SensorFrameReader](#sensorframereadern) · [SensorFrameView](#sensorframeview) · [SensorFrameRecord](#sensorframerecord) · [Constants](#constants) · [Low-level helpers](#low-level-helpers)

## Memory cost

Values are `sizeof` as measured with the ESP32 (xtensa) and AVR compilers.

| Object | ESP32 | AVR (Uno) | Notes |
|---|---:|---:|---|
| `SensorFrameWriter<>` (N = 128) | 136 B | 132 B | ≈ N + 8 |
| `SensorFrameWriter<64>` | 72 B | 68 B | |
| `SensorFrameReader<>` (N = 128) | 156 B | 140 B | ≈ N + 28 |
| `SensorFrameReader<64>` | 92 B | 76 B | |
| `SensorFrameView` | 12 B | 6 B | created on the stack per frame |
| `send()` temporary stack | N + 2 B | N + 2 B | COBS output buffer, released on return |

Choose N as `12 + sum(record sizes) + 2`. Records cost 2 bytes plus their value size. Larger buffers only waste RAM.

---

## `SensorFrameWriter<N>`

Builds one packet in a fixed buffer. `N` is the packet size limit and must be between 14 and 250. The default is 128 (`SF_DEFAULT_PACKET_SIZE`, which you can override with `-D`).

```cpp
SensorFrameWriter<64> w;
w.begin(SF_MSG_TELEMETRY, seq++, sf_device_id(), millis() / 1000);
w.addU32(TAG_RUN_SECONDS, runSeconds);
w.addBool(TAG_ALTERNATOR, running);
w.send(Serial);
```

### `void begin(uint8_t msgType, uint16_t seq, uint32_t deviceId, uint32_t timestamp)`

Starts a new packet and writes the 12-byte header. Call it before every message. A writer object can be reused for as many messages as you like.

### `bool addXxx(uint8_t tag, value)`

Appends one record. Returns `false` and writes nothing if the record plus CRC would not fit in `N`, and sets `overflow()` in that case.

| Method | fmt | Value size |
|---|---|---:|
| `addU8(tag, uint8_t)` / `addI8(tag, int8_t)` | u8 / i8 | 1 |
| `addU16(tag, uint16_t)` / `addI16(tag, int16_t)` | u16 / i16 | 2 |
| `addU32(tag, uint32_t)` / `addI32(tag, int32_t)` | u32 / i32 | 4 |
| `addU64(tag, uint64_t)` / `addI64(tag, int64_t)` | u64 / i64 | 8 |
| `addF32(tag, float)` | f32 | 4 |
| `addF64(tag, double)` | f64 | 8 (not on AVR, where `double` is 32-bit) |
| `addBool(tag, bool)` | bool | 1 |
| `addBytes(tag, const uint8_t* data, uint8_t len)` | bytes | 1 + len |

Strings: `w.addBytes(TAG_NAME, (const uint8_t*)name, strlen(name));`

### `size_t send(Print& out)` (Arduino only)

Calls `finish()`, COBS-encodes the packet, appends `0x00` and writes the frame to any `Print`/`Stream`: `Serial`, `Serial2`, `SoftwareSerial`, `WiFiClient`, and so on. Returns the number of bytes written. Use this on stream transports.

### `const uint8_t* finish()` and `size_t size() const`

`finish()` appends the CRC (only once) and returns the raw packet. Use it on packet transports:

```cpp
mqtt.publish("devices/42/telemetry", w.finish(), w.size());
esp_now_send(peerMac, w.finish(), w.size());
```

`size()` always includes the 2 CRC bytes, even before `finish()` runs, so the call order of function arguments does not matter.

### `size_t encodeFrame(uint8_t* out, size_t cap)`

Same as `send()`, but writes into your buffer. `cap` must be at least `SF_COBS_MAX(N) + 1`. Returns the frame length, or 0 if `cap` is too small.

### `bool overflow() const`

True if any `add*()` call since `begin()` was rejected.

---

## `SensorFrameReader<N>`

Splits an incoming byte stream into frames, COBS-decodes them in place, validates them, and calls your handler. `N` is the largest packet accepted.

```cpp
SensorFrameReader<> reader;

void onFrame(SensorFrameView& f, void* ctx) {
  SensorFrameRecord r;
  if (f.msgType() == SF_MSG_COMMAND && f.find(TAG_CMD_SET_COUNTER, r)) counter = r.asU32();
}
void onError(SfError err, void* ctx) { /* optional: count bad frames */ }

void setup() { reader.onFrame(onFrame); reader.onError(onError); }
void loop()  { reader.poll(Serial); }
```

| Method | Description |
|---|---|
| `onFrame(FrameHandler h, void* ctx = nullptr)` | `void h(SensorFrameView&, void* ctx)`: called for each valid frame |
| `onError(ErrorHandler h, void* ctx = nullptr)` | `void h(SfError, void* ctx)`: called for each dropped frame |
| `size_t poll(Stream& in)` | Reads all available bytes without blocking. Returns frames delivered. Arduino only. |
| `SfError feed(uint8_t b)` | Push one byte. Returns `SF_PENDING`, `SF_OK` (frame delivered) or an `SF_ERR_*` |
| `size_t feed(const uint8_t* data, size_t len)` | Push a buffer. Returns frames delivered. |
| `void reset()` | Discard a partially received frame |

The `SensorFrameView` and every `SensorFrameRecord::data` point into the reader's buffer. They are only valid **inside the callback**, so copy out any values you need.

---

## `SensorFrameView`

A read-only view of one validated packet. You get one from the reader callback, or you can parse a raw packet from a packet transport yourself:

```cpp
void onMqtt(char* topic, uint8_t* payload, unsigned int len) {
  SensorFrameView v;
  if (SensorFrameView::parse(payload, len, v) != SF_OK) return;
  SensorFrameRecord r;
  while (v.next(r)) {
    Serial.printf("tag %u = %f\n", r.tag, r.asDouble());
  }
}
```

| Method | Description |
|---|---|
| `static SfError parse(const uint8_t* buf, size_t len, SensorFrameView& out)` | Checks length, CRC, version and every record. Binds `out` only on `SF_OK`. |
| `uint8_t version()`, `msgType()` | Header fields |
| `uint16_t seq()` | |
| `uint32_t deviceId()`, `timestamp()` | |
| `bool next(SensorFrameRecord& r)` | Next record. Returns `false` at the end. |
| `bool find(uint8_t tag, SensorFrameRecord& r)` | First record with `tag`. Also rewinds the iteration. |
| `void rewind()` | Restart iteration |
| `size_t bodySize()`, `const uint8_t* bytes()` | Raw access (packet without the CRC) |

---

## `SensorFrameRecord`

| Member | Description |
|---|---|
| `uint8_t tag`, `fmt` | From the wire |
| `const uint8_t* data`, `uint8_t len` | Value bytes. For `SF_BYTES`, the payload without the length byte. |
| `bool asBool()` | Non-zero first byte |
| `uint32_t asU32()`, `int32_t asI32()`, `int64_t asI64()` | Any integer fmt, sign-correct. Floats are truncated. |
| `float asFloat()`, `double asDouble()` | Any numeric fmt |
| `uint64_t raw()` | Little-endian bits (for `u64`, or to reinterpret) |

The `as*()` helpers convert from whatever fmt the sender used. If the device later changes a tag from `u16` to `u32`, `asU32()` still works.

---

## Constants

From `sf_types.h`:

| Name | Value |
|---|---|
| `SF_MSG_TELEMETRY`, `SF_MSG_EVENT`, `SF_MSG_COMMAND`, `SF_MSG_ACK`, `SF_MSG_HEARTBEAT` | 1–5 |
| `SF_MSG_APP` | 128, the first application-defined message type |
| `SF_U8` … `SF_F64` | fmt codes 1–12 ([SPEC §3.1](../SPEC.md#31-fmt-codes)) |
| `SF_TAG_ERROR_CODE`, `SF_TAG_FW_VERSION`, `SF_TAG_ACK_SEQ`, `SF_TAG_ACK_STATUS` | 240–243 |
| `SF_OK`, `SF_PENDING`, `SF_ERR_TOO_SHORT`, `SF_ERR_CRC`, `SF_ERR_VERSION`, `SF_ERR_FORMAT`, `SF_ERR_TRUNCATED`, `SF_ERR_COBS`, `SF_ERR_OVERFLOW` | `SfError` |
| `SF_MAX_PACKET` | 250 |
| `SF_COBS_MAX(n)` | worst-case COBS size of `n` bytes |
| `sf_error_str(err)` | short text such as `"crc mismatch"`, for logging |
| `sf_device_id()` | ESP32/ESP8266 only: a 32-bit id derived from the chip's factory MAC |

## Low-level helpers

Use these if you need to build your own framing:

| Function | Description |
|---|---|
| `uint16_t sf_crc16(const uint8_t* d, size_t n)` | CRC16-CCITT-FALSE |
| `uint16_t sf_crc16_update(uint16_t crc, const uint8_t* d, size_t n)` | Incremental CRC; start with `0xFFFF` |
| `size_t sf_cobs_encode(const uint8_t* in, size_t n, uint8_t* out)` | Does not append `0x00` |
| `size_t sf_cobs_decode(const uint8_t* in, size_t n, uint8_t* out)` | `out` may equal `in`. Returns 0 on error. |
