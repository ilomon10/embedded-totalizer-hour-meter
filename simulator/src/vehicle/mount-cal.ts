// mount-cal.ts: find how the board sits in the vehicle from the IMU stream alone,
// the way a host would after the device is fitted (no simulator truth used).
//
//   1. level: the vehicle stands still for 2 s. The accelerometer then reads only
//      gravity, so its mean is "up" in board axes: the mount's tilt.
//   2. front: the driver pulls away straight ahead. The accelerometer minus gravity,
//      flattened onto the ground plane, points to the vehicle's nose: the mount's yaw.
//      Gravity alone cannot give this (any yaw reads the same at rest), and neither can
//      the compass (it measures the board's x axis, not the nose).
//
// Once both are known a host can turn board readings into vehicle ones: forward
// acceleration = (accel - up) · front, which is negative while backing up, and
// vehicle heading = compass heading - yawOffsetDeg.
import type { Vec3 } from '../frames.ts';
import { cross, dot, scale, sub } from './body.ts';

const G = 9.80665;
const DEG = Math.PI / 180;

const LEVEL_FOR_S = 2; // still this long
const LEVEL_GYRO_DPS = 1; // "still": rotation below this ...
const LEVEL_NEAR_G = 0.06; // ... and the accelerometer within this of its running mean
const LEVEL_GIVE_UP_S = 10;
const FRONT_MIN_MS2 = 0.5; // acceleration on the ground plane strong enough to trust its direction
const FRONT_MAX_TURN_DPS = 3; // driving straight
const FRONT_FOR_S = 1; // this much good acceleration
const FRONT_GIVE_UP_S = 30;
const MAX_GAP_S = 0.5;

export type MountCalStep = 'level' | 'front' | 'clear';
export type MountCalPhase = 'none' | 'level' | 'leveled' | 'front' | 'done' | 'failed';

export interface MountCal {
  /** board-axis unit vectors: up (against gravity), the vehicle's nose, and its left side */
  up: Vec3;
  front: Vec3;
  left: Vec3;
  /** the board's roll/pitch while the vehicle stands level (firmware conventions) */
  tiltRollDeg: number;
  tiltPitchDeg: number;
  /** board x clockwise from the vehicle's nose, seen from above: vehicle heading = compass - this */
  yawOffsetDeg: number;
}

export interface MountCalStatus {
  phase: MountCalPhase;
  /** 0..1 within the current step */
  progress: number;
  /** what to do now, or why it failed */
  message: string;
  /** after the level step */
  level: { tiltRollDeg: number; tiltPitchDeg: number } | null;
  /** after the front step */
  cal: MountCal | null;
}

export interface MountSample {
  /** g */
  accel: Vec3;
  /** deg/s */
  gyro: Vec3;
}

const len = (v: Vec3) => Math.hypot(v.x, v.y, v.z);
const unit = (v: Vec3): Vec3 => scale(v, 1 / (len(v) || 1));
/** v without its component along the unit vector n. */
const flatten = (v: Vec3, n: Vec3): Vec3 => sub(v, scale(n, dot(v, n)));
const wrap180 = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** The mount, given "up" and the nose direction in board axes. */
export function mountFrom(upRaw: Vec3, frontRaw: Vec3): MountCal {
  const up = unit(upRaw);
  const front = unit(flatten(frontRaw, up));
  // Compass heading = the board's x axis flattened onto the ground; the offset is the angle from the nose to it.
  const bx = unit(flatten({ x: 1, y: 0, z: 0 }, up));
  const leftOfBx = cross(up, bx);
  return {
    up,
    front,
    left: cross(up, front),
    tiltRollDeg: Math.atan2(up.y, up.z) / DEG,
    tiltPitchDeg: Math.atan2(up.x, Math.hypot(up.y, up.z)) / DEG,
    yawOffsetDeg: wrap180(Math.atan2(dot(front, leftOfBx), dot(front, bx)) / DEG),
  };
}

export class MountCalibrator {
  private phase: MountCalPhase = 'none';
  private message = 'Not calibrated: the board is assumed to point x forward, z up.';
  private lastT: number | null = null;
  private elapsedS = 0;
  private goodS = 0;
  private turnS = 0;
  private sum: Vec3 = { x: 0, y: 0, z: 0 };
  private mean: Vec3 | null = null;
  private up: Vec3 | null = null;
  private cal: MountCal | null = null;

  /** Start a step (level clears the previous result), or clear everything. */
  start(step: MountCalStep): void {
    this.elapsedS = 0;
    this.goodS = 0;
    this.turnS = 0;
    this.sum = { x: 0, y: 0, z: 0 };
    this.mean = null;
    if (step === 'clear') {
      this.phase = 'none';
      this.up = null;
      this.cal = null;
      this.message = 'Not calibrated: the board is assumed to point x forward, z up.';
    } else if (step === 'level') {
      this.phase = 'level';
      this.up = null;
      this.cal = null;
      this.message = 'Hold still for 2 s.';
    } else if (!this.up) {
      this.fail('Level first: the front step needs to know where "up" is.');
    } else {
      this.phase = 'front';
      this.cal = null;
      this.message = 'Drive straight ahead (pull away forward, do not steer).';
    }
  }

  /** The finished calibration, or null. */
  result(): MountCal | null {
    return this.cal;
  }

  status(): MountCalStatus {
    const progress = this.phase === 'level'
      ? this.goodS / LEVEL_FOR_S
      : this.phase === 'front'
      ? this.goodS / FRONT_FOR_S
      : this.phase === 'done' || this.phase === 'leveled'
      ? 1
      : 0;
    const up = this.up ? mountFrom(this.up, { x: 1, y: 0, z: 0 }) : null;
    return {
      phase: this.phase,
      progress: Math.min(1, progress),
      message: this.message,
      level: up ? { tiltRollDeg: up.tiltRollDeg, tiltPitchDeg: up.tiltPitchDeg } : null,
      cal: this.cal,
    };
  }

  /** Feed every IMU reading the host decodes; `tS` = arrival time, s. */
  feed(r: MountSample, tS: number): void {
    const dt = this.lastT === null ? 0 : tS - this.lastT;
    this.lastT = tS;
    if (!(dt > 0) || dt > MAX_GAP_S) return;
    if (this.phase === 'level') this.levelSample(r, dt);
    else if (this.phase === 'front') this.frontSample(r, dt);
  }

  private levelSample({ accel, gyro }: MountSample, dt: number): void {
    this.elapsedS += dt;
    const m = this.mean ??= { ...accel };
    const k = 1 - Math.exp(-dt / 0.3);
    m.x += (accel.x - m.x) * k;
    m.y += (accel.y - m.y) * k;
    m.z += (accel.z - m.z) * k;
    const still = len(gyro) < LEVEL_GYRO_DPS && len(sub(accel, m)) < LEVEL_NEAR_G && Math.abs(len(accel) - 1) < 0.1;
    if (!still) {
      this.goodS = 0;
      this.sum = { x: 0, y: 0, z: 0 };
      this.message = 'Hold still: the vehicle is moving.';
      if (this.elapsedS > LEVEL_GIVE_UP_S) this.fail('Level failed: the vehicle kept moving. Stop it and try again.');
      return;
    }
    this.sum = { x: this.sum.x + accel.x * dt, y: this.sum.y + accel.y * dt, z: this.sum.z + accel.z * dt };
    this.goodS += dt;
    this.message = 'Hold still for 2 s.';
    if (this.goodS >= LEVEL_FOR_S) {
      this.up = unit(this.sum);
      this.phase = 'leveled';
      this.message = 'Level found. Now press Front and drive straight ahead.';
    }
  }

  private frontSample({ accel, gyro }: MountSample, dt: number): void {
    this.elapsedS += dt;
    const up = this.up!;
    const ground = flatten(sub(accel, up), up); // g, on the ground plane
    const strong = len(ground) * G >= FRONT_MIN_MS2;
    const straight = Math.abs(dot(gyro, up)) < FRONT_MAX_TURN_DPS;
    // Same direction as what was collected so far: braking (backwards) is not "the front".
    if (strong && straight && (this.goodS === 0 || dot(ground, this.sum) > 0)) {
      this.sum = { x: this.sum.x + ground.x * dt, y: this.sum.y + ground.y * dt, z: this.sum.z + ground.z * dt };
      this.goodS += dt;
    } else if (strong && !straight) this.turnS += dt;
    if (this.goodS >= FRONT_FOR_S) {
      this.cal = mountFrom(up, this.sum);
      this.phase = 'done';
      this.message = "Calibrated: forward, reverse and heading now use the vehicle's nose.";
    } else if (this.elapsedS > FRONT_GIVE_UP_S) {
      this.fail(
        this.turnS > this.goodS
          ? 'Front failed: the vehicle turned. Drive straight ahead and try again.'
          : 'Front failed: not enough acceleration. Pull away harder and try again.',
      );
    }
  }

  private fail(message: string): void {
    this.phase = 'failed';
    this.message = message;
  }
}
