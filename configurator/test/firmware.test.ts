// firmware.test.ts: `hour-meter firmware` words, which ports can flash, the backup/restore plan, and a whole
// update: flash through test/fake-rom.ts, then reconnect to the simulated device used by --demo.
import { test } from 'bun:test';

import { assert, assertEquals, assertThrows } from './assert.ts';
import { createDemoLink } from '../src/demo.ts';
import { DeviceClient } from '../src/device.ts';
import {
  flashPortProblem,
  isReleaseWord,
  type Note,
  parseFirmwareArgs,
  planRestore,
  type Requester,
  restoreAfterUpdate,
  type Snapshot,
  snapshot,
  updateDevice,
} from '../src/firmware.ts';
import { formatFirmware } from '../src/releases.ts';
import type { DecodedMessage } from '../src/sensorframe.ts';
import { MSG, STATUS_FLAGS } from '../src/tags.ts';
import { FIRMWARE_VERSION } from '../../simulator/src/protocol.ts';
import { appImage, fakeIo, fakeRom } from './fake-rom.ts';

const DEMO_FIRMWARE = formatFirmware(FIRMWARE_VERSION); // what the --demo device reports

const flag = (name: string) => 1 << STATUS_FLAGS.indexOf(name);

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    deviceId: 0x1a2b3c4d,
    fwVersion: 0x00020500,
    statusFlags: 0,
    runSeconds: 4_500_000,
    totalCount: 15_000,
    settings: { telemetryIntervalMs: 1000, output: 3, pulsesPerUnit: 10, bluetooth: true },
    at: '2026-10-24T08:00:00.000Z',
    ...overrides,
  };
}

/** A device that ACKs and records the commands (`refuse` makes it reject some). `values` answers each get. */
function fakeRequester(
  values: Record<number, Record<string, number | boolean>> = {},
  refuse: (cmd: Record<string, number | boolean>) => boolean = () => false,
) {
  const sent: Record<string, number | boolean>[] = [];
  const dev: Requester = {
    request: (cmd) => {
      sent.push(cmd);
      if (refuse(cmd)) return Promise.reject(new Error('device answered InvalidValue'));
      const answer: DecodedMessage = {
        msgType: MSG.ACK,
        seq: 1,
        deviceId: 0x1a2b3c4d,
        timestamp: 0,
        values: { ackSeq: 1, ackStatus: 0, ...(typeof cmd.get === 'number' ? values[cmd.get] : {}) },
      };
      return Promise.resolve(answer);
    },
  };
  return { dev, sent };
}

test('firmware words', () => {
  assertEquals(parseFirmwareArgs([]), { sub: 'version' });
  assertEquals(parseFirmwareArgs(['list']), { sub: 'list' });
  assertEquals(parseFirmwareArgs(['download']), { sub: 'download', spec: 'latest', dir: '.' });
  assertEquals(parseFirmwareArgs(['download', 'v1.0.0', '-o', 'fw']), { sub: 'download', spec: 'v1.0.0', dir: 'fw' });
  assertEquals(parseFirmwareArgs(['flash']), {
    sub: 'flash',
    spec: 'latest',
    baud: 460800,
    noReset: false,
    yes: false,
  });
  assertEquals(parseFirmwareArgs(['flash', 'build/firmware.bin', '--baud', '921600', '--no-reset', '--yes']), {
    sub: 'flash',
    spec: 'build/firmware.bin',
    baud: 921600,
    noReset: true,
    yes: true,
  });
  assertThrows(() => parseFirmwareArgs(['flash', '--baud', '1234']), /--baud: one of/);
  assertThrows(() => parseFirmwareArgs(['flash', 'a.bin', 'b.bin']), /one release or file/);
  assertThrows(() => parseFirmwareArgs(['flash', '--force']), /unknown option '--force'/);
  assertThrows(() => parseFirmwareArgs(['download', 'my.bin']), /latest, a version/);
  assertThrows(() => parseFirmwareArgs(['frobnicate']), /firmware what\?/);
  assertThrows(() => parseFirmwareArgs(['list', 'x']), /unexpected 'x'/);
});

test("release words versus files; only the board's USB port can flash", () => {
  for (const word of ['latest', '2.5.0', 'v1.0.0', 'firmware-v2.4.0']) assert(isReleaseWord(word), word);
  for (const file of ['firmware.bin', './2.5.0', '/tmp/v1.0.0.bin']) assert(!isReleaseWord(file), file);
  assertEquals(flashPortProblem({ demo: false, port: '/dev/ttyUSB0' }, 'linux'), undefined);
  assertEquals(flashPortProblem({ demo: false, port: '/dev/cu.usbserial-1410' }, 'darwin'), undefined);
  assert(/--demo/.test(flashPortProblem({ demo: true, port: '/dev/ttyUSB0' }, 'linux')!));
  assert(/tcp:\/\//.test(flashPortProblem({ demo: false, port: 'tcp://127.0.0.1:5555' }, 'linux')!));
  assert(/Bluetooth/.test(flashPortProblem({ demo: false, port: '/dev/rfcomm0' }, 'linux')!));
  assert(/Windows/.test(flashPortProblem({ demo: false, port: 'COM3' }, 'windows')!));
});

test('restore plan: counters that went back, changed settings, lost settings, a reformat', () => {
  const same = planRestore(snap(), snap({ runSeconds: 4_500_010 }));
  assertEquals(same, { counters: {}, settings: {}, settingsLost: false, formatted: false });

  const formatted = snap({
    runSeconds: 0,
    totalCount: 0,
    statusFlags: flag('eepromFormatted') | flag('settingsDefaults'),
    settings: { telemetryIntervalMs: 1000, output: 1, pulsesPerUnit: 1, bluetooth: false },
  });
  assertEquals(planRestore(snap(), formatted), {
    counters: { setRunSeconds: 4_500_000, setTotalCount: 15_000 },
    settings: { output: 3, pulsesPerUnit: 10, bluetooth: true },
    settingsLost: true,
    formatted: true,
  });

  // A setting the new firmware does not have is left out; defaults before and after are not "lost".
  const older = snap({ statusFlags: flag('settingsDefaults'), settings: { telemetryIntervalMs: 500 } });
  const plan = planRestore(snap({ statusFlags: flag('settingsDefaults') }), older);
  assertEquals([plan.settings, plan.settingsLost], [{ telemetryIntervalMs: 1000 }, false]);
});

test('after a reformat: counters and settings are put back, the version is checked', async () => {
  const { dev, sent } = fakeRequester();
  const after = snap({
    runSeconds: 0,
    totalCount: 0,
    fwVersion: 0x00020600,
    statusFlags: flag('eepromFormatted') | flag('settingsDefaults'),
    settings: { telemetryIntervalMs: 1000, output: 1, pulsesPerUnit: 1, bluetooth: true },
  });
  const notes = await restoreAfterUpdate(dev, snap(), after, '2.6.0');
  // The settings go in one COMMAND: the firmware checks rules between settings on the state after all of them.
  assertEquals(sent, [
    { setRunSeconds: 4_500_000, setTotalCount: 15_000 },
    { output: 3, pulsesPerUnit: 10 },
  ]);
  assertEquals(
    notes.map((n) => n.level),
    ['ok', 'warn', 'ok', 'ok'],
  );
  assert(/runs firmware 2\.6\.0/.test(notes[0].text));
  assert(/counters restored.*0\.00 h -> 1250\.00 h/.test(notes[2].text));
  assert(/2 restored/.test(notes[3].text));
});

test('a setting the new firmware refuses: the others are put back one by one', async () => {
  const { dev, sent } = fakeRequester({}, (cmd) => 'output' in cmd);
  const after = snap({
    runSeconds: 4_600_000, // counted on: only the totalizer went back
    totalCount: 0,
    statusFlags: flag('settingsDefaults'),
    settings: { telemetryIntervalMs: 1000, output: 1, pulsesPerUnit: 1, bluetooth: true },
  });
  const notes = await restoreAfterUpdate(dev, snap(), after);
  assertEquals(sent, [
    { setTotalCount: 15_000 },
    { output: 3, pulsesPerUnit: 10 },
    { output: 3 },
    {
      pulsesPerUnit: 10,
    },
  ]);
  assertEquals(notes[1].text, 'counters restored from the backup: totalizer 0 -> 15000 pulses'); // no hour meter
  assertEquals(notes[2], { level: 'warn', text: '1 settings restored; the new firmware refused output' });
});

test('after an update: a wrong version is an error, changed settings are only listed, another board is left', async () => {
  const { dev, sent } = fakeRequester();
  const notes = await restoreAfterUpdate(dev, snap(), snap({ settings: { ...snap().settings, output: 1 } }), '2.6.0');
  assertEquals(sent, []);
  assertEquals(
    notes.map((n) => n.level),
    ['error', 'warn'],
  );
  assert(/reports firmware 2\.5\.0, not 2\.6\.0/.test(notes[0].text));
  assert(/output 1 \(was 3\).*hour-meter set output=3/.test(notes[1].text));

  const other = await restoreAfterUpdate(dev, snap(), snap({ deviceId: 0x99, runSeconds: 0 }));
  assertEquals(sent, []);
  assert(/another device answered.*nothing restored/.test(other[1].text));
});

test('after an update: a board without the flash store partition is an error', async () => {
  const { dev } = fakeRequester();
  const missing = snap({ fwVersion: 0x00020600, statusFlags: flag('flashStoreMissing') | flag('eepromMissing') });
  const notes = await restoreAfterUpdate(dev, undefined, missing, '2.6.0');
  assertEquals(
    notes.map((n) => n.level),
    ['ok', 'error'],
  );
  assert(/flashStoreMissing.*Flash the full merged image/.test(notes[1].text), notes[1].text);
  const fine = await restoreAfterUpdate(dev, undefined, snap({ fwVersion: 0x00020600 }), '2.6.0');
  assertEquals(
    fine.map((n) => n.level),
    ['ok'],
  );
});

test('snapshot reads status, counters and settings', async () => {
  const { dev, sent } = fakeRequester({
    1: { runSeconds: 3600, totalCount: 42 },
    2: { telemetryIntervalMs: 500, kalmanQAccel: 0.001, altActiveHigh: false },
    3: { fwVersion: 0x00020500, statusFlags: 4 },
  });
  const s = await snapshot(dev);
  assertEquals(sent, [{ get: 3 }, { get: 1 }, { get: 2 }]);
  assertEquals(
    [s.deviceId, s.fwVersion, s.statusFlags, s.runSeconds, s.totalCount],
    [0x1a2b3c4d, 0x20500, 4, 3600, 42],
  );
  assertEquals(s.settings, { telemetryIntervalMs: 500, kalmanQAccel: 0.001, altActiveHigh: false });
});

test('updateDevice: flash, reconnect, check the version and restore counters that went back', async () => {
  const demo = await DeviceClient.connect(createDemoLink(), { readyTimeoutMs: 500 });
  const before = await snapshot(demo);
  demo.close();
  before.runSeconds! += 7200; // the device had counted two more hours than the restarted one will show

  const rom = fakeRom();
  const notes: Note[] = [];
  const { dev, ok } = await updateDevice(
    {
      port: '/dev/ttyUSB0',
      image: { bytes: appImage(40_000), label: `${DEMO_FIRMWARE} (v1.0.0)`, version: DEMO_FIRMWARE },
      note: (n) => notes.push(n),
      reopen: () => DeviceClient.connect(createDemoLink(), { readyTimeoutMs: 500 }),
      io: fakeIo(rom).io,
    },
    before,
  );
  if (!dev) throw new Error(`no client after the update: ${notes.map((n) => n.text).join('; ')}`);
  try {
    assert(ok, notes.map((n) => n.text).join('\n'));
    assert(notes.some((n) => /written and verified/.test(n.text)));
    assert(notes.some((n) => n.text.includes(`runs firmware ${DEMO_FIRMWARE}`)));
    assert(notes.some((n) => /counters restored/.test(n.text)));
    const hour = await dev.request({ get: 1 });
    assert(Number(hour.values.runSeconds) >= before.runSeconds!);
  } finally {
    dev.close();
  }
});

test('updateDevice: the port is reopened after a short absence; if it stays away, nothing throws', async () => {
  const rom = fakeRom();
  let opens = 0;
  const flaky = await updateDevice(
    {
      port: '/dev/ttyUSB0',
      image: { bytes: appImage(4000), label: 'firmware.bin' },
      note: () => {},
      reopen: () =>
        ++opens < 3
          ? Promise.reject(new Error('No such file or directory'))
          : DeviceClient.connect(createDemoLink(), { readyTimeoutMs: 100 }),
      io: fakeIo(rom).io,
      retryMs: 10,
    },
    undefined,
  );
  flaky.dev?.close();
  assertEquals([opens, flaky.ok, flaky.dev !== undefined], [3, true, true]);

  const notes: Note[] = [];
  const gone = await updateDevice(
    {
      port: '/dev/ttyUSB0',
      image: { bytes: appImage(4000), label: 'firmware.bin' },
      note: (n) => notes.push(n),
      reopen: () => Promise.reject(new Error('No such file or directory')),
      io: fakeIo(fakeRom()).io,
      retryMs: 1,
    },
    undefined,
  );
  assertEquals([gone.ok, gone.dev], [false, undefined]);
  assert(
    notes.some((n) => /written and verified/.test(n.text)),
    'the flash itself is reported',
  );
  assertEquals(notes.at(-1), { level: 'error', text: 'the port did not come back (No such file or directory)' });
});

test('updateDevice: a failed flash still hands back an open client', async () => {
  const rom = fakeRom({ silent: true });
  const notes: Note[] = [];
  const { dev, ok } = await updateDevice(
    {
      port: '/dev/ttyUSB0',
      image: { bytes: appImage(4000), label: 'firmware.bin' },
      note: (n) => notes.push(n),
      reopen: () => DeviceClient.connect(createDemoLink(), { readyTimeoutMs: 100 }),
      io: fakeIo(rom).io,
    },
    undefined,
  );
  dev?.close();
  assertEquals(ok, false);
  assert(/flash failed: no answer from the ESP32 bootloader/.test(notes[0].text));
});
