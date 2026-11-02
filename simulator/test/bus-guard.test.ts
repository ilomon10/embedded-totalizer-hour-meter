// bus-guard.test.ts: the BusGuard cases of esp32/test/test_app/test_main.cpp.
import { test } from 'bun:test';

import { assertEquals } from './assert.ts';
import { BusGuard, FIRST_PAUSE_MS, HEALTHY_MS, MAX_PAUSE_MS, PARK_AFTER_MS } from '../src/bus-guard.ts';

test('parks after 5 s of failures, or at once when a line is held low; one working transfer starts over', () => {
  const g = new BusGuard();
  assertEquals(g.shouldPark(0, true, false), false);
  assertEquals(g.shouldPark(PARK_AFTER_MS - 1, true, false), false);
  assertEquals(g.shouldPark(PARK_AFTER_MS, false, false), false, 'one working transfer (or NACK) resets');
  assertEquals(g.shouldPark(PARK_AFTER_MS + 1, true, false), false);
  assertEquals(g.shouldPark(2 * PARK_AFTER_MS + 1, true, false), true);

  assertEquals(new BusGuard().shouldPark(0, true, true), true, 'SDA or SCL held low: nothing can work, park now');
});

test('retries after 10 s, then twice as long while the lines are held, up to 5 min', () => {
  const g = new BusGuard();
  assertEquals(g.isParked(), false);
  g.parked(1000);
  assertEquals(g.isParked(), true);
  assertEquals(g.retryDue(1000 + FIRST_PAUSE_MS - 1), false);
  assertEquals(g.retryDue(1000 + FIRST_PAUSE_MS), true);
  let t = 1000 + FIRST_PAUSE_MS;
  let expect = FIRST_PAUSE_MS;
  for (let i = 0; i < 10; i++) {
    g.retryFailed(t);
    expect = Math.min(expect * 2, MAX_PAUSE_MS);
    assertEquals(g.pauseMs(), expect);
    assertEquals(g.retryDue(t + expect - 1), false);
    assertEquals(g.retryDue(t + expect), true);
    t += expect;
  }
  assertEquals(g.pauseMs(), MAX_PAUSE_MS);

  g.resumed(t); // lines free again: in use
  assertEquals(g.isParked(), false);
  assertEquals(g.retryDue(t + MAX_PAUSE_MS), false);
  g.parked(t + 1000); // bad again soon: keeps the long pause
  assertEquals(g.pauseMs(), MAX_PAUSE_MS);
  g.resumed(t + 2000);
  g.parked(t + 2000 + HEALTHY_MS); // after 10 good minutes: starts over
  assertEquals(g.pauseMs(), FIRST_PAUSE_MS);

  const flaky = new BusGuard();
  flaky.parked(0);
  flaky.resumed(FIRST_PAUSE_MS);
  flaky.parked(FIRST_PAUSE_MS + 5000); // failed again 5 s after the retry
  assertEquals(flaky.pauseMs(), 2 * FIRST_PAUSE_MS);
  flaky.reset(); // the `i2c` setting was switched: as at boot
  assertEquals(flaky.isParked(), false);
  flaky.parked(1);
  assertEquals(flaky.pauseMs(), FIRST_PAUSE_MS);
});
