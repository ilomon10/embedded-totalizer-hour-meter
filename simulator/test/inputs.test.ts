// inputs.test.ts: auto/manual inputs reach the frames exactly, and faults change live.
import { assert, assertEquals } from './assert.ts';
import { Faults } from '../src/faults.ts';
import { parseScenario } from '../src/scenarios.ts';
import { Device, Flag, MSG } from '../src/protocol.ts';
import { makeDevice } from './helpers.ts';

Deno.test('manual motion and vibration reach TELEMETRY byte-exact', () => {
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  device.setInput('motion', { rollDeg: 12.34, pitchDeg: -5.5, headingDeg: 270 });
  device.setInput('vibration', { rmsMg: 150, peakMg: 600 });
  run(1100);
  const t = lastOf(MSG.TELEMETRY);
  assert(t);
  const raw = Object.fromEntries(t.records.map((r) => [r.name, r.raw]));
  assertEquals([raw.roll, raw.pitch, raw.heading, raw.vibRms, raw.vibPeak], [1234, -550, 27000, 150, 600]);
});

Deno.test('touching one value keeps the rest of the group where it was', () => {
  const { device } = makeDevice();
  device.powerOn();
  const before = device.snapshot().values.motion;
  device.setInput('motion', { rollDeg: 20 });
  const after = device.snapshot().values.motion;
  assertEquals(after.rollDeg, 20);
  assertEquals(after.pitchDeg, before.pitchDeg);
  assertEquals(device.inputs().modes.motion, 'manual');
});

Deno.test('back to auto: the animation drives the group again', () => {
  const { device, run } = makeDevice();
  device.powerOn();
  device.setInput('motion', { rollDeg: 45 });
  device.setAutoInput('motion');
  run(1000);
  assertEquals(device.inputs().modes.motion, 'auto');
  assert(Math.abs(device.snapshot().values.motion.rollDeg) < 3); // the gentle built-in tilt, not 45
});

Deno.test('a manual engine is not overridden by the engine-cycle scenario', () => {
  const { device, run } = makeDevice();
  const cycle = parseScenario('engine-cycle=1,1', () => 0.5);
  device.powerOn();
  device.setInput('engine', { running: false });
  for (let t = 0; t < 3000; t += 100) {
    cycle.tick?.(t, device);
    run(100);
    assertEquals(device.engineRunning(), false);
  }
});

Deno.test('a manual pulse rate drives the totalizer', () => {
  const { device, run } = makeDevice({ pulsesPerSecond: 0 });
  device.powerOn();
  device.setInput('engine', { running: true });
  device.setInput('pulses', { perSecond: 10 });
  const start = device.hourMeter().totalCount;
  run(2000);
  assertEquals(device.hourMeter().totalCount - start, 20);
});

Deno.test('errors, extra flags and RTC temperature reach the status block', () => {
  const { device } = makeDevice();
  device.powerOn();
  device.setInput('errors', { i2cErrors: 7, overruns: 2 });
  device.setInput('flags', { imuStuck: true, storageError: true });
  device.setInput('rtc', { tempC: -10.25 });
  const st = device.status();
  assertEquals([st.i2cErrors, st.overruns, st.rtcTempQuarterC], [7, 2, -41]);
  const want = Flag.i2cErrors | Flag.imuStuck | Flag.storageError;
  assertEquals(st.flags & want, want);
});

Deno.test('RTC battery switched off: the next power cycle loses the time', () => {
  const { device } = makeDevice();
  device.powerOn();
  assertEquals(device.status().timeValid, true);
  device.setInput('rtc', { battery: false });
  device.reset(6); // a watchdog reset keeps power: the time survives
  assertEquals(device.status().timeValid, true);
  device.powerOn();
  const st = device.status();
  assertEquals(st.timeValid, false);
  assertEquals(st.flags & Flag.rtcBatteryLost, Flag.rtcBatteryLost);
});

Deno.test('counter preset from the web UI works like the firmware preset', () => {
  const { device } = makeDevice();
  device.powerOn();
  device.presetCounters(3600, 42);
  assertEquals([device.hourMeter().runSeconds, device.hourMeter().totalCount], [3600, 42]);
  const noEeprom = makeDevice({ fitted: Device.rtc | Device.imu | Device.mag });
  noEeprom.device.powerOn();
  noEeprom.device.presetCounters(3600, null);
  assertEquals(noEeprom.device.hourMeter().runSeconds, 3600); // RAM only, not persisted
});

Deno.test('faults change live: corrupt every frame, then none', () => {
  const faults = new Faults(() => 0); // always "hit"
  const frame = Uint8Array.from([5, 1, 2, 3, 4, 0]);
  assertEquals(faults.mangle(frame), frame);
  faults.set({ corruptEvery: 1 });
  assert(faults.mangle(frame).some((b, i) => b !== frame[i]));
  faults.set({ corruptEvery: 0, noise: 1 });
  assert(faults.mangle(frame).length > frame.length);
  faults.set({ noise: 0 });
  assertEquals(faults.mangle(frame), frame);
});

Deno.test('the IMU stream agrees with a manual attitude (firmware formulas decode it back)', async () => {
  const { headingFromMag, pitchFromAccel, rollFromAccel } = await import('../src/attitude.ts');
  const { device, run, lastOf } = makeDevice();
  device.powerOn();
  device.setInput('motion', { rollDeg: 25, pitchDeg: -10, headingDeg: 120 });
  device.setInput('vibration', { rmsMg: 0, peakMg: 0 });
  run(200);
  const imu = lastOf(MSG.IMU);
  assert(imu);
  const v = imu.values as Record<string, number>; // scaled: g, uT
  const accel = { x: v.accelX, y: v.accelY, z: v.accelZ };
  const mag = { x: v.magX, y: v.magY, z: v.magZ };
  assert(Math.abs(rollFromAccel(accel) - 25) < 1, `roll ${rollFromAccel(accel)}`);
  assert(Math.abs(pitchFromAccel(accel) + 10) < 1, `pitch ${pitchFromAccel(accel)}`);
  assert(Math.abs(headingFromMag(mag, accel) - 120) < 2, `heading ${headingFromMag(mag, accel)}`);
});
