// health.ts: every status flag (tags.ts STATUS_FLAGS) in plain words: how bad it is, why it matters, what fixes it
// and which screen does it. Severity depends on the context (a missing EEPROM is fine once the ESP32 flash keeps
// the values; "IMU not calibrated" means nothing without an IMU). Pure.
//
//   error   act now: counts or settings are not kept, safe mode, a stuck IMU
//   warn    to check: time, calibration, an empty journal, bus errors
//   info    worth knowing, not a problem: factory settings, a fresh EEPROM, no compass fitted
import type { ScreenId } from './nav.ts';

export type Severity = 'error' | 'warn' | 'info';

export interface Issue {
  flag: string;
  severity: Severity;
  title: string;
  /** Why it matters, one sentence. */
  why: string;
  /** What to do, if anything. */
  fix?: string;
  /** The screen that fixes it. */
  screen?: ScreenId;
}

type Entry = Omit<Issue, 'flag'>;

const FLASH_STORE_FIRMWARE = 0x00020600; // 2.6.0 keeps settings + counters in the ESP32's flash too

const CATALOG: Record<string, Entry> = {
  eepromMissing: {
    severity: 'error',
    title: 'No EEPROM',
    why: 'This firmware keeps the counters only in the EEPROM, so nothing is saved.',
    fix: 'Fit the EEPROM, or update to firmware 2.6.0 or newer (it saves in the ESP32 flash).',
    screen: 'firmware',
  },
  rtcMissing: {
    severity: 'warn',
    title: 'No RTC',
    why: 'Frames carry the uptime instead of the date.',
    fix: 'Fit the DS3231 RTC. Until then the time is set from this PC after every boot.',
    screen: 'diagnostics',
  },
  timeInvalid: {
    severity: 'warn',
    title: 'Time unknown',
    why: 'Saves and frames have no date.',
    fix: 'Set the time from this PC.',
    screen: 'overview',
  },
  imuMissing: {
    severity: 'info',
    title: 'No IMU',
    why: 'No tilt, heading or vibration; the vibration threshold is ignored.',
    screen: 'diagnostics',
  },
  magMissing: {
    severity: 'info',
    title: 'No compass',
    why: 'No heading (normal on boards with an MPU-6500).',
  },
  imuNotCalibrated: {
    severity: 'warn',
    title: 'IMU not calibrated',
    why: 'Tilt and vibration are inaccurate.',
    fix: 'Calibrate accel + gyro: board flat and still, about 5 s.',
    screen: 'calibrate',
  },
  magNotCalibrated: {
    severity: 'warn',
    title: 'Compass not calibrated',
    why: 'The heading is off.',
    fix: 'Calibrate the compass: rotate the board in every direction.',
    screen: 'calibrate',
  },
  settingsDefaults: {
    severity: 'info',
    title: 'Factory settings',
    why: 'No saved settings were found at boot.',
    fix: 'On a unit that was set up before, apply its settings again.',
    screen: 'settings',
  },
  journalEmpty: {
    severity: 'warn',
    title: 'Hour meter started at 0',
    why: 'No saved hour meter was found at boot.',
    fix: 'If the machine already had hours, set the counters.',
    screen: 'counters',
  },
  storageError: {
    severity: 'error',
    title: 'Saving failed',
    why: 'A save to flash or EEPROM failed; the device keeps retrying.',
    fix: 'If it stays, the storage is faulty: service the device.',
    screen: 'diagnostics',
  },
  imuStuck: {
    severity: 'error',
    title: 'IMU stuck',
    why: 'The IMU sends the same sample over and over: it is dead or a fake chip.',
    fix: 'Replace the IMU. With a vibration threshold set, the hours stop counting.',
    screen: 'diagnostics',
  },
  imuSaturated: {
    severity: 'info',
    title: 'IMU over range',
    why: 'A shock above ±4 g or ±500 °/s in the last interval.',
  },
  i2cErrors: {
    severity: 'warn',
    title: 'I2C bus errors',
    why: 'Bus errors since boot (one glitch from plugging a module in is enough).',
    fix: 'If the count keeps rising, check the I2C wiring and pull-ups.',
    screen: 'diagnostics',
  },
  eepromFormatted: {
    severity: 'info',
    title: 'EEPROM formatted',
    why: 'A blank or foreign EEPROM was set up at boot (normal for a new chip).',
  },
  calibrating: {
    severity: 'info',
    title: 'Calibrating',
    why: 'A calibration is running.',
    screen: 'calibrate',
  },
  rtcBatteryLost: {
    severity: 'warn',
    title: 'RTC battery lost',
    why: 'The time was lost while the power was off.',
    fix: 'Fit a CR2032 (or a permanent battery feed).',
    screen: 'diagnostics',
  },
  timeNotBackedUp: {
    severity: 'warn',
    title: 'Time not backed up',
    why: 'The time is kept in RAM only and is lost at the next restart.',
    fix: 'Fit an RTC with a battery.',
    screen: 'diagnostics',
  },
  settingsNotSaved: {
    severity: 'error',
    title: 'Settings not saved',
    why: 'Changed settings are lost at the next restart: there is no store.',
    fix: 'Flash the full firmware image, or fit an EEPROM.',
    screen: 'firmware',
  },
  safeMode: {
    severity: 'error',
    title: 'Safe mode: I2C off',
    why: 'Three unplanned restarts in a row; RTC, IMU and EEPROM are skipped.',
    fix: 'Fix the bus fault (a loose or shorted module), then reboot.',
    screen: 'diagnostics',
  },
  flashStoreMissing: {
    severity: 'warn',
    title: 'No flash store',
    why: 'An app-only update kept the old partition table: only the EEPROM keeps the values.',
    fix: 'Flash the full firmware image.',
    screen: 'firmware',
  },
};

export interface HealthContext {
  /** Firmware version (0x00MMmmpp), for the EEPROM rule. */
  fwVersion?: number;
  /** The TUI sets the device clock by itself when it is unknown. */
  autoTimeSync?: boolean;
}

/** One flag in plain words, with the severity it has next to the other flags. */
export function issueFor(flag: string, flags: readonly string[], ctx: HealthContext = {}): Issue {
  const base = CATALOG[flag] ?? { severity: 'warn' as const, title: flag, why: 'Unknown status flag.' };
  const issue: Issue = { flag, ...base };
  const has = (f: string) => flags.includes(f);
  if (flag === 'eepromMissing') {
    const flashKeeps =
      ctx.fwVersion !== undefined && ctx.fwVersion >= FLASH_STORE_FIRMWARE && !has('flashStoreMissing');
    if (flashKeeps) {
      return {
        ...issue,
        severity: 'info',
        why: 'The counters and settings are kept in the ESP32 flash (no second copy).',
        fix: undefined,
      };
    }
    if (has('flashStoreMissing')) {
      return { ...issue, title: 'Nothing is saved', why: 'No EEPROM and no flash store.', screen: 'firmware' };
    }
  }
  if (flag === 'flashStoreMissing' && has('eepromMissing')) return { ...issue, severity: 'error' };
  if (flag === 'timeInvalid' && ctx.autoTimeSync) {
    return { ...issue, severity: 'info', why: 'It is being set from this PC.', fix: undefined };
  }
  if (flag === 'imuNotCalibrated' && has('imuMissing')) return { ...issue, severity: 'info', fix: undefined };
  return issue;
}

const RANK: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

/** All flags as issues, worst first. */
export function issues(flags: readonly string[], ctx: HealthContext = {}): Issue[] {
  return flags.map((f) => issueFor(f, flags, ctx)).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}

/** The problems only (errors and warnings): what the Overview and the sidebar badge count. */
export function problems(flags: readonly string[], ctx: HealthContext = {}): Issue[] {
  return issues(flags, ctx).filter((i) => i.severity !== 'info');
}

export interface HealthSummary {
  level: 'ok' | 'warn' | 'error' | 'unknown';
  /** "✔ healthy", "▲ 2 to check", "✖ 1 fault". */
  text: string;
  count: number;
}

export function summary(flags: readonly string[] | undefined, ctx: HealthContext = {}): HealthSummary {
  if (flags === undefined) return { level: 'unknown', text: '… reading', count: 0 };
  const list = problems(flags, ctx);
  const errors = list.filter((i) => i.severity === 'error').length;
  if (errors) return { level: 'error', text: `✖ ${errors} fault${errors > 1 ? 's' : ''}`, count: list.length };
  if (list.length) return { level: 'warn', text: `▲ ${list.length} to check`, count: list.length };
  return { level: 'ok', text: '✔ healthy', count: 0 };
}

/** Areas that are fine when none of their flags is set: "✔ storage  ✔ clock  ✔ modules ...". */
const OK_AREAS: ReadonlyArray<[string, readonly string[]]> = [
  ['storage', ['storageError', 'settingsNotSaved', 'flashStoreMissing', 'journalEmpty']],
  ['clock', ['timeInvalid', 'rtcBatteryLost', 'timeNotBackedUp', 'rtcMissing']],
  ['modules', ['eepromMissing', 'imuMissing', 'imuStuck']],
  ['I2C bus', ['i2cErrors']],
  ['not in safe mode', ['safeMode']],
];

export function okAreas(flags: readonly string[]): string[] {
  return OK_AREAS.filter(([, list]) => !list.some((f) => flags.includes(f))).map(([label]) => label);
}

/** Every known flag (for the "all 20 checks" list on Diagnostics). */
export const ALL_FLAGS: readonly string[] = Object.keys(CATALOG);
