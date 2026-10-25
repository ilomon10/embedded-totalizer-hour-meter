// format.ts: numbers, times, ages and ids the way every TUI screen shows them. Pure.
import type { Value } from '../state.ts';

/** Seconds since 1970 of 2000-01-01: device timestamps below this are uptime, not wall time. */
export const EPOCH_2000 = 946684800;

/** "1250.03" with `digits` decimals, or "–" while the value is missing. */
export function num(v: Value | undefined, digits = 2): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '–';
}

/** A whole number, or "–". */
export function int(v: Value | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : '–';
}

/** The device id as 8 upper-case hex digits ("1A2B3C4D"), or "–". */
export function deviceIdText(id: number | undefined): string {
  return id === undefined ? '–' : (id >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

/** "45 s", "4 min 10 s", "1 h 12 min", "3 d 4 h". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  if (s < 86400) {
    const m = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`;
  }
  const h = Math.floor((s % 86400) / 3600);
  return `${Math.floor(s / 86400)} d${h ? ` ${h} h` : ''}`;
}

/** "32 s ago" from a past time in ms; "just now" under a second. */
export function ago(atMs: number, nowMs: number): string {
  const ms = nowMs - atMs;
  return ms < 1000 ? 'just now' : `${duration(ms / 1000)} ago`;
}

/** Age of a value in ms with one decimal under 10 s: "0.4 s", "12 s". */
export function age(atMs: number, nowMs: number): string {
  const s = Math.max(0, (nowMs - atMs) / 1000);
  return s < 10 ? `${s.toFixed(1)} s` : duration(s);
}

/** "2026-10-25 14:32:05 UTC", or "unknown" for a time before 2000 (uptime, not a date). */
export function utcText(epoch: Value | undefined): string {
  if (typeof epoch !== 'number' || epoch < EPOCH_2000) return 'unknown';
  return `${new Date(epoch * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** "14:32:05" in UTC. */
export function utcClock(epoch: number): string {
  return new Date(epoch * 1000).toISOString().slice(11, 19);
}

/** "22:32" in this PC's time zone. */
export function localClock(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** A bar of `width` cells for value/max, with eighth-cell precision: "███████▍". */
export function bar(value: number, max: number, width: number): string {
  // Round to whole eighths first: a fraction that rounds up to 8/8 is a full block, not an eighth block past "▉".
  const eighths = Math.round(Math.max(0, Math.min(1, value / (max || 1))) * width * 8);
  const part = eighths % 8;
  return '█'.repeat(Math.floor(eighths / 8)) + (part ? '▏▎▍▌▋▊▉'[part - 1] : '');
}

/** "████████░░░░" progress bar of `width` cells for a 0..1 fraction. */
export function progressBar(fraction: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Cut `text` to `width` cells with "…" (one cell per code point is close enough for this TUI's text). */
export function fit(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

/** Pad with spaces to `width` (by code points). */
export function padEnd(text: string, width: number): string {
  const n = [...text].length;
  return n >= width ? text : text + ' '.repeat(width - n);
}

/** "/dev/ttyUSB0" stays; a long path keeps its end: "…/serial/by-id/usb-Silicon_Labs…". */
export function shortPort(port: string, width: number): string {
  const chars = [...port];
  return chars.length <= width ? port : `…${chars.slice(chars.length - width + 1).join('')}`;
}
