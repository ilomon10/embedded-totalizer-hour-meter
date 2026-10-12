// commands.ts: command validation, a port of esp32/lib/App/src/CommandHandler.cpp
// (checkAction, validate) and SettingsSchema.cpp (checkValue, checkCrossField).
//
// The firmware rule is ALL-OR-NOTHING: every record of a COMMAND is checked
// before anything runs. The first bad record decides the ackStatus and is
// reported as rejectedTag. Pure functions only; device.ts executes the result.
import type { Settings } from './frames.ts';
import { EPOCH_MAX, EPOCH_MIN } from './frames.ts';
import { Ack, type DecodedRecord, RESET_MAGIC, SETTINGS, tagOf, TAGS } from './protocol.ts';

export interface Rejection {
  status: number;
  rejectedTag: number;
}

const SETTING_BY_TAG = new Map(Object.entries(SETTINGS).map(([name, spec]) => [spec.tag, name]));

export const CMD = Object.freeze({
  setTime: tagOf('setTime'),
  get: tagOf('get'),
  setRunSeconds: tagOf('setRunSeconds'),
  setTotalCount: tagOf('setTotalCount'),
  resetCounters: tagOf('resetCounters'),
  calibrate: tagOf('calibrate'),
  reboot: tagOf('reboot'),
  unlock: tagOf('unlock'),
});

/** Integer value of a record, or null for floats / bytes / out of 0..max (firmware readUint). */
export function readUint(r: DecodedRecord, max: number): number | null {
  if (r.fmt === 'bytes' || r.fmt === 'f32' || r.fmt === 'f64') return null;
  const v = Number(r.raw);
  return v >= 0 && v <= max ? v : null;
}

export function isSettingTag(tag: number): boolean {
  return SETTING_BY_TAG.has(tag);
}

/** Check one action record without running it (firmware checkAction). */
export function checkAction(r: DecodedRecord): number {
  switch (r.tag) {
    case CMD.setTime: {
      const v = readUint(r, EPOCH_MAX);
      return v !== null && v >= EPOCH_MIN ? Ack.Ok : Ack.InvalidValue;
    }
    case CMD.get: {
      const v = readUint(r, 4);
      return v !== null && v >= 1 ? Ack.Ok : Ack.InvalidValue;
    }
    case CMD.setRunSeconds:
    case CMD.setTotalCount:
      return readUint(r, 0xffffffff) !== null ? Ack.Ok : Ack.InvalidValue;
    case CMD.resetCounters:
      return readUint(r, 0xffffffff) === RESET_MAGIC ? Ack.Ok : Ack.BadMagic;
    case CMD.calibrate: {
      const v = readUint(r, 2);
      return v !== null && v >= 1 ? Ack.Ok : Ack.InvalidValue;
    }
    case CMD.reboot:
    case CMD.unlock: // checked by the access gate before we get here
      return Ack.Ok;
    default:
      return Ack.UnknownTag;
  }
}

/** Check one setting value (firmware checkValue). Returns the value or a Rejection. */
export function checkSetting(r: DecodedRecord): number | Rejection {
  const name = SETTING_BY_TAG.get(r.tag) as string;
  const spec = SETTINGS[name];
  const reject = { status: Ack.InvalidValue, rejectedTag: r.tag };
  if (r.fmt === 'bytes') return reject;
  const v = Number(r.raw);
  if (!(v >= spec.min && v <= spec.max)) return reject; // also rejects NaN
  if (TAGS[r.tag].fmt !== 'f32' && Math.floor(v) !== v) return reject;
  if (spec.values && !spec.values.includes(v)) return reject; // uartBaud: standard rates only
  return v;
}

/**
 * Validate a whole COMMAND (firmware validate). On success returns the settings
 * as they will be after the command; nothing has been changed yet.
 */
export function validateCommand(records: DecodedRecord[], current: Settings): { next: Settings } | Rejection {
  const next: Settings = { ...current };
  for (const r of records) {
    if (isSettingTag(r.tag)) {
      const v = checkSetting(r);
      if (typeof v !== 'number') return v;
      const name = SETTING_BY_TAG.get(r.tag) as string;
      next[name] = typeof current[name] === 'boolean' ? v !== 0 : TAGS[r.tag].fmt === 'f32' ? Math.fround(v) : v;
      continue;
    }
    const status = checkAction(r);
    if (status !== Ack.Ok) return { status, rejectedTag: r.tag };
  }
  if (Number(next.imuStreamHz) > Number(next.imuSampleHz)) {
    return { status: Ack.InvalidValue, rejectedTag: SETTINGS.imuStreamHz.tag }; // cannot stream faster than we sample
  }
  return { next };
}
