// device.test.ts: the simulated device follows the firmware's rules
// (Application.cpp, CommandHandler.cpp, Telemetry.cpp). Time is a FakeClock.
import { assert, assertEquals } from './assert.ts';
import { ResetReason } from '../src/device.ts';
import { Ack, Device, Flag, MSG, RESET_MAGIC } from '../src/protocol.ts';
import { command, makeDevice, tagsOf } from './helpers.ts';

const BOOT_TAGS = [8, 1, 2, 3, 4, 5, 6, 7, 50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 241, 54];
const TELEMETRY_TAGS = [1, 2, 3, 4, 5, 50, 53, 40, 41, 42, 43, 44];

Deno.test('power-on sends the boot EVENT with the firmware record order', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  assertEquals(last().msgType, MSG.EVENT);
  assertEquals(tagsOf(last()), BOOT_TAGS);
  assertEquals(last().values.resetReason, ResetReason.powerOn);
  assertEquals(last().values.runHours, 1250);
  assertEquals(last().seq, 0);
});

Deno.test('TELEMETRY every second, with IMU and vibration records after the first window', () => {
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  run(1000);
  const t = lastOf(MSG.TELEMETRY);
  assert(t);
  assertEquals(tagsOf(t), TELEMETRY_TAGS);
  assertEquals(t.timestamp, t.values.epoch ?? 1791376497); // valid time: header timestamp is UTC
});

Deno.test('IMU stream at imuStreamHz in filtered mode (default)', () => {
  const { device, run, sent } = makeDevice();
  device.powerOn();
  run(1000);
  const imu = sent.filter((s) => s.msg.msgType === MSG.IMU);
  assertEquals(imu.length, 10);
  assertEquals(tagsOf(imu[0].msg), [30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42]);
});

Deno.test('get=1..4 answers with the requested data in one ACK', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(7, { get: 1 }));
  assertEquals(tagsOf(last()), [242, 243, 1, 2, 3, 4, 5, 6, 7]);
  assertEquals(last().values.ackSeq, 7);
  device.onCommand(command(8, { get: 2 }));
  assertEquals(last().records.length, 2 + 19);
  assertEquals(last().values.btPin, 1234);
  device.onCommand(command(9, { get: 3 }));
  assertEquals(tagsOf(last()).slice(2), [50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 241, 54]);
  device.onCommand(command(10, { get: 4 }));
  assertEquals(last().records.length, 2 + 19);
});

Deno.test('get=1..4 in one command: the last group is cut at 250 bytes, like the firmware', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(11, { get: 1 }, [2, 3, 4].map((v) => ({ tag: 101, fmt: 'u8', value: v }))));
  assertEquals(last().values.ackStatus, Ack.Ok);
  const tags = tagsOf(last());
  assert(tags.includes(54) && tags.includes(128), 'get=1..3 complete');
  assertEquals(tags.filter((t) => t >= 130 && t <= 148).length, 9); // 21 + 39 + 78 + 55 = 193; 57 bytes left = 9 f32 records
});

Deno.test('settings are all-or-nothing: one bad value rejects the whole command', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { telemetryIntervalMs: 500, imuSampleHz: 5 }));
  assertEquals(last().values.ackStatus, Ack.InvalidValue);
  assertEquals(last().values.rejectedTag, 111);
  device.onCommand(command(2, { get: 2 }));
  assertEquals(last().values.telemetryIntervalMs, 1000);
});

Deno.test('cross-field check: imuStreamHz above imuSampleHz is rejected on tag 112', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { imuSampleHz: 20, imuStreamHz: 50 }));
  assertEquals([last().values.ackStatus, last().values.rejectedTag], [Ack.InvalidValue, 112]);
});

Deno.test('uartBaud accepts standard rates only', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { uartBaud: 100000 }));
  assertEquals(last().values.ackStatus, Ack.InvalidValue);
  device.onCommand(command(2, { uartBaud: 9600 }));
  assertEquals(last().values.ackStatus, Ack.Ok);
});

Deno.test('action checks: setTime range, reset magic, unknown tag', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { setTime: 12345 }));
  assertEquals([last().values.ackStatus, last().values.rejectedTag], [Ack.InvalidValue, 100]);
  device.onCommand(command(2, { resetCounters: 1 }));
  assertEquals([last().values.ackStatus, last().values.rejectedTag], [Ack.BadMagic, 104]);
  device.onCommand(command(3, {}, [{ tag: 200, fmt: 'u8', value: 1 }]));
  assertEquals([last().values.ackStatus, last().values.rejectedTag], [Ack.UnknownTag, 200]);
  device.onCommand(command(4, { resetCounters: RESET_MAGIC, get: 1 }));
  assertEquals([last().values.ackStatus, last().values.runSeconds], [Ack.Ok, 0]);
});

Deno.test('a retried command seq replays the same ACK and does not run twice', () => {
  const { device, sent } = makeDevice();
  device.powerOn();
  device.onCommand(command(5, { setRunSeconds: 3600, get: 1 }));
  device.onCommand(command(5, { setRunSeconds: 7200, get: 1 }));
  const acks = sent.filter((s) => s.msg.msgType === MSG.ACK).map((s) => s.msg);
  assertEquals(acks.length, 2);
  assertEquals(acks[1], acks[0]);
  assertEquals(acks[1].values.runSeconds, 3600);
});

Deno.test('setTime fixes an invalid clock; without RTC the time is flagged not backed up', () => {
  const { device, last } = makeDevice({ fitted: Device.eeprom | Device.imu | Device.mag });
  device.powerOn();
  assert(Number(last().values.statusFlags) & Flag.timeInvalid);
  device.onCommand(command(1, { setTime: 1791376496, get: 3 }));
  assertEquals(last().values.timeValid, true);
  assertEquals(Number(last().values.statusFlags) & Flag.timeNotBackedUp, Flag.timeNotBackedUp);
  assertEquals(last().timestamp, 1791376496);
});

Deno.test('RTC without battery: rtcBatteryLost and timeInvalid at power-on, header timestamp is uptime', () => {
  const { device, last, run, lastOf } = makeDevice({ rtcBattery: false });
  device.powerOn();
  const flags = Number(last().values.statusFlags);
  assertEquals(flags & (Flag.rtcBatteryLost | Flag.timeInvalid), Flag.rtcBatteryLost | Flag.timeInvalid);
  run(3000);
  assertEquals(lastOf(MSG.TELEMETRY)?.timestamp, 3);
});

Deno.test('presets without EEPROM answer DeviceMissing', () => {
  const { device, last } = makeDevice({ fitted: Device.rtc | Device.imu | Device.mag });
  device.powerOn();
  device.onCommand(command(1, { setRunSeconds: 10 }));
  assertEquals([last().values.ackStatus, last().values.rejectedTag], [Ack.DeviceMissing, 102]);
});

Deno.test('reboot: ACK first, then a boot EVENT with resetReason 3 and seq restarting at 0', () => {
  const { device, run, last, sent } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { reboot: 1 }));
  assertEquals(last().msgType, MSG.ACK);
  run(100);
  const boot = sent.filter((s) => s.msg.msgType === MSG.EVENT).map((s) => s.msg)[1];
  assertEquals([boot.values.resetReason, boot.seq], [ResetReason.software, 0]);
});

Deno.test('IMU calibration: calibrating flag, then EVENT kind 2 with the calibration values', () => {
  const { device, run, last, lastOf } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { calibrate: 1 }));
  assertEquals(last().values.ackStatus, Ack.Ok);
  device.onCommand(command(2, { calibrate: 1 }));
  assertEquals(last().values.ackStatus, Ack.Busy);
  run(5200); // 512 samples at 100 Hz
  const event = lastOf(MSG.EVENT);
  assert(event);
  assertEquals([event.values.eventKind, event.values.calibResult, event.values.calFlags], [2, 0, 1]);
  assertEquals(tagsOf(event).length, 3 + 19);
});

Deno.test('unplugged IMU is lost after 3 presence checks: EVENT kind 3, no IMU records in TELEMETRY', () => {
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  run(100);
  device.setFitted(Device.imu, false);
  run(6100);
  const event = lastOf(MSG.EVENT);
  assert(event);
  assertEquals(event.values.eventKind, 3);
  assertEquals(event.values.devices, Device.eeprom | Device.rtc);
  run(1000);
  assertEquals(tagsOf(lastOf(MSG.TELEMETRY) as never), [1, 2, 3, 4, 5, 50, 53]);
});

Deno.test('a replugged IMU brings its magnetometer back: EVENT kind 3 with all modules', () => {
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  device.setFitted(Device.imu, false);
  run(6100);
  device.setFitted(Device.imu, true);
  run(2100);
  assertEquals(lastOf(MSG.EVENT)?.values.devices, Device.eeprom | Device.rtc | Device.imu | Device.mag);
});

Deno.test('Bluetooth session: Locked until unlock, BadPin on a wrong PIN, live data after unlock', () => {
  const { device, last } = makeDevice({ bluetoothSession: true, btPin: 4821 });
  device.powerOn();
  assertEquals(device.liveDataAllowed(), false);
  device.onCommand(command(1, { get: 1 }));
  assertEquals([last().values.ackStatus, last().values.rejectedTag], [Ack.Locked, 107]);
  device.onCommand(command(2, { unlock: 1111 }));
  assertEquals(last().values.ackStatus, Ack.BadPin);
  device.onCommand(command(3, { unlock: 4821, get: 3 }));
  assertEquals([last().values.ackStatus, last().values.btState], [Ack.Ok, 3]);
  assertEquals(device.liveDataAllowed(), true);
  device.clientConnected();
  assertEquals(device.liveDataAllowed(), false);
});

Deno.test('output=uart stops periodic data on the simulated USB port', () => {
  const { device } = makeDevice();
  device.powerOn();
  assertEquals(device.liveDataAllowed(), true);
  device.onCommand(command(1, { output: 2 }));
  assertEquals(device.liveDataAllowed(), false);
});
