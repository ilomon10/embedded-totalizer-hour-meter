// mount.test.ts: the reverse gear, a board fitted turned/tilted in the truck, the
// host-side mounting calibration (level + front), and dead reckoning that uses it.
import { assert } from './assert.ts';
import { pitchFromAccel, rollFromAccel } from '../src/attitude.ts';
import type { Mount } from '../src/vehicle/body.ts';
import { DeadReckoner } from '../src/vehicle/dead-reckoning.ts';
import { ImuSynth, type RawSample } from '../src/vehicle/imu-synth.ts';
import { type Controls, initialState, STEP_S, Truck } from '../src/vehicle/models.ts';
import { MountCalibrator } from '../src/vehicle/mount-cal.ts';
import { type Message, MSG, rec } from '../src/protocol.ts';
import { createRng } from '../src/clock.ts';

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;
const PARK: Controls = { throttle: 0, brake: 1, steer: 0, pitch: 0 };
const PULL_AWAY: Controls = { throttle: 0.6, brake: 0, steer: 0, pitch: 0 };

/** The IMU stream frame a host would receive for one sample (wire scales). */
function frame(s: RawSample): Message {
  const a = s.accelG;
  const g = s.gyroDps;
  return {
    msgType: MSG.IMU,
    timestamp: 0,
    records: [
      rec('accelX', Math.round(a.x * 1000)),
      rec('accelY', Math.round(a.y * 1000)),
      rec('accelZ', Math.round(a.z * 1000)),
      rec('gyroX', Math.round(g.x * 10)),
      rec('gyroY', Math.round(g.y * 10)),
      rec('gyroZ', Math.round(g.z * 10)),
      rec('roll', Math.round(rollFromAccel(a) * 100)),
      rec('pitch', Math.round(pitchFromAccel(a) * 100)),
    ],
  };
}

/** A truck with the board fitted as `mount`, sampled at 100 Hz. */
function rig(mount: Mount, seed = 11) {
  const truck = new Truck(initialState(30));
  const synth = new ImuSynth(createRng(seed));
  synth.setMount(mount);
  synth.ideal(truck.state);
  let t = 0;
  return {
    truck,
    /** Drive for `seconds`, handing each noisy sample to `feed`. */
    drive(c: Controls, seconds: number, feed: (s: RawSample, t: number) => void) {
      for (let i = 0; i < Math.round(seconds / STEP_S); i++) {
        truck.step(c);
        t += STEP_S;
        feed(synth.noisy(synth.ideal(truck.state), truck.vibrationMg()), t);
      }
    },
  };
}

function calibrate(mount: Mount) {
  const r = rig(mount);
  const cal = new MountCalibrator();
  const feed = (s: RawSample, t: number) => cal.feed({ accel: s.accelG, gyro: s.gyroDps }, t);
  r.drive(PARK, 1, feed);
  cal.start('level');
  r.drive(PARK, 3, feed);
  assert(cal.status().phase === 'leveled', cal.status().message);
  cal.start('front');
  r.drive(PULL_AWAY, 3, feed);
  return cal;
}

Deno.test('truck: reverse gear backs up, and steering right then turns the nose left', () => {
  const forward = new Truck(initialState(0));
  const back = new Truck(initialState(0));
  for (let i = 0; i < 500; i++) {
    forward.step({ throttle: 0.5, brake: 0, steer: 0.5, pitch: 0 });
    back.step({ throttle: 0.5, brake: 0, steer: 0.5, pitch: 0, reverse: true });
  }
  assert(back.state.speed < -1 && back.state.speed >= -Truck.MAX_REVERSE, `reverse speed ${back.state.speed}`);
  assert(back.engaged === -1, 'reverse engaged');
  assert(forward.state.headingDeg > 0 && forward.state.headingDeg < 180, `forward ${forward.state.headingDeg}`);
  assert(back.state.headingDeg > 180, `reversing turns the other way: ${back.state.headingDeg}`);
  assert(back.state.n < 0, 'it moved backwards (south)');
});

Deno.test('truck: the gear waits for standstill, and brakes never push the speed past 0', () => {
  const truck = new Truck(initialState(0));
  for (let i = 0; i < 400; i++) truck.step({ throttle: 1, brake: 0, steer: 0, pitch: 0 });
  assert(truck.state.speed > 5, 'moving forward');
  let crossed = false;
  for (let i = 0; i < 1500; i++) {
    const before = truck.state.speed;
    truck.step({ throttle: 1, brake: 0, steer: 0, pitch: 0, reverse: true }); // throttle in R while rolling forward
    if (before > Truck.SHIFT_BELOW) assert(truck.engaged === 1, `still in drive at ${before} m/s`);
    if (truck.state.speed < 0) crossed = true;
  }
  assert(crossed && truck.state.speed < -1, `backing up after stopping: ${truck.state.speed}`);
  for (let i = 0; i < 500; i++) truck.step({ throttle: 0, brake: 1, steer: 0, pitch: 0, reverse: true });
  assert(truck.state.speed === 0, `brake stops at 0, not past it: ${truck.state.speed}`);
});

Deno.test('mount calibration: level + front recover a board turned 90° and tilted 10°', () => {
  const cal = calibrate({ yawDeg: 90, pitchDeg: 0, rollDeg: 10 }).result();
  assert(cal, 'calibrated');
  assert(near(cal.yawOffsetDeg, 90, 2), `yaw ${cal.yawOffsetDeg}`);
  assert(near(cal.tiltRollDeg, 10, 2) && near(cal.tiltPitchDeg, 0, 2), `tilt ${cal.tiltRollDeg}/${cal.tiltPitchDeg}`);
  // board x points to the truck's right, so the nose is along the board's +y (left of x)
  assert(near(cal.front.y, 1, 0.05), JSON.stringify(cal.front));
});

Deno.test('mount calibration: a board fitted backwards and nose-up', () => {
  const cal = calibrate({ yawDeg: 180, pitchDeg: 15, rollDeg: 0 }).result();
  assert(cal, 'calibrated');
  assert(near(Math.abs(cal.yawOffsetDeg), 180, 2), `yaw ${cal.yawOffsetDeg}`);
  assert(near(cal.tiltPitchDeg, 15, 2), `pitch ${cal.tiltPitchDeg}`);
});

Deno.test('mount calibration: each step says why it failed', () => {
  const early = new MountCalibrator();
  early.start('front');
  assert(early.status().phase === 'failed' && /Level first/.test(early.status().message));

  const moving = rig({ yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
  const m = new MountCalibrator();
  moving.drive(PULL_AWAY, 2, () => {});
  m.start('level');
  moving.drive(
    { throttle: 0.3, brake: 0, steer: 0.6, pitch: 0 },
    12,
    (s, t) => m.feed({ accel: s.accelG, gyro: s.gyroDps }, t),
  );
  assert(m.status().phase === 'failed' && /kept moving/.test(m.status().message), m.status().message);

  for (
    const [c, why] of [[{ throttle: 0, brake: 1, steer: 0, pitch: 0 }, /not enough acceleration/], [
      { throttle: 1, brake: 0, steer: 1, pitch: 0 },
      /turned/,
    ]] as const
  ) {
    const r = rig({ yawDeg: 0, pitchDeg: 0, rollDeg: 0 });
    const cal = new MountCalibrator();
    const feed = (s: RawSample, t: number) => cal.feed({ accel: s.accelG, gyro: s.gyroDps }, t);
    cal.start('level');
    r.drive(PARK, 3, feed);
    r.drive({ ...c, steer: c.steer }, 1, () => {}); // (let the wheels turn before the step starts)
    cal.start('front');
    r.drive(c, 32, feed);
    assert(cal.status().phase === 'failed' && why.test(cal.status().message), cal.status().message);
  }
});

Deno.test('dead reckoning with a calibrated 90° mount follows 50 m forward and 20 m back', () => {
  const mount = { yawDeg: 90, pitchDeg: 0, rollDeg: 0 };
  const r = rig(mount, 5);
  const cal = new MountCalibrator();
  const dr = new DeadReckoner('still');
  const feed = (s: RawSample, t: number) => {
    const msg = frame(s);
    dr.onFrame(msg, t);
    cal.feed({ accel: s.accelG, gyro: s.gyroDps }, t);
  };
  r.drive(PARK, 1, feed);
  dr.anchor({ ...r.truck.state });
  cal.start('level');
  r.drive(PARK, 3, feed);
  cal.start('front');
  r.drive(PULL_AWAY, 2, feed);
  dr.mount = cal.result();
  assert(dr.mount, cal.status().message);
  r.drive(PARK, 6, feed); // stop: the zero-velocity update settles the speed
  dr.anchor({ ...r.truck.state }); // a GPS fix while parked: the next sample re-learns gravity
  r.drive(PARK, 1, feed);
  const start = { e: r.truck.state.e, n: r.truck.state.n };
  // forward about 50 m, stop, then back about 20 m
  while (Math.hypot(r.truck.state.e - start.e, r.truck.state.n - start.n) < 50) r.drive(PULL_AWAY, 0.1, feed);
  r.drive(PARK, 6, feed);
  const turn = { e: r.truck.state.e, n: r.truck.state.n };
  let minSpeed = 0;
  const reverse = { ...PULL_AWAY, throttle: 0.4, reverse: true };
  while (Math.hypot(r.truck.state.e - turn.e, r.truck.state.n - turn.n) < 20) {
    r.drive(reverse, 0.1, feed);
    minSpeed = Math.min(minSpeed, dr.estimate().speed);
  }
  r.drive(PARK, 6, feed);
  const est = dr.estimate();
  const err = Math.hypot(est.e - r.truck.state.e, est.n - r.truck.state.n);
  assert(minSpeed < -1, `the estimate backs up too: ${minSpeed.toFixed(2)} m/s`);
  assert(err < 6, `${err.toFixed(1)} m off after 50 m forward + 20 m back`);

  // the same trip without the calibration: board x is the truck's right side, so it gets lost
  const r2 = rig(mount, 5);
  const blind = new DeadReckoner('still');
  const feed2 = (s: RawSample, t: number) => blind.onFrame(frame(s), t);
  r2.drive(PARK, 1, feed2);
  blind.anchor({ ...r2.truck.state });
  r2.drive(PARK, 3, feed2);
  r2.drive(PULL_AWAY, 8, feed2);
  const e2 = blind.estimate();
  assert(Math.hypot(e2.e - r2.truck.state.e, e2.n - r2.truck.state.n) > 15, 'uncalibrated mount drifts');
});
