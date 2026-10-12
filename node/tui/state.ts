// state.ts: the TUI's view of the device, built from incoming frames.
// Pure functions only (no I/O), so it is unit-tested in state.test.ts.
import tagsCjs from '../tags.js';

const { MSG, EVENT_KIND, ACK_STATUS, SETTINGS, decodeStatusFlags } = tagsCjs;

export type Value = number | boolean | bigint | Buffer;
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
  connection: 'connecting' | 'connected' | 'demo' | 'error';
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

/** 0x00MMmmpp -> "M.m.p" */
export function formatFirmware(v: Value | undefined): string {
  if (typeof v !== 'number') return '?';
  return `${(v >> 16) & 0xff}.${(v >> 8) & 0xff}.${v & 0xff}`;
}

function describeEvent(values: Record<string, Value>): { level: Level; text: string } {
  const kind = EVENT_KIND[values.eventKind as keyof typeof EVENT_KIND] ?? `event ${String(values.eventKind)}`;
  if (kind === 'calibrationDone') {
    const result = ACK_STATUS[values.calibResult as number] ?? String(values.calibResult);
    return { level: result === 'Ok' ? 'ok' : 'error', text: `calibration finished: ${result}` };
  }
  if (kind === 'devicesChanged') {
    const list = devicesPresent(values.devices as number).map(([n, p]) => `${n} ${p ? 'yes' : 'no'}`).join(', ');
    return { level: 'warn', text: `modules changed: ${list}` };
  }
  if (kind === 'boot') {
    return { level: 'info', text: `device booted (reset reason ${String(values.resetReason)})` };
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
