// state.test.ts: the TUI's pure reducer and setting validation.
import { test } from 'bun:test';

import { assertEquals, assertMatch } from './assert.ts';
import {
  activeFlags,
  addLog,
  applyConnState,
  applyMessage,
  confirmSettings,
  devicesPresent,
  flagColor,
  formatFirmware,
  initialState,
  MAX_LOG,
  updateAvailable,
} from '../src/tui/state.ts';
import type { FirmwareRelease } from '../src/releases.ts';
import { linkBanner, parseSetting } from '../src/tui/App.tsx';

test('frames merge into a flat value map and settings are tracked', () => {
  let s = initialState('/dev/ttyUSB0', false);
  s = applyMessage(s, {
    msgType: 1,
    seq: 1,
    deviceId: 0xabc,
    timestamp: 0,
    values: { runHours: 1250, timeValid: false, statusFlags: 4 },
  }, 1000);
  s = applyMessage(s, {
    msgType: 4,
    seq: 2,
    deviceId: 0xabc,
    timestamp: 0,
    values: { ackSeq: 9, ackStatus: 0, telemetryIntervalMs: 500, streamMode: 2 },
  }, 2000);
  assertEquals(s.connection, 'connected');
  assertEquals(s.values.runHours, 1250);
  assertEquals(s.settings, { telemetryIntervalMs: 500, streamMode: 2 });
  assertEquals(activeFlags(s), ['timeInvalid']);
  assertEquals(s.frames, 2);
});

test('events are logged in plain language', () => {
  let s = initialState('x', true);
  s = applyMessage(s, { msgType: 2, seq: 1, deviceId: 1, timestamp: 0, values: { eventKind: 3, devices: 0b0101 } }, 1);
  s = applyMessage(s, { msgType: 2, seq: 2, deviceId: 1, timestamp: 0, values: { eventKind: 2, calibResult: 8 } }, 2);
  assertMatch(s.log[0].text, /EEPROM yes, RTC no, IMU yes, MAG no/);
  assertEquals(s.log[1].level, 'error');
  assertMatch(s.log[1].text, /Failed/);
});

test('helpers', () => {
  assertEquals(formatFirmware(0x00020200), '2.2.0');
  assertEquals(devicesPresent(0b1011).map(([, p]) => p), [true, true, false, true]);
  let s = initialState('x', true);
  for (let i = 0; i < MAX_LOG + 10; i++) s = addLog(s, 'info', `#${i}`, i);
  assertEquals(s.log.length, MAX_LOG);
});

test('the header names a newer release, never a prerelease', () => {
  const release = (version: string, prerelease = false): FirmwareRelease => ({
    version,
    tag: `v-${version}`,
    date: '2026-10-24T00:00:00Z',
    prerelease,
    asset: `hour-meter-${version}-esp32dev-merged.bin`,
    url: '',
    sumsUrl: '',
  });
  const releases = [release('2.7.0', true), release('2.6.0'), release('2.5.0')];
  assertEquals(updateAvailable(0x00020500, releases), '2.6.0');
  assertEquals(updateAvailable(0x00020600, releases), undefined);
  assertEquals(updateAvailable(0x00030000, releases), undefined); // the device is newer
  assertEquals(updateAvailable(undefined, releases), undefined); // version not read yet
  assertEquals(updateAvailable(0x00020500, undefined), undefined); // GitHub not asked yet
});

test('a missing EEPROM is red only when nothing else keeps the values', () => {
  assertEquals(flagColor('eepromMissing', ['eepromMissing'], 0x00020500), 'red'); // 2.5.0: nothing saved
  assertEquals(flagColor('eepromMissing', ['eepromMissing'], 0x00020600), 'yellow'); // 2.6.0: the flash keeps them
  assertEquals(flagColor('eepromMissing', ['eepromMissing', 'flashStoreMissing'], 0x00020600), 'red');
  assertEquals(flagColor('eepromMissing', ['eepromMissing'], undefined), 'red'); // version not read yet
  assertEquals(flagColor('storageError', [], 0x00020600), 'red');
  assertEquals(flagColor('flashStoreMissing', [], 0x00020600), 'yellow');
});

test('setting input is validated like the firmware does', () => {
  assertEquals(parseSetting('telemetryIntervalMs', '500'), { value: 500 });
  assertMatch(parseSetting('telemetryIntervalMs', '50').error!, /range/);
  assertMatch(parseSetting('telemetryIntervalMs', '500.5').error!, /whole/);
  assertEquals(parseSetting('output', 'both'), { value: 3 });
  assertEquals(parseSetting('altActiveHigh', 'false'), { value: false });
  assertMatch(parseSetting('uartBaud', '12345').error!, /one of/);
  assertEquals(parseSetting('kalmanQAccel', '0.001'), { value: 0.001 });
});

test('an Ok ACK confirms the settings that were sent', () => {
  let s = initialState('x', true);
  s = applyMessage(s, { msgType: 4, seq: 1, deviceId: 1, timestamp: 0, values: { streamMode: 2 } }, 1);
  s = confirmSettings(s, { streamMode: 3, setTime: 123 });
  assertEquals(s.settings, { streamMode: 3 }); // commands are not settings
});

test('the link: a disconnect and the reconnect are logged once each, the demo stays the demo', () => {
  let s = initialState('/dev/ttyUSB0', false);
  s = applyConnState(s, { kind: 'connected' }, '/dev/ttyUSB0', 1000);
  assertEquals(s.log, []); // the first connect is not news
  const lost = { kind: 'waiting' as const, problem: 'the board was disconnected', sinceMs: 2000, lost: true };
  s = applyConnState(s, lost, '/dev/ttyUSB0', 2000);
  s = applyConnState(s, lost, '/dev/ttyUSB0', 3000); // tried again: no new line
  assertEquals(s.connection, 'waiting');
  assertEquals(s.log.map((e) => [e.level, e.text]), [[
    'error',
    'the board was disconnected: waiting for /dev/ttyUSB0',
  ]]);
  assertEquals(
    linkBanner(s, 14_000, true),
    'The board was disconnected (12 s ago). Plug it back in: it reconnects by itself · p: other port.',
  );
  s = applyConnState(s, { kind: 'connected' }, '/dev/ttyUSB1', 15_000);
  assertEquals(s.port, '/dev/ttyUSB1');
  assertEquals(s.problem, undefined);
  assertEquals(s.log[s.log.length - 1].text, 'connected to /dev/ttyUSB1');
  assertEquals(linkBanner(s, 15_000, true), undefined);

  const never = applyConnState(
    initialState('/dev/ttyUSB0', false),
    {
      kind: 'waiting',
      problem: 'no permission to open /dev/ttyUSB0',
      sinceMs: 0,
      lost: false,
    },
    '/dev/ttyUSB0',
    0,
  );
  assertEquals(linkBanner(never, 500, false), 'No permission to open /dev/ttyUSB0. Trying again every second.');

  const demo = initialState('simulated', true);
  assertEquals(applyConnState(demo, { kind: 'connected' }, 'demo', 0), demo);
});

test('another board on the port: the old values are dropped', () => {
  const frame = (deviceId: number, values: Record<string, number>) => ({
    msgType: 1,
    seq: 1,
    deviceId,
    timestamp: 0,
    values,
  });
  let s = initialState('/dev/ttyUSB0', false);
  s = applyMessage(s, frame(0xa, { runHours: 5, totalCount: 9, telemetryIntervalMs: 500 }), 1);
  s = applyMessage(s, frame(0xb, { runHours: 7 }), 2);
  assertEquals(s.values, { runHours: 7 });
  assertEquals(s.settings, {});
  assertEquals(s.deviceId, 0xb);
  assertMatch(s.log[0].text, /another device on this port: b/);
});
