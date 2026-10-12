// models.ts: how a truck and a plane move, stepped at a fixed 100 Hz.
//
// Both take the same controls and keep their state in local east/north/up metres.
// They are deliberately simple and smooth (no tyre slip, no wind): the goal is
// motion whose accelerations and rotations are physically consistent, so the IMU
// data derived from it is something a real driver could dead-reckon from.
import type { Attitude } from './body.ts';

export const STEP_S = 0.01;
const G = 9.80665;
const DEG = Math.PI / 180;

export type VehicleKind = 'truck' | 'plane';

export interface Controls {
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
  /** -1 (full left) .. +1 (full right) */
  steer: number;
  /** -1 (nose down / descend) .. +1 (nose up / climb); plane only */
  pitch: number;
}

export const NO_CONTROLS: Controls = Object.freeze({ throttle: 0, brake: 0, steer: 0, pitch: 0 });

export interface VehicleState extends Attitude {
  e: number;
  n: number;
  u: number;
  /** speed along the path, m/s */
  speed: number;
  /** world velocity, m/s (east, north, up) */
  ve: number;
  vn: number;
  vu: number;
}

export interface Vehicle {
  readonly kind: VehicleKind;
  state: VehicleState;
  step(c: Controls): void;
  /** Rough engine/road vibration for this moment, mg RMS. */
  vibrationMg(): number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const approach = (v: number, target: number, maxStep: number) => v + clamp(target - v, -maxStep, maxStep);
/** First-order lag toward a target with time constant tau seconds. */
const lag = (v: number, target: number, tau: number) => v + (target - v) * (1 - Math.exp(-STEP_S / tau));

function wrapHeading(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function initialState(headingDeg: number, altM = 0, speed = 0): VehicleState {
  const h = headingDeg * DEG;
  return {
    e: 0,
    n: 0,
    u: altM,
    headingDeg,
    pitchDeg: 0,
    rollDeg: 0,
    speed,
    ve: speed * Math.sin(h),
    vn: speed * Math.cos(h),
    vu: 0,
  };
}

/**
 * Truck: kinematic bicycle model. Heading rate = v / L * tan(steer angle).
 * Body roll leans out of turns, pitch squats when accelerating and dives when
 * braking (positive pitch = nose up, firmware 2.4.0).
 */
export class Truck implements Vehicle {
  readonly kind = 'truck';
  static readonly WHEELBASE_M = 4.2;
  static readonly MAX_STEER_DEG = 35;
  static readonly STEER_RATE_DPS = 40;
  static readonly MAX_ACCEL = 1.8;
  static readonly MAX_BRAKE = 6;
  static readonly MAX_SPEED = 25; // 90 km/h
  static readonly MAX_LATERAL = 4.5; // m/s², about 0.45 g: the tyres' grip; beyond it the truck understeers
  private steerDeg = 0;
  private aLong = 0;
  private aLat = 0;

  constructor(public state: VehicleState) {}

  step(c: Controls): void {
    const s = this.state;
    this.steerDeg = approach(
      this.steerDeg,
      clamp(c.steer, -1, 1) * Truck.MAX_STEER_DEG,
      Truck.STEER_RATE_DPS * STEP_S,
    );
    const drag = 0.15 + 0.0009 * s.speed * s.speed; // rolling + air
    let a = clamp(c.throttle, 0, 1) * Truck.MAX_ACCEL - clamp(c.brake, 0, 1) * Truck.MAX_BRAKE;
    a -= s.speed > 0 ? drag : 0;
    if (s.speed >= Truck.MAX_SPEED && a > 0) a = 0;
    const speed = clamp(s.speed + a * STEP_S, 0, Truck.MAX_SPEED);
    this.aLong = (speed - s.speed) / STEP_S;
    const kinematic = (speed / Truck.WHEELBASE_M) * Math.tan(this.steerDeg * DEG); // rad/s, + = clockwise
    const gripLimit = Truck.MAX_LATERAL / Math.max(speed, 0.5); // understeer: no tighter than grip allows
    const yawRate = clamp(kinematic, -gripLimit, gripLimit);
    this.aLat = speed * yawRate; // toward the turn centre, + = right
    s.headingDeg = wrapHeading(s.headingDeg + (yawRate / DEG) * STEP_S);
    s.speed = speed;
    const h = s.headingDeg * DEG;
    s.ve = speed * Math.sin(h);
    s.vn = speed * Math.cos(h);
    s.vu = 0;
    s.e += s.ve * STEP_S;
    s.n += s.vn * STEP_S;
    // Suspension: about 1.2° of body roll per m/s² of lateral accel, 0.6° pitch per m/s² of braking/accel.
    // (capped: a loaded truck leans a few degrees at most before its springs bottom out)
    s.rollDeg = lag(s.rollDeg, clamp(-1.2 * this.aLat, -6, 6), 0.35); // right turn -> leans left -> negative
    s.pitchDeg = lag(s.pitchDeg, clamp(0.6 * this.aLong, -4, 4), 0.3); // braking (a < 0) -> nose dives -> negative
  }

  vibrationMg(): number {
    return 14 + this.state.speed * 5.5; // idling diesel plus road, grows with speed
  }
}

/**
 * Plane: coordinated turns at constant altitude unless climbing.
 * Turn rate = g * tan(bank) / v; flight path angle from the pitch control;
 * airspeed between stall and maximum.
 */
export class Plane implements Vehicle {
  readonly kind = 'plane';
  static readonly STALL = 30;
  static readonly CRUISE = 55;
  static readonly MAX_SPEED = 75;
  static readonly MAX_BANK_DEG = 45;
  static readonly BANK_RATE_DPS = 30;
  static readonly MAX_GAMMA_DEG = 12;
  static readonly AOA_DEG = 2; // the nose sits a little above the flight path
  private bankDeg = 0;
  private gammaDeg = 0;

  constructor(public state: VehicleState) {
    if (state.speed < Plane.STALL) state.speed = Plane.CRUISE;
  }

  step(c: Controls): void {
    const s = this.state;
    this.bankDeg = approach(
      this.bankDeg,
      clamp(c.steer, -1, 1) * Plane.MAX_BANK_DEG,
      Plane.BANK_RATE_DPS * STEP_S,
    );
    this.gammaDeg = lag(this.gammaDeg, clamp(c.pitch, -1, 1) * Plane.MAX_GAMMA_DEG, 1.2);
    if (s.u <= 0 && this.gammaDeg < 0) this.gammaDeg = 0; // never below the start height
    const thrust = clamp(c.throttle, 0, 1) * 4 - clamp(c.brake, 0, 1) * 3;
    const drag = 1.2 * (s.speed / Plane.CRUISE) ** 2 + G * Math.sin(this.gammaDeg * DEG);
    s.speed = clamp(s.speed + (thrust - drag) * STEP_S, Plane.STALL, Plane.MAX_SPEED);
    const yawRate = (G * Math.tan(this.bankDeg * DEG)) / s.speed; // rad/s, + = clockwise (right bank)
    s.headingDeg = wrapHeading(s.headingDeg + (yawRate / DEG) * STEP_S);
    const h = s.headingDeg * DEG;
    const gamma = this.gammaDeg * DEG;
    s.ve = s.speed * Math.cos(gamma) * Math.sin(h);
    s.vn = s.speed * Math.cos(gamma) * Math.cos(h);
    s.vu = s.speed * Math.sin(gamma);
    s.e += s.ve * STEP_S;
    s.n += s.vn * STEP_S;
    s.u = Math.max(0, s.u + s.vu * STEP_S);
    s.rollDeg = this.bankDeg; // right wing down = left side up = positive roll
    s.pitchDeg = this.gammaDeg + Plane.AOA_DEG; // nose up = positive
  }

  vibrationMg(): number {
    return 22 + this.state.speed * 0.6; // propeller and airflow
  }
}

export function makeVehicle(kind: VehicleKind, headingDeg = 0, altM = 0): Vehicle {
  return kind === 'plane'
    ? new Plane(initialState(headingDeg, Math.max(altM, 300), Plane.CRUISE))
    : new Truck(initialState(headingDeg, 0, 0));
}
