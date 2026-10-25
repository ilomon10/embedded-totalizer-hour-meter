// banner.ts: the one line under the header when something is wrong with the link, with the key that helps.
// Nothing shows while all is well. Pure.
//
//   ✖ Board unplugged 12 s ago. Plug it back in: it reconnects by itself.        [p] other port
//   ▲ Bluetooth session locked: live data, settings and counters need the PIN.    [u] unlock
//   ▲ Live data goes to the UART pins only (output = UART). Commands still work.  [6] settings
//   ▲ No data for 8 s (telemetry is every 1 s).                                   [8] diagnose
import type { DeviceState } from '../state.ts';
import { duration } from './format.ts';
import type { Transport } from './settings.ts';

export interface Banner {
  level: 'error' | 'warn';
  text: string;
  /** The key that helps, and what it does. */
  key?: string;
  action?: string;
}

export interface BannerContext {
  nowMs: number;
  /** Since when data is expected: the connect, or the end of a flash. */
  sinceMs: number;
  transport: Transport;
  canSwitchPort: boolean;
  flashing: boolean;
  /** The last command was answered Locked (a Bluetooth session that needs the PIN). */
  locked: boolean;
}

/** How long without a frame before the "no data" warning: 5 s, or 3 telemetry intervals if longer. */
export function noDataAfterMs(telemetryIntervalMs: unknown): number {
  const t = Number(telemetryIntervalMs);
  return Math.max(5000, Number.isFinite(t) && t > 0 ? 3 * t : 0);
}

export function banner(state: DeviceState, ctx: BannerContext): Banner | undefined {
  const port = ctx.canSwitchPort ? { key: 'p', action: 'other port' } : {};
  if (state.connection === 'connecting') {
    return { level: 'warn', text: `◌ Connecting to ${state.port}… (an ESP32 board restarts when its port opens)` };
  }
  if (state.connection === 'waiting') {
    const s = Math.floor((ctx.nowMs - (state.waitingSinceMs ?? ctx.nowMs)) / 1000);
    const problem = state.problem ?? 'not connected';
    const since = s >= 1 ? ` (${duration(s)} ago)` : '';
    const next = state.lost ? 'Plug it back in: it reconnects by itself.' : 'Trying again every second.';
    return { level: 'error', text: `✖ ${problem[0].toUpperCase()}${problem.slice(1)}${since}. ${next}`, ...port };
  }
  if (state.connection !== 'connected' || ctx.flashing) return undefined;
  if (ctx.locked) {
    return {
      level: 'warn',
      text: '▲ Bluetooth session locked: live data, settings and counters need the PIN.',
      key: 'u',
      action: 'unlock',
    };
  }
  const telemetry = state.settings.telemetryIntervalMs;
  const quietMs = ctx.nowMs - (state.lastFrameMs ?? ctx.sinceMs);
  if (quietMs < noDataAfterMs(telemetry)) return undefined;
  if (ctx.transport === 'serial' && Number(state.settings.output) === 2) {
    return {
      level: 'warn',
      text: '▲ Live data goes to the UART pins only (output = UART). Commands still work.',
      key: '6',
      action: 'settings',
    };
  }
  const every = typeof telemetry === 'number' ? ` (telemetry is every ${duration(telemetry / 1000)})` : '';
  return {
    level: 'warn',
    text: `▲ No data for ${duration(quietMs / 1000)}${every}.`,
    key: '8',
    action: 'diagnose',
  };
}
