const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { buildRequest } = require('../commands');
const { DeviceClient, codec } = require('../device');
const { RESET_MAGIC, MSG } = require('../tags');

test('CLI words become command values', () => {
  assert.deepEqual(buildRequest(['get', 'status']).values, { get: 3 });
  assert.deepEqual(buildRequest(['set', 'telemetryIntervalMs=500', 'output=both', 'altActiveHigh=false']).values,
    { telemetryIntervalMs: 500, output: 3, altActiveHigh: false });
  assert.deepEqual(buildRequest(['set-hours', '1234.5']).values, { setRunSeconds: 4444200 });
  assert.deepEqual(buildRequest(['reset-counters', '--yes']).values, { resetCounters: RESET_MAGIC });
  const t = buildRequest(['set-time']).values.setTime;
  assert.ok(Math.abs(t - Date.now() / 1000) < 5);
  assert.throws(() => buildRequest(['reset-counters']), /--yes/);
  assert.throws(() => buildRequest(['set', 'nope=1']), /unknown setting/);
  assert.throws(() => buildRequest(['get', 'x']), /get what/);
});

test('counters can be set to any value, and reset one at a time', () => {
  const { hoursToSeconds, unitsToPulses } = require('../tags');
  assert.deepEqual(buildRequest(['set-hours', '1250.5']).values, { setRunSeconds: 4501800 });
  assert.deepEqual(buildRequest(['set-units', '5230.75'], { pulsesPerUnit: 100 }).values, { setTotalCount: 523075 });
  assert.deepEqual(buildRequest(['set-units', '12.3'], { pulsesPerUnit: 1 }).values, { setTotalCount: 12 });  // whole pulses
  assert.deepEqual(buildRequest(['reset-hours', '--yes']).values, { setRunSeconds: 0 });
  assert.deepEqual(buildRequest(['reset-totalizer', '--yes']).values, { setTotalCount: 0 });
  assert.throws(() => buildRequest(['reset-totalizer']), /--yes/);
  assert.throws(() => buildRequest(['set-hours', '-1']), />= 0/);
  assert.throws(() => hoursToSeconds(2e6), /max 1193046 hours/);
  assert.throws(() => unitsToPulses(5e9, 1), /max/);
  assert.throws(() => unitsToPulses(1, 0), /pulsesPerUnit/);
});

test('every command encodes with the tag table', () => {
  for (const args of [['get', 'hour'], ['set', 'uartBaud=230400', 'kalmanQAccel=0.001'], ['calibrate', 'mag'], ['reboot']]) {
    const pkt = codec.encode({ msgType: MSG.COMMAND, values: buildRequest(args).values });
    assert.ok(pkt.length > 14);
  }
});

// A fake device on an in-memory duplex: answers each COMMAND with an ACK.
function fakePort({ dropFirst = false, status = 0 } = {}) {
  const toDevice = new PassThrough();
  const fromDevice = new PassThrough();
  // Host writes go to the device; device replies are pushed into the readable side.
  const port = Object.assign(fromDevice, { write: (b) => toDevice.write(b), close: () => {} });
  let dropped = !dropFirst;
  let sends = 0;
  toDevice.on('data', (chunk) => {
    sends++;
    const cmd = codec.decodeFrame(chunk);
    if (!dropped) { dropped = true; return; } // simulate a lost frame
    fromDevice.push(codec.frame({ msgType: MSG.ACK, seq: 1, values: { ackSeq: cmd.seq, ackStatus: status, runSeconds: 42 } }));
  });
  return { port, sends: () => sends };
}

test('request resolves with the matching ACK', async () => {
  const { port } = fakePort();
  const ack = await new DeviceClient(port).request({ get: 1 });
  assert.equal(ack.values.runSeconds, 42);
});

test('request retries with the same seq after a lost frame', async () => {
  const { port, sends } = fakePort({ dropFirst: true });
  const ack = await new DeviceClient(port).request({ get: 1 }, { timeoutMs: 50 });
  assert.equal(ack.values.ackStatus, 0);
  assert.equal(sends(), 2);
});

test('request rejects on an error ACK', async () => {
  const { port } = fakePort({ status: 2 });
  await assert.rejects(new DeviceClient(port).request({ telemetryIntervalMs: 5 }), /InvalidValue/);
});

test('auto time sync answers an unknown device time with setTime', async () => {
  const toDevice = new PassThrough();
  const fromDevice = new PassThrough();
  const port = Object.assign(fromDevice, { write: (b) => toDevice.write(b), close: () => {} });
  const commands = [];
  toDevice.on('data', (chunk) => {
    const cmd = codec.decodeFrame(chunk);
    commands.push(cmd.values);
    fromDevice.push(codec.frame({ msgType: MSG.ACK, seq: 2, values: { ackSeq: cmd.seq, ackStatus: 0 } }));
  });
  let clock = 1791376496000;
  const dev = new DeviceClient(port).enableAutoTimeSync({ minIntervalMs: 30000, now: () => clock });
  const synced = new Promise((resolve) => dev.once('timeSynced', resolve));
  const telemetry = (timeValid) => codec.frame({ msgType: MSG.TELEMETRY, seq: 1, values: { runSeconds: 5, timeValid, statusFlags: timeValid ? 0 : 4 } });

  fromDevice.push(telemetry(false));
  assert.equal(await synced, 1791376496);
  assert.deepEqual(commands, [{ setTime: 1791376496 }]);

  fromDevice.push(telemetry(false));          // within 30 s: rate-limited
  fromDevice.push(telemetry(true));           // valid time: nothing to do
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(commands.length, 1);

  clock += 31000;                              // later and still unknown: try again
  fromDevice.push(telemetry(false));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(commands.length, 2);
});
