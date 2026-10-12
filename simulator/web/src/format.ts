// format.ts: small display helpers. Flag and module names come from the shared
// tag table (configurator/src/tags.ts), the same file the device tools use.
import { decodeStatusFlags } from '../../../configurator/src/tags.ts';

export { BT_STATE, SETTINGS, STATUS_FLAGS } from '../../../configurator/src/tags.ts';

export const MODULES = [
  { name: 'eeprom', label: 'EEPROM', bit: 0x01, note: 'AT24C256 · counters, settings' },
  { name: 'rtc', label: 'RTC', bit: 0x02, note: 'DS3231 · UTC clock, temperature' },
  { name: 'imu', label: 'IMU', bit: 0x04, note: 'MPU9250 · also removes the magnetometer' },
  { name: 'mag', label: 'Magnetometer', bit: 0x08, note: 'AK8963 inside the MPU9250 · heading' },
] as const;

export const RESET_REASON: Record<number, string> = {
  1: 'power-on',
  3: 'software (reboot)',
  4: 'panic',
  5: 'interrupt watchdog',
  6: 'task watchdog',
  7: 'watchdog',
  9: 'brown-out',
};

export function activeFlags(flags: number): string[] {
  return decodeStatusFlags(flags);
}

export function hours(runSeconds: number): string {
  return (Math.floor(runSeconds / 36) / 100).toFixed(2);
}

export function utc(epoch: number): string {
  return epoch ? new Date(epoch * 1000).toISOString().replace('.000Z', 'Z') : 'unknown';
}

export function time(atMs: number): string {
  return new Date(atMs).toTimeString().slice(0, 8);
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
