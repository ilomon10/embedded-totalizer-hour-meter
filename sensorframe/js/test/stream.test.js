'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { FrameStream, createCodec } = require('..');

const codec = createCodec({ tags: { 1: { name: 'n', fmt: 'u16' } } });
const frames = [1, 2, 3].map((n) => codec.frame({ seq: n, values: { n } }));

function run(chunks, opts) {
  return new Promise((resolve) => {
    const s = new FrameStream({ codec, ...opts });
    const got = [];
    const errors = [];
    s.on('data', (m) => got.push(m.values.n));
    s.on('frameError', (e) => errors.push(e.code));
    s.on('end', () => resolve({ got, errors }));
    for (const c of chunks) s.write(c);
    s.end();
  });
}

test('concatenated frames in one chunk', async () => {
  assert.deepEqual((await run([Buffer.concat(frames)])).got, [1, 2, 3]);
});

test('frames split byte by byte', async () => {
  const all = Buffer.concat(frames);
  const chunks = [...all].map((b) => Buffer.from([b]));
  assert.deepEqual((await run(chunks)).got, [1, 2, 3]);
});

test('garbage and corrupt frames are skipped, stream keeps going', async () => {
  const bad = Buffer.from(frames[1]); bad[5] ^= 0xff;
  const noise = Buffer.from('boot log text\r\n\0');
  const { got, errors } = await run([Buffer.from([0, 0]), noise, frames[0], bad, frames[2]]);
  assert.deepEqual(got, [1, 3]);
  assert.equal(errors.length, 2);
});

test('oversized frame without delimiter is dropped, then resyncs', async () => {
  const small = createCodec({ tags: { 1: { name: 'n', fmt: 'u16' } }, maxPacketSize: 20 });
  const junk = Buffer.alloc(100, 0x41);
  const { got, errors } = await run([junk, Buffer.from([0]), frames[0]], { codec: small });
  assert.deepEqual(got, [1]);
  assert.deepEqual(errors, ['OVERFLOW']);
});
