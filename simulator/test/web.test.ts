// web.test.ts: the web UI server over a real socket: page, state, control messages.
import { test } from 'bun:test';

import { assert, assertEquals } from './assert.ts';
import { Faults } from '../src/faults.ts';
import { MSG } from '../src/protocol.ts';
import { applyClientMessage, startWebServer, WebHub } from '../src/web/server.ts';
import type { ClientMessage, ServerMessage, SimState } from '../src/web/messages.ts';
import { command, makeDevice } from './helpers.ts';

function context() {
  const sim = makeDevice();
  sim.device.powerOn();
  const faults = new Faults(() => 0.5);
  const ctx = {
    device: sim.device,
    faults,
    nowMs: () => sim.clock.nowMs(),
    random: () => 0.5,
    version: 'test',
    deviceId: 0x1a2b3c4d,
    transport: { label: '/tmp/ttyTest', connected: () => true },
  };
  return { ...sim, faults, ctx };
}

test('control messages drive the device', () => {
  const { device, faults, ctx, run, lastOf } = context();
  const apply = (msg: ClientMessage) => assertEquals(applyClientMessage(msg, ctx), null);
  apply({ type: 'set', group: 'motion', patch: { rollDeg: 15 } });
  apply({ type: 'module', module: 'imu', fitted: false });
  apply({ type: 'faults', patch: { corruptEvery: 3 } });
  apply({ type: 'counters', runSeconds: 7200 });
  apply({ type: 'calibration', flags: 3 });
  assertEquals(device.snapshot().values.motion.rollDeg, 15);
  assertEquals(device.isFitted(0x04) || device.isFitted(0x08), false);
  assertEquals(faults.get().corruptEvery, 3);
  assertEquals(device.hourMeter().runSeconds, 7200);
  assertEquals(device.snapshot().calibrationFlags, 3);
  apply({ type: 'power', action: 'watchdog' });
  run(10);
  assertEquals(lastOf(MSG.EVENT)?.values.resetReason, 6);
  assertEquals(lastOf(MSG.EVENT)?.values.lastCause, 1);
  assertEquals(applyClientMessage({ type: 'counters', runSeconds: -1 }, ctx), 'counters must be 0..4294967295');
});

test('drive messages: reverse gear, board mount (clamped) and the mounting calibration', () => {
  const { device, ctx, run } = context();
  const apply = (msg: ClientMessage) => applyClientMessage(msg, ctx);
  assertEquals(apply({ type: 'mount-cal', step: 'level' }), 'no vehicle: start one first');
  device.onCommand(command(1, { imuStreamHz: 100, streamMode: 2 })); // the calibration reads the host's stream
  assertEquals(apply({ type: 'vehicle', kind: 'truck', origin: { lat: -6.17, lon: 106.82 } }), null);
  assertEquals(apply({ type: 'mount', mount: { yawDeg: -90, pitchDeg: 0, rollDeg: 50 } }), null);
  const vehicle = () => device.vehicle()!.snapshot();
  assertEquals(vehicle().mount, { yawDeg: 270, pitchDeg: 0, rollDeg: 30 });
  run(500); // parked (warm-up)
  assertEquals(apply({ type: 'mount-cal', step: 'level' }), null);
  run(2500);
  assertEquals(vehicle().mountCal.phase, 'leveled', vehicle().mountCal.message);
  assert(Math.abs(vehicle().mountCal.level!.tiltRollDeg - 30) < 2, JSON.stringify(vehicle().mountCal.level));
  assertEquals(apply({ type: 'mount-cal', step: 'sideways' as never }), 'unknown step sideways');
  apply({ type: 'controls', controls: { throttle: 0, brake: 0, steer: 0, pitch: 0, reverse: true } });
  run(50);
  assertEquals(vehicle().controls.reverse, true);
  assertEquals(vehicle().gear, 'R');
});

test('web server: page or build hint, JSON state, and a WebSocket round trip', async () => {
  const { device, ctx } = context();
  const hub = new WebHub(ctx);
  const web = startWebServer(hub, { port: 0, hostname: '127.0.0.1' });
  try {
    const page = await fetch(web.url);
    const body = await page.text();
    assert(page.status === 200 ? body.includes('<div id="root">') : body.includes('bun run web:build'));

    const state = (await (await fetch(`${web.url}api/state`)).json()) as SimState;
    assertEquals(state.deviceId, 0x1a2b3c4d);

    const ws = new WebSocket(`${web.url.replace('http', 'ws')}api/ws`);
    const messages: ServerMessage[] = [];
    const rolled = new Promise<SimState>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data) as ServerMessage;
        messages.push(msg);
        if (msg.type === 'state' && msg.state.values.motion.rollDeg === 33) resolve(msg.state);
      };
    });
    await new Promise((resolve) => (ws.onopen = resolve));
    ws.send(JSON.stringify({ type: 'set', group: 'motion', patch: { rollDeg: 33 } } satisfies ClientMessage));
    const s = await rolled;
    assertEquals(s.inputs.modes.motion, 'manual');
    assertEquals(device.snapshot().values.motion.rollDeg, 33);
    assert(messages.some((m) => m.type === 'log'), 'log history is sent on connect');
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    await web.close();
  }
});
