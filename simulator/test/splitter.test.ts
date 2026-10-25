// splitter.test.ts: frame splitting and the panic signal (64 zero bytes in a row).
import { test } from 'bun:test';

import { assertEquals } from './assert.ts';
import { FrameSplitter } from '../src/splitter.ts';

test('64 zeros in a row fire onPanic once; 63 do not; non-zero bytes reset the run', () => {
  let panics = 0;
  const s = new FrameSplitter(() => {}, () => {}, () => panics++);
  s.push(new Uint8Array(63));
  assertEquals(panics, 0);
  s.push(Uint8Array.of(1));
  s.push(new Uint8Array(63));
  assertEquals(panics, 0);
  s.push(new Uint8Array(1)); // 64th in a row
  assertEquals(panics, 1);
  s.push(new Uint8Array(128));
  assertEquals(panics, 3);
});
