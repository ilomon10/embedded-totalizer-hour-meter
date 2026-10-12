// LogPanel.tsx: every frame the device sent, every command it received, sessions and errors.
import { useMemo, useState } from 'react';

import type { LogEntry } from '../../../src/web/messages.ts';
import { Button, Panel } from '../controls.tsx';
import { time } from '../format.ts';

const KINDS = ['TELEMETRY', 'IMU', 'EVENT', 'ACK', 'COMMAND', 'info'] as const;
type Kind = (typeof KINDS)[number];
const SHOWN = 300;

function kindOf(e: LogEntry): Kind {
  return e.dir === 'info' ? 'info' : (KINDS.includes(e.type as Kind) ? e.type as Kind : 'info');
}

const DIR_STYLE: Record<LogEntry['dir'], string> = {
  tx: 'text-sky-700 dark:text-sky-400',
  rx: 'text-violet-700 dark:text-violet-400',
  info: 'text-amber-700 dark:text-amber-400',
};

export function LogPanel({ log, onClear }: { log: LogEntry[]; onClear: () => void }) {
  const [hidden, setHidden] = useState<Set<Kind>>(new Set(['TELEMETRY', 'IMU']));
  const [paused, setPaused] = useState<LogEntry[] | null>(null);
  const source = paused ?? log;
  const rows = useMemo(() => source.filter((e) => !hidden.has(kindOf(e))).slice(-SHOWN).reverse(), [source, hidden]);
  const toggle = (k: Kind) => {
    const next = new Set(hidden);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setHidden(next);
  };
  return (
    <Panel title='Frame log' wide>
      <div className='flex flex-wrap items-center gap-2'>
        {KINDS.map((k) => (
          <button
            key={k}
            type='button'
            onClick={() => toggle(k)}
            className={`rounded-full border px-2 py-0.5 font-mono text-xs ${
              hidden.has(k)
                ? 'border-slate-300 text-slate-400 line-through dark:border-slate-700'
                : 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-300'
            }`}
          >
            {k}
          </button>
        ))}
        <span className='ml-auto flex gap-2'>
          <Button onClick={() => setPaused(paused ? null : [...log])}>{paused ? 'Resume' : 'Pause'}</Button>
          <Button onClick={onClear}>Clear</Button>
        </span>
      </div>
      <div className='max-h-96 overflow-auto rounded-md bg-slate-50 p-2 font-mono text-xs dark:bg-slate-950'>
        {rows.length === 0 && (
          <p className='text-slate-500'>Nothing yet. Connect a host to the port, or show TELEMETRY.</p>
        )}
        {rows.map((e) => (
          <div key={e.id} className={`flex flex-wrap gap-x-2 py-0.5 ${e.delivered === false ? 'opacity-50' : ''}`}>
            <span className='shrink-0 text-slate-500'>{time(e.atMs)}</span>
            <span className={`w-6 shrink-0 ${DIR_STYLE[e.dir]}`}>
              {e.dir === 'tx' ? '→' : e.dir === 'rx' ? '←' : '•'}
            </span>
            <span className='w-20 shrink-0 font-semibold'>{e.type}</span>
            <span className='w-12 shrink-0 text-slate-500'>{e.seq !== undefined ? `#${e.seq}` : ''}</span>
            <span className='min-w-0 basis-full break-all text-slate-700 sm:flex-1 sm:basis-0 dark:text-slate-300'>
              {e.text}
              {e.records?.map(([k, v]) =>
                `${k}=${v}`
              ).join(' ')}
              {e.delivered === false && ' (not delivered)'}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
