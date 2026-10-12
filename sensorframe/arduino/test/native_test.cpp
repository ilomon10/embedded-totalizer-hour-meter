// Desktop unit tests for the Arduino library. No Arduino needed:
//   make -C sensorframe/arduino/test
// Each golden vector (test_vectors.h, generated from the same source as the
// JS tests) is rebuilt with SensorFrameWriter and must match byte for byte.
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "../src/SensorFrame.h"
#include "test_vectors.h"

static int failures = 0;
static int checks = 0;
#define CHECK(cond)                                                    \
  do {                                                                 \
    checks++;                                                          \
    if (!(cond)) {                                                     \
      failures++;                                                      \
      printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);         \
    }                                                                  \
  } while (0)

static void hexdump(const char* label, const uint8_t* b, size_t n) {
  printf("    %s:", label);
  for (size_t i = 0; i < n; i++) printf(" %02x", b[i]);
  printf("\n");
}

static void test_crc() {
  CHECK(sf_crc16((const uint8_t*)"123456789", 9) == 0x29B1);
  uint16_t c = sf_crc16_update(0xFFFF, (const uint8_t*)"12345", 5);
  CHECK(sf_crc16_update(c, (const uint8_t*)"6789", 4) == 0x29B1);
}

static void test_cobs() {
  const uint8_t a[] = {0x11, 0x22, 0x00, 0x33};
  uint8_t enc[16], dec[16];
  size_t n = sf_cobs_encode(a, 4, enc);
  const uint8_t expect[] = {0x03, 0x11, 0x22, 0x02, 0x33};
  CHECK(n == 5 && memcmp(enc, expect, 5) == 0);
  CHECK(sf_cobs_decode(enc, n, dec) == 4 && memcmp(dec, a, 4) == 0);

  // 600 bytes with zeros and a 254+ run, decoded in place.
  uint8_t big[600], buf[SF_COBS_MAX(600)];
  for (int i = 0; i < 600; i++) big[i] = (i < 300) ? (uint8_t)(i % 7) : (uint8_t)(1 + i % 250);
  n = sf_cobs_encode(big, 600, buf);
  CHECK(n <= SF_COBS_MAX(600));
  CHECK(memchr(buf, 0, n) == nullptr);
  CHECK(sf_cobs_decode(buf, n, buf) == 600 && memcmp(buf, big, 600) == 0);

  const uint8_t bad1[] = {0x05, 0x11};
  const uint8_t bad2[] = {0x03, 0x00, 0x11};
  CHECK(sf_cobs_decode(bad1, 2, dec) == 0);
  CHECK(sf_cobs_decode(bad2, 3, dec) == 0);
}

static void build(const TvVector& v, SensorFrameWriter<SF_MAX_PACKET>& w) {
  w.begin(v.msgType, v.seq, v.deviceId, v.timestamp);
  for (size_t i = 0; i < v.recordCount; i++) {
    const TvRecord& r = v.records[i];
    bool ok = false;
    switch (r.fmt) {
      case SF_U8: ok = w.addU8(r.tag, (uint8_t)r.i); break;
      case SF_I8: ok = w.addI8(r.tag, (int8_t)r.i); break;
      case SF_U16: ok = w.addU16(r.tag, (uint16_t)r.i); break;
      case SF_I16: ok = w.addI16(r.tag, (int16_t)r.i); break;
      case SF_U32: ok = w.addU32(r.tag, (uint32_t)r.i); break;
      case SF_I32: ok = w.addI32(r.tag, (int32_t)r.i); break;
      case SF_F32: ok = w.addF32(r.tag, (float)r.d); break;
      case SF_BOOL: ok = w.addBool(r.tag, r.i != 0); break;
      case SF_BYTES: ok = w.addBytes(r.tag, r.bytes, r.len); break;
      case SF_U64: ok = w.addU64(r.tag, r.u); break;
      case SF_I64: ok = w.addI64(r.tag, r.i); break;
      case SF_F64: ok = w.addF64(r.tag, r.d); break;
    }
    CHECK(ok);
  }
}

static void test_vectors() {
  for (size_t k = 0; k < TEST_VECTOR_COUNT; k++) {
    const TvVector& v = TEST_VECTORS[k];
    printf("  vector: %s\n", v.name);
    SensorFrameWriter<SF_MAX_PACKET> w;
    build(v, w);
    const uint8_t* pkt = w.finish();
    bool same = w.size() == v.packetLen && memcmp(pkt, v.packet, v.packetLen) == 0;
    CHECK(same);
    if (!same) {
      hexdump("got     ", pkt, w.size());
      hexdump("expected", v.packet, v.packetLen);
    }
    uint8_t frame[SF_COBS_MAX(SF_MAX_PACKET) + 1];
    size_t fn = w.encodeFrame(frame, sizeof(frame));
    CHECK(fn == v.frameLen && memcmp(frame, v.frame, fn) == 0);

    // Parse the golden packet back and compare every record.
    SensorFrameView view;
    CHECK(SensorFrameView::parse(v.packet, v.packetLen, view) == SF_OK);
    CHECK(view.msgType() == v.msgType && view.seq() == v.seq);
    CHECK(view.deviceId() == v.deviceId && view.timestamp() == v.timestamp);
    SensorFrameRecord r;
    size_t i = 0;
    while (view.next(r)) {
      const TvRecord& e = v.records[i++];
      CHECK(r.tag == e.tag && r.fmt == e.fmt);
      switch (r.fmt) {
        case SF_F32: case SF_F64: CHECK(r.asDouble() == e.d); break;
        case SF_U64: CHECK(r.raw() == e.u); break;
        case SF_BYTES: CHECK(r.len == e.len && memcmp(r.data, e.bytes, e.len) == 0); break;
        default: CHECK(r.asI64() == e.i); break;
      }
    }
    CHECK(i == v.recordCount);
  }
}

static void test_parse_errors() {
  const TvVector& v = TEST_VECTORS[0];
  uint8_t b[64];
  SensorFrameView view;
  memcpy(b, v.packet, v.packetLen);
  CHECK(SensorFrameView::parse(b, 10, view) == SF_ERR_TOO_SHORT);
  b[15] ^= 1;
  CHECK(SensorFrameView::parse(b, v.packetLen, view) == SF_ERR_CRC);

  auto withCrc = [&](size_t bodyLen) {
    uint16_t c = sf_crc16(b, bodyLen);
    b[bodyLen] = (uint8_t)c;
    b[bodyLen + 1] = (uint8_t)(c >> 8);
    return bodyLen + 2;
  };
  size_t body = v.packetLen - 2;
  memcpy(b, v.packet, v.packetLen);
  b[0] = 2;
  CHECK(SensorFrameView::parse(b, withCrc(body), view) == SF_ERR_VERSION);
  memcpy(b, v.packet, v.packetLen);
  b[13] = 99;
  CHECK(SensorFrameView::parse(b, withCrc(body), view) == SF_ERR_FORMAT);
  memcpy(b, v.packet, v.packetLen);
  CHECK(SensorFrameView::parse(b, withCrc(body - 1), view) == SF_ERR_TRUNCATED);
}

static void test_writer_overflow() {
  SensorFrameWriter<20> w;  // 12 header + 2 crc -> 6 bytes for records
  w.begin(SF_MSG_TELEMETRY, 0, 0, 0);
  CHECK(w.addU32(1, 1));    // 6 bytes: full
  CHECK(!w.addU8(2, 1));
  CHECK(w.overflow());
  w.finish();
  CHECK(w.size() == 20);
  SensorFrameView view;
  CHECK(SensorFrameView::parse(w.finish(), w.size(), view) == SF_OK);
  uint8_t tiny[8];
  CHECK(w.encodeFrame(tiny, sizeof(tiny)) == 0);
}

static int framesSeen = 0;
static uint16_t lastSeq = 0;
static int errorsSeen = 0;
static void onFrame(SensorFrameView& f, void* ctx) {
  framesSeen++;
  lastSeq = f.seq();
  *(int*)ctx += 1;
}
static void onError(SfError, void*) { errorsSeen++; }

static void test_reader_stream() {
  SensorFrameReader<64> reader;
  int ctxCount = 0;
  reader.onFrame(onFrame, &ctxCount);
  reader.onError(onError);

  const TvVector& v = TEST_VECTORS[0];
  const uint8_t noise[] = {'b', 'o', 'o', 't', '\r', '\n', 0x00, 0x00};
  CHECK(reader.feed(noise, sizeof(noise)) == 0);
  CHECK(errorsSeen == 1);  // "boot\r\n" is not valid COBS/CRC

  // Byte by byte
  for (size_t i = 0; i < v.frameLen; i++) reader.feed(v.frame[i]);
  CHECK(framesSeen == 1 && ctxCount == 1 && lastSeq == v.seq);

  // Corrupted frame then a good one
  uint8_t bad[64];
  memcpy(bad, v.frame, v.frameLen);
  bad[6] ^= 0x40;
  reader.feed(bad, v.frameLen);
  CHECK(errorsSeen == 2);
  CHECK(reader.feed(TEST_VECTORS[3].frame, TEST_VECTORS[3].frameLen) == 1);
  CHECK(lastSeq == TEST_VECTORS[3].seq);

  // Too big for a 64-byte reader: overflow, then resync
  CHECK(reader.feed(TEST_VECTORS[2].frame, TEST_VECTORS[2].frameLen) == 0);
  CHECK(errorsSeen == 3);
  CHECK(reader.feed(v.frame, v.frameLen) == 1);
}

static void test_record_helpers() {
  SensorFrameWriter<> w;
  w.begin(SF_MSG_TELEMETRY, 7, 1, 2);
  w.addI16(4, -123);
  w.addF32(5, 2.5f);
  w.addBool(6, true);
  SensorFrameView view;
  CHECK(SensorFrameView::parse(w.finish(), w.size(), view) == SF_OK);
  SensorFrameRecord r;
  CHECK(view.find(4, r) && r.asI32() == -123 && fabs(r.asDouble() * 0.1 + 12.3) < 1e-9);
  CHECK(view.find(5, r) && r.asFloat() == 2.5f);
  CHECK(view.find(6, r) && r.asBool());
  CHECK(!view.find(99, r));
}

int main() {
  printf("SensorFrame native tests\n");
  test_crc();
  test_cobs();
  test_vectors();
  test_parse_errors();
  test_writer_overflow();
  test_reader_stream();
  test_record_helpers();
  printf("%d checks, %d failures\n", checks, failures);
  return failures ? 1 : 0;
}
