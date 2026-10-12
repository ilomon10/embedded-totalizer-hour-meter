// attitude.ts: what the accelerometer and magnetometer read for a given roll,
// pitch and heading, so the IMU stream agrees with the orientation the device
// reports. The inverse functions are ports of the firmware's own math
// (esp32/lib/Filters/src/Orientation.h and Compass.h); test/attitude.test.ts
// checks the round trip.
//
// Board frame (MPU9250): right-handed, x forward, y left, z up. A board lying
// flat reads +1 g on z. Roll: about x, left side up positive. Pitch: nose up positive,
// atan2(ax, hypot(ay, az)), so positive pitch is NOSE UP (firmware 2.4.0 fixed
// the sign; 2.3.0 reported nose down).
// Heading: the board's x axis, clockwise from magnetic north.
import type { Vec3 } from './frames.ts';

const DEG = Math.PI / 180;

/** A typical mid-latitude field: horizontal part toward north, vertical part pointing down. */
export const FIELD_HORIZONTAL_UT = 30;
export const FIELD_DOWN_UT = 40;

const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const normalize = (a: Vec3): Vec3 => scale(a, 1 / Math.hypot(a.x, a.y, a.z));

/** Firmware orientation::upVector: the unit "up" vector in the board frame. */
export function upVector(rollDeg: number, pitchDeg: number): Vec3 {
  const r = rollDeg * DEG;
  const p = pitchDeg * DEG;
  return { x: Math.sin(p), y: Math.cos(p) * Math.sin(r), z: Math.cos(p) * Math.cos(r) };
}

/** Firmware orientation::rollDeg / pitchDeg from a resting accelerometer. */
export function rollFromAccel(a: Vec3): number {
  return Math.atan2(a.y, a.z) / DEG;
}
export function pitchFromAccel(a: Vec3): number {
  return Math.atan2(a.x, Math.hypot(a.y, a.z)) / DEG;
}

/** Firmware compass::headingDeg: 0..360, clockwise from magnetic north. */
export function headingFromMag(mag: Vec3, up: Vec3): number {
  const east = normalize(cross(mag, up));
  const north = cross(up, east);
  const deg = Math.atan2(east.x, north.x) / DEG;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * Gravity (g) and the earth's field (uT) in the board frame for an attitude.
 * North lies in the horizontal plane at `headingDeg` counter-clockwise from the
 * board's x axis (seen from above), so the firmware recovers exactly that heading.
 */
export function sensorVectors(rollDeg: number, pitchDeg: number, headingDeg: number): { accelG: Vec3; magUt: Vec3 } {
  const up = upVector(rollDeg, pitchDeg);
  const x: Vec3 = { x: 1, y: 0, z: 0 };
  // Horizontal direction of the board's x axis (pitch is limited to ±90°, so it never vanishes).
  const along = Math.abs(dot(x, up)) > 0.9999 ? normalize(cross(up, { x: 0, y: 1, z: 0 })) : normalize(
    add(x, scale(up, -dot(x, up))),
  );
  const left = cross(up, along); // 90° counter-clockwise from `along`, seen from above
  const h = headingDeg * DEG;
  const north = add(scale(along, Math.cos(h)), scale(left, Math.sin(h)));
  return {
    accelG: up,
    magUt: add(scale(north, FIELD_HORIZONTAL_UT), scale(up, -FIELD_DOWN_UT)),
  };
}
