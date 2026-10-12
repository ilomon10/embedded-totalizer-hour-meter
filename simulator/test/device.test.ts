// device.test.ts: the simulated device follows the firmware's rules
// (Application.cpp, CommandHandler.cpp, Telemetry.cpp). Time is a FakeClock.
import { assert, assertEquals } from './assert.ts';
import { ResetReason } from '../src/device.ts';
import { Ack, Device, Flag, MSG, RESET_MAGIC } from '../src/protocol.ts';
import { parseScenario } from '../src/scenarios.ts';
import { command, makeDevice, tagsOf } from './helpers.ts';

const BOOT_TAGS = [8, 1, 2, 3, 10, 4, 5, 6, 7, 50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 62, 63, 241, 54];
const TELEMETRY_TAGS = [1, 2, 3, 10, 4, 5, 50, 53, 40, 41, 42, 43, 44];

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
  assertEquals(tagsOf(last()), [242, 243, 1, 2, 3, 10, 4, 5, 6, 7]);
  assertEquals(last().values.ackSeq, 7);
  device.onCommand(command(8, { get: 2 }));
  assertEquals(last().records.length, 2 + 20);
  assertEquals(last().values.btPin, 1234);
  device.onCommand(command(9, { get: 3 }));
  assertEquals(tagsOf(last()).slice(2), [50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 62, 63, 241, 54]);
  device.onCommand(command(10, { get: 4 }));
  assertEquals(last().records.length, 2 + 19);
});

Deno.test('get=1..4 in one command: the last group is cut at 250 bytes, like the firmware', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(11, { get: 1 }, [2, 3, 4].map((v) => ({ tag: 101, fmt: 'u8', value: v }))));
  assertEquals(last().values.ackStatus, Ack.Ok);
  const tags = tagsOf(last());
  assert(tags.includes(54) && tags.includes(129), 'get=1..3 complete');
  assertEquals(tags.filter((t) => t >= 130 && t <= 148).length, 7); // 21 + 42 + 82 + 55 = 200; 50 bytes left = 7 f32 records of get=4
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
  assertEquals([boot.values.lastCause, boot.values.lastStage], [5, 8]);
});

Deno.test('panic signal: restarts at once with lastCause 4, keeps the counters, Bluetooth ignores it', () => {
  const { device, run, sent } = makeDevice();
  device.powerOn();
  run(5000);
  const before = device.hourMeter().runSeconds;
  device.panicSignal();
  const boots = sent.filter((s) => s.msg.msgType === MSG.EVENT).map((s) => s.msg);
  assertEquals(boots.length, 2);
  const v = boots[1].values;
  assertEquals([v.resetReason, v.lastCause, v.lastStage, boots[1].seq], [3, 4, 8, 0]);
  assertEquals(v.runSeconds, before);
  const bt = makeDevice({ bluetoothSession: true });
  bt.device.powerOn();
  bt.device.panicSignal();
  assertEquals(bt.sent.filter((s) => s.msg.msgType === MSG.EVENT).length, 1);
});

Deno.test('hang: silent and deaf until a restart', () => {
  const { device, run, sent } = makeDevice();
  device.powerOn();
  device.hang();
  const n = sent.length;
  run(3000);
  device.onCommand(command(1, { get: 3 }));
  assertEquals(sent.length, n);
  device.panicSignal();
  assertEquals(sent.length, n + 1);
});

Deno.test('safe mode: no modules, safeMode flag, no IMU stream; a power cycle or the panic signal leaves it', () => {
  const { device, run, sent } = makeDevice({
    safeMode: true,
    firstBoot: { reason: ResetReason.taskWatchdog, cause: 1, stage: 7 },
  });
  device.powerOn();
  run(3000);
  const boot = sent[0].msg.values;
  assertEquals([boot.devices, boot.lastCause, boot.lastStage], [0, 1, 7]);
  assertEquals((Number(boot.statusFlags) >>> 18) & 1, 1);
  assertEquals(sent.some((s) => s.msg.msgType === MSG.IMU), false);
  assertEquals(device.hourMeter().runSeconds > 0, true);
  device.powerOn();
  assertEquals(sent.filter((s) => s.msg.msgType === MSG.EVENT).pop()?.msg.values.devices, 15);

  const second = makeDevice({ safeMode: true, firstBoot: { reason: ResetReason.taskWatchdog, cause: 1, stage: 7 } });
  second.device.powerOn();
  second.device.panicSignal(); // a restart someone asked for clears the restart count, like the firmware
  const after = second.sent.filter((s) => s.msg.msgType === MSG.EVENT).pop()?.msg.values;
  assertEquals([after?.devices, after?.lastCause, (Number(after?.statusFlags) >>> 18) & 1], [15, 4, 0]);
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
  assertEquals(tagsOf(lastOf(MSG.TELEMETRY) as never), [1, 2, 3, 10, 4, 5, 50, 53]);
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

Deno.test('settings ACK lists runVibMinMg (129), default 0, validated 0..2000', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { get: 2 }));
  assertEquals(last().values.runVibMinMg, 0);
  assertEquals(tagsOf(last()).at(-1), 129);
  device.onCommand(command(2, { runVibMinMg: 2001 }));
  assertEquals(last().values.ackStatus, Ack.InvalidValue);
  assertEquals(last().values.rejectedTag, 129);
  device.onCommand(command(3, { runVibMinMg: 30 }));
  assertEquals(last().values.ackStatus, Ack.Ok);
  device.onCommand(command(4, { get: 2 }));
  assertEquals(last().values.runVibMinMg, 30);
});

/** acc-wire: run seconds after 3 cycles of 120 s, and TELEMETRY (altInput, alternator) in the off phase. */
function accWire(runVibMinMg: number) {
  const { device, run, lastOf, clock } = makeDevice({ runSeconds: 0, random: () => 0.5 });
  const scenario = parseScenario('acc-wire', () => 0.5);
  device.powerOn();
  if (runVibMinMg) device.onCommand(command(1, { runVibMinMg }));
  const samples: { t: number; altInput: unknown; alternator: unknown }[] = [];
  for (let ms = 0; ms < 360_000; ms += 10) {
    scenario.tick!(clock.nowMs(), device);
    run(10);
    if (ms % 10_000 === 5_000) {
      const t = lastOf(MSG.TELEMETRY)!;
      samples.push({ t: ms / 1000, altInput: t.values.altInput, alternator: t.values.alternator });
    }
  }
  return { runSeconds: device.hourMeter().runSeconds, samples };
}

Deno.test('acc-wire without runVibMinMg: run hours grow the whole time the key is on (the bug)', () => {
  const r = accWire(0);
  assert(r.runSeconds >= 355 && r.runSeconds <= 360, `runSeconds ${r.runSeconds}`);
  assert(r.samples.every((s) => s.alternator === true && s.altInput === true));
});

Deno.test('acc-wire with runVibMinMg=30: run hours grow only while the engine runs', () => {
  const r = accWire(30);
  // 3 cycles x 60 s of engine, minus the first vibration window; confirmation lags by one telemetry-free poll.
  assert(r.runSeconds >= 175 && r.runSeconds <= 182, `runSeconds ${r.runSeconds}`);
  const off = r.samples.filter((s) => s.t % 120 < 15 || s.t % 120 > 85);
  assert(off.length > 0 && off.every((s) => s.altInput === true && s.alternator === false));
  const on = r.samples.filter((s) => s.t % 120 > 25 && s.t % 120 < 75);
  assert(on.every((s) => s.alternator === true));
  console.log(`acc-wire: without ${accWire(0).runSeconds} s, with runVibMinMg=30 ${r.runSeconds} s of 360 s`);
});
