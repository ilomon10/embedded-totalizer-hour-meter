// log.tsx: 0 Log. Everything that happened this session (it survives a port change), filtered by kind, scrollable,
// following the newest line until you scroll up; `s` saves it next to the service reports.
import { useState } from 'react';

import { deviceIdText } from '../model/format.ts';
import type { LogEntry } from '../state.ts';
import { charOf, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { saveReportFile } from '../store.ts';
import { C, LEVEL } from '../theme.ts';
import { dim, Line, Spread } from '../ui.tsx';

const FILTERS = ['all', 'events', 'commands', 'problems'] as const;
type Filter = (typeof FILTERS)[number];

const EVENT =
  /^(device (booted|restarted)|calibration finished|modules changed|another device|the board|reconnected|connected to)|waiting for /;

function matches(e: LogEntry, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'problems') return e.level === 'warn' || e.level === 'error';
  const event = EVENT.test(e.text);
  return f === 'events' ? event : !event;
}

const time = (ms: number) => new Date(ms).toTimeString().slice(0, 8);

export function LogScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const [filter, setFilter] = useState<Filter>('all');
  const [offset, setOffset] = useState(0); // lines up from the newest; 0 = following
  const entries = ui.device.log.filter((e) => matches(e, filter));
  const rows = Math.max(3, shell.height - 2);
  const maxOffset = Math.max(0, entries.length - rows);
  const off = Math.min(offset, maxOffset);
  const page = entries.slice(Math.max(0, entries.length - rows - off), entries.length - off);

  useScreenKeys((k) => {
    const c = charOf(k);
    const clamp = (x: number) => Math.max(0, Math.min(maxOffset, x));
    if (k.name === 'up' || c === 'k') setOffset((o) => clamp(o + 1));
    else if (k.name === 'down' || c === 'j') setOffset((o) => clamp(o - 1));
    else if (k.name === 'pageup') setOffset((o) => clamp(o + rows));
    else if (k.name === 'pagedown') setOffset((o) => clamp(o - rows));
    else if (k.name === 'left' || k.name === 'right') {
      const step = k.name === 'right' ? 1 : FILTERS.length - 1;
      setFilter((f) => FILTERS[(FILTERS.indexOf(f) + step) % FILTERS.length]);
      setOffset(0);
    } else if (c === 'f') setOffset(0);
    else if (c === 's') {
      const name = `log-${deviceIdText(ui.device.deviceId)}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
      const text =
        ui.device.log.map((e) => `${new Date(e.atMs).toISOString()}  ${e.level.padEnd(5)}  ${e.text}`).join('\n') +
        '\n';
      void saveReportFile(name, text).then(
        (path) => ctrl.log('ok', `log saved: ${path}`),
        (err) => ctrl.log('error', `log not saved: ${(err as Error).message}`),
      );
    } else return false;
    return true;
  });

  return (
    <box style={{ flexDirection: 'column' }}>
      <Spread
        left={FILTERS.flatMap((f) => [f === filter ? { t: `[${f}]`, fg: C.cyan, bold: true } : dim(` ${f} `), '  '])}
        right={[dim(`${entries.length} entries · ${off === 0 ? 'following' : `${off} lines up · f follow`}`)]}
      />
      {page.length === 0 ? <Line segs={[dim('nothing yet')]} /> : null}
      {page.map((e, i) => (
        <Line
          key={`${e.atMs}-${i}`}
          segs={[
            dim(`${time(e.atMs)}  `),
            { t: `${LEVEL[e.level].mark}  `, fg: LEVEL[e.level].color },
            { t: e.text, fg: e.level === 'info' ? C.fg : LEVEL[e.level].color },
          ]}
        />
      ))}
    </box>
  );
}
