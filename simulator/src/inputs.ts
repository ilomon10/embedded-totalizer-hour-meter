// inputs.ts: what the simulated sensors "measure", group by group.
//
// Every group is either `auto` (the built-in animation: engine cycle, gentle
// tilt, engine vibration, sensor noise) or `manual` (held at a value set from the
// web UI). Pure functions only: device.ts asks effectiveInputs() for the values
// of the moment and turns them into frames exactly like the firmware would.
import type { Vec3 } from './frames.ts';

export type Mode = 'auto' | 'manual';

export interface EngineInput {
  running: boolean;
}
export interface PulsesInput {
  perSecond: number;
}
export interface MotionInput {
  rollDeg: number;
  pitchDeg: number;
  headingDeg: number;
}
export interface VibrationInput {
  rmsMg: number;
  peakMg: number;
}
export interface ImuInput {
  accelG: Vec3;
  gyroDps: Vec3;
  magUt: Vec3;
  rawAccelG: Vec3;
  rawGyroDps: Vec3;
  rawMagUt: Vec3;
}
export interface RtcInput {
  tempC: number;
  /** false: the RTC has no backup battery and loses its time at the next power-on. */
  battery: boolean;
}
export interface ErrorsInput {
  i2cErrors: number;
  overruns: number;
}
export interface FlagsInput {
  imuStuck: boolean;
  imuSaturated: boolean;
  storageError: boolean;
  eepromFormatted: boolean;
}

export interface InputValues {
  engine: EngineInput;
  pulses: PulsesInput;
  motion: MotionInput;
  vibration: VibrationInput;
  imu: ImuInput;
  rtc: RtcInput;
  errors: ErrorsInput;
  flags: FlagsInput;
}

export type Group = keyof InputValues;
export const GROUPS: readonly Group[] = ['engine', 'pulses', 'motion', 'vibration', 'imu', 'rtc', 'errors', 'flags'];

/** Manual values plus the mode of every group. */
export interface Inputs {
  modes: Record<Group, Mode>;
  manual: InputValues;
}

/** What auto mode needs to know about the moment. */
export interface AutoContext {
  /** Seconds since boot. */
  t: number;
  /** Engine state from --engine or the engine-cycle scenario. */
  engineOn: boolean;
  pulsesPerSecond: number;
  rtcBattery: boolean;
  random: () => number;
}

const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export function defaultInputs(): Inputs {
  const modes = Object.fromEntries(GROUPS.map((g) => [g, 'auto'])) as Record<Group, Mode>;
  return {
    modes,
    manual: {
      engine: { running: true },
      pulses: { perSecond: 3.5 },
      motion: { rollDeg: 0, pitchDeg: 0, headingDeg: 0 },
      vibration: { rmsMg: 35, peakMg: 98 },
      imu: {
        accelG: { x: 0, y: 0, z: 1 },
        gyroDps: ZERO,
        magUt: ZERO,
        rawAccelG: { x: 0, y: 0, z: 1 },
        rawGyroDps: ZERO,
        rawMagUt: ZERO,
      },
      rtc: { tempC: 29.25, battery: true },
      errors: { i2cErrors: 0, overruns: 0 },
      flags: { imuStuck: false, imuSaturated: false, storageError: false, eepromFormatted: false },
    },
  };
}

function jitter(v: Vec3, n: (s: number) => number, scale: number): Vec3 {
  return { x: v.x + n(scale), y: v.y + n(scale), z: v.z + n(scale) };
}

/** The built-in animation (what the simulator always did before the web UI). */
export function autoValues(ctx: AutoContext): InputValues {
  const { t, engineOn, random } = ctx;
  const n = (scale: number) => (random() - 0.5) * scale;
  const shake = engineOn ? 0.04 : 0.003;
  const accelG: Vec3 = { x: n(shake), y: n(shake), z: 1 + n(shake) };
  const gyroDps: Vec3 = { x: n(0.3), y: n(0.3), z: n(0.3) };
  const magUt: Vec3 = { x: 30 + n(0.5), y: -5 + n(0.5), z: -40 + n(0.5) };
  const rmsMg = engineOn ? 35 + random() * 8 : 2 + random();
  return {
    engine: { running: engineOn },
    pulses: { perSecond: ctx.pulsesPerSecond },
    motion: { rollDeg: 1.5 + Math.sin(t / 7), pitchDeg: -0.8 + Math.cos(t / 9), headingDeg: (t * 3) % 360 },
    vibration: { rmsMg, peakMg: rmsMg * 2.8 },
    imu: {
      accelG,
      gyroDps,
      magUt,
      rawAccelG: jitter(accelG, n, 0.05),
      rawGyroDps: jitter(gyroDps, n, 2),
      rawMagUt: jitter(magUt, n, 3),
    },
    rtc: { tempC: 29.25, battery: ctx.rtcBattery },
    errors: { i2cErrors: 0, overruns: 0 },
    flags: { imuStuck: false, imuSaturated: false, storageError: false, eepromFormatted: false },
  };
}

/** Manual groups hold their value; auto groups take this moment's animation. */
export function effectiveInputs(inputs: Inputs, ctx: AutoContext): InputValues {
  const auto = autoValues(ctx);
  const pick = <G extends Group>(g: G): InputValues[G] => (inputs.modes[g] === 'manual' ? inputs.manual[g] : auto[g]);
  return {
    engine: pick('engine'),
    pulses: pick('pulses'),
    motion: pick('motion'),
    vibration: pick('vibration'),
    imu: pick('imu'),
    rtc: pick('rtc'),
    errors: pick('errors'),
    flags: pick('flags'),
  };
}

/**
 * Switch a group to manual and change some of its values. A group that was auto
 * starts from the values it shows right now, so touching one slider does not
 * make the others jump.
 */
export function setManual<G extends Group>(
  inputs: Inputs,
  group: G,
  current: InputValues[G],
  patch: Partial<InputValues[G]>,
): Inputs {
  const base = inputs.modes[group] === 'auto' ? current : inputs.manual[group];
  return {
    modes: { ...inputs.modes, [group]: 'manual' },
    manual: { ...inputs.manual, [group]: { ...base, ...patch } },
  };
}

export function setAuto(inputs: Inputs, group: Group): Inputs {
  return { modes: { ...inputs.modes, [group]: 'auto' }, manual: inputs.manual };
}
