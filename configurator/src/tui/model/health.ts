// health.ts: every status flag (tags.ts STATUS_FLAGS) in plain words: how bad it is, why it matters, what fixes it
// and which screen does it. Severity depends on the context (a missing EEPROM is fine once the ESP32 flash keeps
// the values; "IMU not calibrated" means nothing without an IMU; while the I2C bus is switched off or parked no
// module answers, and that is the one thing to look at). Pure.
//
//   error   act now: counts or settings are not kept, safe mode, a parked I2C bus, a stuck IMU
//   warn    to check: time, calibration, an empty journal, bus errors
//   info    worth knowing, not a problem: factory settings, a fresh EEPROM, no compass fitted, I2C switched off
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
    title: 'Safe mode',
    why: 'Three unplanned restarts in a row (watchdog, crash or USB stall); RTC, IMU and EEPROM are skipped until the next restart.',
    fix: 'Reboot the device (8 Diagnostics). If it keeps restarting, the restart cause there says why.',
    screen: 'diagnostics',
  },
  flashStoreMissing: {
    severity: 'warn',
    title: 'No flash store',
    why: 'An app-only update kept the old partition table: only the EEPROM keeps the values.',
    fix: 'Flash the full firmware image.',
    screen: 'firmware',
  },
  i2cParked: {
    severity: 'error',
    title: 'I2C bus parked',
    why: 'The bus kept failing, so the device released it: the RTC, IMU and EEPROM count as missing. The hour meter keeps counting; the bus is retried automatically.',
    fix: 'Unplug the modules one at a time. Check the wiring, the pull-ups and that the MPU9250 AD0 pin is tied to 3.3 V (address 0x69, else it clashes with the RTC at 0x68).',
    screen: 'diagnostics',
  },
  i2cOff: {
    severity: 'info',
    title: 'I2C off (hour meter only)',
    why: 'The I2C modules setting is off: the RTC, IMU and EEPROM are not used. The hour meter keeps counting and saving in the ESP32 flash; this PC sets the time after each start.',
    fix: 'To use the modules, switch I2C modules back on.',
    screen: 'settings',
  },
};

export interface HealthContext {
  /** Firmware version (0x00MMmmpp), for the EEPROM rule. */
  fwVersion?: number;
  /** The TUI sets the device clock by itself when it is unknown. */
  autoTimeSync?: boolean;
  /** i2cLines (tag 64): the lines a parked bus found held low. Undefined until a full status has said. */
  i2cLines?: number;
}

/** What `i2cLines` says about a parked bus: bit 0 SDA held low, bit 1 SCL held low, 0 both lines free. */
export function i2cLinesText(lines: number): string {
  const held = [lines & 1 ? 'SDA' : '', lines & 2 ? 'SCL' : ''].filter(Boolean);
  return held.length ? `${held.join(' and ')} held low` : 'both lines free but transfers time out';
}

/**
 * Why the I2C modules are not in use, when they are not: the setting is off, the bus is parked after trouble, or
 * safe mode skips it.
 */
export function i2cIdleReason(flags: readonly string[]): string | undefined {
  if (flags.includes('i2cOff')) return 'I2C off';
  if (flags.includes('i2cParked')) return 'I2C bus parked';
  return flags.includes('safeMode') ? 'safe mode skips I2C' : undefined;
}

/** What follows from an idle bus and is not a problem of its own (a missing EEPROM has its own rule below). */
const IDLE_BUS_CONSEQUENCES = ['rtcMissing', 'imuNotCalibrated', 'magNotCalibrated', 'i2cErrors'];

/** One flag in plain words, with the severity it has next to the other flags. */
export function issueFor(flag: string, flags: readonly string[], ctx: HealthContext = {}): Issue {
  const base = CATALOG[flag] ?? { severity: 'warn' as const, title: flag, why: 'Unknown status flag.' };
  const issue: Issue = { flag, ...base };
  const has = (f: string) => flags.includes(f);
  if (flag === 'eepromMissing') {
    // The flags i2cOff and i2cParked exist only in firmware 2.7.0 and newer, so they say the flash keeps the values too
    // (safeMode does not: firmware 2.4.0 and 2.5.0 have it, but no flash store).
    const flashFirmware =
      (ctx.fwVersion !== undefined && ctx.fwVersion >= FLASH_STORE_FIRMWARE) || has('i2cOff') || has('i2cParked');
    const flashKeeps = flashFirmware && !has('flashStoreMissing');
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
  // The bus is off or parked: no module answers. That is one problem (or a choice), not one per module; the time
  // stays a warning, as it is lost at the next restart.
  const idle = i2cIdleReason(flags);
  if (idle && IDLE_BUS_CONSEQUENCES.includes(flag)) {
    return { ...issue, severity: 'info', why: `Not a separate problem: ${idle}.`, fix: undefined };
  }
  if (flag === 'i2cParked' && ctx.i2cLines !== undefined) {
    const lines = i2cLinesText(ctx.i2cLines);
    return { ...issue, why: `${lines[0].toUpperCase()}${lines.slice(1)}. ${issue.why}` };
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
  ['I2C bus', ['i2cErrors', 'i2cParked', 'i2cOff']],
  ['not in safe mode', ['safeMode']],
];

export function okAreas(flags: readonly string[]): string[] {
  return OK_AREAS.filter(([, list]) => !list.some((f) => flags.includes(f))).map(([label]) => label);
}

/** Every known flag (for the "all checks" list on Diagnostics). */
export const ALL_FLAGS: readonly string[] = Object.keys(CATALOG);
