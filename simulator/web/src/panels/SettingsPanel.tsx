// SettingsPanel.tsx: the device settings as the host last wrote them (read-only here:
// settings change through COMMANDs, as on the real device).
import { SETTINGS } from '../format.ts';
import type { PanelProps } from './types.ts';
import { Panel } from '../controls.tsx';

// f32 settings come back as the nearest float (0.0005 -> 0.000500000023…): show 6 significant digits.
function formatSetting(v: number | boolean | undefined): string {
  return typeof v === 'number' && !Number.isInteger(v) ? String(Number(v.toPrecision(6))) : String(v);
}

export function SettingsPanel({ state }: PanelProps) {
  return (
    <Panel title='Settings (written by the host)'>
      <table className='w-full text-sm'>
        <tbody>
          {Object.entries(SETTINGS).map(([name, spec]) => (
            <tr key={name} className='border-b border-slate-100 last:border-0 dark:border-slate-800'>
              <td className='py-1 font-mono text-xs text-slate-500'>{spec.tag}</td>
              <td className='py-1 text-slate-700 dark:text-slate-300'>{name}</td>
              <td className='py-1 text-right font-mono tabular-nums'>
                {formatSetting(state.settings[name])}
                {spec.unit && <span className='ml-1 text-xs text-slate-500'>{spec.unit}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
