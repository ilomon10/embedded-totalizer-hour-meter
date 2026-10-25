// state.ts: the TUI's view of the device, built from incoming frames.
// Pure functions only (no I/O), so it is unit-tested in state.test.ts.
import type { ConnState } from '../connection.ts';
import { compareVersions, findRelease, type FirmwareRelease, formatFirmware } from '../releases.ts';
import { bootText, causeText } from '../restart.ts';
import { ACK_STATUS, decodeStatusFlags, EVENT_KIND, MSG, SETTINGS } from '../tags.ts';

export type Value = number | boolean | bigint | Uint8Array;
export type Level = 'info' | 'ok' | 'warn' | 'error';

export interface LogEntry {
  atMs: number;
  level: Level;
  text: string;
}

export interface DecodedMessage {
  msgType: number;
  seq: number;
  deviceId: number;
  timestamp: number;
  values: Record<string, Value>;
}

export interface DeviceState {
  /** The link (connection.ts), or 'demo' for the simulated device. */
  connection: 'connecting' | 'connected' | 'demo' | 'waiting' | 'paused' | 'closed';
  /** Why the link is not open, while `connection` is 'waiting'. */
  problem?: string;
  /** Since when, while 'waiting'. */
  waitingSinceMs?: number;
  /** While 'waiting': it was connected (unplugged, link dropped), not a port that has not opened yet. */
  lost?: boolean;
  port: string;
  deviceId?: number;
  lastFrameMs?: number;
  frames: number;
  /** Latest value of every tag the device has sent (flat, by tag name). */
  values: Record<string, Value>;
  /** Settings as last read from / confirmed by the device. */
  settings: Record<string, Value>;
  log: LogEntry[];
}

export const MAX_LOG = 200;

export function initialState(port: string, demo: boolean): DeviceState {
  return { connection: demo ? 'demo' : 'connecting', port, frames: 0, values: {}, settings: {}, log: [] };
}

/**
 * Fold a change of the link into the state, and log the changes worth a line: a disconnect, the reconnect, a new
 * reason for not connecting. The demo stays 'demo'.
 */
export function applyConnState(state: DeviceState, conn: ConnState, port: string, nowMs: number): DeviceState {
  if (state.connection === 'demo') return state;
  const was = state.connection;
  let next: DeviceState = {
    ...state,
    port,
    connection: conn.kind,
    problem: undefined,
    waitingSinceMs: undefined,
    lost: undefined,
  };
  if (conn.kind === 'waiting') {
    next = { ...next, problem: conn.problem, waitingSinceMs: conn.sinceMs, lost: conn.lost };
    if (was !== 'waiting' || state.problem !== conn.problem) {
      next = addLog(next, conn.lost ? 'error' : 'warn', `${conn.problem}: waiting for ${port}`, nowMs);
    }
  }
  if (conn.kind === 'connected') {
    next = { ...next, lastFrameMs: undefined }; // the no-data banner counts from the reconnect
    if (was === 'waiting') next = addLog(next, 'ok', `connected to ${port}`, nowMs);
  }
  return next;
}

export function addLog(state: DeviceState, level: Level, text: string, atMs: number): DeviceState {
  const log = [...state.log, { atMs, level, text }];
  return { ...state, log: log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log };
}

const DEVICE_NAMES = ['EEPROM', 'RTC', 'IMU', 'MAG'] as const;

/** Module presence from the `devices` bitmask: [['EEPROM', true], ...]. */
export function devicesPresent(mask: number | undefined): Array<[string, boolean]> {
  return DEVICE_NAMES.map((name, bit) => [name, mask !== undefined && ((mask >> bit) & 1) === 1]);
}

export function activeFlags(state: DeviceState): string[] {
  const flags = state.values.statusFlags;
  return typeof flags === 'number' ? decodeStatusFlags(flags) : [];
}

export { formatFirmware };

const SERIOUS = new Set([
  'eepromMissing',
  'storageError',
  'timeInvalid',
  'rtcBatteryLost',
  'imuStuck',
  'i2cErrors',
  'safeMode',
]);
const FLASH_STORE_FIRMWARE = 0x00020600; // 2.6.0 keeps settings + counters in the ESP32's flash too

/** Red for flags that need action now. A missing EEPROM is only a warning when the flash keeps the values. */
export function flagColor(flag: string, flags: string[], fwVersion: Value | undefined): 'red' | 'yellow' {
  if (flag === 'eepromMissing') {
    const flashKeeps =
      typeof fwVersion === 'number' && fwVersion >= FLASH_STORE_FIRMWARE && !flags.includes('flashStoreMissing');
    return flashKeeps ? 'yellow' : 'red';
  }
  return SERIOUS.has(flag) ? 'red' : 'yellow';
}

/** The newest release's version if it is newer than the device's firmware (header: "update available"). */
export function updateAvailable(fwVersion: Value | undefined, releases: FirmwareRelease[] | undefined) {
  const latest = releases && findRelease(releases, 'latest');
  if (!latest || typeof fwVersion !== 'number') return undefined;
  return compareVersions(latest.version, formatFirmware(fwVersion)) > 0 ? latest.version : undefined;
}

function describeEvent(values: Record<string, Value>): { level: Level; text: string } {
  const kind = EVENT_KIND[values.eventKind as keyof typeof EVENT_KIND] ?? `event ${String(values.eventKind)}`;
  if (kind === 'calibrationDone') {
    const result = ACK_STATUS[values.calibResult as number] ?? String(values.calibResult);
    return { level: result === 'Ok' ? 'ok' : 'error', text: `calibration finished: ${result}` };
  }
  if (kind === 'devicesChanged') {
    const list = devicesPresent(values.devices as number)
      .map(([n, p]) => `${n} ${p ? 'yes' : 'no'}`)
      .join(', ');
    return { level: 'warn', text: `modules changed: ${list}` };
  }
  if (kind === 'boot') {
    return { level: causeText(values) ? 'warn' : 'info', text: bootText(values) };
  }
  return { level: 'info', text: kind };
}

/**
 * The device ACKed a command with Ok: every setting in it is now in effect
 * (the ACK itself does not echo values), so record them as confirmed.
 */
export function confirmSettings(state: DeviceState, sent: Record<string, Value>): DeviceState {
  const settings = { ...state.settings };
  for (const [name, value] of Object.entries(sent)) {
    if (name in SETTINGS) settings[name] = value;
  }
  return { ...state, settings };
}

/** Fold one decoded frame into the state. */
export function applyMessage(state: DeviceState, msg: DecodedMessage, nowMs: number): DeviceState {
  if (state.deviceId !== undefined && msg.deviceId !== state.deviceId) {
    // Another board on this port (swapped while unplugged): nothing of the old one's values stays on screen.
    const id = msg.deviceId.toString(16);
    state = addLog(
      { ...state, values: {}, settings: {}, frames: 0 },
      'warn',
      `another device on this port: ${id}`,
      nowMs,
    );
  }
  const settings = { ...state.settings };
  for (const [name, value] of Object.entries(msg.values)) {
    if (name in SETTINGS) settings[name] = value;
  }
  let next: DeviceState = {
    ...state,
    connection: state.connection === 'connecting' ? 'connected' : state.connection,
    deviceId: msg.deviceId,
    lastFrameMs: nowMs,
    frames: state.frames + 1,
    values: { ...state.values, ...msg.values },
    settings,
  };
  if (msg.msgType === MSG.EVENT) {
    const { level, text } = describeEvent(msg.values);
    next = addLog(next, level, text, nowMs);
  }
  return next;
}

/** Banner when nothing has arrived for 5 s (since connecting, or since the last frame). */
export function noDataBanner(
  lastFrameMs: number | undefined,
  startMs: number,
  nowMs: number,
  hardResetNote?: string,
): string | undefined {
  if (nowMs - (lastFrameMs ?? startMs) < 5000) return undefined;
  return `No data from the device. ${hardResetNote ?? 'Press H to hard-reset.'}`;
}
