// nav.ts: the TUI's screens, grouped by task (maintain, set up, service), with their number keys.
//
//   MAINTAIN   1 Overview  2 Counters  3 Report
//   SET UP     4 Commission  5 Live inputs  6 Settings  7 Calibrate
//   SERVICE    8 Diagnostics  9 Firmware  0 Log

export type ScreenId =
  | 'overview'
  | 'counters'
  | 'report'
  | 'commission'
  | 'live'
  | 'settings'
  | 'calibrate'
  | 'diagnostics'
  | 'firmware'
  | 'log';

export type Group = 'MAINTAIN' | 'SET UP' | 'SERVICE';

export interface ScreenInfo {
  id: ScreenId;
  /** The number key that opens it. */
  key: string;
  label: string;
  /** For the one-line tab bar below 100 columns. */
  short: string;
  group: Group;
}

export const SCREENS: readonly ScreenInfo[] = Object.freeze([
  { id: 'overview', key: '1', label: 'Overview', short: 'Overview', group: 'MAINTAIN' },
  { id: 'counters', key: '2', label: 'Counters', short: 'Count', group: 'MAINTAIN' },
  { id: 'report', key: '3', label: 'Report', short: 'Report', group: 'MAINTAIN' },
  { id: 'commission', key: '4', label: 'Commission', short: 'Comm', group: 'SET UP' },
  { id: 'live', key: '5', label: 'Live inputs', short: 'Live', group: 'SET UP' },
  { id: 'settings', key: '6', label: 'Settings', short: 'Set', group: 'SET UP' },
  { id: 'calibrate', key: '7', label: 'Calibrate', short: 'Cal', group: 'SET UP' },
  { id: 'diagnostics', key: '8', label: 'Diagnostics', short: 'Diag', group: 'SERVICE' },
  { id: 'firmware', key: '9', label: 'Firmware', short: 'FW', group: 'SERVICE' },
  { id: 'log', key: '0', label: 'Log', short: 'Log', group: 'SERVICE' },
]);

export const GROUPS: readonly Group[] = ['MAINTAIN', 'SET UP', 'SERVICE'];

/** From this terminal width on, the menu is a sidebar; below it, one tab line. */
export const WIDE_COLUMNS = 100;

export function screenByKey(key: string): ScreenInfo | undefined {
  return SCREENS.find((s) => s.key === key);
}

export function screenInfo(id: ScreenId): ScreenInfo {
  return SCREENS.find((s) => s.id === id)!;
}

/** "7 Calibrate": how a screen is named in hints ("→ 7 Calibrate"). */
export function screenRef(id: ScreenId): string {
  const s = screenInfo(id);
  return `${s.key} ${s.label}`;
}
