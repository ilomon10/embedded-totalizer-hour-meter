import test from 'node:test';
import assert from 'node:assert/strict';

import { applyMessage, confirmSettings, activeFlags, devicesPresent, formatFirmware, initialState, MAX_LOG, addLog } from './state.js';
import { parseSetting } from './App.js';

test('frames merge into a flat value map and settings are tracked', () => {
  let s = initialState('/dev/ttyUSB0', false);
  s = applyMessage(s, { msgType: 1, seq: 1, deviceId: 0xabc, timestamp: 0, values: { runHours: 1250, timeValid: false, statusFlags: 4 } }, 1000);
  s = applyMessage(s, { msgType: 4, seq: 2, deviceId: 0xabc, timestamp: 0, values: { ackSeq: 9, ackStatus: 0, telemetryIntervalMs: 500, streamMode: 2 } }, 2000);
  assert.equal(s.connection, 'connected');
  assert.equal(s.values.runHours, 1250);
  assert.deepEqual(s.settings, { telemetryIntervalMs: 500, streamMode: 2 });
  assert.deepEqual(activeFlags(s), ['timeInvalid']);
  assert.equal(s.frames, 2);
});

test('events are logged in plain language', () => {
  let s = initialState('x', true);
  s = applyMessage(s, { msgType: 2, seq: 1, deviceId: 1, timestamp: 0, values: { eventKind: 3, devices: 0b0101 } }, 1);
  s = applyMessage(s, { msgType: 2, seq: 2, deviceId: 1, timestamp: 0, values: { eventKind: 2, calibResult: 8 } }, 2);
  assert.match(s.log[0].text, /EEPROM yes, RTC no, IMU yes, MAG no/);
  assert.equal(s.log[1].level, 'error');
  assert.match(s.log[1].text, /Failed/);
});

test('helpers', () => {
  assert.equal(formatFirmware(0x00020200), '2.2.0');
  assert.deepEqual(devicesPresent(0b1011).map(([, p]) => p), [true, true, false, true]);
  let s = initialState('x', true);
  for (let i = 0; i < MAX_LOG + 10; i++) s = addLog(s, 'info', `#${i}`, i);
  assert.equal(s.log.length, MAX_LOG);
});

test('setting input is validated like the firmware does', () => {
  assert.deepEqual(parseSetting('telemetryIntervalMs', '500'), { value: 500 });
  assert.match(parseSetting('telemetryIntervalMs', '50').error!, /range/);
  assert.match(parseSetting('telemetryIntervalMs', '500.5').error!, /whole/);
  assert.deepEqual(parseSetting('output', 'both'), { value: 3 });
  assert.deepEqual(parseSetting('altActiveHigh', 'false'), { value: false });
  assert.match(parseSetting('uartBaud', '12345').error!, /one of/);
  assert.deepEqual(parseSetting('kalmanQAccel', '0.001'), { value: 0.001 });
});

test('an Ok ACK confirms the settings that were sent', () => {
  let s = initialState('x', true);
  s = applyMessage(s, { msgType: 4, seq: 1, deviceId: 1, timestamp: 0, values: { streamMode: 2 } }, 1);
  s = confirmSettings(s, { streamMode: 3, setTime: 123 });
  assert.deepEqual(s.settings, { streamMode: 3 });  // commands are not settings
});
