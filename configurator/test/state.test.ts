// state.test.ts: the TUI's pure reducer and setting validation.
import { assertEquals, assertMatch } from './assert.ts';
import {
  activeFlags,
  addLog,
  applyMessage,
  confirmSettings,
  devicesPresent,
  formatFirmware,
  initialState,
  MAX_LOG,
} from '../src/tui/state.ts';
import { parseSetting } from '../src/tui/App.tsx';

Deno.test('frames merge into a flat value map and settings are tracked', () => {
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

Deno.test('events are logged in plain language', () => {
  let s = initialState('x', true);
  s = applyMessage(s, { msgType: 2, seq: 1, deviceId: 1, timestamp: 0, values: { eventKind: 3, devices: 0b0101 } }, 1);
  s = applyMessage(s, { msgType: 2, seq: 2, deviceId: 1, timestamp: 0, values: { eventKind: 2, calibResult: 8 } }, 2);
  assertMatch(s.log[0].text, /EEPROM yes, RTC no, IMU yes, MAG no/);
  assertEquals(s.log[1].level, 'error');
  assertMatch(s.log[1].text, /Failed/);
});

Deno.test('helpers', () => {
  assertEquals(formatFirmware(0x00020200), '2.2.0');
  assertEquals(devicesPresent(0b1011).map(([, p]) => p), [true, true, false, true]);
  let s = initialState('x', true);
  for (let i = 0; i < MAX_LOG + 10; i++) s = addLog(s, 'info', `#${i}`, i);
  assertEquals(s.log.length, MAX_LOG);
});

Deno.test('setting input is validated like the firmware does', () => {
  assertEquals(parseSetting('telemetryIntervalMs', '500'), { value: 500 });
  assertMatch(parseSetting('telemetryIntervalMs', '50').error!, /range/);
  assertMatch(parseSetting('telemetryIntervalMs', '500.5').error!, /whole/);
  assertEquals(parseSetting('output', 'both'), { value: 3 });
  assertEquals(parseSetting('altActiveHigh', 'false'), { value: false });
  assertMatch(parseSetting('uartBaud', '12345').error!, /one of/);
  assertEquals(parseSetting('kalmanQAccel', '0.001'), { value: 0.001 });
});

Deno.test('an Ok ACK confirms the settings that were sent', () => {
  let s = initialState('x', true);
  s = applyMessage(s, { msgType: 4, seq: 1, deviceId: 1, timestamp: 0, values: { streamMode: 2 } }, 1);
  s = confirmSettings(s, { streamMode: 3, setTime: 123 });
  assertEquals(s.settings, { streamMode: 3 }); // commands are not settings
});
