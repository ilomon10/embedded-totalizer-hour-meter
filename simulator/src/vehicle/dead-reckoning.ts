// dead-reckoning.ts: a reference host-side estimator. It sees only what a host sees:
// the IMU stream frames (filtered accel in mg, gyro in 0.1 °/s, roll/pitch, heading),
// at the rate the host configured. No access to the simulator's truth except at
// an anchor (a simulated GPS fix).
//
// Method, deliberately plain so its drift is easy to reason about:
//   1. "up" in the board frame. Ground vehicles: learned while standing still (a truck's
//      mounting tilt doesn't change), with a zero-velocity update: when the
//      accelerometer reads 1 g and the gyro is quiet for a second, the vehicle is
//      parked, so "up" = the accelerometer and speed = 0. Aircraft (never still): the
//      reported roll/pitch (Orientation.h's upVector).
//      "Parked" is judged by vibration, not by the mean: a truck cruising at constant
//      speed also reads pure gravity on average, but it shakes far more than an idling one.
//      Why not the reported roll/pitch for trucks too: the firmware's KalmanAngle trusts
//      the accelerometer strongly (rMeasure 0.03), so its pitch absorbs forward
//      acceleration and removing "gravity" with it would cancel the very signal we need.
//   2. heading: integrate the rotation rate about "up" (gyro), or take the compass heading
//   3. motion acceleration = accelerometer - up (1 g), forward component -> speed
//   4. position += speed * (sin heading, cos heading) * dt
import { upVector } from '../attitude.ts';
import type { Message } from '../protocol.ts';
import { MSG, TAGS } from '../protocol.ts';

const G = 9.80665;
const DEG = Math.PI / 180;
const MAX_GAP_S = 0.5; // a longer silence is not integrated (stream stopped)

export type HeadingSource = 'gyro' | 'compass';
export type GravitySource = 'still' | 'attitude';

const STANDSTILL_MPS = 0.3; // an anchor below this speed re-learns gravity
const STILL_RMS_G = 0.025; // vibration (RMS around the short-term mean) below this: idling at most ...
const STILL_NEAR_G = 0.05; // ... and the accelerometer within this of the learned gravity (steady
// acceleration is not "parked"; a slightly wrong gravity can still heal) ...
const STILL_GYRO_DPS = 0.6; // ... and rotation below this ...
const STILL_FOR_S = 1; // ... for this long = parked
const RMS_TAU_S = 0.5; // the short-term mean and vibration level span about this long
const GRAVITY_TAU_S = 0.5; // while parked, follow the accelerometer this fast

export interface Estimate {
  e: number;
  n: number;
  headingDeg: number;
  speed: number;
  samples: number;
}

const NAME_OF = new Map(Object.entries(TAGS).map(([tag, def]) => [Number(tag), def.name]));

/** Where an estimate restarts from: a GPS fix (position, velocity) plus, for aircraft, attitude. */
export interface AnchorState {
  e: number;
  n: number;
  u: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  speed: number;
  ve: number;
  vn: number;
  vu: number;
}

/** A host-side estimator fed with the frames the host receives. */
export interface Estimator {
  headingSource: HeadingSource;
  anchor(at: AnchorState): void;
  onFrame(msg: Message, tS: number): void;
  estimate(): Estimate;
}

export interface ImuReading {
  /** g */
  accel: { x: number; y: number; z: number };
  /** deg/s */
  gyro: { x: number; y: number; z: number };
  rollDeg: number;
  pitchDeg: number;
  headingDeg?: number;
}

/** Decode one IMU stream frame the way a host would: wire values times their scales. */
export function readImuFrame(msg: Message): ImuReading | null {
  if (msg.msgType !== MSG.IMU) return null;
  const v: Record<string, number> = {};
  for (const r of msg.records) v[NAME_OF.get(r.tag) ?? ''] = Number(r.value);
  // Filtered values when streamed, else raw: the scales are the wire scales.
  const ax = v.accelX ?? v.rawAccelX;
  const gz = v.gyroZ ?? v.rawGyroZ;
  if (ax === undefined || gz === undefined) return null; // the stream carries no accel/gyro
  const accel = { x: ax / 1000, y: (v.accelY ?? v.rawAccelY) / 1000, z: (v.accelZ ?? v.rawAccelZ) / 1000 };
  const gyro = { x: (v.gyroX ?? v.rawGyroX) / 10, y: (v.gyroY ?? v.rawGyroY) / 10, z: gz / 10 };
  return {
    accel,
    gyro,
    rollDeg: v.roll !== undefined ? v.roll / 100 : Math.atan2(accel.y, accel.z) / DEG,
    pitchDeg: v.pitch !== undefined ? v.pitch / 100 : Math.atan2(-accel.x, Math.hypot(accel.y, accel.z)) / DEG,
    headingDeg: v.heading !== undefined ? v.heading / 100 : undefined,
  };
}

export class DeadReckoner implements Estimator {
  headingSource: HeadingSource = 'gyro';
  private est: Estimate = { e: 0, n: 0, headingDeg: 0, speed: 0, samples: 0 };
  private lastT: number | null = null;
  private gravity: { x: number; y: number; z: number } | null = null;
  private learnGravity = true;

  private stillS = 0;
  private vibMs2 = 1; // running mean of |a - short-term mean|², g² (starts "moving")
  private shortMean: { x: number; y: number; z: number } | null = null;

  constructor(public gravitySource: GravitySource = 'still') {}

  /**
   * Re-anchor position, heading and speed (a GPS fix). While standing still the
   * accelerometer reads pure gravity, so the next sample also re-learns "up"
   * (a zero-velocity update); otherwise the gravity estimate is kept.
   */
  anchor(at: AnchorState): void {
    this.est = { e: at.e, n: at.n, headingDeg: at.headingDeg, speed: at.speed, samples: 0 };
    // (the frame clock keeps running: a fix resets the state, not the time)
    if (Math.abs(at.speed) < STANDSTILL_MPS) {
      this.learnGravity = true;
      this.vibMs2 = 0; // known to be parked: start the stillness detector from "quiet"
      this.shortMean = null;
    }
  }

  estimate(): Estimate {
    return { ...this.est };
  }

  /** Feed every frame the device sends; only IMU stream frames are used. `tS` = arrival time, s. */
  onFrame(msg: Message, tS: number): void {
    const r = readImuFrame(msg);
    if (!r) return;
    const { accel, gyro } = r;
    const roll = r.rollDeg;
    const pitch = r.pitchDeg;
    const dt = this.lastT === null ? 0 : tS - this.lastT;
    this.lastT = tS;
    if (this.learnGravity) {
      this.gravity = { ...accel }; // standing still: the accelerometer reads exactly "up"
      this.learnGravity = false;
    } else if (this.gravity === null) this.gravity = upVector(roll, pitch); // moving: best guess, the reported attitude
    if (!(dt > 0) || dt > MAX_GAP_S) return;

    const up = this.upFrom(accel, gyro, roll, pitch, dt);
    const e = this.est;
    if (this.headingSource === 'compass' && r.headingDeg !== undefined) e.headingDeg = r.headingDeg;
    else {
      const turnDps = -(gyro.x * up.x + gyro.y * up.y + gyro.z * up.z); // rotation about up, clockwise +
      e.headingDeg = (((e.headingDeg + turnDps * dt) % 360) + 360) % 360;
    }
    const forward = (accel.x - up.x) * G; // m/s², board x = vehicle forward
    e.speed = Math.max(0, e.speed + forward * dt);
    const horizontal = e.speed * Math.min(1, Math.max(0, up.z)); // the forward axis' share of the ground
    e.e += horizontal * Math.sin(e.headingDeg * DEG) * dt;
    e.n += horizontal * Math.cos(e.headingDeg * DEG) * dt;
    e.samples++;
  }

  /** "up" for this sample; for ground vehicles also the zero-velocity update. */
  private upFrom(
    accel: { x: number; y: number; z: number },
    gyro: { x: number; y: number; z: number },
    roll: number,
    pitch: number,
    dt: number,
  ) {
    if (this.gravitySource === 'attitude') return upVector(roll, pitch);
    const g = this.gravity!;
    // Parked = little vibration around the short-term mean (a variance test: it doesn't
    // depend on the gravity estimate being right yet), and nothing rotates.
    const kv = 1 - Math.exp(-dt / RMS_TAU_S);
    const m = this.shortMean ??= { ...accel };
    m.x += (accel.x - m.x) * kv;
    m.y += (accel.y - m.y) * kv;
    m.z += (accel.z - m.z) * kv;
    const dev2 = (accel.x - m.x) ** 2 + (accel.y - m.y) ** 2 + (accel.z - m.z) ** 2;
    this.vibMs2 += (dev2 - this.vibMs2) * kv;
    const nearGravity = Math.hypot(accel.x - g.x, accel.y - g.y, accel.z - g.z) < STILL_NEAR_G;
    const quiet = Math.sqrt(this.vibMs2) < STILL_RMS_G && nearGravity &&
      Math.hypot(gyro.x, gyro.y, gyro.z) < STILL_GYRO_DPS;
    this.stillS = quiet ? this.stillS + dt : 0;
    if (this.stillS >= STILL_FOR_S) {
      const k = 1 - Math.exp(-dt / GRAVITY_TAU_S);
      g.x += (accel.x - g.x) * k;
      g.y += (accel.y - g.y) * k;
      g.z += (accel.z - g.z) * k;
      this.est.speed = 0; // zero-velocity update
    }
    const len = Math.hypot(g.x, g.y, g.z) || 1;
    return { x: g.x / len, y: g.y / len, z: g.z / len };
  }
}
