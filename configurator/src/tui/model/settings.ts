// settings.ts: the 20 device settings as people read them: grouped by what they control, a plain label, the
// factory default, the unit, the choices, and what a change will do. Edits are staged and sent as one command (the
// device takes all of them or none). Pure; the ranges come from tags.ts SETTINGS (checked against the firmware).
import { SETTINGS, tags } from '../../tags.ts';
import type { Value } from '../state.ts';

export type SettingGroup =
  | 'ENGINE DETECTION'
  | 'TOTALIZER'
  | 'SAVING & CLOCK'
  | 'OUTPUT & PORTS'
  | 'IMU & VIBRATION'
  | 'IMU STREAM'
  | 'BLUETOOTH & SECURITY'
  | 'IMU FILTER (ADVANCED)';

export interface Choice {
  value: number | boolean;
  label: string;
}

export interface SettingUi {
  name: string;
  label: string;
  group: SettingGroup;
  unit?: string;
  /** Picked from a list (on/off, edge, port, baud) instead of typed. */
  choices?: Choice[];
  /** The value shown in words instead of a number ("off" for 0). */
  zeroLabel?: string;
  /** Factory default (esp32/lib/Storage/src/Settings.cpp defaultSettings()). */
  factory: number | boolean;
  help: string;
  advice?: string;
}

/** On screen in this order. */
export const SETTING_UI: readonly SettingUi[] = Object.freeze([
  {
    name: 'altActiveHigh',
    label: 'Running when input is',
    group: 'ENGINE DETECTION',
    choices: [
      { value: false, label: 'LOW (817 module)' },
      { value: true, label: 'HIGH' },
    ],
    factory: false,
    help: 'The input level that means the engine runs. The PC817 module pulls the input LOW.',
    advice: 'Wrong here, the meter counts while the engine is stopped.',
  },
  {
    name: 'altDebounceMs',
    label: 'Input debounce',
    group: 'ENGINE DETECTION',
    unit: 'ms',
    factory: 200,
    help: 'The engine input must hold a new level this long before it counts.',
    advice: 'Raise it if short spikes on the wire count as running.',
  },
  {
    name: 'runVibMinMg',
    label: 'Vibration threshold',
    group: 'ENGINE DETECTION',
    unit: 'mg',
    zeroLabel: 'off',
    factory: 0,
    help: 'Counts only while the vibration RMS is above this (released below 70 %). Off: the input alone decides.',
    advice: 'Measure key-on and idle vibration in 5 Live inputs; it suggests a value.',
  },
  {
    name: 'pulseRisingEdge',
    label: 'Count on edge',
    group: 'TOTALIZER',
    choices: [
      { value: false, label: 'falling' },
      { value: true, label: 'rising' },
    ],
    factory: false,
    help: 'Which edge of the pulse input counts.',
  },
  {
    name: 'pulseMinIntervalUs',
    label: 'Pulse debounce',
    group: 'TOTALIZER',
    unit: 'µs',
    factory: 1000,
    help: 'Pulses closer together than this are ignored (1000 µs caps counting at 1 kHz).',
    advice: 'Keep it below the shortest real gap between two pulses.',
  },
  {
    name: 'pulsesPerUnit',
    label: 'Pulses per unit',
    group: 'TOTALIZER',
    factory: 1,
    help: 'Scale of the totalizer in units, e.g. pulses per litre. The stored pulse count does not change.',
  },
  {
    name: 'persistIntervalS',
    label: 'Save while running every',
    group: 'SAVING & CLOCK',
    unit: 's',
    factory: 60,
    help: 'Longest gap between saves while the engine runs (it also saves at every stop).',
    advice: 'A sudden power cut loses at most this much counting.',
  },
  {
    name: 'rtcSyncIntervalS',
    label: 'Re-read the RTC every',
    group: 'SAVING & CLOCK',
    unit: 's',
    factory: 60,
    help: 'How often the device clock is corrected from the RTC (also refreshes the RTC temperature).',
  },
  {
    name: 'telemetryIntervalMs',
    label: 'Telemetry every',
    group: 'OUTPUT & PORTS',
    unit: 'ms',
    factory: 1000,
    help: 'How often the device sends the counters, engine state and health.',
  },
  {
    name: 'output',
    label: 'Live data to',
    group: 'OUTPUT & PORTS',
    choices: [
      { value: 1, label: 'USB' },
      { value: 2, label: 'UART' },
      { value: 3, label: 'both' },
    ],
    factory: 1,
    help: 'Where live data and events go (applied after the answer). USB always answers commands.',
  },
  {
    name: 'uartBaud',
    label: 'UART baud',
    group: 'OUTPUT & PORTS',
    choices: (SETTINGS.uartBaud.values ?? []).map((b) => ({ value: b, label: String(b) })),
    factory: 115200,
    help: 'Speed of the UART pins (applied after the answer). USB stays at 115200.',
  },
  {
    name: 'imuSampleHz',
    label: 'IMU sample rate',
    group: 'IMU & VIBRATION',
    unit: 'Hz',
    factory: 100,
    help: 'How often the IMU is read and filtered.',
    advice: 'Below about 26 Hz the accel + gyro calibration cannot finish.',
  },
  {
    name: 'vibrationWindowMs',
    label: 'Vibration window',
    group: 'IMU & VIBRATION',
    unit: 'ms',
    factory: 1000,
    help: 'The window of the vibration RMS and peak; also how fast the vibration threshold reacts.',
  },
  {
    name: 'streamMode',
    label: 'Stream content',
    group: 'IMU STREAM',
    choices: [
      { value: 0, label: 'off' },
      { value: 1, label: 'raw' },
      { value: 2, label: 'filtered' },
      { value: 3, label: 'both' },
    ],
    factory: 2,
    help: 'What the IMU stream sends: the sensor values, the filtered ones, or both.',
  },
  {
    name: 'imuStreamHz',
    label: 'Stream rate',
    group: 'IMU STREAM',
    unit: 'Hz',
    zeroLabel: 'off',
    factory: 10,
    help: 'IMU frames per second (0 = off); at most the IMU sample rate.',
    advice: '"both" at 100 Hz needs 230400 baud or more on the UART pins.',
  },
  {
    name: 'bluetooth',
    label: 'Bluetooth radio',
    group: 'BLUETOOTH & SECURITY',
    choices: [
      { value: false, label: 'off' },
      { value: true, label: 'on' },
    ],
    factory: false,
    help: 'Classic Bluetooth SPP, named HourMeter-XXXX (applied after the answer).',
  },
  {
    name: 'btPin',
    label: 'Bluetooth PIN',
    group: 'BLUETOOTH & SECURITY',
    factory: 1234,
    help: 'Unlocks a Bluetooth session (5 wrong tries lock it for 60 s).',
    advice: 'Change it from 1234 at installation.',
  },
  {
    name: 'kalmanQAccel',
    label: 'Accel filter',
    group: 'IMU FILTER (ADVANCED)',
    factory: 0.0005,
    help: 'Kalman process noise: higher follows faster but is noisier.',
  },
  {
    name: 'kalmanQGyro',
    label: 'Gyro filter',
    group: 'IMU FILTER (ADVANCED)',
    factory: 0.01,
    help: 'Kalman process noise: higher follows faster but is noisier.',
  },
  {
    name: 'kalmanQMag',
    label: 'Compass filter',
    group: 'IMU FILTER (ADVANCED)',
    factory: 0.05,
    help: 'Kalman process noise: higher follows faster but is noisier.',
  },
]);

export const SETTING_GROUPS: readonly SettingGroup[] = [...new Set(SETTING_UI.map((s) => s.group))];

export function settingUi(name: string): SettingUi | undefined {
  return SETTING_UI.find((s) => s.name === name);
}

const isFloat = (name: string) => tags[SETTINGS[name]?.tag]?.fmt === 'f32';

/** A number for display: floats to 4 significant digits, integers as they are. */
function numberText(name: string, v: number): string {
  return isFloat(name) ? String(Number(v.toPrecision(4))) : String(v);
}

/** Same value? (the device sends booleans for bool settings; staged values may be either). */
export function sameValue(a: Value | undefined, b: Value | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return Number(a) === Number(b);
}

/** "LOW (817 module)", "300 ms", "off", "USB", "?" while unread. The PIN shows as dots unless `reveal`. */
export function valueText(name: string, v: Value | undefined, reveal = false): string {
  if (v === undefined) return '?';
  const ui = settingUi(name);
  const choice = ui?.choices?.find((c) => sameValue(c.value, v));
  if (choice) return choice.label;
  if (name === 'btPin' && !reveal) return '••••';
  const n = Number(v);
  if (ui?.zeroLabel && n === 0) return ui.zeroLabel;
  return `${numberText(name, n)}${ui?.unit ? ` ${ui.unit}` : ''}`;
}

/** The value as it is typed into the editor (no unit, the PIN in clear). */
export function editText(name: string, v: Value | undefined): string {
  if (v === undefined) return '';
  return typeof v === 'boolean' ? String(v) : numberText(name, Number(v));
}

/** "0–5000 ms", "1–65535", "off, 1–100 Hz", or the choices. */
export function rangeText(name: string): string {
  const spec = SETTINGS[name];
  const ui = settingUi(name);
  if (!spec || !ui) return '';
  if (ui.choices) return ui.choices.map((c) => c.label).join(' / ');
  const unit = ui.unit ? ` ${ui.unit}` : '';
  if (ui.zeroLabel && spec.min === 0) return `${ui.zeroLabel} (0) or 1–${spec.max}${unit}`;
  return `${spec.min}–${spec.max}${unit}`;
}

/** Parse a typed value. An empty field is an error, never 0. */
export function parseSettingInput(name: string, text: string): { value?: number | boolean; error?: string } {
  const spec = SETTINGS[name];
  const ui = settingUi(name);
  if (!spec || !ui) return { error: 'unknown setting' };
  const t = text.trim();
  if (t === '') return { error: 'enter a value' };
  if (ui.choices) {
    const lower = t.toLowerCase();
    const choice =
      ui.choices.find((c) => c.label.toLowerCase() === lower || c.label.toLowerCase().split(' ')[0] === lower) ??
      ui.choices.find((c) => String(c.value) === lower || String(Number(c.value)) === lower);
    return choice ? { value: choice.value } : { error: `one of ${ui.choices.map((c) => c.label).join(', ')}` };
  }
  if (ui.zeroLabel && t.toLowerCase() === ui.zeroLabel) return { value: 0 };
  const n = Number(t);
  if (Number.isNaN(n)) return { error: 'not a number' };
  if (!isFloat(name) && !Number.isInteger(n)) return { error: 'must be a whole number' };
  if (n < spec.min || n > spec.max) return { error: `range ${rangeText(name)}` };
  return { value: n };
}

export interface Change {
  name: string;
  from: Value | undefined;
  to: number | boolean;
}

/** The staged values that differ from the device's, in screen order. */
export function pendingChanges(device: Record<string, Value>, draft: Record<string, number | boolean>): Change[] {
  return SETTING_UI.filter((ui) => ui.name in draft && !sameValue(device[ui.name], draft[ui.name])).map((ui) => ({
    name: ui.name,
    from: device[ui.name],
    to: draft[ui.name],
  }));
}

/** The one command that applies the changes. */
export function commandFor(changes: readonly Change[]): Record<string, number | boolean> {
  return Object.fromEntries(changes.map((c) => [c.name, c.to]));
}

/** How the TUI is connected, for the "this cuts your own link" warnings. */
export type Transport = 'serial' | 'bluetooth' | 'tcp' | 'demo';

export function transportOf(port: string, demo: boolean): Transport {
  if (demo) return 'demo';
  if (port.startsWith('tcp://')) return 'tcp';
  return /rfcomm/i.test(port) ? 'bluetooth' : 'serial';
}

export interface ReviewNote {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface ReviewContext {
  transport: Transport;
  /** The device's values (counters, flags) for the consequences. */
  values: Record<string, Value>;
  flags: readonly string[];
}

/** What applying `change` will do, beyond the new value: consequences and link warnings. */
export function reviewNotes(change: Change, ctx: ReviewContext): ReviewNote[] {
  const notes: ReviewNote[] = [];
  const to = Number(change.to);
  switch (change.name) {
    case 'pulsesPerUnit': {
      const count = ctx.values.totalCount;
      if (typeof count === 'number') {
        notes.push({
          level: 'info',
          text: `totalizer will show ${(count / to).toFixed(2)} units (now ${(count / Number(change.from ?? 1)).toFixed(2)})`,
        });
      }
      break;
    }
    case 'runVibMinMg':
      notes.push({ level: 'info', text: to > 0 ? `counts only above ${to} mg` : 'the engine input alone decides' });
      if (to > 0 && ctx.flags.includes('imuMissing')) {
        notes.push({ level: 'warn', text: 'ignored: there is no IMU' });
      }
      break;
    case 'output':
      if (ctx.transport === 'serial' && to === 2) {
        notes.push({
          level: 'error',
          text: "Over the board's USB port this link stops receiving live data and events. Commands still work, so you can set it back here.",
        });
      }
      break;
    case 'uartBaud':
      if (ctx.transport === 'serial') {
        notes.push({
          level: 'warn',
          text: `Connected through the UART pins (not USB)? Reconnect at ${to} baud afterwards.`,
        });
      }
      break;
    case 'bluetooth':
      if (ctx.transport === 'bluetooth' && to === 0) {
        notes.push({
          level: 'error',
          text: 'This turns off the radio you are connected through: the session ends. Turn it on again over USB.',
        });
      }
      break;
    case 'btPin':
      if (ctx.transport === 'bluetooth')
        notes.push({ level: 'info', text: 'the next Bluetooth session needs the new PIN' });
      if (to === 1234) notes.push({ level: 'warn', text: '1234 is the factory PIN: choose another one' });
      break;
  }
  return notes;
}

/** A rule over several settings, checked on the values after the change. */
export function crossCheck(after: Record<string, Value>): string | undefined {
  const stream = Number(after.imuStreamHz);
  const sample = Number(after.imuSampleHz);
  if (Number.isFinite(stream) && Number.isFinite(sample) && stream > sample) {
    return `Stream rate (${stream} Hz) must not be above the IMU sample rate (${sample} Hz).`;
  }
  return undefined;
}

/** Differs from the factory default? */
export function changedFromFactory(name: string, v: Value | undefined): boolean {
  const ui = settingUi(name);
  return ui !== undefined && v !== undefined && !sameValue(ui.factory, v);
}
