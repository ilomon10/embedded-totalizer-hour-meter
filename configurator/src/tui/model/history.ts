// history.ts: the last minute of live readings (engine input, counters, vibration) for the Live inputs screen and
// the commissioning checks: rates, "since you opened this screen", a sparkline, and the vibration-threshold
// suggestion of WIRING.md (key on, engine off: highest RMS; idling: lowest RMS; threshold half way, at least
// twice the key-on value). Pure.
import type { Value } from '../state.ts';

export interface LiveSample {
  atMs: number;
  altInput?: boolean;
  alternator?: boolean;
  vibRms?: number;
  vibPeak?: number;
  totalCount?: number;
  runSeconds?: number;
}

/** How far back the live readings go: the longest view of the vibration time series. */
export const HISTORY_MS = 600_000;

/** Add the readings of one TELEMETRY frame; samples older than HISTORY_MS drop off. */
export function addSample(list: readonly LiveSample[], values: Record<string, Value>, atMs: number): LiveSample[] {
  const num = (v: Value | undefined) => (typeof v === 'number' ? v : undefined);
  const bool = (v: Value | undefined) => (typeof v === 'boolean' ? v : undefined);
  const sample: LiveSample = {
    atMs,
    altInput: bool(values.altInput),
    alternator: bool(values.alternator),
    vibRms: num(values.vibRms),
    vibPeak: num(values.vibPeak),
    totalCount: num(values.totalCount),
    runSeconds: num(values.runSeconds),
  };
  return [...list.filter((s) => atMs - s.atMs <= HISTORY_MS), sample];
}

export function between(list: readonly LiveSample[], fromMs: number, toMs = Infinity): LiveSample[] {
  return list.filter((s) => s.atMs >= fromMs && s.atMs <= toMs);
}

type NumKey = 'vibRms' | 'vibPeak' | 'totalCount' | 'runSeconds';

export function maxOf(list: readonly LiveSample[], key: NumKey): number | undefined {
  const xs = list.map((s) => s[key]).filter((x): x is number => x !== undefined);
  return xs.length ? Math.max(...xs) : undefined;
}

export function minOf(list: readonly LiveSample[], key: NumKey): number | undefined {
  const xs = list.map((s) => s[key]).filter((x): x is number => x !== undefined);
  return xs.length ? Math.min(...xs) : undefined;
}

/** How much `key` grew from the first sample at or after `fromMs` to the newest one. */
export function grownSince(list: readonly LiveSample[], key: NumKey, fromMs: number): number | undefined {
  const window = between(list, fromMs).filter((s) => s[key] !== undefined);
  if (window.length < 2) return window.length === 1 ? 0 : undefined;
  return window[window.length - 1][key]! - window[0][key]!;
}

/** Pulses per second over the last `windowMs`. */
export function pulseRate(list: readonly LiveSample[], nowMs: number, windowMs = 10_000): number | undefined {
  const window = between(list, nowMs - windowMs).filter((s) => s.totalCount !== undefined);
  if (window.length < 2) return undefined;
  const first = window[0];
  const last = window[window.length - 1];
  const seconds = (last.atMs - first.atMs) / 1000;
  return seconds > 0 ? (last.totalCount! - first.totalCount!) / seconds : undefined;
}

const SPARK = '▁▂▃▄▅▆▇█';

/** The last `width` values as block heights, scaled to `max`. */
export function sparkline(values: readonly number[], width: number, max: number): string {
  return values
    .slice(-width)
    .map((v) => SPARK[Math.max(0, Math.min(7, Math.round((v / (max || 1)) * 7)))])
    .join('');
}

/** The 10 s measurements of the vibration-threshold procedure. */
export type Measure = 'keyOn' | 'idle';
export const MEASURE_MS = 10_000;

/** Key on, engine off: the highest RMS in the window; idling: the lowest. */
export function measureResult(list: readonly LiveSample[], kind: Measure, fromMs: number): number | undefined {
  const window = between(list, fromMs, fromMs + MEASURE_MS);
  return kind === 'keyOn' ? maxOf(window, 'vibRms') : minOf(window, 'vibRms');
}

/** Half way between key-on and idle, at least twice the key-on value; none if idle is not clearly above it. */
export function suggestThreshold(keyOnMax?: number, idleMin?: number): { value?: number; why: string } {
  if (keyOnMax === undefined || idleMin === undefined) return { why: 'measure key on and idle first' };
  const value = Math.max(Math.round((keyOnMax + idleMin) / 2), 2 * keyOnMax);
  if (value >= idleMin) {
    return { why: 'idle vibration is too close to key-on: a threshold cannot tell them apart' };
  }
  return { value, why: 'half way, at least 2 × engine off' };
}
