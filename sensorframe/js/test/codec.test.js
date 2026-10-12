'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createCodec, SensorFrameError, MSG_TYPE } = require('..');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'test-vectors.json'), 'utf8'));
const codec = createCodec();

function expected(r) {
  if (r.fmt === 'bytes') return Buffer.from(r.value, 'hex');
  if (r.fmt === 'u64' || r.fmt === 'i64') return BigInt(r.value);
  return r.value;
}

for (const v of vectors) {
  test(`golden vector: ${v.name} decodes`, () => {
    const msg = codec.decode(Buffer.from(v.packetHex, 'hex'));
    assert.equal(msg.version, 1);
    assert.equal(msg.msgType, v.header.msgType);
    assert.equal(msg.seq, v.header.seq);
    assert.equal(msg.deviceId, v.header.deviceId);
    assert.equal(msg.timestamp, v.header.timestamp);
    assert.equal(msg.records.length, v.records.length);
    msg.records.forEach((rec, i) => {
      assert.equal(rec.tag, v.records[i].tag);
      assert.equal(rec.fmt, v.records[i].fmt);
      assert.deepEqual(rec.value, expected(v.records[i]));
    });
  });

  test(`golden vector: ${v.name} encodes byte-exact`, () => {
    const records = v.records.map((r) => ({ tag: r.tag, fmt: r.fmt, value: expected(r) }));
    assert.equal(codec.encode({ ...v.header, records }).toString('hex'), v.packetHex);
    assert.equal(codec.frame({ ...v.header, records }).toString('hex'), v.frameHex);
    assert.deepEqual(codec.decodeFrame(Buffer.from(v.frameHex, 'hex')).records.length, v.records.length);
  });
}

test('hour-meter vector matches the hand-written layout in SPEC.md', () => {
  const hex = [
    '01', '01', '0100', '78563412', '100e0000',  // header
    '01', '05', '100e0000',                      // runSeconds u32 3600
    '02', '05', 'd2040000',                      // totalCount u32 1234
    '03', '08', '01',                            // alternator bool true
    '04', '04', 'ea00',                          // temperature i16 234
    '186c',                                      // crc 0x6c18 LE
  ].join('');
  assert.equal(vectors[0].packetHex, hex);
});

const tags = {
  1: { name: 'runSeconds', fmt: 'u32', unit: 's' },
  2: { name: 'totalCount', fmt: 'u32' },
  3: { name: 'alternator', fmt: 'bool' },
  4: { name: 'temperature', fmt: 'i16', scale: 0.1, unit: '°C' },
  5: { name: 'label', fmt: 'bytes' },
};
const named = createCodec({ tags });

test('tag table: names, scale and units', () => {
  const msg = named.decode(Buffer.from(vectors[0].packetHex, 'hex'));
  assert.deepEqual(msg.values, { runSeconds: 3600, totalCount: 1234, alternator: true, temperature: 23.4 });
  assert.equal(msg.records[3].raw, 234);
  assert.equal(msg.records[3].unit, '°C');
  assert.equal(msg.msgTypeName, 'TELEMETRY');
});

test('encode by name with scale round-trips', () => {
  const values = { runSeconds: 7200, alternator: false, temperature: -12.3, label: 'pump-1' };
  const msg = named.decode(named.encode({ seq: 9, values }));
  assert.equal(msg.values.runSeconds, 7200);
  assert.equal(msg.values.alternator, false);
  assert.equal(msg.values.temperature, -12.3);
  assert.equal(msg.values.label.toString(), 'pump-1');
  assert.equal(msg.records[2].raw, -123);
});

test('unknown tags decode as tag_<n>', () => {
  const pkt = codec.encode({ records: [{ tag: 77, fmt: 'u8', value: 5 }] });
  assert.deepEqual(named.decode(pkt).values, { tag_77: 5 });
});

test('reserved tags have built-in names', () => {
  const pkt = codec.encode({ msgType: MSG_TYPE.ACK, values: { ackSeq: 42, ackStatus: 0 } });
  assert.deepEqual(codec.decode(pkt).values, { ackSeq: 42, ackStatus: 0 });
});

function code(fn) {
  try { fn(); } catch (e) { assert.ok(e instanceof SensorFrameError); return e.code; }
  assert.fail('expected SensorFrameError');
}

test('decode rejects bad packets with a specific code', () => {
  const good = Buffer.from(vectors[0].packetHex, 'hex');

  assert.equal(code(() => codec.decode(good.subarray(0, 10))), 'TOO_SHORT');

  const flipped = Buffer.from(good); flipped[15] ^= 0x01;
  assert.equal(code(() => codec.decode(flipped)), 'CRC');

  const withCrc = (body) => { const b = Buffer.alloc(body.length + 2); body.copy(b); b.writeUInt16LE(require('..').crc16(body), body.length); return b; };
  const body = good.subarray(0, good.length - 2);

  const v2 = Buffer.from(body); v2[0] = 2;
  assert.equal(code(() => codec.decode(withCrc(v2))), 'VERSION');

  const badFmt = Buffer.from(body); badFmt[13] = 99;
  assert.equal(code(() => codec.decode(withCrc(badFmt))), 'FORMAT');

  assert.equal(code(() => codec.decode(withCrc(body.subarray(0, body.length - 1)))), 'TRUNCATED');
  assert.equal(code(() => codec.decodeFrame(Buffer.from([0x05, 0x11, 0x00]))), 'COBS');
});

test('encode validates input', () => {
  assert.equal(code(() => named.encode({ values: { nope: 1 } })), 'ENCODE');
  assert.equal(code(() => codec.encode({ records: [{ tag: 1, fmt: 'u8', value: 256 }] })), 'ENCODE');
  assert.equal(code(() => codec.encode({ records: [{ tag: 1, fmt: 'u16', value: 1.5 }] })), 'ENCODE');
  assert.equal(code(() => codec.encode({ records: [{ tag: 0, fmt: 'u8', value: 1 }] })), 'ENCODE');
  assert.equal(code(() => codec.encode({ records: [{ tag: 1, fmt: 'zz', value: 1 }] })), 'ENCODE');
  const many = Array.from({ length: 60 }, () => ({ tag: 1, fmt: 'u32', value: 1 }));
  assert.equal(code(() => codec.encode({ records: many })), 'TOO_LARGE');
  assert.equal(code(() => createCodec({ tags: { 1: { name: 'a', fmt: 'bad' } } })), 'ENCODE');
});
