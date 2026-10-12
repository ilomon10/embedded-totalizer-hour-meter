// ModulesPanel.tsx: plug and unplug the modules. "Fitted" is what is physically
// there; "detected" is what the firmware has noticed (lost after 3 missed checks,
// about 6 s; found again within 2 s), which is what the host sees.
import { Panel, Toggle } from '../controls.tsx';
import { MODULES } from '../format.ts';
import type { PanelProps } from './types.ts';

export function ModulesPanel({ state, send }: PanelProps) {
  return (
    <Panel title='Modules'>
      {MODULES.map((m) => {
        const fitted = (state.fitted & m.bit) !== 0;
        const detected = (state.status.devices & m.bit) !== 0;
        return (
          <div key={m.name} className='space-y-1'>
            <Toggle
              label={m.label}
              note={m.note}
              checked={fitted}
              onChange={(on) => send({ type: 'module', module: m.name, fitted: on })}
            />
            <p
              className={`text-xs ${
                detected ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'
              }`}
            >
              {detected ? '✔ detected by the firmware' : '✘ not detected'}
              {fitted !== detected && ' · changing…'}
            </p>
          </div>
        );
      })}
    </Panel>
  );
}
