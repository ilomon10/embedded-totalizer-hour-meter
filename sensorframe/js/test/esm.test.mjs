import test from 'node:test';
import assert from 'node:assert/strict';
import sf, { createCodec, MSG_TYPE } from '../index.mjs';

test('ESM named + default exports', () => {
  assert.equal(typeof createCodec, 'function');
  assert.equal(MSG_TYPE.TELEMETRY, 1);
  assert.equal(sf.createCodec, createCodec);
});
