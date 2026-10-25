// common.tsx: device facts in words, shared by Overview, Diagnostics and Commission: the clock against this PC,
// the modules, where the values are kept, the last restart, one health issue.
import { causeText } from '../../restart.ts';
import type { UiState } from '../controller.ts';
import { duration, localClock, utcText } from '../model/format.ts';
import type { Issue } from '../model/health.ts';
import { screenRef } from '../model/nav.ts';
import { activeFlags, devicesPresent, type DeviceState } from '../state.ts';
import { C, MARK } from '../theme.ts';
import { bad, dim, ok, type Seg, warn } from '../ui.tsx';

/** The device's clock now (UTC epoch), from the last frame with a date; undefined while the time is unknown. */
export function deviceEpochNow(ui: UiState, nowMs: number): number | undefined {
  if (!ui.clock || ui.device.values.timeValid === false) return undefined;
  return ui.clock.epoch + Math.floor((nowMs - ui.clock.atMs) / 1000);
}

export function clockSegs(ui: UiState, nowMs: number, autoTimeSync: boolean): Seg[] {
  const epoch = deviceEpochNow(ui, nowMs);
  if (epoch === undefined) {
    return [bad('unknown'), dim(autoTimeSync ? ' · being set from this PC' : ' · [t] set it from this PC')];
  }
  const off = Math.round(epoch - nowMs / 1000);
  return [
    `${utcText(epoch)} · local ${localClock(epoch)} · `,
    Math.abs(off) <= 2
      ? ok(`${MARK.ok} same as this PC`)
      : warn(`${MARK.warn} ${duration(Math.abs(off))} ${off > 0 ? 'ahead of' : 'behind'} this PC`),
  ];
}

const MODULE_NAMES = ['EEPROM', 'RTC', 'IMU', 'compass'];

export function moduleSegs(values: DeviceState['values']): Seg[] {
  if (typeof values.devices !== 'number') return [dim('reading…')];
  return devicesPresent(values.devices).flatMap(([, present], i) => [
    present ? ok(`${MARK.ok} ${MODULE_NAMES[i]}`) : dim(`${MARK.off} ${MODULE_NAMES[i]}`),
    '   ',
  ]);
}

const SETTINGS_SOURCE = ['factory defaults', 'EEPROM copy A', 'EEPROM copy B', 'flash copy A', 'flash copy B'];

/** Where the counters and settings are kept. */
export function storageSegs(state: DeviceState): Seg[] {
  const v = state.values;
  if (v.statusFlags === undefined) return [dim('reading…')];
  const flags = activeFlags(state);
  const flash = typeof v.fwVersion === 'number' && v.fwVersion >= 0x00020600 && !flags.includes('flashStoreMissing');
  const eeprom = !flags.includes('eepromMissing');
  const source =
    typeof v.settingsSource === 'number' ? ` · settings from ${SETTINGS_SOURCE[v.settingsSource] ?? '?'}` : '';
  if (flags.includes('storageError')) return [bad(`${MARK.error} a save failed`), dim(source)];
  if (flash && eeprom) return [ok(`${MARK.ok} flash + EEPROM`), dim(source)];
  if (flash) return [ok(`${MARK.ok} ESP32 flash`), dim(` (no EEPROM)${source}`)];
  if (eeprom) return [warn(`${MARK.warn} EEPROM only`), dim(` (no flash store)${source}`)];
  return [bad(`${MARK.error} nothing is saved`), dim(' · flash the full firmware image')];
}

const RESET_REASON: Record<number, string> = {
  1: 'power-on',
  3: 'software restart',
  4: 'crash',
  5: 'watchdog',
  6: 'watchdog',
  7: 'watchdog',
  9: 'brown-out',
};

export function restartText(values: DeviceState['values']): string {
  const reason =
    typeof values.resetReason === 'number'
      ? (RESET_REASON[values.resetReason] ?? `reset reason ${values.resetReason}`)
      : '?';
  const up = typeof values.uptime === 'number' ? `, ${duration(values.uptime)} ago` : '';
  return `${reason}${up} · previous run ${causeText(values) ? `ended by ${causeText(values)}` : 'ended normally'}`;
}

/** "▲ IMU not calibrated      Tilt and vibration readings are off.        → 7 Calibrate" */
export function issueSegs(issue: Issue, width: number, selected: boolean): Seg[] {
  const mark = issue.severity === 'error' ? MARK.error : issue.severity === 'warn' ? MARK.warn : MARK.live;
  const color = issue.severity === 'error' ? C.red : issue.severity === 'warn' ? C.yellow : C.dim;
  const link = issue.screen ? `→ ${screenRef(issue.screen)}` : '';
  const title = `${mark} ${issue.title}`.padEnd(26);
  const room = Math.max(0, width - title.length - link.length - 2);
  const why = issue.why.length > room ? `${issue.why.slice(0, Math.max(0, room - 1))}…` : issue.why;
  return [
    { t: selected ? MARK.select : ' ', fg: C.cyan },
    { t: title, fg: color, bold: selected },
    why.padEnd(room),
    ' ',
    dim(link),
  ];
}
