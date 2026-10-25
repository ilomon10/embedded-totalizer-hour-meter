// frames.test.ts: the simulator must produce the firmware's bytes exactly.
// The golden frames are read from the firmware's own unit test, so this test
// fails as soon as either side changes the wire format.
import { test } from 'bun:test';

import { assertEquals } from './assert.ts';
import {
  appendHourMeter,
  buildAck,
  buildTelemetry,
  type DeviceStatus,
  type HourMeterSnapshot,
  toI16,
  toU16,
} from '../src/frames.ts';
import { MSG, rec } from '../src/protocol.ts';
import { frameHex } from './helpers.ts';

const FIRMWARE_TEST = new URL('../../esp32/test/test_app/test_main.cpp', import.meta.url);

async function golden(name: string): Promise<string> {
  const source = await Bun.file(FIRMWARE_TEST).text();
  const start = source.indexOf(`${name} =`);
  if (start < 0) throw new Error(`${name} not found in ${FIRMWARE_TEST.pathname}`);
  const literal = source.slice(start, source.indexOf(';', start));
  return [...literal.matchAll(/"([^"]*)"/g)]
    .map((m) => m[1])
    .join('')
    .trim();
}

// Same inputs as test_golden_doc_examples() in esp32/test/test_app/test_main.cpp.
const status: DeviceStatus = {
  timeValid: true,
  epoch: 1791376496, // 2026-10-07T12:34:56Z
  uptimeS: 0,
  devices: 0,
  i2cErrors: 0,
  overruns: 0,
  resetReason: 0,
  settingsSource: 0,
  btState: 0,
  lastCause: 0,
  lastStage: 0,
  rtcTempValid: false,
  rtcTempQuarterC: 0,
  flags: 0,
};
const hourMeter: HourMeterSnapshot = {
  runSeconds: 4500000, // 1250.00 h
  totalCount: 15000,
  pulsesPerUnit: 100,
  running: true,
  inputActive: true,
  lastSavedEpoch: 1791376440,
  journalSeq: 812,
};

test('TELEMETRY equals the firmware golden frame', async () => {
  const msg = buildTelemetry(hourMeter, status, null, null);
  assertEquals(frameHex(msg, 1, 0x12345678), await golden('kGoldenTelemetry'));
});

test('COMMAND setTime equals the firmware golden frame', async () => {
  const msg = { msgType: MSG.COMMAND, timestamp: 0, records: [rec('setTime', 1791376496)] };
  assertEquals(frameHex(msg, 42, 0), await golden('kGoldenSetTime'));
});

test('ACK to get=1 equals the firmware golden frame', async () => {
  const msg = buildAck(status, 43, 0, 0);
  appendHourMeter(msg.records, hourMeter, true);
  assertEquals(frameHex(msg, 2, 0x12345678), await golden('kGoldenAckGetHour'));
});

test('scaling rounds like C roundf and saturates like the firmware', () => {
  assertEquals(toI16(-0.025, 100), -3); // half away from zero (Math.round would give -2)
  assertEquals(toI16(1000, 100), 32767);
  assertEquals(toI16(Number.NaN, 100), 0);
  assertEquals(toU16(-1, 100), 0);
  assertEquals(toU16(359.996, 100), 36000);
});
