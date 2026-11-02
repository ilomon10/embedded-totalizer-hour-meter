// device.test.ts: the simulated device follows the firmware's rules
// (Application.cpp, CommandHandler.cpp, Telemetry.cpp). Time is a FakeClock.
import { test } from 'bun:test';

import { assert, assertEquals } from './assert.ts';
import { type DeviceOptions, ResetReason } from '../src/device.ts';
import { Ack, Device, Flag, MSG, RESET_MAGIC } from '../src/protocol.ts';
import { parseScenario } from '../src/scenarios.ts';
import { command, makeDevice, tagsOf } from './helpers.ts';

const BOOT_TAGS = [8, 1, 2, 3, 10, 4, 5, 6, 7, 50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 62, 63, 241, 54];
const PARKED_BOOT_TAGS = [...BOOT_TAGS.slice(0, -1), 64]; // no RTC temperature (nothing was read), i2cLines last
const TELEMETRY_TAGS = [1, 2, 3, 10, 4, 5, 50, 53, 40, 41, 42, 43, 44];
const ALL_MODULES = Device.eeprom | Device.rtc | Device.imu | Device.mag;
const MODULES_MISSING = Flag.eepromMissing | Flag.rtcMissing | Flag.imuMissing | Flag.magMissing;

test('power-on sends the boot EVENT with the firmware record order', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  assertEquals(last().msgType, MSG.EVENT);
  assertEquals(tagsOf(last()), BOOT_TAGS);
  assertEquals(last().values.resetReason, ResetReason.powerOn);
  assertEquals(last().values.runHours, 1250);
  assertEquals(last().seq, 0);
});

test('TELEMETRY every second, with IMU and vibration records after the first window', () => {
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  run(1000);
  const t = lastOf(MSG.TELEMETRY);
  assert(t);
  assertEquals(tagsOf(t), TELEMETRY_TAGS);
  assertEquals(t.timestamp, t.values.epoch ?? 1791376497); // valid time: header timestamp is UTC
});

test('IMU stream at imuStreamHz in filtered mode (default)', () => {
  const { device, run, sent } = makeDevice();
  device.powerOn();
  run(1000);
  const imu = sent.filter((s) => s.msg.msgType === MSG.IMU);
  assertEquals(imu.length, 10);
  assertEquals(tagsOf(imu[0].msg), [30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 41, 42]);
});

test('get=1..4 answers with the requested data in one ACK', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(7, { get: 1 }));
  assertEquals(tagsOf(last()), [242, 243, 1, 2, 3, 10, 4, 5, 6, 7]);
  assertEquals(last().values.ackSeq, 7);
  device.onCommand(command(8, { get: 2 }));
  assertEquals(last().records.length, 2 + 22);
  assertEquals(last().values.btPin, 1234);
  assertEquals(tagsOf(last()).slice(-3), [129, 150, 151]);
  device.onCommand(command(9, { get: 3 }));
  assertEquals(tagsOf(last()).slice(2), [50, 53, 51, 52, 55, 56, 57, 58, 60, 61, 62, 63, 241, 54]);
  device.onCommand(command(10, { get: 4 }));
  assertEquals(last().records.length, 2 + 19);
});

test('get=1..4 in one command: the last group is cut at 250 bytes, like the firmware', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(
    command(
      11,
      { get: 1 },
      [2, 3, 4].map((v) => ({ tag: 101, fmt: 'u8', value: v })),
    ),
  );
  assertEquals(last().values.ackStatus, Ack.Ok);
  const tags = tagsOf(last());
  assert(tags.includes(54) && tags.includes(151), 'get=1..3 complete');
  assertEquals(tags.filter((t) => t >= 130 && t <= 148).length, 6); // 21 + 42 + 88 + 61 = 212; 38 bytes left = 6 f32 records of get=4
});

test('settings are all-or-nothing: one bad value rejects the whole command', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { telemetryIntervalMs: 500, imuSampleHz: 5 }));
  assertEquals(last().values.ackStatus, Ack.InvalidValue);
  assertEquals(last().values.rejectedTag, 111);
  device.onCommand(command(2, { get: 2 }));
  assertEquals(last().values.telemetryIntervalMs, 1000);
});

test('cross-field check: imuStreamHz above imuSampleHz is rejected on tag 112', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { imuSampleHz: 20, imuStreamHz: 50 }));
  assertEquals([last().values.ackStatus, last().values.rejectedTag], [Ack.InvalidValue, 112]);
});

test('uartBaud accepts standard rates only', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { uartBaud: 100000 }));
  assertEquals(last().values.ackStatus, Ack.InvalidValue);
  device.onCommand(command(2, { uartBaud: 9600 }));
  assertEquals(last().values.ackStatus, Ack.Ok);
});

test('action checks: setTime range, reset magic, unknown tag', () => {
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

test('a retried command seq replays the same ACK and does not run twice', () => {
  const { device, sent } = makeDevice();
  device.powerOn();
  device.onCommand(command(5, { setRunSeconds: 3600, get: 1 }));
  device.onCommand(command(5, { setRunSeconds: 7200, get: 1 }));
  const acks = sent.filter((s) => s.msg.msgType === MSG.ACK).map((s) => s.msg);
  assertEquals(acks.length, 2);
  assertEquals(acks[1], acks[0]);
  assertEquals(acks[1].values.runSeconds, 3600);
});

test('setTime fixes an invalid clock; without RTC the time is flagged not backed up', () => {
  const { device, last } = makeDevice({ fitted: Device.eeprom | Device.imu | Device.mag });
  device.powerOn();
  assert(Number(last().values.statusFlags) & Flag.timeInvalid);
  device.onCommand(command(1, { setTime: 1791376496, get: 3 }));
  assertEquals(last().values.timeValid, true);
  assertEquals(Number(last().values.statusFlags) & Flag.timeNotBackedUp, Flag.timeNotBackedUp);
  assertEquals(last().timestamp, 1791376496);
});

test('RTC without battery: rtcBatteryLost and timeInvalid at power-on, header timestamp is uptime', () => {
  const { device, last, run, lastOf } = makeDevice({ rtcBattery: false });
  device.powerOn();
  const flags = Number(last().values.statusFlags);
  assertEquals(flags & (Flag.rtcBatteryLost | Flag.timeInvalid), Flag.rtcBatteryLost | Flag.timeInvalid);
  run(3000);
  assertEquals(lastOf(MSG.TELEMETRY)?.timestamp, 3);
});

test('without an EEPROM the flash keeps the counters (2.6.0); with neither store presets answer DeviceMissing', () => {
  const noEeprom = { fitted: Device.rtc | Device.imu | Device.mag };
  const { device, last } = makeDevice(noEeprom);
  device.powerOn();
  assertEquals(last().values.runHours, 1250); // from the flash copy
  assertEquals(last().values.settingsSource, 3);
  device.onCommand(command(1, { setRunSeconds: 36000, get: 3 }));
  assertEquals(last().values.ackStatus, Ack.Ok);
  const flags = Number(last().values.statusFlags);
  assertEquals([flags & Flag.eepromMissing, flags & Flag.settingsNotSaved], [Flag.eepromMissing, 0]);
  device.powerOn(); // power cycle: the preset survives in the flash
  assertEquals(last().values.runSeconds, 36000);

  const old = makeDevice({ ...noEeprom, flashStore: false }); // an old partition table and no EEPROM
  old.device.powerOn();
  const bootFlags = Number(old.last().values.statusFlags);
  assertEquals(bootFlags & Flag.flashStoreMissing, Flag.flashStoreMissing);
  assertEquals(bootFlags & Flag.journalEmpty, Flag.journalEmpty);
  old.device.onCommand(command(1, { setRunSeconds: 10 }));
  assertEquals([old.last().values.ackStatus, old.last().values.rejectedTag], [Ack.DeviceMissing, 102]);
});

test('every save goes to flash and EEPROM; a returning EEPROM is brought up to date, not added', () => {
  const { device, run, last } = makeDevice({ fitted: Device.rtc | Device.imu | Device.mag });
  device.powerOn();
  device.onCommand(command(1, { setRunSeconds: 7200 })); // saved in the flash only
  device.setFitted(Device.eeprom, true); // the EEPROM (1250 h, an older save) answers again
  run(2100); // next presence check
  device.onCommand(command(2, { get: 1 }));
  const afterReturn = Number(last().values.runSeconds);
  assert(afterReturn >= 7200 && afterReturn < 7300, `${afterReturn}`); // the engine runs; 1250 h were NOT added
  device.setFitted(Device.eeprom, false);
  run(6100); // lost after 3 missed checks
  device.powerOn(); // and the flash still has it
  device.onCommand(command(3, { get: 1 }));
  const afterPowerCycle = Number(last().values.runSeconds);
  assert(afterPowerCycle >= 7200 && afterPowerCycle < 7300, `${afterPowerCycle}`);
});

test('first boot after the update: the EEPROM moves into the flash; a late EEPROM adds to counts from zero', () => {
  const noEeprom = Device.rtc | Device.imu | Device.mag;
  const moved = makeDevice({ freshFlash: true });
  moved.device.powerOn();
  assertEquals(moved.last().values.runHours, 1250); // from the EEPROM
  moved.device.setFitted(Device.eeprom, false);
  moved.run(6100);
  moved.device.powerOn(); // the EEPROM is gone: the flash carries on
  moved.device.onCommand(command(1, { get: 1 }));
  assert(Number(moved.last().values.runSeconds) >= 1250 * 3600);

  const late = makeDevice({ freshFlash: true, fitted: noEeprom }); // the EEPROM did not answer at that boot
  late.device.powerOn();
  assertEquals(Number(late.last().values.statusFlags) & Flag.journalEmpty, Flag.journalEmpty); // counting from 0
  late.run(3000);
  late.device.setFitted(Device.eeprom, true); // it answers now
  late.run(2100);
  late.device.onCommand(command(2, { get: 1 }));
  const total = Number(late.last().values.runSeconds);
  assert(total >= 1250 * 3600 && total < 1250 * 3600 + 60, `${total}`); // its 1250 h added to what was counted
  late.device.setFitted(Device.eeprom, false);
  late.run(6100);
  late.device.setFitted(Device.eeprom, true); // contact lost and back: its record is the device's own now
  late.run(2100);
  late.device.onCommand(command(3, { get: 1 }));
  assert(Number(late.last().values.runSeconds) < 1250 * 3600 + 120, 'added only once');
});

test('reboot: ACK first, then a boot EVENT with resetReason 3 and seq restarting at 0', () => {
  const { device, run, last, sent } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { reboot: 1 }));
  assertEquals(last().msgType, MSG.ACK);
  run(100);
  const boot = sent.filter((s) => s.msg.msgType === MSG.EVENT).map((s) => s.msg)[1];
  assertEquals([boot.values.resetReason, boot.seq], [ResetReason.software, 0]);
  assertEquals([boot.values.lastCause, boot.values.lastStage], [5, 8]);
});

test('panic signal: restarts at once with lastCause 4, keeps the counters, Bluetooth ignores it', () => {
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

test('hang: silent and deaf until a restart', () => {
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

test('safe mode: no modules, safeMode flag, no IMU stream; a power cycle or the panic signal leaves it', () => {
  const { device, run, sent } = makeDevice({
    safeMode: true,
    firstBoot: { reason: ResetReason.taskWatchdog, cause: 1, stage: 7 },
  });
  device.powerOn();
  run(3000);
  const boot = sent[0].msg.values;
  assertEquals([boot.devices, boot.lastCause, boot.lastStage], [0, 1, 7]);
  assertEquals((Number(boot.statusFlags) >>> 18) & 1, 1);
  assertEquals(
    sent.some((s) => s.msg.msgType === MSG.IMU),
    false,
  );
  assertEquals(device.hourMeter().runSeconds > 0, true);
  device.powerOn();
  assertEquals(sent.filter((s) => s.msg.msgType === MSG.EVENT).pop()?.msg.values.devices, 15);

  const second = makeDevice({ safeMode: true, firstBoot: { reason: ResetReason.taskWatchdog, cause: 1, stage: 7 } });
  second.device.powerOn();
  second.device.panicSignal(); // a restart someone asked for clears the restart count, like the firmware
  const after = second.sent.filter((s) => s.msg.msgType === MSG.EVENT).pop()?.msg.values;
  assertEquals([after?.devices, after?.lastCause, (Number(after?.statusFlags) >>> 18) & 1], [15, 4, 0]);
});

test('IMU calibration: calibrating flag, then EVENT kind 2 with the calibration values', () => {
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

test('unplugged IMU is lost after 3 presence checks: EVENT kind 3, no IMU records in TELEMETRY', () => {
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

test('a replugged IMU brings its magnetometer back: EVENT kind 3 with all modules', () => {
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  device.setFitted(Device.imu, false);
  run(6100);
  device.setFitted(Device.imu, true);
  run(2100);
  assertEquals(lastOf(MSG.EVENT)?.values.devices, Device.eeprom | Device.rtc | Device.imu | Device.mag);
});

test('Bluetooth session: Locked until unlock, BadPin on a wrong PIN, live data after unlock', () => {
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

test('output=uart stops periodic data on the simulated USB port', () => {
  const { device } = makeDevice();
  device.powerOn();
  assertEquals(device.liveDataAllowed(), true);
  device.onCommand(command(1, { output: 2 }));
  assertEquals(device.liveDataAllowed(), false);
});

test('settings ACK lists runVibMinMg (129), default 0, validated 0..2000', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { get: 2 }));
  assertEquals(last().values.runVibMinMg, 0);
  assertEquals(tagsOf(last()).at(-3), 129); // then i2c (150) and pulseInput (151)
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

test('acc-wire without runVibMinMg: run hours grow the whole time the key is on (the bug)', () => {
  const r = accWire(0);
  assert(r.runSeconds >= 355 && r.runSeconds <= 360, `runSeconds ${r.runSeconds}`);
  assert(r.samples.every((s) => s.alternator === true && s.altInput === true));
});

test('acc-wire with runVibMinMg=30: run hours grow only while the engine runs', () => {
  const r = accWire(30);
  // 3 cycles x 60 s of engine, minus the first vibration window; confirmation lags by one telemetry-free poll.
  assert(r.runSeconds >= 175 && r.runSeconds <= 182, `runSeconds ${r.runSeconds}`);
  const off = r.samples.filter((s) => s.t % 120 < 15 || s.t % 120 > 85);
  assert(off.length > 0 && off.every((s) => s.altInput === true && s.alternator === false));
  const on = r.samples.filter((s) => s.t % 120 > 25 && s.t % 120 < 75);
  assert(on.every((s) => s.alternator === true));
  console.log(`acc-wire: without ${accWire(0).runSeconds} s, with runVibMinMg=30 ${r.runSeconds} s of 360 s`);
});

test('settings ACK ends with i2c (150) and pulseInput (151): bool records, both on by default, only 0 or 1 accepted', () => {
  const { device, last } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { get: 2 }));
  assertEquals(
    last()
      .records.slice(-2)
      .map((r) => [r.tag, r.fmt, r.value]),
    [
      [150, 'bool', true],
      [151, 'bool', true],
    ],
  );
  device.onCommand(command(2, {}, [{ tag: 150, fmt: 'u8', value: 2 }]));
  assertEquals([last().values.ackStatus, last().values.rejectedTag], [Ack.InvalidValue, 150]);
  device.onCommand(command(3, { i2c: true, pulseInput: false, get: 2 }));
  assertEquals([last().values.ackStatus, last().values.i2c, last().values.pulseInput], [Ack.Ok, true, false]);
});

test('i2c=false: the bus is released and every module dropped (flag i2cOff, not i2cParked); i2c=true starts it again', () => {
  const { device, run, sent, last, lastOf } = makeDevice();
  device.powerOn();
  run(100);
  device.onCommand(command(1, { i2c: false, get: 3 }));
  const ack = last();
  assertEquals(ack.msgType, MSG.ACK);
  assertEquals(ack.values.devices, 0); // the ACK already reports the new state
  const flags = Number(ack.values.statusFlags);
  assertEquals(flags & (MODULES_MISSING | Flag.i2cOff | Flag.i2cParked), MODULES_MISSING | Flag.i2cOff);
  assertEquals(flags & Flag.timeNotBackedUp, Flag.timeNotBackedUp); // the RTC is gone, the time stays in RAM
  assertEquals(ack.values.timeValid, true);
  assertEquals(tagsOf(ack).includes(64), false); // i2cLines only while parked
  run(10);
  const dropped = lastOf(MSG.EVENT);
  assertEquals([dropped?.values.eventKind, dropped?.values.devices], [3, 0]);
  assert(sent.findIndex((s) => s.msg === ack) < sent.findIndex((s) => s.msg === dropped), 'EVENT after the ACK');

  const n = sent.length;
  const runSeconds = device.hourMeter().runSeconds;
  run(5000); // no presence checks, no IMU, but the hour meter counts
  assertEquals(
    sent.slice(n).some((s) => s.msg.msgType === MSG.IMU || s.msg.msgType === MSG.EVENT),
    false,
  );
  assert(device.hourMeter().runSeconds >= runSeconds + 4);

  device.powerOn(); // an i2c=false unit boots with no I2C at all
  const boot = lastOf(MSG.EVENT)!;
  assertEquals(tagsOf(boot), BOOT_TAGS.slice(0, -1)); // nothing read the RTC (no 54), the bus is not parked (no 64)
  assertEquals(boot.values.devices, 0);
  assertEquals(
    Number(boot.values.statusFlags) & (MODULES_MISSING | Flag.i2cOff | Flag.i2cParked | Flag.timeInvalid),
    MODULES_MISSING | Flag.i2cOff | Flag.timeInvalid,
  ); // nothing read the RTC
  assertEquals(boot.values.timeValid, false);

  device.onCommand(command(2, { i2c: true }));
  run(10);
  const back = lastOf(MSG.EVENT)!;
  assertEquals([back.values.eventKind, back.values.devices], [3, ALL_MODULES]);
  assertEquals(Number(back.values.statusFlags) & (MODULES_MISSING | Flag.i2cOff | Flag.i2cParked), 0);
  assertEquals(tagsOf(back).slice(-2), [241, 54]);
  assertEquals(back.values.timeValid, true); // the RTC keeps the time
});

test('pulseInput=false: the totalizer stops and drops the pulses it had not counted yet; the hour meter goes on', () => {
  const { device, run } = makeDevice({ runSeconds: 0, totalCount: 0, pulsesPerSecond: 2.5 });
  device.powerOn();
  run(4000);
  const counted = device.hourMeter().totalCount;
  assert(counted >= 9 && counted <= 10, `${counted}`);
  device.onCommand(command(1, { pulseInput: false }));
  run(4000);
  assertEquals(device.hourMeter().totalCount, counted);
  assert(device.hourMeter().runSeconds >= 7, 'the engine is still counted');
  device.onCommand(command(2, { pulseInput: true }));
  run(4000);
  assert(device.hourMeter().totalCount >= counted + 9, 'counting again');

  const slow = makeDevice({ totalCount: 0, pulsesPerSecond: 0.5 });
  slow.device.powerOn();
  slow.run(1500); // 0.75 of a pulse is on its way
  slow.device.onCommand(command(1, { pulseInput: false }));
  slow.run(10);
  slow.device.onCommand(command(2, { pulseInput: true }));
  slow.run(600);
  assertEquals(slow.device.hourMeter().totalCount, 0); // 0.3 pulse since: the 0.75 was dropped, not kept
});

/** A device set up by a scenario's configure(), as main.ts does before power-on. */
function scenarioDevice(spec: string, options: Partial<DeviceOptions> = {}) {
  const scenario = parseScenario(spec, () => 0.5);
  const configured: Partial<DeviceOptions> = { ...options };
  scenario.configure?.(configured as DeviceOptions);
  return { scenario, ...makeDevice(configured) };
}

test('i2c-parked: parked at boot with SDA low (devices 0, flag 20, i2cLines 1), the hour meter still counts', () => {
  const { device, run, sent, lastOf } = scenarioDevice('i2c-parked');
  device.powerOn();
  const boot = sent[0].msg;
  assertEquals(boot.msgType, MSG.EVENT);
  assertEquals(tagsOf(boot), PARKED_BOOT_TAGS);
  assertEquals([boot.values.devices, boot.values.i2cLines, boot.values.lastCause], [0, 1, 0]);
  const flags = Number(boot.values.statusFlags);
  assertEquals(
    flags & (MODULES_MISSING | Flag.i2cParked | Flag.i2cOff | Flag.safeMode | Flag.timeInvalid),
    MODULES_MISSING | Flag.i2cParked | Flag.timeInvalid,
  ); // the RTC was never read
  const runSeconds = device.hourMeter().runSeconds;
  run(5000);
  assert(device.hourMeter().runSeconds >= runSeconds + 4);
  assertEquals(tagsOf(lastOf(MSG.TELEMETRY)!), [1, 2, 3, 10, 4, 5, 50, 53]); // no IMU records
  assertEquals(Number(lastOf(MSG.TELEMETRY)!.values.statusFlags) & Flag.i2cParked, Flag.i2cParked);
  assertEquals(
    sent.some((s) => s.msg.msgType === MSG.IMU),
    false,
  );
  device.onCommand(command(1, { get: 3 })); // the same block in get=3
  assertEquals(tagsOf(lastOf(MSG.ACK)!).slice(-2), [241, 64]);
});

test('a held SDA line: the bus is tried again after 10 s, 20 s, 40 s ... and resumes at the first retry after the release', () => {
  /** Seconds after boot at which the modules are back, with SDA released at `releaseAtS`. */
  function recoveredAtS(releaseAtS: number): number {
    const { device, run } = makeDevice({ busFault: { sdaLow: true } });
    device.powerOn();
    run(releaseAtS * 1000);
    device.setBusFault({ sdaLow: false });
    for (let ms = releaseAtS * 1000; ms < 400_000; ms += 10) {
      run(10);
      if (device.status().devices !== 0) return ms / 1000;
    }
    throw new Error(`no recovery after releasing SDA at ${releaseAtS} s`);
  }
  // retries at 10, 30, 70, 150, 310 s: the pause doubles while the line is still held
  assertEquals([5, 15, 35, 75, 155].map(recoveredAtS), [10, 30, 70, 150, 310]);
});

test('i2c-parked=65: released by the scenario; the modules come back with EVENT kind 3, flag 20 and tag 64 gone', () => {
  const { scenario, device, clock, run, sent, lastOf } = scenarioDevice('i2c-parked=65');
  device.powerOn();
  const runSeconds = device.hourMeter().runSeconds;
  for (let ms = 0; ms < 69_900; ms += 10) {
    scenario.tick!(clock.nowMs(), device);
    run(10);
  }
  assertEquals([device.status().devices, device.snapshot().busFault.sdaLow], [0, false]); // let go, but not retried yet
  assertEquals(Number(device.status().flags) & Flag.i2cParked, Flag.i2cParked);
  for (let ms = 0; ms < 200; ms += 10) {
    scenario.tick!(clock.nowMs(), device);
    run(10); // the retry at 70 s, the presence check one poll later
  }
  const back = lastOf(MSG.EVENT)!;
  assertEquals([back.values.eventKind, back.values.devices], [3, ALL_MODULES]);
  assertEquals(Number(back.values.statusFlags) & (Flag.i2cParked | MODULES_MISSING | Flag.timeInvalid), 0);
  assertEquals(tagsOf(back).slice(-2), [241, 54]);
  assertEquals(back.values.timeValid, true); // the RTC was read at last
  assertEquals(back.timestamp, back.values.epoch);
  run(2000);
  assert(sent.some((s) => s.msg.msgType === MSG.IMU));
  assert(device.hourMeter().runSeconds >= runSeconds + 70);
});

test('a line held low while running parks the bus at once: EVENT kind 3 with devices 0 and i2cLines, nothing is lost', () => {
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  run(3000);
  const before = device.hourMeter().runSeconds;
  device.setBusFault({ sdaLow: true, sclLow: true });
  run(10);
  const parked = lastOf(MSG.EVENT)!;
  assertEquals([parked.values.eventKind, parked.values.devices, parked.values.i2cLines], [3, 0, 3]);
  assertEquals(tagsOf(parked).slice(-2), [241, 64]); // the RTC temperature goes with the RTC
  const flags = Number(parked.values.statusFlags);
  assertEquals(
    flags & (MODULES_MISSING | Flag.i2cParked | Flag.timeNotBackedUp | Flag.safeMode),
    MODULES_MISSING | Flag.i2cParked | Flag.timeNotBackedUp, // the time stays in RAM
  );
  assertEquals(parked.values.lastCause, 0); // never a restart

  device.setBusFault({ sdaLow: false }); // SCL is still held: the first retry (10 s) keeps it parked, 20 s more
  run(10_000);
  assertEquals(device.status().i2cLines, 2);
  device.setBusFault({ sclLow: false });
  run(19_900);
  assertEquals(device.status().devices, 0);
  run(200);
  const back = lastOf(MSG.EVENT)!;
  assertEquals([back.values.eventKind, back.values.devices], [3, ALL_MODULES]);
  assertEquals(Number(back.values.statusFlags) & (Flag.i2cParked | Flag.timeNotBackedUp), 0); // the RTC has the time again
  const after = device.hourMeter().runSeconds;
  assert(after >= before + 30 && after < before + 40, `${before} -> ${after}`); // counted all along, nothing added twice
});

test('transfers that time out park the bus after 5 s with both lines free (i2cLines 0); the pause doubles on a quick relapse', () => {
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  run(1000);
  const parkedFlag = () => Number(device.status().flags) & Flag.i2cParked;
  device.setBusFault({ timeouts: true });
  run(4900);
  assertEquals([parkedFlag(), device.status().devices], [0, ALL_MODULES]); // two missed checks so far
  run(200);
  assertEquals(parkedFlag(), Flag.i2cParked);
  const event = lastOf(MSG.EVENT)!;
  assertEquals([event.values.eventKind, event.values.devices, event.values.i2cLines], [3, 0, 0]);
  assertEquals(tagsOf(event).at(-1), 64); // reported although it is 0

  run(10_000); // the retry finds both lines free: the bus is in use again, and failing
  assertEquals(parkedFlag(), 0);
  run(5100); // another 5 s of failures: parked again, now for 20 s
  assertEquals(parkedFlag(), Flag.i2cParked);
  device.setBusFault({ timeouts: false });
  run(19_800);
  assertEquals(parkedFlag(), Flag.i2cParked);
  run(300);
  assertEquals([parkedFlag(), device.status().devices], [0, ALL_MODULES]);
});

test('the pause starts again at 10 s only after the bus has worked for 10 minutes', () => {
  const { device, run } = makeDevice({ busFault: { sdaLow: true } });
  device.powerOn();
  device.setBusFault({ sdaLow: false });
  run(10_100); // the retry at 10 s finds it free, the presence check one poll later
  assertEquals(device.status().devices, ALL_MODULES);
  /** The bus fails and the line is let go at once: the pause until the retry, in ms. */
  function pauseAfterRelapse(): number {
    device.setBusFault({ sdaLow: true });
    run(10); // parked
    device.setBusFault({ sdaLow: false });
    for (let ms = 0; ms < 400_000; ms += 10) {
      run(10);
      if (device.status().devices !== 0) return ms; // the retry came one poll earlier
    }
    throw new Error('never back');
  }
  run(60_000);
  assertEquals(pauseAfterRelapse(), 20_000); // one minute after the retry: doubled
  run(600_000);
  assertEquals(pauseAfterRelapse(), 10_000); // after 10 good minutes: starts over
});

test('safe mode never starts the bus: the i2c setting does not, and a held line is not parked', () => {
  const { device, run, last } = makeDevice({
    safeMode: true,
    firstBoot: { reason: ResetReason.taskWatchdog, cause: 1, stage: 7 },
    busFault: { sdaLow: true },
  });
  device.powerOn();
  const flags = () => Number(device.status().flags);
  assertEquals(flags() & (Flag.safeMode | Flag.i2cParked | Flag.i2cOff), Flag.safeMode);
  assertEquals(tagsOf(last()).includes(64), false);
  device.onCommand(command(1, { i2c: false }));
  assertEquals(flags() & (Flag.safeMode | Flag.i2cParked | Flag.i2cOff), Flag.safeMode | Flag.i2cOff);
  device.onCommand(command(2, { i2c: true }));
  assertEquals(flags() & (Flag.safeMode | Flag.i2cParked | Flag.i2cOff), Flag.safeMode);
  run(15_000);
  device.setBusFault({ sdaLow: false });
  run(15_000);
  assertEquals([device.status().devices, flags() & Flag.i2cParked], [0, 0]);
  assertEquals(device.status().timeValid, false); // nothing read the RTC
});

test('transfers timing out at boot: no module attaches, the bus is parked 5 s later with i2cLines 0', () => {
  const { device, run, last } = makeDevice({ busFault: { timeouts: true } });
  device.powerOn();
  assertEquals([last().values.devices, Number(last().values.statusFlags) & Flag.i2cParked], [0, 0]);
  run(4900);
  assertEquals(Number(device.status().flags) & Flag.i2cParked, 0);
  run(200);
  assertEquals([Number(device.status().flags) & Flag.i2cParked, device.status().i2cLines], [Flag.i2cParked, 0]);
  device.setBusFault({ timeouts: false });
  run(10_000);
  assertEquals(device.status().devices, ALL_MODULES);
});

test('i2c off and on again: a held line is not touched while off, and the pause history starts over', () => {
  const { device, run, last } = makeDevice({ busFault: { sdaLow: true } });
  device.powerOn();
  run(11_000); // the retry at 10 s found SDA still held: the next one would be 20 s later
  const busFlags = () => Number(device.status().flags) & (Flag.i2cOff | Flag.i2cParked);
  assertEquals(busFlags(), Flag.i2cParked);
  device.onCommand(command(1, { i2c: false }));
  assertEquals(busFlags(), Flag.i2cOff); // off, not parked
  run(30_000); // nothing touches the pins
  assertEquals(busFlags(), Flag.i2cOff);
  device.onCommand(command(2, { i2c: true, get: 3 }));
  assertEquals(busFlags(), Flag.i2cParked); // starting the bus finds SDA held
  assertEquals([last().values.i2cLines, tagsOf(last()).at(-1)], [1, 64]);
  device.setBusFault({ sdaLow: false });
  run(9900);
  assertEquals(device.status().devices, 0);
  run(200); // 10 s after the bus was started again, not 20
  assertEquals(device.status().devices, ALL_MODULES);
});
