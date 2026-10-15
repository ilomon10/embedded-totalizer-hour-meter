// sim.ts: one simulated vehicle carrying the hour meter. Ties the parts together:
//   physics (models.ts, 100 Hz) -> sensor readings (imu-synth.ts) -> the firmware's
//   IMU pipeline (pipeline.ts, at imuSampleHz) -> the values the device reports,
// plus a reference dead-reckoning estimate fed with the frames the host receives.
// The device (device.ts) asks advance() each poll and reads inputValues().
import type { Calibration, Settings } from '../frames.ts';
import type { Message } from '../protocol.ts';
import type { InputValues } from '../inputs.ts';
import { type Mount, NO_MOUNT } from './body.ts';
import { DeadReckoner, type Estimator, type HeadingSource, readImuFrame } from './dead-reckoning.ts';
import { MountCalibrator, type MountCalStatus, type MountCalStep } from './mount-cal.ts';
import { StrapdownIns } from './strapdown.ts';
import { type LatLon, LocalFrame } from './geo.ts';
import { ImuSynth, type RawSample } from './imu-synth.ts';
import { type Controls, makeVehicle, NO_CONTROLS, STEP_S, Truck, type Vehicle, type VehicleKind } from './models.ts';
import { FirmwarePipeline, type PipelineOutput } from './pipeline.ts';
import { RouteFollower, type RoutePlan } from './route.ts';

export type DriveMode = 'idle' | 'live' | 'route';

const LIVE_TIMEOUT_MS = 500; // no controls for this long: brake (a closed tab must not keep driving)
const WARM_UP_MS = 3000; // parked with the engine running after placing, like a real start: the
// estimator learns gravity at a true standstill before anything moves
const MAX_STEPS_PER_ADVANCE = 50; // after a long pause, catch up at most 0.5 s
const TRACK_EVERY_S = 0.5;
const TRACK_MAX_POINTS = 7200; // one hour at 2 points per second

export interface TrackPoint {
  lat: number;
  lon: number;
  /** estimate, same moment */
  elat: number;
  elon: number;
  t: number;
}

export interface VehicleSnapshot {
  kind: VehicleKind;
  origin: LatLon;
  mode: DriveMode;
  playing: boolean;
  routeDone: boolean;
  truth: {
    lat: number;
    lon: number;
    alt: number;
    headingDeg: number;
    pitchDeg: number;
    rollDeg: number;
    speed: number;
  };
  estimate: { lat: number; lon: number; headingDeg: number; speed: number; samples: number };
  errorM: number;
  distanceM: number;
  elapsedS: number;
  sinceAnchorS: number;
  headingSource: HeadingSource;
  controls: Controls;
  /** the gear engaged: 'R' while the truck may back up */
  gear: 'D' | 'R';
  route: RoutePlan | null;
  /** how the board is fitted (truth; trucks only) */
  mount: Mount;
  /** the host-side mounting calibration (level + front) */
  mountCal: MountCalStatus;
}

export interface VehicleOptions {
  kind: VehicleKind;
  origin: LatLon;
  headingDeg?: number;
  random: () => number;
}

export class VehicleSim {
  readonly kind: VehicleKind;
  readonly frame: LocalFrame;
  private vehicle: Vehicle;
  private synth: ImuSynth;
  private pipeline = new FirmwarePipeline();
  private dr: Estimator;
  private mountCal = new MountCalibrator();
  private mount: Mount = NO_MOUNT;
  private mode: DriveMode = 'idle';
  private playing = false;
  private plan: RoutePlan | null = null;
  private follower: RouteFollower | null = null;
  private live: Controls = NO_CONTROLS;
  private liveAtMs = 0;
  private applied: Controls = NO_CONTROLS;
  private lastMs: number | null = null;
  private stepCarryS = 0;
  private sampleCarryS = 0;
  private ideal: RawSample | null = null;
  private out: PipelineOutput | null = null;
  private configured = '';
  private startMs = 0;
  private parkedUntilMs = Infinity;
  private anchorMs = 0;
  private nowMs = 0;
  private distance = 0;
  private track: TrackPoint[] = [];
  private trackSeq = 0;
  private lastTrackS = -Infinity;
  private trackResets = 0;

  constructor(opts: VehicleOptions) {
    this.kind = opts.kind;
    this.frame = new LocalFrame(opts.origin);
    this.vehicle = makeVehicle(opts.kind, opts.headingDeg ?? 0);
    // Ground vehicles: gravity learned while parked + zero-velocity updates. Aircraft: a strapdown INS.
    this.dr = opts.kind === 'plane' ? new StrapdownIns() : new DeadReckoner();
    this.synth = new ImuSynth(opts.random);
    this.anchor();
  }

  // --------------------------------------------------------------- driving ----

  setMode(mode: DriveMode): void {
    this.mode = mode;
    if (mode !== 'route') this.playing = false;
  }

  setLive(c: Controls, nowMs: number): void {
    this.mode = 'live';
    this.live = c;
    this.liveAtMs = nowMs;
  }

  setRoute(plan: RoutePlan | null): void {
    this.plan = plan;
    this.follower = plan ? new RouteFollower(this.frame, plan, this.kind) : null;
    this.playing = false;
  }

  play(): void {
    if (!this.plan) return;
    if (!this.follower || this.follower.done) this.follower = new RouteFollower(this.frame, this.plan, this.kind);
    this.mode = 'route';
    this.playing = true;
  }

  pause(): void {
    this.playing = false;
  }

  stop(): void {
    this.playing = false;
    if (this.plan) this.follower = new RouteFollower(this.frame, this.plan, this.kind);
  }

  /** A simulated GPS fix: the estimate jumps to the truth and starts drifting again. */
  anchor(): void {
    const s = this.vehicle.state;
    this.dr.anchor(s);
    this.anchorMs = this.nowMs;
  }

  /** Refit the board in the vehicle (trucks only: the plane's INS aligns to the airframe). */
  setMount(m: Mount): void {
    if (this.kind !== 'truck') return;
    this.mount = { ...m };
    this.synth.setMount(this.mount);
  }

  /** Run a mounting calibration step on the frames the host receives. */
  calibrateMount(step: MountCalStep): void {
    this.mountCal.start(step);
    if (this.dr instanceof DeadReckoner) this.dr.mount = this.mountCal.result();
  }

  setHeadingSource(source: HeadingSource): void {
    this.dr.headingSource = source;
  }

  clearTracks(): void {
    this.track = [];
    this.trackResets++;
    this.distance = 0;
    this.startMs = this.nowMs;
  }

  // ------------------------------------------------------------ simulation ----

  private controlsNow(): Controls {
    const s = this.vehicle.state;
    if (this.kind === 'truck' && this.nowMs < this.parkedUntilMs) return { ...NO_CONTROLS, brake: 1 };
    if (this.mode === 'live') {
      return this.nowMs - this.liveAtMs > LIVE_TIMEOUT_MS ? { ...NO_CONTROLS, brake: 0.6 } : this.live;
    }
    if (this.mode === 'route' && this.playing && this.follower) {
      const c = this.follower.controls(s);
      if (this.follower.done) this.playing = false;
      return c;
    }
    // idle / paused: hold still (a plane keeps flying straight at its current speed)
    return this.kind === 'plane' ? { throttle: 0.35, brake: 0, steer: 0, pitch: 0 } : { ...NO_CONTROLS, brake: 1 };
  }

  /** Step physics up to `nowMs` and run the firmware pipeline at the device's sample rate. */
  advance(nowMs: number, settings: Settings, cal: Calibration): void {
    const key = `${settings.imuSampleHz}|${settings.vibrationWindowMs}|${settings.kalmanQAccel}|${JSON.stringify(cal)}`;
    if (key !== this.configured) {
      this.pipeline.configure(settings, cal);
      this.configured = key;
    }
    if (this.lastMs === null) {
      this.lastMs = nowMs;
      this.startMs = nowMs;
      this.anchorMs = nowMs;
      this.parkedUntilMs = nowMs + WARM_UP_MS;
      // Real sensor values from the very first frame: otherwise the device would send the
      // default animation's (tilted) IMU values once, and a host would learn the wrong "up".
      this.ideal = this.synth.ideal(this.vehicle.state);
      this.out = this.pipeline.process(this.synth.noisy(this.ideal, this.vehicle.vibrationMg()), 0.01);
    }
    this.stepCarryS += (nowMs - this.lastMs) / 1000;
    this.lastMs = nowMs;
    const samplePeriodS = 1 / Math.max(1, Math.min(100, Number(settings.imuSampleHz))); // physics is 100 Hz
    let steps = 0;
    while (this.stepCarryS >= STEP_S && steps < MAX_STEPS_PER_ADVANCE) {
      this.stepCarryS -= STEP_S;
      steps++;
      this.nowMs = nowMs - this.stepCarryS * 1000;
      this.applied = this.controlsNow();
      const before = { e: this.vehicle.state.e, n: this.vehicle.state.n };
      this.vehicle.step(this.applied);
      this.distance += Math.hypot(this.vehicle.state.e - before.e, this.vehicle.state.n - before.n);
      this.ideal = this.synth.ideal(this.vehicle.state);
      this.sampleCarryS += STEP_S;
      if (this.sampleCarryS + 1e-9 >= samplePeriodS) {
        this.sampleCarryS -= samplePeriodS;
        this.out = this.pipeline.process(this.synth.noisy(this.ideal, this.vehicle.vibrationMg()), samplePeriodS);
      }
    }
    if (steps === MAX_STEPS_PER_ADVANCE) this.stepCarryS = 0; // drop the backlog instead of fast-forwarding
    this.nowMs = nowMs;
    this.recordTrack();
  }

  private recordTrack(): void {
    const t = (this.nowMs - this.startMs) / 1000;
    if (t - this.lastTrackS < TRACK_EVERY_S) return;
    this.lastTrackS = t;
    const truth = this.frame.toLatLon(this.vehicle.state);
    const est = this.dr.estimate();
    const e = this.frame.toLatLon({ e: est.e, n: est.n, u: 0 });
    this.track.push({ lat: truth.lat, lon: truth.lon, elat: e.lat, elon: e.lon, t });
    this.trackSeq++;
    if (this.track.length > TRACK_MAX_POINTS) this.track.splice(0, this.track.length - TRACK_MAX_POINTS);
  }

  /** Every frame the device sends: the dead-reckoner reads the IMU stream like a host would. */
  onFrame(msg: Message, nowMs: number): void {
    this.dr.onFrame(msg, nowMs / 1000);
    const r = readImuFrame(msg);
    if (!r) return;
    const wasDone = this.mountCal.result() !== null;
    this.mountCal.feed(r, nowMs / 1000);
    if (!wasDone && this.dr instanceof DeadReckoner) this.dr.mount = this.mountCal.result();
  }

  /** What the device reports while this vehicle drives it (groups in 'vehicle' mode). */
  inputValues(): Partial<InputValues> {
    const o = this.out;
    if (!o) return { engine: { running: true } };
    const fuel = 0.8 + this.applied.throttle * 9; // pulses/s: idle flow plus throttle
    return {
      engine: { running: true },
      pulses: { perSecond: fuel },
      motion: { rollDeg: o.rollDeg, pitchDeg: o.pitchDeg, headingDeg: o.headingDeg },
      vibration: o.vibration ?? { rmsMg: this.vehicle.vibrationMg(), peakMg: this.vehicle.vibrationMg() * 3 },
      imu: {
        accelG: o.accelG,
        gyroDps: o.gyroDps,
        magUt: o.magUt,
        rawAccelG: o.rawAccelG,
        rawGyroDps: o.rawGyroDps,
        rawMagUt: o.rawMagUt,
      },
    };
  }

  // ------------------------------------------------------------ reporting ----

  snapshot(): VehicleSnapshot {
    const s = this.vehicle.state;
    const truth = this.frame.toLatLon(s);
    const est = this.dr.estimate();
    const estLL = this.frame.toLatLon({ e: est.e, n: est.n, u: 0 });
    return {
      kind: this.kind,
      origin: this.frame.origin,
      mode: this.mode,
      playing: this.playing,
      routeDone: this.follower?.done ?? false,
      truth: {
        lat: truth.lat,
        lon: truth.lon,
        alt: s.u,
        headingDeg: s.headingDeg,
        pitchDeg: s.pitchDeg,
        rollDeg: s.rollDeg,
        speed: s.speed,
      },
      estimate: { lat: estLL.lat, lon: estLL.lon, headingDeg: est.headingDeg, speed: est.speed, samples: est.samples },
      errorM: Math.hypot(est.e - s.e, est.n - s.n),
      distanceM: this.distance,
      elapsedS: (this.nowMs - this.startMs) / 1000,
      sinceAnchorS: (this.nowMs - this.anchorMs) / 1000,
      headingSource: this.dr.headingSource,
      controls: this.applied,
      gear: this.vehicle instanceof Truck && this.vehicle.engaged === -1 ? 'R' : 'D',
      route: this.plan,
      mount: this.mount,
      mountCal: this.mountCal.status(),
    };
  }

  /** Track points after `since` (a cursor from a previous call); `reset` = start over. */
  trackSince(since: number, resets: number): { points: TrackPoint[]; cursor: number; resets: number; reset: boolean } {
    const reset = resets !== this.trackResets;
    const first = this.trackSeq - this.track.length; // seq of track[0]
    const from = reset ? 0 : Math.max(0, since - first);
    return { points: this.track.slice(from), cursor: this.trackSeq, resets: this.trackResets, reset };
  }
}
