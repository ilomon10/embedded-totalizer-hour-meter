// commission.ts: the 8 install steps of the Commission screen and their checks, worked out from what the device
// reports (and, for the engine input, from 3 s of live readings taken when the technician says the engine is off
// or running). Progress is kept per device id (tui/store.ts), so a half-done install can be continued. Pure.
import { formatFirmware, compareVersions } from '../../releases.ts';
import { activeFlags, devicesPresent, type DeviceState } from '../state.ts';
import { between, type LiveSample } from './history.ts';

export type StepId = 'identify' | 'modules' | 'engine' | 'pulse' | 'clock' | 'calibrate' | 'counters' | 'finish';

export interface StepDef {
  id: StepId;
  n: number;
  label: string;
  intro: string;
  optional?: boolean;
}

export const STEPS: readonly StepDef[] = Object.freeze([
  { id: 'identify', n: 1, label: 'Identify device', intro: 'Which board this is, and is its firmware the latest?' },
  {
    id: 'modules',
    n: 2,
    label: 'Modules & storage',
    intro: 'Tick the modules fitted on this board: they must answer.',
  },
  {
    id: 'engine',
    n: 3,
    label: 'Engine input',
    intro: 'The meter must count only while the engine runs, not at key-on.',
  },
  { id: 'pulse', n: 4, label: 'Pulse input', intro: 'Pulses from the flow meter must be counted.', optional: true },
  { id: 'clock', n: 5, label: 'Clock', intro: 'The device keeps UTC, set from this PC.' },
  {
    id: 'calibrate',
    n: 6,
    label: 'Calibrate IMU',
    intro: 'Accel + gyro with the board level; the compass is optional.',
  },
  {
    id: 'counters',
    n: 7,
    label: 'Counters',
    intro: 'Preset the hours and totalizer from the old meter, if any.',
    optional: true,
  },
  {
    id: 'finish',
    n: 8,
    label: 'Security & finish',
    intro: 'Bluetooth locked down, then a service report for the records.',
  },
]);

export type StepMark = 'done' | 'skipped';

export interface Fitted {
  eeprom: boolean;
  rtc: boolean;
  imu: boolean;
  mag: boolean;
}

export interface Verdict {
  ok: boolean;
  detail: string;
}

export interface Progress {
  marks: Partial<Record<StepId, StepMark>>;
  /** The modules the technician says are fitted (default: the ones that answer). */
  fitted?: Fitted;
  engineOff?: Verdict;
  engineOn?: Verdict;
  /** The totalizer when watching for pulses started. */
  pulseFrom?: number;
  reportSaved?: boolean;
  updatedAt?: string;
}

export const emptyProgress = (): Progress => ({ marks: {} });

export type CheckStatus = 'ok' | 'fail' | 'wait' | 'todo';

export interface Check {
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface CheckContext {
  state: DeviceState;
  progress: Progress;
  /** The newest firmware release ("2.7.0"), once the release list is in. */
  latest?: string;
}

/** The I2C modules: their key, name, and bit in the device's module mask. */
export const MODULES: ReadonlyArray<[keyof Fitted, string, number]> = [
  ['eeprom', 'EEPROM', 0],
  ['rtc', 'RTC', 1],
  ['imu', 'IMU', 2],
  ['mag', 'compass', 3],
];

/** The modules that answer now, as the default "fitted" ticks. */
export function presentModules(state: DeviceState): Fitted | undefined {
  const mask = state.values.devices;
  if (typeof mask !== 'number') return undefined;
  const [eeprom, rtc, imu, mag] = devicesPresent(mask).map(([, present]) => present);
  return { eeprom, rtc, imu, mag };
}

/**
 * The engine-input check over 3 s of live readings. Off: the input must stay off (on means the wire is live at
 * key-on). Running: the meter must count (input on but not counted means the vibration threshold holds it back).
 */
export function engineVerdict(
  samples: readonly LiveSample[],
  fromMs: number,
  toMs: number,
  expect: 'off' | 'on',
): Verdict {
  const window = between(samples, fromMs, toMs).filter((s) => s.altInput !== undefined);
  if (window.length === 0) return { ok: false, detail: 'no readings from the device' };
  const inputOn = window.some((s) => s.altInput);
  const counted = window.some((s) => s.alternator);
  if (expect === 'off') {
    return inputOn
      ? { ok: false, detail: 'input ON with the engine off: the wire is live at key-on (IG/ACC)' }
      : { ok: true, detail: 'input off, not counting' };
  }
  if (counted) return { ok: true, detail: 'input on, counting' };
  return inputOn
    ? { ok: false, detail: 'input on but not counting: the vibration threshold holds it back' }
    : { ok: false, detail: 'input stays OFF: check the wire and the 817 module' };
}

/** The checks of one step, from the device's state and the progress so far. */
export function checks(step: StepId, ctx: CheckContext): Check[] {
  const { state, progress } = ctx;
  const v = state.values;
  const flags = activeFlags(state);
  const has = (f: string) => flags.includes(f);
  const known = v.statusFlags !== undefined;
  switch (step) {
    case 'identify': {
      const fw = formatFirmware(v.fwVersion);
      const firmware: Check =
        fw === '?'
          ? { label: 'Firmware', status: 'wait', detail: 'reading…' }
          : ctx.latest === undefined
            ? { label: 'Firmware', status: 'ok', detail: `${fw} (release list not loaded)` }
            : compareVersions(ctx.latest, fw) > 0
              ? { label: 'Firmware', status: 'fail', detail: `${fw}: ${ctx.latest} is available (9 Firmware)` }
              : { label: 'Firmware', status: 'ok', detail: `${fw}, the latest` };
      return [
        state.deviceId === undefined
          ? { label: 'Device id', status: 'wait', detail: 'waiting for the first frame' }
          : {
              label: 'Device id',
              status: 'ok',
              detail: (state.deviceId >>> 0).toString(16).toUpperCase().padStart(8, '0'),
            },
        firmware,
      ];
    }
    case 'modules': {
      const present = presentModules(state);
      if (!present || !known) return [{ label: 'Modules', status: 'wait', detail: 'reading the device status…' }];
      const fitted = progress.fitted ?? present;
      const list: Check[] = MODULES.filter(([key]) => fitted[key]).map(([key, name]) => ({
        label: name,
        status: present[key] ? 'ok' : 'fail',
        detail: present[key] ? 'answers' : 'fitted but does not answer: check its wiring',
      }));
      const fwOk = typeof v.fwVersion === 'number' && v.fwVersion >= 0x00020600;
      const storeOk = (fwOk && !has('flashStoreMissing')) || present.eeprom;
      list.push({
        label: 'Storage',
        status: has('storageError') || has('settingsNotSaved') || !storeOk ? 'fail' : 'ok',
        detail: has('storageError')
          ? 'a save failed'
          : !storeOk
            ? 'nowhere to keep the counters: flash the full image or fit an EEPROM'
            : fwOk && !has('flashStoreMissing')
              ? `ESP32 flash${present.eeprom ? ' + EEPROM' : ''}`
              : 'EEPROM only',
      });
      list.push({
        label: 'Safe mode',
        status: has('safeMode') ? 'fail' : 'ok',
        detail: has('safeMode') ? 'on: fix the I2C fault, then reboot (8 Diagnostics)' : 'off',
      });
      return list;
    }
    case 'engine':
      return [
        progress.engineOff
          ? {
              label: 'a) Key ON, engine OFF',
              status: progress.engineOff.ok ? 'ok' : 'fail',
              detail: progress.engineOff.detail,
            }
          : { label: 'a) Key ON, engine OFF', status: 'todo', detail: 'then press Enter to check' },
        progress.engineOn
          ? {
              label: 'b) Engine running',
              status: progress.engineOn.ok ? 'ok' : 'fail',
              detail: progress.engineOn.detail,
            }
          : { label: 'b) Engine running', status: 'todo', detail: 'start the engine, then press Enter' },
      ];
    case 'pulse': {
      const count = typeof v.totalCount === 'number' ? v.totalCount : undefined;
      if (progress.pulseFrom === undefined || count === undefined) {
        return [{ label: 'Pulses counted', status: 'todo', detail: 'press Enter, then let product flow' }];
      }
      const counted = count - progress.pulseFrom;
      return [
        counted > 0
          ? { label: 'Pulses counted', status: 'ok', detail: `+${counted} since you started` }
          : { label: 'Pulses counted', status: 'wait', detail: 'none yet: let product flow' },
      ];
    }
    case 'clock':
      if (!known) return [{ label: 'Time', status: 'wait', detail: 'reading…' }];
      return [
        v.timeValid === true && !has('timeInvalid')
          ? { label: 'Time', status: 'ok', detail: 'set (UTC)' }
          : { label: 'Time', status: 'fail', detail: 'unknown: press t to set it from this PC' },
        has('rtcMissing')
          ? { label: 'RTC', status: 'fail', detail: 'no RTC: the time is lost at every restart' }
          : has('rtcBatteryLost') || has('timeNotBackedUp')
            ? {
                label: 'RTC battery',
                status: 'fail',
                detail: 'the time is not kept when the power is off: fit a CR2032',
              }
            : { label: 'RTC battery', status: 'ok', detail: 'keeps the time' },
      ];
    case 'calibrate': {
      if (!known) return [{ label: 'IMU', status: 'wait', detail: 'reading…' }];
      if (has('imuMissing')) return [{ label: 'IMU', status: 'ok', detail: 'no IMU fitted: nothing to calibrate' }];
      const list: Check[] = [
        has('imuNotCalibrated')
          ? { label: 'Accel + gyro', status: 'todo', detail: 'press Enter to open 7 Calibrate' }
          : { label: 'Accel + gyro', status: 'ok', detail: 'calibrated' },
      ];
      if (!has('magMissing')) {
        list.push(
          has('magNotCalibrated')
            ? { label: 'Compass (optional)', status: 'todo', detail: 'only needed for the heading' }
            : { label: 'Compass (optional)', status: 'ok', detail: 'calibrated' },
        );
      }
      return list;
    }
    case 'counters': {
      const hours = typeof v.runSeconds === 'number' ? `${(v.runSeconds / 3600).toFixed(2)} h` : '?';
      const total = typeof v.totalCount === 'number' ? `${v.totalCount} pulses` : '?';
      return [
        { label: 'Now', status: progress.marks.counters === 'done' ? 'ok' : 'todo', detail: `${hours} · ${total}` },
      ];
    }
    case 'finish': {
      const bt = state.settings.bluetooth;
      const pin = Number(state.settings.btPin);
      return [
        bt === undefined
          ? { label: 'Bluetooth', status: 'wait', detail: 'reading the settings…' }
          : !bt
            ? { label: 'Bluetooth', status: 'ok', detail: 'off' }
            : pin === 1234
              ? { label: 'Bluetooth', status: 'fail', detail: 'on with the factory PIN 1234: change it (6 Settings)' }
              : { label: 'Bluetooth', status: 'ok', detail: 'on, PIN changed' },
        progress.reportSaved
          ? { label: 'Service report', status: 'ok', detail: 'saved' }
          : { label: 'Service report', status: 'todo', detail: 'press Enter to open 3 Report' },
      ];
    }
  }
}

/** A step passes when no check failed or is still open. */
export function passed(list: readonly Check[]): boolean {
  return list.length > 0 && list.every((c) => c.status === 'ok');
}

/** Steps marked done or skipped. */
export function doneCount(progress: Progress): number {
  return STEPS.filter((s) => progress.marks[s.id]).length;
}
