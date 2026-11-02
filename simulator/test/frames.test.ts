// frames.test.ts: the simulator must produce the firmware's bytes exactly.
// The golden frames are read from the firmware's own unit test, so this test
// fails as soon as either side changes the wire format.
import { test } from 'bun:test';

import { assertEquals } from './assert.ts';
import {
  appendHourMeter,
  appendSettings,
  appendStatus,
  buildAck,
  buildDevicesChangedEvent,
  buildTelemetry,
  type DeviceStatus,
  type HourMeterSnapshot,
  toI16,
  toU16,
} from '../src/frames.ts';
import { DEFAULT_SETTINGS } from '../src/device.ts';
import { codec, MSG, type Rec, rec } from '../src/protocol.ts';
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
  i2cParked: false,
  i2cLines: 0,
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

test('the full status ends with rtcTemp (54) and i2cLines (64), and i2cLines only while the bus is parked', () => {
  const tags = (st: DeviceStatus, full = true) => {
    const out: Rec[] = [];
    appendStatus(out, st, full);
    return out.map((r) => r.tag);
  };
  const STATUS = [50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 62, 63, 241];
  const withTemp = { ...status, rtcTempValid: true, rtcTempQuarterC: 117 };
  assertEquals(tags(withTemp), [...STATUS, 54]);
  assertEquals(tags({ ...withTemp, i2cParked: true, i2cLines: 1 }), [...STATUS, 54, 64]);
  assertEquals(tags({ ...status, i2cParked: true, i2cLines: 0 }), [...STATUS, 64], 'both lines free: still reported');
  assertEquals(tags({ ...status, i2cParked: false, i2cLines: 3 }), STATUS, 'i2cLines alone is not enough');
  assertEquals(tags({ ...status, i2cParked: true, i2cLines: 3 }, false), [50, 53], 'TELEMETRY never carries it');

  const event = buildDevicesChangedEvent({ ...status, i2cParked: true, i2cLines: 2 });
  const decoded = codec.decode(codec.encode({ ...event, seq: 1, deviceId: 0x1a2b3c4d }));
  assertEquals([decoded.values.i2cLines, decoded.records.at(-1)?.fmt], [2, 'u8']);
});

test('the settings are listed in the firmware table order: 110..129, then i2c (150) and pulseInput (151) as bool', () => {
  const out: Rec[] = [];
  appendSettings(out, { ...DEFAULT_SETTINGS });
  assertEquals(
    out.map((r) => r.tag),
    [...Array.from({ length: 20 }, (_, i) => 110 + i), 150, 151],
  );
  assertEquals(
    out.slice(-2).map((r) => [r.fmt, r.value]),
    [
      ['bool', true],
      ['bool', true],
    ],
  );
});
