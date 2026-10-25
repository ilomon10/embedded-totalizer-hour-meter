// pipeline.ts: the firmware's IMU pipeline, ported line by line, so the simulator
// reports what the device would compute from the same samples:
//   esp32/lib/Filters/src/KalmanAngle.h   roll/pitch: accel angle + gyro rate
//   esp32/lib/Filters/src/Kalman1D.h      per-axis smoothing of accel, gyro, mag
//   esp32/lib/Filters/src/Vibration.h     high-pass + RMS/peak over a window
//   esp32/lib/Filters/src/Compass.h       calibration + tilt-compensated heading
//   esp32/lib/App/src/ImuPipeline.cpp     configure() and updateFilters()
// Including the real behaviour in turns: centripetal acceleration tilts the
// accelerometer's idea of "down", and the Kalman filter partly believes it.
import { headingFromMag, pitchFromAccel, rollFromAccel, upVector } from '../attitude.ts';
import type { Calibration, Settings, Vec3 } from '../frames.ts';
import type { RawSample } from './imu-synth.ts';

const MAG_NOISE_VAR = 0.36; // ImuPipeline::kMagNoiseVar
const GRAVITY_CUTOFF_HZ = 0.5; // VibrationMeter::kGravityCutoffHz

const f32 = Math.fround;

/** KalmanAngle.h */
export class KalmanAngle {
  qAngle = 0.001;
  qBias = 0.003;
  rMeasure = 0.03;
  private angle = 0;
  private bias = 0;
  private p = [
    [0, 0],
    [0, 0],
  ];
  private initialized = false;

  update(accelAngleDeg: number, gyroRateDps: number, dt: number): number {
    if (!this.initialized || !(dt > 0) || dt > 1) {
      this.reset(accelAngleDeg);
      return this.angle;
    }
    const p = this.p;
    const rate = gyroRateDps - this.bias;
    this.angle += dt * rate;
    p[0][0] += dt * (dt * p[1][1] - p[0][1] - p[1][0] + this.qAngle);
    p[0][1] -= dt * p[1][1];
    p[1][0] -= dt * p[1][1];
    p[1][1] += this.qBias * dt;
    const s = p[0][0] + this.rMeasure;
    const k0 = p[0][0] / s;
    const k1 = p[1][0] / s;
    const y = accelAngleDeg - this.angle;
    this.angle += k0 * y;
    this.bias += k1 * y;
    const p00 = p[0][0];
    const p01 = p[0][1];
    p[0][0] -= k0 * p00;
    p[0][1] -= k0 * p01;
    p[1][0] -= k1 * p00;
    p[1][1] -= k1 * p01;
    return this.angle;
  }

  reset(angleDeg: number): void {
    this.angle = angleDeg;
    this.bias = 0;
    this.p = [
      [0, 0],
      [0, 0],
    ];
    this.initialized = true;
  }

  value(): number {
    return this.angle;
  }
}

/** Kalman1D.h */
export class Kalman1D {
  private x = 0;
  private p = 1;
  private initialized = false;

  constructor(
    private q = 0.001,
    private r = 0.01,
  ) {}

  setNoise(q: number, r: number): void {
    this.q = q > 0 ? q : 1e-9;
    this.r = r > 0 ? r : 1e-9;
  }

  update(z: number): number {
    if (!this.initialized) {
      this.x = z;
      this.p = this.r;
      this.initialized = true;
      return this.x;
    }
    this.p += this.q;
    const k = this.p / (this.p + this.r);
    this.x += k * (z - this.x);
    this.p *= 1 - k;
    return this.x;
  }
}

/** Vibration.h */
export class VibrationMeter {
  private alpha = 0.03;
  private window = 100;
  private count = 0;
  private sumSq = 0;
  private peak = 0;
  private gravity: Vec3 = { x: 0, y: 0, z: 0 };
  private gravityInit = false;

  configure(sampleHz: number, windowSamples: number): void {
    const dt = 1 / (sampleHz > 0 ? sampleHz : 100);
    const rc = 1 / (2 * 3.14159265 * GRAVITY_CUTOFF_HZ);
    this.alpha = dt / (rc + dt);
    this.window = windowSamples === 0 ? 1 : windowSamples;
    this.count = 0;
    this.sumSq = 0;
    this.peak = 0;
  }

  add(a: Vec3): { rmsMg: number; peakMg: number } | null {
    if (!this.gravityInit) {
      this.gravity = { ...a };
      this.gravityInit = true;
    }
    const g = this.gravity;
    this.gravity = {
      x: g.x + (a.x - g.x) * this.alpha,
      y: g.y + (a.y - g.y) * this.alpha,
      z: g.z + (a.z - g.z) * this.alpha,
    };
    const mg = Math.hypot(a.x - this.gravity.x, a.y - this.gravity.y, a.z - this.gravity.z) * 1000;
    this.sumSq += mg * mg;
    this.peak = Math.max(this.peak, mg);
    this.count++;
    if (this.count < this.window) return null;
    const out = { rmsMg: Math.sqrt(this.sumSq / this.count), peakMg: this.peak };
    this.count = 0;
    this.sumSq = 0;
    this.peak = 0;
    return out;
  }
}

export interface PipelineOutput {
  rawAccelG: Vec3;
  rawGyroDps: Vec3;
  rawMagUt: Vec3;
  accelG: Vec3;
  gyroDps: Vec3;
  magUt: Vec3;
  rollDeg: number;
  pitchDeg: number;
  headingDeg: number;
  vibration: { rmsMg: number; peakMg: number } | null;
}

const vsub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vmul = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });
const AXES = ['x', 'y', 'z'] as const;

/** ImuPipeline.cpp: configure() + updateFilters() + the vibration meter. */
export class FirmwarePipeline {
  private accelKf = AXES.map(() => new Kalman1D());
  private gyroKf = AXES.map(() => new Kalman1D());
  private magKf = AXES.map(() => new Kalman1D());
  private rollKf = new KalmanAngle();
  private pitchKf = new KalmanAngle();
  private vib = new VibrationMeter();
  private cal!: Calibration;
  private lastVibration: { rmsMg: number; peakMg: number } | null = null;

  configure(settings: Settings, cal: Calibration): void {
    this.cal = cal;
    AXES.forEach((axis, i) => {
      this.accelKf[i].setNoise(Number(settings.kalmanQAccel), cal.accelNoiseVar[axis]);
      this.gyroKf[i].setNoise(Number(settings.kalmanQGyro), cal.gyroNoiseVar[axis]);
      this.magKf[i].setNoise(Number(settings.kalmanQMag), MAG_NOISE_VAR);
    });
    const hz = Number(settings.imuSampleHz);
    const window = Math.floor((hz * Number(settings.vibrationWindowMs)) / 1000);
    this.vib.configure(hz, window === 0 ? 1 : window);
    this.lastVibration = null;
  }

  process(sample: RawSample, dtS: number): PipelineOutput {
    const c = this.cal;
    const a = vsub(sample.accelG, c.accelBiasG);
    const g = vsub(sample.gyroDps, c.gyroBiasDps);
    const smooth = (kf: Kalman1D[], v: Vec3): Vec3 => ({
      x: f32(kf[0].update(v.x)),
      y: f32(kf[1].update(v.y)),
      z: f32(kf[2].update(v.z)),
    });
    const accelG = smooth(this.accelKf, a);
    const gyroDps = smooth(this.gyroKf, g);
    const accRoll = rollFromAccel(a);
    if (Math.abs(accRoll - this.rollKf.value()) > 180) this.rollKf.reset(accRoll); // crossed the ±180 seam
    const rollDeg = this.rollKf.update(accRoll, g.x, dtS);
    const pitchDeg = this.pitchKf.update(pitchFromAccel(a), -g.y, dtS); // a +y rate lowers the nose (ImuPipeline.cpp)
    const m = vmul(vsub(sample.magUt, c.magOffsetUt), c.magScale);
    const magUt = smooth(this.magKf, m);
    const headingDeg = headingFromMag(magUt, upVector(rollDeg, pitchDeg));
    const window = this.vib.add(a);
    if (window) this.lastVibration = window;
    return {
      rawAccelG: sample.accelG,
      rawGyroDps: sample.gyroDps,
      rawMagUt: sample.magUt,
      accelG,
      gyroDps,
      magUt,
      rollDeg,
      pitchDeg,
      headingDeg,
      vibration: this.lastVibration,
    };
  }
}
