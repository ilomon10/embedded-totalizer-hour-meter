// imu-synth.ts: what the MPU9250 on the board would measure while the vehicle moves.
//
//   accelerometer: specific force f = (a_world - g_world) in the board frame, in g.
//                  At rest that is +1 g on z; braking, turning and climbing add to it.
//   gyroscope:     the board's rotation rate, right-handed about x, y, z, in deg/s.
//   magnetometer:  the earth's field (north + down) in the board frame, in uT.
// Accelerations and rotation rates come from the motion itself (differences between
// 100 Hz steps), so they are exactly consistent with the path drawn on the map.
import type { Vec3 } from '../frames.ts';
import { FIELD_DOWN_UT, FIELD_HORIZONTAL_UT } from '../attitude.ts';
import { add, type Axes, axesOf, bodyRates, scale, toBody } from './body.ts';
import { STEP_S, type VehicleState } from './models.ts';

const G = 9.80665;
const RAD = 180 / Math.PI;
const FIELD_WORLD: Vec3 = { x: 0, y: FIELD_HORIZONTAL_UT, z: -FIELD_DOWN_UT }; // east, north, up

export interface RawSample {
  accelG: Vec3;
  gyroDps: Vec3;
  magUt: Vec3;
}

export class ImuSynth {
  private prevAxes: Axes | null = null;
  private prevVel: Vec3 | null = null;
  private spare: number | null = null;

  constructor(private readonly random: () => number) {}

  /** Standard normal random number (Box-Muller, one cached). */
  private gauss(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    const u = Math.max(1e-12, this.random());
    const v = this.random();
    const m = Math.sqrt(-2 * Math.log(u));
    this.spare = m * Math.sin(2 * Math.PI * v);
    return m * Math.cos(2 * Math.PI * v);
  }

  private noise(sigma: number): Vec3 {
    return { x: this.gauss() * sigma, y: this.gauss() * sigma, z: this.gauss() * sigma };
  }

  /** The ideal (noise-free) readings for this step, given the state after it. */
  ideal(s: VehicleState): RawSample {
    const axes = axesOf(s);
    const vel: Vec3 = { x: s.ve, y: s.vn, z: s.vu };
    const aWorld = this.prevVel
      ? scale({ x: vel.x - this.prevVel.x, y: vel.y - this.prevVel.y, z: vel.z - this.prevVel.z }, 1 / STEP_S)
      : { x: 0, y: 0, z: 0 };
    const rates = this.prevAxes ? bodyRates(this.prevAxes, axes, STEP_S) : { x: 0, y: 0, z: 0 };
    this.prevAxes = axes;
    this.prevVel = vel;
    return {
      accelG: toBody(axes, add(scale(aWorld, 1 / G), { x: 0, y: 0, z: 1 })),
      gyroDps: scale(rates, RAD),
      magUt: toBody(axes, FIELD_WORLD),
    };
  }

  /** A sample as the sensor reports it: ideal readings plus vibration (RMS, mg) and sensor noise. */
  noisy(ideal: RawSample, vibrationMg: number): RawSample {
    const vib = vibrationMg / 1000 / Math.sqrt(3); // per-axis sigma so the vector RMS is vibrationMg
    return {
      accelG: add(add(ideal.accelG, this.noise(vib)), this.noise(0.004)),
      gyroDps: add(add(ideal.gyroDps, this.noise(vibrationMg * 0.004)), this.noise(0.05)),
      magUt: add(ideal.magUt, this.noise(0.4)),
    };
  }

  reset(): void {
    this.prevAxes = null;
    this.prevVel = null;
  }
}
