// run-confirm.test.ts: the RunConfirm cases of esp32/test/test_app/test_main.cpp.
import { test } from 'bun:test';

import { assertEquals } from './assert.ts';
import { RunConfirm } from '../src/run-confirm.ts';

test('RunConfirm: off, no IMU, first window and hysteresis', () => {
  const c = new RunConfirm();
  assertEquals(c.update(true, true, 0, 0), true, 'setting off: the input alone decides');
  assertEquals(c.update(false, false, 0, 40), true, 'no IMU: never lose hours');
  assertEquals(c.update(true, false, 0, 40), false, 'no vibration window yet');
  assertEquals(c.update(true, true, 12, 40), false, 'key on, engine off');
  assertEquals(c.update(true, true, 40, 40), true, 'idle');
  assertEquals(c.update(true, true, 29, 40), true, 'quiet moment, still above 70 %');
  assertEquals(c.update(true, true, 27, 40), false, 'below 28 mg: engine stopped');
  assertEquals(c.update(true, true, 35, 40), false, 'must reach 40 again');
});
