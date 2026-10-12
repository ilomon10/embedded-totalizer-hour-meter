// commands.test.ts: CLI words -> command values (pure), and every command encodes.
import { assert, assertEquals, assertThrows } from './assert.ts';
import { buildRequest } from '../src/commands.ts';
import { codec } from '../src/sensorframe.ts';
import { hoursToSeconds, MSG, RESET_MAGIC, unitsToPulses } from '../src/tags.ts';

Deno.test('CLI words become command values', () => {
  assertEquals(buildRequest(['get', 'status']).values, { get: 3 });
  assertEquals(
    buildRequest(['set', 'telemetryIntervalMs=500', 'output=both', 'altActiveHigh=false']).values,
    { telemetryIntervalMs: 500, output: 3, altActiveHigh: false },
  );
  assertEquals(buildRequest(['set-hours', '1234.5']).values, { setRunSeconds: 4444200 });
  assertEquals(buildRequest(['reset-counters', '--yes']).values, { resetCounters: RESET_MAGIC });
  const t = Number(buildRequest(['set-time']).values.setTime);
  assert(Math.abs(t - Date.now() / 1000) < 5);
  assertThrows(() => buildRequest(['reset-counters']), /--yes/);
  assertThrows(() => buildRequest(['set', 'nope=1']), /unknown setting/);
  assertThrows(() => buildRequest(['get', 'x']), /get what/);
  assertThrows(() => buildRequest(['frobnicate']), /unknown command/);
});

Deno.test('Bluetooth settings (tags 127, 128) can be set from the CLI', () => {
  assertEquals(buildRequest(['set', 'bluetooth=true', 'btPin=4821']).values, { bluetooth: true, btPin: 4821 });
});

Deno.test('counters can be set to any value, and reset one at a time', () => {
  assertEquals(buildRequest(['set-hours', '1250.5']).values, { setRunSeconds: 4501800 });
  assertEquals(buildRequest(['set-units', '5230.75'], { pulsesPerUnit: 100 }).values, { setTotalCount: 523075 });
  assertEquals(buildRequest(['set-units', '12.3'], { pulsesPerUnit: 1 }).values, { setTotalCount: 12 }); // whole pulses
  assertEquals(buildRequest(['reset-hours', '--yes']).values, { setRunSeconds: 0 });
  assertEquals(buildRequest(['reset-totalizer', '--yes']).values, { setTotalCount: 0 });
  assertThrows(() => buildRequest(['reset-totalizer']), /--yes/);
  assertThrows(() => buildRequest(['set-hours', '-1']), />= 0/);
  assertThrows(() => hoursToSeconds(2e6), /max 1193046 hours/);
  assertThrows(() => unitsToPulses(5e9, 1), /max/);
  assertThrows(() => unitsToPulses(1, 0), /pulsesPerUnit/);
});

Deno.test('every command encodes with the tag table', () => {
  const cases = [['get', 'hour'], ['set', 'uartBaud=230400', 'kalmanQAccel=0.001'], ['calibrate', 'mag'], ['reboot']];
  for (const args of cases) {
    const packet = codec.encode({ msgType: MSG.COMMAND, values: buildRequest(args).values });
    assert(packet.length > 14);
  }
});

Deno.test('engine text: input on but not confirmed by vibration', async () => {
  const { engineText } = await import('../src/reader.ts');
  assertEquals(engineText({ alternator: true, altInput: true }), 'ON ');
  assertEquals(engineText({ alternator: false, altInput: true }), 'OFF (input on)');
  assertEquals(engineText({ alternator: false }), 'OFF');
});
