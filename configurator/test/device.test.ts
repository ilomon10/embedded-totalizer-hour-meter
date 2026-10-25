// device.test.ts: DeviceClient protocol rules over an in-memory link, plus a full
// round trip against the simulated device used by --demo.
import { assert, assertEquals, assertRejects } from './assert.ts';
import { createDemoLink } from '../src/demo.ts';
import { ackErrorText, DeviceClient } from '../src/device.ts';
import { type Link, linkPair } from '../src/links.ts';
import { codec, type DecodedMessage } from '../src/sensorframe.ts';
import { MSG } from '../src/tags.ts';

/** A fake device on the far end of a link pair: `reply` decides the answer to each COMMAND. */
function fakeDevice(reply: (cmd: DecodedMessage, n: number) => object | null) {
  const [host, device] = linkPair();
  const commands: DecodedMessage[] = [];
  const push = (msg: object) => device.write(codec.frame(msg as never));
  void (async () => {
    let pending: number[] = [];
    for await (const chunk of device.readable) {
      for (const byte of chunk) {
        if (byte !== 0) {
          pending.push(byte);
          continue;
        }
        const cmd = codec.decodeFrame(Uint8Array.from(pending));
        pending = [];
        commands.push(cmd);
        const answer = reply(cmd, commands.length);
        if (answer) await push(answer);
      }
    }
  })();
  return { host, commands, push };
}

const ack = (cmd: DecodedMessage, ackStatus = 0, extra = {}) => ({
  msgType: MSG.ACK,
  seq: 1,
  values: { ackSeq: cmd.seq, ackStatus, ...extra },
});

function client(link: Link): DeviceClient {
  return new DeviceClient(link);
}

Deno.test('request resolves with the matching ACK', async () => {
  const { host } = fakeDevice((cmd) => ack(cmd, 0, { runSeconds: 42 }));
  const dev = client(host);
  assertEquals((await dev.request({ get: 1 })).values.runSeconds, 42);
  dev.close();
});

Deno.test('request retries with the same seq after a lost frame', async () => {
  const { host, commands } = fakeDevice((cmd, n) => (n === 1 ? null : ack(cmd))); // drop the first
  const dev = client(host);
  assertEquals((await dev.request({ get: 1 }, { timeoutMs: 50 })).values.ackStatus, 0);
  assertEquals(commands.length, 2);
  assertEquals(commands[1].seq, commands[0].seq);
  dev.close();
});

Deno.test('request rejects on an error ACK', async () => {
  const { host } = fakeDevice((cmd) => ack(cmd, 2, { rejectedTag: 110 }));
  const dev = client(host);
  await assertRejects(() => dev.request({ telemetryIntervalMs: 5 }), /InvalidValue \(tag 110: telemetryIntervalMs\)/);
  dev.close();
});

Deno.test('auto time sync answers an unknown device time with setTime, rate-limited', async () => {
  const { host, commands, push } = fakeDevice((cmd) => ack(cmd));
  let clock = 1791376496000;
  const dev = client(host).enableAutoTimeSync({ minIntervalMs: 30000, now: () => clock });
  const synced = new Promise((resolve) => dev.once('timeSynced', resolve));
  const telemetry = (timeValid: boolean) => ({
    msgType: MSG.TELEMETRY,
    seq: 1,
    values: { runSeconds: 5, timeValid, statusFlags: timeValid ? 0 : 4 },
  });
  const settle = () => new Promise((r) => setTimeout(r, 50));

  await push(telemetry(false));
  assertEquals(await synced, 1791376496);
  assertEquals(commands.map((c) => c.values), [{ setTime: 1791376496 }]);

  await push(telemetry(false)); // within 30 s: rate-limited
  await push(telemetry(true)); // valid time: nothing to do
  await settle();
  assertEquals(commands.length, 1);

  clock += 31000; // later and still unknown: try again
  await push(telemetry(false));
  await settle();
  assertEquals(commands.length, 2);
  dev.close();
});

Deno.test('--demo device: boot, telemetry and a get=1 round trip', async () => {
  const dev = await DeviceClient.connect(createDemoLink(), { readyTimeoutMs: 2000 });
  const telemetry = await new Promise<DecodedMessage>((resolve) => {
    const onFrame = (msg: DecodedMessage) => {
      if (msg.msgType !== MSG.TELEMETRY) return;
      dev.off('frame', onFrame);
      resolve(msg);
    };
    dev.on('frame', onFrame);
  });
  assertEquals(telemetry.values.runHours, 1250);
  const hour = await dev.request({ get: 1 });
  assertEquals(hour.values.journalSeq, 812);
  assert(Number(hour.values.runSeconds) >= 4500000);
  dev.close();
});

Deno.test('a counter change answered DeviceMissing says which store is missing', () => {
  const answer = (statusFlags?: number, rejectedTag = 102) =>
    ackErrorText({ msgType: MSG.ACK, seq: 1, values: { ackSeq: 1, ackStatus: 4, rejectedTag, statusFlags } } as never);
  const eepromMissing = 1 << 0;
  const flashStoreMissing = 1 << 19;
  const both = answer(eepromMissing | flashStoreMissing);
  assert(both.startsWith('device answered DeviceMissing (tag 102: setRunSeconds). Nowhere to keep it'), both);
  assert(both.includes('flashStoreMissing') && both.includes('hour-meter firmware flash'), both);
  assert(answer(eepromMissing, 103).includes('before 2.6.0'), answer(eepromMissing, 103));
  assertEquals(answer(undefined), 'device answered DeviceMissing (tag 102: setRunSeconds)');
  assertEquals(answer(eepromMissing, 105), 'device answered DeviceMissing (tag 105: calibrate)'); // the IMU, not a store
});
