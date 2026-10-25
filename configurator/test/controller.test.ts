// controller.test.ts: the TUI controller against the demo device (the simulator in-process) and against a fake
// client for the events, the Bluetooth lock and the firmware checklist.
import { test } from 'bun:test';
import { EventEmitter } from 'node:events';

import { assert, assertEquals, assertMatch } from './assert.ts';
import { connect } from '../src/cli.ts';
import { Connection } from '../src/connection.ts';
import { AckError } from '../src/device.ts';
import type { FirmwareActions } from '../src/tui/firmware-actions.ts';
import { FLASH_RUNNING, TuiController, type Client, type Link } from '../src/tui/controller.ts';
import { planCounter } from '../src/tui/model/counters.ts';
import { pendingChanges } from '../src/tui/model/settings.ts';
import { initialState, type DecodedMessage } from '../src/tui/state.ts';
import { MSG } from '../src/tags.ts';

const noFirmware: FirmwareActions = {
  list: () => Promise.resolve([]),
  image: () => Promise.reject(new Error('offline')),
  file: () => Promise.reject(new Error('offline')),
  flashNote: 'Flashing needs the real board on its USB port, not --demo.',
};

async function until(what: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('against the demo device: reads, a counter preset and a settings change with their results', async () => {
  const conn = new Connection({ target: { demo: true, port: 'demo' }, open: (t) => connect(t, 1000) });
  const ctrl = new TuiController({ conn, initial: initialState('simulated', false), firmware: noFirmware });
  conn.start();
  ctrl.start();
  try {
    await until(
      () =>
        ctrl.snapshot.device.settings.altDebounceMs !== undefined &&
        ctrl.snapshot.device.values.runSeconds !== undefined,
    );
    assert(ctrl.snapshot.device.log.some((e) => e.text === 'read settings, status, counters, calibration'));

    const now = { runSeconds: Number(ctrl.snapshot.device.values.runSeconds), pulsesPerUnit: 1 };
    const r = await ctrl.applyCounter(planCounter('hours', '1310.5', now).plan!);
    assert(r.ok, r.text);
    assertMatch(r.text, /^hour meter 1250\.\d\d → 1310\.50 h \(save #\d+\)$/);
    assertEquals(ctrl.snapshot.device.values.runSeconds, 4_717_800);

    const device = ctrl.snapshot.device.settings;
    const ok = await ctrl.applySettings(pendingChanges(device, { altDebounceMs: 300 }));
    assert(ok.ok, ok.text);
    assertEquals(ctrl.snapshot.device.settings.altDebounceMs, 300);
    const bad = await ctrl.applySettings(pendingChanges(device, { imuStreamHz: 100, imuSampleHz: 50 }));
    assertEquals(bad.ok, false); // the device refuses all of it
    assertMatch(bad.text, /InvalidValue/);
    assertEquals(ctrl.snapshot.busy, undefined);
  } finally {
    ctrl.stop();
    conn.close();
  }
});

/** A link with one fake client whose answers the test decides. */
function fakeLink(answer: (values: Record<string, number | boolean>) => DecodedMessage | Error) {
  const client = new EventEmitter() as EventEmitter & Client;
  client.request = (values) => {
    const a = answer(values);
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  };
  const pins: string[] = [];
  const link = Object.assign(new EventEmitter(), {
    client,
    state: { kind: 'connected' as const },
    port: '/dev/rfcomm0',
    demo: false,
    rememberPin: (pin: string) => pins.push(pin),
  }) as unknown as Link;
  return { client, link, pins };
}

const ack = (values: Record<string, number> = {}): DecodedMessage => ({
  msgType: MSG.ACK,
  seq: 1,
  deviceId: 1,
  timestamp: 0,
  values: { ackStatus: 0, ...values },
});

test('calibration: the result comes with the EVENT, or "no result" after the timeout; one at a time', async () => {
  const sent: Array<Record<string, number | boolean>> = [];
  const { client, link } = fakeLink((values) => {
    sent.push(values);
    return ack();
  });
  const ctrl = new TuiController({
    conn: link,
    initial: initialState('x', false),
    firmware: noFirmware,
    calibrationTimeoutMs: 50,
  });
  ctrl.start();
  try {
    const result = () => ctrl.snapshot.calibration?.result;
    await ctrl.calibrate(1);
    assertEquals(result(), undefined); // still running
    // A second Enter before the screen draws again: refused, nothing sent.
    assertEquals((await ctrl.calibrate(1)).text, 'a calibration is running: wait for its result');
    assertEquals(sent.filter((v) => 'calibrate' in v).length, 1);
    client.emit('frame', {
      msgType: MSG.EVENT,
      seq: 2,
      deviceId: 1,
      timestamp: 0,
      values: { eventKind: 2, calibResult: 0 },
    });
    assertEquals(result()?.ok, true);
    await ctrl.calibrate(2);
    await new Promise((r) => setTimeout(r, 80));
    assertEquals(result()?.text, 'no result from the device');
  } finally {
    ctrl.stop();
  }
});

test('a refresh asked for while one runs joins it: one set of reads, one log line', async () => {
  let gets = 0;
  const { link } = fakeLink((values) => {
    if ('get' in values) gets++;
    return ack();
  });
  const ctrl = new TuiController({ conn: link, initial: initialState('x', false), firmware: noFirmware });
  ctrl.start(); // reads the device once
  try {
    await Promise.all([ctrl.refresh(), ctrl.refresh()]);
    assertEquals(gets, 4);
    assertEquals(ctrl.snapshot.device.log.filter((e) => e.text.startsWith('read settings')).length, 1);
  } finally {
    ctrl.stop();
  }
});

test('Bluetooth: a Locked answer shows the lock; a good PIN unlocks and is kept for reconnects', async () => {
  let pinOk = false;
  const { link, pins } = fakeLink((values) => {
    if ('unlock' in values) {
      pinOk = values.unlock === 4821;
      return pinOk ? ack() : new AckError('device answered BadPin', ack({ ackStatus: 10 }));
    }
    return pinOk ? ack() : new AckError('device answered Locked', ack({ ackStatus: 9 }));
  });
  const ctrl = new TuiController({ conn: link, initial: initialState('x', false), firmware: noFirmware });
  ctrl.start();
  try {
    await until(() => ctrl.snapshot.locked);
    assertEquals((await ctrl.unlock('1111')).ok, false);
    assertEquals(ctrl.snapshot.locked, true);
    assertEquals((await ctrl.unlock('4821')).ok, true);
    assertEquals(ctrl.snapshot.locked, false);
    assertEquals(pins, ['4821']);
  } finally {
    ctrl.stop();
  }
});

test('firmware: the update is a checklist; the device waits for it; refused without a flasher', async () => {
  const { link } = fakeLink(() => ack());
  const image = { bytes: new Uint8Array(2048), label: '2.7.0 (v1.3.0)', version: '2.7.0', cached: true };
  let during: string[] = [];
  const firmware: FirmwareActions = {
    ...noFirmware,
    flashNote: undefined,
    image: () => Promise.resolve(image),
    flash: async (_image, hooks) => {
      // The flasher has the port: commands, the panic signal and a hard reset wait for it.
      during = [
        (await ctrl.send('get status', { get: 3 })).text,
        (await ctrl.panic()).text,
        (await ctrl.hardReset()).text,
      ];
      hooks.step('backup', 'ok', 'counters + 20 settings');
      hooks.step('bootloader', 'run');
      hooks.progress({ stage: 'write', done: 1024, total: 2048 });
      hooks.step('bootloader', 'ok', 'ESP32 aa:bb');
      hooks.note({ level: 'ok', text: 'written and verified' });
      for (const id of ['write', 'verify', 'restart', 'restore'] as const) hooks.step(id, 'ok');
      return { ok: true };
    },
  };
  const ctrl = new TuiController({ conn: link, initial: initialState('x', false), firmware });
  const release = {
    version: '2.7.0',
    tag: 'v1.3.0',
    date: '2026-10-30',
    prerelease: false,
    asset: 'x.bin',
    url: '',
    sumsUrl: '',
  };
  assert(await ctrl.flash({ release }, '2.6.0 → 2.7.0 (v1.3.0)'));
  assertEquals(during, [
    `get status: ${FLASH_RUNNING}`,
    `panic signal: ${FLASH_RUNNING}`,
    `hard reset: ${FLASH_RUNNING}`,
  ]);
  const job = ctrl.snapshot.flash!;
  assertEquals(job.done, true);
  assertEquals(
    job.steps.map((s) => s.status),
    ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
  );
  assertEquals(job.steps[0].detail, '2 KB, SHA256 ok (cached)');
  assertEquals(ctrl.snapshot.result?.text, 'firmware update done: 2.6.0 → 2.7.0 (v1.3.0)');
  ctrl.closeFlash();
  assertEquals(ctrl.snapshot.flash, undefined);

  const refused = new TuiController({ conn: link, initial: initialState('x', false), firmware: noFirmware });
  assertEquals(await refused.flash({ release }, 'x'), false);
  assertMatch(refused.snapshot.result!.text, /not --demo/);
});
