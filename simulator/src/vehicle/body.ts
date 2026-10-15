// body.ts: the board's axes in the world (east/north/up), from an attitude.
//
// Vehicle frame: x forward, y left, z up, right-handed. The board frame equals it
// unless a mount rotation says otherwise (mountAxes: a board fitted turned or tilted). Angles follow the firmware's math
// (Orientation.h): roll about x, left side up positive; pitch positive nose up
// (a right-handed rate about +y lowers the nose); heading = x axis clockwise from north.
import type { Vec3 } from '../frames.ts';

const DEG = Math.PI / 180;

export interface Attitude {
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

/** The board's x, y, z axes as world (east, north, up) unit vectors. */
export interface Axes {
  x: Vec3;
  y: Vec3;
  z: Vec3;
}

export const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/** World vectors use x = east, y = north, z = up. */
export function axesOf(a: Attitude): Axes {
  const h = a.headingDeg * DEG;
  const p = a.pitchDeg * DEG;
  const r = a.rollDeg * DEG;
  const forward: Vec3 = { x: Math.sin(h) * Math.cos(p), y: Math.cos(h) * Math.cos(p), z: Math.sin(p) };
  const left0: Vec3 = { x: -Math.cos(h), y: Math.sin(h), z: 0 }; // level, before roll
  const up0 = cross(forward, left0);
  return {
    x: forward,
    y: add(scale(left0, Math.cos(r)), scale(up0, Math.sin(r))),
    z: sub(scale(up0, Math.cos(r)), scale(left0, Math.sin(r))),
  };
}

/** A world vector expressed in the board frame. */
export function toBody(axes: Axes, world: Vec3): Vec3 {
  return { x: dot(world, axes.x), y: dot(world, axes.y), z: dot(world, axes.z) };
}

/**
 * Body angular rate (rad/s, right-handed about x, y, z) that turns `prev` into `next`
 * over dt: the small-angle part of R_prev^T R_next.
 */
export function bodyRates(prev: Axes, next: Axes, dt: number): Vec3 {
  // Columns of R_next in the prev body frame: d(axis)/dt ≈ ω × axis.
  const nx = toBody(prev, next.x);
  const ny = toBody(prev, next.y);
  const nz = toBody(prev, next.z);
  return {
    x: (ny.z - nz.y) / 2 / dt,
    y: (nz.x - nx.z) / 2 / dt,
    z: (nx.y - ny.x) / 2 / dt,
  };
}

/**
 * How the board sits in the vehicle, in the same terms as an attitude relative to the
 * vehicle: yaw = board x clockwise from the vehicle's nose (seen from above), then
 * pitch (board nose up) and roll (board left side up). All 0 = x forward, z up.
 */
export interface Mount {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

export const NO_MOUNT: Mount = Object.freeze({ yawDeg: 0, pitchDeg: 0, rollDeg: 0 });

export const isMounted = (m: Mount) => m.yawDeg !== 0 || m.pitchDeg !== 0 || m.rollDeg !== 0;

/** The board's axes in the world, given the vehicle's axes and the mount. */
export function mountAxes(vehicle: Axes, m: Mount): Axes {
  if (!isMounted(m)) return vehicle;
  // axesOf() with the mount as an attitude, read with "north" = vehicle forward and "east" = right.
  const rel = axesOf({ headingDeg: m.yawDeg, pitchDeg: m.pitchDeg, rollDeg: m.rollDeg });
  const toWorld = (v: Vec3): Vec3 => add(add(scale(vehicle.x, v.y), scale(vehicle.y, -v.x)), scale(vehicle.z, v.z));
  return { x: toWorld(rel.x), y: toWorld(rel.y), z: toWorld(rel.z) };
}
