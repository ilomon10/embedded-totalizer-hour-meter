// attitude3d.ts: device attitude <-> three.js, and the spring that makes the
// board follow its target.
//
// Device (MPU9250) frame: x forward, y left, z up. Mapped into three.js (y up) as
//   device x -> three -Z (into the screen), device y -> three -X, device z -> three +Y,
// which keeps the frame right-handed. North is three -Z, east is three +X.
import { Quaternion, Vector3 } from 'three';

export interface Attitude {
  rollDeg: number;
  pitchDeg: number;
  headingDeg: number;
}

const DEG = Math.PI / 180;
const Y = new Vector3(0, 1, 0);
const X = new Vector3(1, 0, 0);
const Z = new Vector3(0, 0, 1);

/**
 * Yaw, then pitch, then roll (intrinsic, like the firmware's aerospace angles):
 *   heading clockwise from above  = about +Y by -heading
 *   pitch: positive = nose up (Orientation.h, firmware 2.4.0):
 *          about +X by +pitch   (forward, -Z, rises toward +Y)
 *   roll right side down (dev. x) = about +Z by -roll    (left side, -X, rises)
 */
export function attitudeToQuaternion(a: Attitude, out = new Quaternion()): Quaternion {
  const yaw = new Quaternion().setFromAxisAngle(Y, -a.headingDeg * DEG);
  const pitch = new Quaternion().setFromAxisAngle(X, a.pitchDeg * DEG);
  const roll = new Quaternion().setFromAxisAngle(Z, -a.rollDeg * DEG);
  return out.copy(yaw).multiply(pitch).multiply(roll);
}

export const clampPitch = (deg: number) => Math.max(-89, Math.min(89, deg));
export const wrapRoll = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
export const wrapHeading = (deg: number) => ((deg % 360) + 360) % 360;

/** Heading (clockwise from north = -Z) of a point on the ground plane around the board. */
export function headingOfPoint(x: number, z: number): number {
  return wrapHeading(Math.atan2(x, -z) / DEG);
}

/** Frame-rate independent exponential follow ("critically damped" feel without overshoot). */
export function follow(current: Quaternion, target: Quaternion, lambda: number, dt: number): void {
  current.slerp(target, 1 - Math.exp(-lambda * dt));
}
