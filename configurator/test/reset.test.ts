// reset.test.ts: panic signal, hard-reset steps/constants, restart text, `reset` arguments. No FFI here.
import { test } from 'bun:test';

import { assert, assertEquals, assertRejects, assertThrows } from './assert.ts';
import { parseResetArgs } from '../src/commands.ts';
import { hardResetSteps, isLocalSerial, panicPayload, runSteps, sendPanic, serialConstants } from '../src/reset.ts';
import type { Step } from '../src/reset.ts';
import { bootText, resetResultText } from '../src/restart.ts';
import { applyMessage, initialState, noDataBanner } from '../src/tui/state.ts';
import { PANIC_ZERO_RUN } from '../src/tags.ts';

test('panic payload is exactly 64 zero bytes and is written as one chunk', async () => {
  const p = panicPayload();
  assertEquals(PANIC_ZERO_RUN, 64);
  assertEquals(p.length, 64);
  assert(p.every((b) => b === 0));
  const written: Uint8Array[] = [];
  await sendPanic({ write: (b) => (written.push(b), Promise.resolve()) });
  assertEquals(written, [new Uint8Array(64)]);
});

test('hard reset steps: DTR off, RTS on 100 ms, RTS off; IO0 (DTR) never asserted', async () => {
  const expected: Step[] = [
    { set: 'dtr', on: false },
    { set: 'rts', on: true },
    { wait: 100 },
    {
      set: 'rts',
      on: false,
    },
  ];
  assertEquals(hardResetSteps(), expected);
  const seen: string[] = [];
  await runSteps(hardResetSteps(), {
    set: (line, on) => seen.push(`${line}=${on}`),
    sleep: (ms) => (seen.push(`wait ${ms}`), Promise.resolve()),
  });
  assertEquals(seen, ['dtr=false', 'rts=true', 'wait 100', 'rts=false']);
});

test('serial constants per OS; Windows is refused', () => {
  const linux = serialConstants('linux');
  assertEquals([linux.TIOCMBIS, linux.TIOCMBIC, linux.O_NOCTTY, linux.O_NONBLOCK], [0x5416, 0x5417, 0x100, 0x800]);
  assertEquals(linux.libc, ['libc.so.6']);
  const mac = serialConstants('darwin');
  assertEquals([mac.TIOCMBIS, mac.TIOCMBIC, mac.O_NOCTTY, mac.O_NONBLOCK], [0x8004746c, 0x8004746b, 0x20000, 0x4]);
  assertEquals(mac.libc, ['libSystem.B.dylib', '/usr/lib/libSystem.dylib']);
  for (const k of [linux, mac]) assertEquals([k.TIOCM_DTR, k.TIOCM_RTS, k.O_RDWR], [2, 4, 2]);
  assertThrows(() => serialConstants('windows'), /use --signal/);
});

test('only wired serial ports can be hard-reset', () => {
  assert(isLocalSerial('/dev/ttyUSB0'));
  assert(!isLocalSerial('tcp://127.0.0.1:5555'));
  assert(!isLocalSerial('/dev/rfcomm0'));
  assert(!isLocalSerial('/dev/ttyUSB0', true));
});

test('reset arguments', () => {
  assertEquals(parseResetArgs([]), 'auto');
  assertEquals(parseResetArgs(['--hard']), 'hard');
  assertEquals(parseResetArgs(['--signal']), 'signal');
  assertThrows(() => parseResetArgs(['--hard', '--signal']), /not both/);
  assertThrows(() => parseResetArgs(['--now']), /unexpected/);
});

test('boot text names the cause and stage', () => {
  assertEquals(
    bootText({ resetReason: 6, lastCause: 1, lastStage: 7 }),
    'device restarted: watchdog while IMU (reset reason 6)',
  );
  assertEquals(bootText({ resetReason: 1, lastCause: 0, lastStage: 0 }), 'device booted (power-on)');
  assertEquals(bootText({ resetReason: 1 }), 'device booted (power-on)');
  assertEquals(bootText({ resetReason: 4, lastCause: 6, lastStage: 0 }), 'device restarted: crash (reset reason 4)');
  assertEquals(
    resetResultText({ resetReason: 1, lastCause: 4, lastStage: 8 }),
    'device restarted (reset reason 1 power-on, last cause: panicSignal while serial / command)',
  );
  assertEquals(resetResultText({ resetReason: 3 }), 'device restarted (reset reason 3 software)');
});

test('a boot EVENT with a cause is logged as a warning', () => {
  const s = applyMessage(
    initialState('/dev/ttyUSB0', false),
    {
      msgType: 2,
      seq: 1,
      deviceId: 1,
      timestamp: 0,
      values: { eventKind: 1, resetReason: 6, lastCause: 1, lastStage: 7 },
    },
    1000,
  );
  assertEquals(s.log[0].level, 'warn');
  assertEquals(s.log[0].text, 'device restarted: watchdog while IMU (reset reason 6)');
});

test('no-data banner after 5 s of silence', () => {
  assertEquals(noDataBanner(undefined, 1000, 5999), undefined);
  assertEquals(noDataBanner(undefined, 1000, 6000), 'No data from the device. Press H to hard-reset.');
  assertEquals(noDataBanner(10000, 1000, 14000), undefined);
  assertEquals(
    noDataBanner(10000, 1000, 15000, 'Hard reset needs USB.'),
    'No data from the device. Hard reset needs USB.',
  );
});

test('hard reset is refused on a non-serial link before anything is opened', async () => {
  const { run } = await import('../src/commands.ts');
  await assertRejects(() => run(['reset', '--hard', '--demo']), /--hard needs a real serial port/);
  await assertRejects(() => run(['reset', '--hard', '--port', 'tcp://127.0.0.1:1']), /local serial port/);
});
