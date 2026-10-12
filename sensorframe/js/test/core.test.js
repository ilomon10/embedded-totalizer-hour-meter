'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crc16, cobsEncode, cobsDecode } = require('..');

test('crc16 check value (CRC16-CCITT-FALSE)', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x29b1);
});

test('crc16 is incremental', () => {
  const a = Buffer.from('12345');
  const b = Buffer.from('6789');
  assert.equal(crc16(b, crc16(a)), 0x29b1);
});

test('cobs round trip incl. zeros and long runs', () => {
  const cases = [
    [0x00],
    [0x00, 0x00],
    [0x11, 0x22, 0x00, 0x33],
    [0x11, 0x00, 0x00, 0x00],
    Array.from({ length: 254 }, (_, i) => i + 1),
    Array.from({ length: 255 }, (_, i) => (i % 255) + 1),
    Array.from({ length: 600 }, (_, i) => i % 7),
  ];
  for (const c of cases) {
    const input = Buffer.from(c);
    const enc = cobsEncode(input);
    assert.equal(enc.includes(0), false, 'encoded output must not contain 0x00');
    assert.ok(enc.length <= input.length + Math.floor(input.length / 254) + 1);
    assert.deepEqual(cobsDecode(enc), input);
  }
});

test('cobs known vectors (Wikipedia examples)', () => {
  assert.equal(cobsEncode(Buffer.from([0x00])).toString('hex'), '0101');
  assert.equal(cobsEncode(Buffer.from([0x11, 0x22, 0x00, 0x33])).toString('hex'), '0311220233');
  assert.equal(cobsEncode(Buffer.from([0x11, 0x00, 0x00, 0x00])).toString('hex'), '0211010101');
});

test('cobs decode rejects malformed input', () => {
  assert.equal(cobsDecode(Buffer.from([0x05, 0x11])), null);  // code runs past end
  assert.equal(cobsDecode(Buffer.from([0x03, 0x00, 0x11])), null);  // embedded zero
  assert.equal(cobsDecode(Buffer.from([0x00])), null);
});
