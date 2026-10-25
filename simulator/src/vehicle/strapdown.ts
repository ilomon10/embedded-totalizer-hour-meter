// strapdown.ts: the reference estimator for aircraft, a plain 3D strapdown INS fed
// with the IMU stream the host receives.
//
// Why aircraft need it: in a coordinated turn the accelerometer feels no sideways
// force; "down" still points through the cabin floor while the plane banks 45°. So
// gravity can't be read off the accelerometer (the firmware's roll even reads level),
// and attitude has to come from integrating the gyro, as every aircraft AHRS does.
//
//   1. at a fix: position, velocity and attitude come from the truth (GPS + alignment)
//   2. attitude: rotate the board's axes by the gyro rate each sample
//   3. acceleration: specific force rotated into the world, minus gravity
//   4. velocity and position: integrate
import type { Message } from '../protocol.ts';
import { add, type Axes, axesOf, cross, dot, scale } from './body.ts';
import { type AnchorState, type Estimate, type Estimator, type HeadingSource, readImuFrame } from './dead-reckoning.ts';

const G = 9.80665;
const DEG = Math.PI / 180;
const MAX_GAP_S = 0.5;

type V = { x: number; y: number; z: number };

/** Rotate v about the unit axis k by angle a (Rodrigues). */
function rotate(v: V, k: V, a: number): V {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return add(add(scale(v, c), scale(cross(k, v), s)), scale(k, dot(k, v) * (1 - c)));
}

function orthonormalize(r: Axes): Axes {
  const x = scale(r.x, 1 / Math.hypot(r.x.x, r.x.y, r.x.z));
  const zRaw = cross(x, r.y);
  const z = scale(zRaw, 1 / Math.hypot(zRaw.x, zRaw.y, zRaw.z));
  return { x, y: cross(z, x), z };
}

export class StrapdownIns implements Estimator {
  headingSource: HeadingSource = 'gyro'; // attitude always comes from the gyro here
  private axes: Axes = axesOf({ headingDeg: 0, pitchDeg: 0, rollDeg: 0 });
  private pos: V = { x: 0, y: 0, z: 0 };
  private vel: V = { x: 0, y: 0, z: 0 };
  private lastT: number | null = null;
  private samples = 0;

  anchor(at: AnchorState): void {
    this.axes = axesOf(at);
    this.pos = { x: at.e, y: at.n, z: at.u };
    this.vel = { x: at.ve, y: at.vn, z: at.vu };
    this.samples = 0; // the frame clock keeps running: a fix resets the state, not the time
  }

  onFrame(msg: Message, tS: number): void {
    const r = readImuFrame(msg);
    if (!r) return;
    const dt = this.lastT === null ? 0 : tS - this.lastT;
    this.lastT = tS;
    if (!(dt > 0) || dt > MAX_GAP_S) return;
    const R = this.axes;
    // World angular velocity = body rate expressed with the board's world axes.
    const w = add(add(scale(R.x, r.gyro.x * DEG), scale(R.y, r.gyro.y * DEG)), scale(R.z, r.gyro.z * DEG));
    const rate = Math.hypot(w.x, w.y, w.z);
    if (rate > 1e-9) {
      const k = scale(w, 1 / rate);
      const angle = rate * dt;
      this.axes = orthonormalize({ x: rotate(R.x, k, angle), y: rotate(R.y, k, angle), z: rotate(R.z, k, angle) });
    }
    const f = add(add(scale(this.axes.x, r.accel.x), scale(this.axes.y, r.accel.y)), scale(this.axes.z, r.accel.z));
    const a = scale({ x: f.x, y: f.y, z: f.z - 1 }, G); // minus gravity (1 g up in specific force)
    this.vel = add(this.vel, scale(a, dt));
    this.pos = add(this.pos, scale(this.vel, dt));
    this.samples++;
  }

  estimate(): Estimate {
    const x = this.axes.x;
    return {
      e: this.pos.x,
      n: this.pos.y,
      headingDeg: (Math.atan2(x.x, x.y) / DEG + 360) % 360,
      speed: Math.hypot(this.vel.x, this.vel.y, this.vel.z),
      samples: this.samples,
    };
  }
}
