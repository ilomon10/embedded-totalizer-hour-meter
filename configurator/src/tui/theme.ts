// theme.ts: the TUI's colours and marks. Colours are hex strings (OpenTUI's colour objects crash its Windows DLL
// in some versions). Meaning never rests on colour alone: every state also has a mark and words.
//
//   ✔ ● ok, live (green)   ▲ ◌ attention, busy (yellow)   ✖ fault (red)   ○ off (gray)   ▸ selected (cyan)

export const C = {
  fg: '#d7dae0',
  dim: '#7f848e',
  green: '#98c379',
  yellow: '#e5c07b',
  red: '#e06c75',
  cyan: '#56b6c2',
  border: '#4b5563',
  borderFocus: '#56b6c2',
  headerBg: '#1f2a36',
  selectBg: '#2b3a4a',
  dialogBg: '#151b23',
  // Behind a chart: when the 10 s vibration measurements were taken (key on, idling).
  bandKeyOn: '#3a3424',
  bandIdle: '#22362a',
} as const;

export const MARK = {
  ok: '✔',
  warn: '▲',
  error: '✖',
  live: '●',
  off: '○',
  busy: '◌',
  select: '▸',
  update: '↑',
  changed: '•',
} as const;

export type Tone = 'ok' | 'warn' | 'error' | 'info' | 'dim';

export function toneColor(tone: Tone): string {
  return { ok: C.green, warn: C.yellow, error: C.red, info: C.fg, dim: C.dim }[tone];
}

/** The log levels of state.ts as colours and marks. */
export const LEVEL: Record<'info' | 'ok' | 'warn' | 'error', { color: string; mark: string }> = {
  info: { color: C.fg, mark: MARK.live },
  ok: { color: C.green, mark: MARK.ok },
  warn: { color: C.yellow, mark: MARK.warn },
  error: { color: C.red, mark: MARK.error },
};
