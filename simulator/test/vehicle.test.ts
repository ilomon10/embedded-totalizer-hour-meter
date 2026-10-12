// vehicle.test.ts: the vehicle physics, the sensor readings derived from them, the
// firmware pipeline port, route following, track parsing and dead reckoning.
import { assert, assertEquals } from './assert.ts';
import { pitchFromAccel, rollFromAccel, upVector } from '../src/attitude.ts';
import { axesOf, toBody } from '../src/vehicle/body.ts';
import { DeadReckoner } from '../src/vehicle/dead-reckoning.ts';
import { distanceM, LocalFrame } from '../src/vehicle/geo.ts';
import { ImuSynth } from '../src/vehicle/imu-synth.ts';
import { initialState, Plane, STEP_S, Truck } from '../src/vehicle/models.ts';
import { KalmanAngle } from '../src/vehicle/pipeline.ts';
import { RouteFollower } from '../src/vehicle/route.ts';
import { parseCsv, parseGpx, parseTrack } from '../src/vehicle/tracks.ts';
import { MSG, rec } from '../src/protocol.ts';
import { createRng } from '../src/clock.ts';

const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

Deno.test('body axes agree with the firmware: world up in the board frame is upVector(roll, pitch)', () => {
  for (const [roll, pitch, heading] of [[0, 0, 0], [20, -10, 75], [-35, 15, 300], [5, 40, 180]]) {
    const up = toBody(axesOf({ rollDeg: roll, pitchDeg: pitch, headingDeg: heading }), { x: 0, y: 0, z: 1 });
    const want = upVector(roll, pitch);
    assert(near(up.x, want.x, 1e-9) && near(up.y, want.y, 1e-9) && near(up.z, want.z, 1e-9), `${roll}/${pitch}`);
  }
});

Deno.test('geo: metres <-> lat/lon round trip, and a 1 km step is 1 km', () => {
  const frame = new LocalFrame({ lat: -1.2654, lon: 116.8312 });
  const p = frame.toLatLon({ e: 1000, n: 0, u: 0 });
  assert(near(distanceM(frame.origin, p), 1000, 2));
  const back = frame.toEnu(p);
  assert(near(back.e, 1000, 1e-6) && near(back.n, 0, 1e-6));
});

Deno.test('truck: constant steer drives a circle of radius L / tan(steer), and the IMU feels v²/r', () => {
  const truck = new Truck(initialState(0));
  const synth = new ImuSynth(() => 0.5);
  const steer = 0.3; // 10.5°: a gentle, truck-like circle
  for (let i = 0; i < 2500; i++) truck.step({ throttle: i < 600 ? 0.5 : 0.2, brake: 0, steer, pitch: 0 });
  synth.ideal(truck.state);
  let horizontalG = 0;
  let yawDps = 0;
  const v = truck.state.speed;
  for (let i = 0; i < 100; i++) {
    const before = truck.state.speed;
    truck.step({ throttle: 0.2, brake: 0, steer, pitch: 0 });
    truck.state.speed = before; // hold speed exactly for a clean check
    const s = synth.ideal(truck.state);
    // Rotate the measured specific force back to the world and remove gravity: what is left is v²/r.
    const ax = axesOf(truck.state);
    const f = s.accelG;
    const world = {
      x: ax.x.x * f.x + ax.y.x * f.y + ax.z.x * f.z,
      y: ax.x.y * f.x + ax.y.y * f.y + ax.z.y * f.z,
      z: ax.x.z * f.x + ax.y.z * f.y + ax.z.z * f.z - 1,
    };
    horizontalG += Math.hypot(world.x, world.y) / 100;
    yawDps += -s.gyroDps.z / 100; // clockwise turn = negative rate about +z (board level enough)
  }
  const radius = Truck.WHEELBASE_M / Math.tan(steer * Truck.MAX_STEER_DEG * Math.PI / 180);
  const expectedG = (v * v) / radius / 9.80665;
  assert(near(horizontalG, expectedG, expectedG * 0.03), `horizontal ${horizontalG} g, expected ${expectedG}`);
  assert(near(yawDps, (v / radius) * 180 / Math.PI, 0.6), `yaw ${yawDps} °/s`);
});

Deno.test('truck: full lock at speed is limited by tyre grip (about 0.45 g), not by geometry', () => {
  const truck = new Truck(initialState(0, 0, 16)); // 58 km/h
  const synth = new ImuSynth(() => 0.5);
  synth.ideal(truck.state);
  let maxHorizontal = 0;
  for (let i = 0; i < 300; i++) {
    truck.step({ throttle: 0.4, brake: 0, steer: 1, pitch: 0 });
    const f = synth.ideal(truck.state).accelG;
    const ax = axesOf(truck.state); // back to the world: grip limits the horizontal force
    const wx = ax.x.x * f.x + ax.y.x * f.y + ax.z.x * f.z;
    const wy = ax.x.y * f.x + ax.y.y * f.y + ax.z.y * f.z;
    if (i > 0) maxHorizontal = Math.max(maxHorizontal, Math.hypot(wx, wy));
  }
  assert(maxHorizontal < 0.5, `horizontal ${maxHorizontal.toFixed(3)} g`);
});

Deno.test('plane: a coordinated turn has no sideways force; turn rate = g·tan(bank)/v', () => {
  const plane = new Plane(initialState(0, 300, Plane.CRUISE));
  const synth = new ImuSynth(() => 0.5);
  for (let i = 0; i < 800; i++) plane.step({ throttle: 0.35, brake: 0, steer: 0.6, pitch: 0 }); // bank settles at 27°
  let side = 0;
  let start = plane.state.headingDeg;
  synth.ideal(plane.state);
  for (let i = 0; i < 100; i++) {
    plane.step({ throttle: 0.35, brake: 0, steer: 0.6, pitch: 0 });
    side += Math.abs(synth.ideal(plane.state).accelG.y) / 100;
  }
  const turned = ((plane.state.headingDeg - start + 360) % 360) / (100 * STEP_S);
  const bank = 0.6 * Plane.MAX_BANK_DEG * Math.PI / 180;
  const expected = (9.80665 * Math.tan(bank)) / plane.state.speed * 180 / Math.PI;
  assert(side < 0.01, `side force ${side} g`);
  assert(near(turned, expected, 0.3), `turn ${turned} °/s, expected ${expected}`);
  start = 0;
});

Deno.test('KalmanAngle port: first sample resets, then it tracks a step change', () => {
  const k = new KalmanAngle();
  assertEquals(k.update(10, 0, 0.01), 10);
  let a = 10;
  for (let i = 0; i < 500; i++) a = k.update(20, 0, 0.01);
  assert(near(a, 20, 0.5), `angle ${a}`);
});

Deno.test('route follower: a truck reaches every corner of a square and stops at the end', () => {
  const frame = new LocalFrame({ lat: 0, lon: 0 });
  const corners = [[0, 0], [150, 0], [150, 150], [0, 150]].map(([e, n]) => frame.toLatLon({ e, n, u: 0 }));
  const follower = new RouteFollower(frame, { waypoints: corners, speed: 10, loop: false }, 'truck');
  const truck = new Truck(initialState(90));
  let closest = [Infinity, Infinity, Infinity, Infinity];
  for (let i = 0; i < 20000 && !follower.done; i++) {
    truck.step(follower.controls(truck.state));
    closest = closest.map((d, j) => {
      const c = frame.toEnu(corners[j]);
      return Math.min(d, Math.hypot(c.e - truck.state.e, c.n - truck.state.n));
    });
  }
  assert(follower.done, 'route finished');
  assert(closest.every((d) => d < 12), `closest approach per corner: ${closest.map((d) => d.toFixed(1))}`);
  assert(truck.state.speed < 2, `stopped at the end (${truck.state.speed} m/s)`);
});

Deno.test('route follower: a plane flies every leg, even when it cuts the corners', () => {
  const frame = new LocalFrame({ lat: 0, lon: 0 });
  const legs = [[0, 0], [600, 300], [700, -300], [0, -350]].map(([e, n]) => frame.toLatLon({ e, n, u: 0 }));
  const follower = new RouteFollower(frame, { waypoints: legs, speed: 55, alt: 300, loop: false }, 'plane');
  const plane = new Plane(initialState(Math.atan2(600, 300) * 180 / Math.PI, 300, 55));
  let closest = [Infinity, Infinity, Infinity];
  for (let i = 0; i < 12000 && !follower.done; i++) {
    plane.step(follower.controls(plane.state));
    closest = closest.map((d, j) => {
      const c = frame.toEnu(legs[j + 1]);
      return Math.min(d, Math.hypot(c.e - plane.state.e, c.n - plane.state.n));
    });
  }
  assert(follower.done, 'route finished (no orbiting)');
  assert(closest.every((d) => d < 200), `closest approach per turn point: ${closest.map((d) => d.toFixed(0))}`);
});

Deno.test('tracks: GPX and CSV with times become waypoints with speeds', () => {
  const gpx = `<gpx><trk><trkseg>
    <trkpt lat="-1.0000" lon="116.0000"><ele>10</ele><time>2026-10-12T00:00:00Z</time></trkpt>
    <trkpt lat="-1.0009" lon="116.0000"><ele>12</ele><time>2026-10-12T00:00:10Z</time></trkpt>
  </trkseg></trk></gpx>`;
  assertEquals(parseGpx(gpx).length, 2);
  const w = parseTrack('drive.gpx', gpx);
  assert(near(w[1].speed ?? 0, 10, 0.2), `speed ${w[1].speed}`); // 100 m in 10 s
  assertEquals(w[1].alt, 2);
  const csv = 'time,lat,lon\n0,-1,116\n20,-1.0009,116\n';
  assertEquals(parseCsv(csv).length, 2);
  assert(near(parseTrack('t.csv', csv)[1].speed ?? 0, 5, 0.1));
});

/**
 * A realistic short trip from a standstill: accelerate, weave through gentle
 * curves, brake to a stop. The dead-reckoner is anchored while stopped (so it
 * learns gravity) and fed quantized IMU frames at `hz`. Returns the final error, m.
 */
function trip(hz: number): number {
  const truck = new Truck(initialState(45));
  const synth = new ImuSynth(createRng(7)); // real sensors vibrate: seeded, so the test is repeatable
  const dr = new DeadReckoner('still');
  synth.ideal(truck.state);
  dr.anchor({ ...truck.state, speed: 0 });
  const every = Math.round(100 / hz);
  const seconds = 42;
  for (let i = 1; i <= seconds * 100; i++) {
    const t = i * STEP_S;
    const c = t < 2
      ? { throttle: 0, brake: 1, steer: 0, pitch: 0 } // parked: the anchor learns gravity here
      : t < 12
      ? { throttle: 0.5, brake: 0, steer: 0, pitch: 0 }
      : t < 32
      ? { throttle: 0.15, brake: 0, steer: Math.sin(t / 3) * 0.12, pitch: 0 }
      : { throttle: 0, brake: 0.4, steer: 0, pitch: 0 };
    truck.step(c);
    const ideal = synth.ideal(truck.state);
    if (i % every !== 0) continue;
    const s = synth.noisy(ideal, truck.vibrationMg());
    const a = s.accelG;
    const g = s.gyroDps;
    dr.onFrame({
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
    }, t);
  }
  const est = dr.estimate();
  return Math.hypot(est.e - truck.state.e, est.n - truck.state.n);
}

Deno.test('dead reckoning from the wire data follows a 40 s trip, and drifts more at a low stream rate', () => {
  const fast = trip(100);
  const slow = trip(5);
  // About 10% of 166 m: suspension squat under acceleration tilts gravity onto the forward axis,
  // which no IMU-only method can tell apart from acceleration. Real, not a simulator bug.
  assert(fast < 30, `100 Hz: ${fast.toFixed(1)} m after the trip`);
  assert(slow > fast, `5 Hz drift (${slow.toFixed(1)} m) should exceed 100 Hz drift (${fast.toFixed(1)} m)`);
});

Deno.test('right after a vehicle is attached, the first IMU frame already carries its gravity', async () => {
  const { makeDevice } = await import('./helpers.ts');
  const { VehicleSim } = await import('../src/vehicle/sim.ts');
  const { command } = await import('./helpers.ts');
  const { device, run, sent } = makeDevice();
  device.powerOn();
  device.onCommand(command(1, { imuStreamHz: 100 })); // an IMU frame on every 10 ms poll
  device.setInput('motion', { rollDeg: 8, pitchDeg: -6 }); // a tilted animation before the vehicle arrives
  run(100);
  const before = sent.length;
  device.attachVehicle(new VehicleSim({ kind: 'truck', origin: { lat: -6.17, lon: 106.82 }, random: () => 0.5 }));
  run(10); // the very next poll: before the vehicle has taken a single physics step
  const first = sent.slice(before).find((s) => s.msg.msgType === MSG.IMU)?.msg;
  assert(first, 'an IMU frame after attaching');
  const a = first.values as Record<string, number>;
  // a level, parked truck: gravity straight down the board's z axis (within sensor noise)
  assert(Math.abs(a.accelX) < 0.02 && Math.abs(a.accelY) < 0.02 && Math.abs(a.accelZ - 1) < 0.02, JSON.stringify(a));
});

/** Fly the 3-leg route with banked turns, feeding a strapdown INS quantized samples at `hz`. */
async function flight(hz: number): Promise<{ errorM: number; distanceM: number }> {
  const { StrapdownIns } = await import('../src/vehicle/strapdown.ts');
  const frame = new LocalFrame({ lat: 0, lon: 0 });
  const legs = [[0, 0], [600, 300], [700, -300], [0, -350]].map(([e, n]) => frame.toLatLon({ e, n, u: 0 }));
  const follower = new RouteFollower(frame, { waypoints: legs, speed: 55, alt: 300, loop: false }, 'plane');
  const plane = new Plane(initialState(Math.atan2(600, 300) * 180 / Math.PI, 300, 55));
  const synth = new ImuSynth(createRng(3));
  const ins = new StrapdownIns();
  const feed = (
    sample: { accelG: { x: number; y: number; z: number }; gyroDps: { x: number; y: number; z: number } },
    t: number,
  ) =>
    ins.onFrame({
      msgType: MSG.IMU,
      timestamp: 0,
      records: [
        rec('accelX', Math.round(sample.accelG.x * 1000)),
        rec('accelY', Math.round(sample.accelG.y * 1000)),
        rec('accelZ', Math.round(sample.accelG.z * 1000)),
        rec('gyroX', Math.round(sample.gyroDps.x * 10)),
        rec('gyroY', Math.round(sample.gyroDps.y * 10)),
        rec('gyroZ', Math.round(sample.gyroDps.z * 10)),
      ],
    }, t);
  feed(synth.noisy(synth.ideal(plane.state), plane.vibrationMg()), 0); // the stream was already running
  ins.anchor(plane.state);
  const every = Math.round(100 / hz);
  let distanceM = 0;
  for (let i = 1; i <= 6000; i++) {
    const before = { e: plane.state.e, n: plane.state.n };
    plane.step(follower.controls(plane.state));
    distanceM += Math.hypot(plane.state.e - before.e, plane.state.n - before.n);
    const ideal = synth.ideal(plane.state);
    if (i % every !== 0) continue;
    feed(synth.noisy(ideal, plane.vibrationMg()), i * STEP_S);
  }
  const est = ins.estimate();
  return { errorM: Math.hypot(est.e - plane.state.e, est.n - plane.state.n), distanceM };
}

Deno.test('strapdown INS follows a plane through banked turns (where accelerometer tilt fails)', async () => {
  const fast = await flight(100);
  const slow = await flight(10);
  assert(
    fast.errorM / fast.distanceM < 0.03,
    `100 Hz: ${fast.errorM.toFixed(0)} m after ${fast.distanceM.toFixed(0)} m`,
  );
  assert(
    slow.errorM > fast.errorM,
    `10 Hz (${slow.errorM.toFixed(0)} m) should drift more than 100 Hz (${fast.errorM.toFixed(0)} m)`,
  );
});
