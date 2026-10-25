// access-gate.test.ts: Bluetooth PIN lock, same rules as esp32/lib/App/src/AccessGate.h.
import { test } from 'bun:test';

import { assertEquals } from './assert.ts';
import { AccessGate, LOCKOUT_MS, MAX_FAILURES } from '../src/access-gate.ts';
import { Ack } from '../src/protocol.ts';

test('starts locked; the right PIN unlocks; lock() locks again', () => {
  const gate = new AccessGate();
  assertEquals(gate.unlocked(), false);
  assertEquals(gate.tryUnlock(1234, 1234, 0), Ack.Ok);
  assertEquals(gate.unlocked(), true);
  gate.lock();
  assertEquals(gate.unlocked(), false);
});

test('5 wrong PINs lock out every unlock for 60 s, even the right PIN', () => {
  const gate = new AccessGate();
  for (let i = 0; i < MAX_FAILURES; i++) assertEquals(gate.tryUnlock(1, 1234, 0), Ack.BadPin);
  assertEquals(gate.tryUnlock(1234, 1234, 1000), Ack.Locked);
  assertEquals(gate.tryUnlock(1234, 1234, LOCKOUT_MS - 1), Ack.Locked);
  assertEquals(gate.tryUnlock(1234, 1234, LOCKOUT_MS), Ack.Ok);
});

test('the failure count survives a reconnect', () => {
  const gate = new AccessGate();
  for (let i = 0; i < MAX_FAILURES - 1; i++) gate.tryUnlock(1, 1234, 0);
  gate.lock();
  assertEquals(gate.tryUnlock(1, 1234, 0), Ack.BadPin);
  assertEquals(gate.tryUnlock(1234, 1234, 0), Ack.Locked);
});
