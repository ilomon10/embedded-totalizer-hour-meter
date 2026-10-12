// restart.ts: turn the reset reason / last cause / last stage of a boot EVENT into text.
// Pure (no I/O): shared by the TUI log, `hour-meter read` and `hour-meter reset`.
import { LAST_CAUSE, LAST_STAGE } from './tags.ts';

type Values = Record<string, unknown>;

/** resetReason (tag 58). Values not listed print as the bare number. */
const RESET_REASON: Readonly<Record<number, string>> = Object.freeze({
  1: 'power-on',
  3: 'software',
  4: 'crash',
  5: 'watchdog',
  6: 'watchdog',
  7: 'watchdog',
  9: 'brown-out',
});

/** "watchdog while IMU", or undefined when the device reports no cause (0 / absent). */
export function causeText(values: Values): string | undefined {
  const cause = Number(values.lastCause);
  if (!values.lastCause || !(cause > 0)) return undefined;
  const name = LAST_CAUSE[cause] ?? `cause ${cause}`;
  const stage = Number(values.lastStage);
  return stage > 0 ? `${name} while ${LAST_STAGE[stage] ?? `stage ${stage}`}` : name;
}

/** Boot EVENT line for the TUI log: "device restarted: watchdog while IMU (reset reason 6)". */
export function bootText(values: Values): string {
  const reason = Number(values.resetReason);
  const cause = causeText(values);
  if (cause) return `device restarted: ${cause} (reset reason ${reason})`;
  return `device booted (${RESET_REASON[reason] ?? `reset reason ${String(values.resetReason)}`})`;
}

/** One-line result of `hour-meter reset`: "device restarted (reset reason 1 power-on, last cause: ...)". */
export function resetResultText(values: Values): string {
  const reason = Number(values.resetReason);
  const name = RESET_REASON[reason];
  const parts = [`reset reason ${reason}${name ? ` ${name}` : ''}`];
  const cause = causeText(values);
  if (cause) parts.push(`last cause: ${cause}`);
  return `device restarted (${parts.join(', ')})`;
}
