// GamepadMapper.tsx: bind each driving action to a gamepad axis or button.
// Press "Assign", then move the stick, trigger or button you want; set dead zone
// and direction; the mapping is saved in this browser.
import { useEffect, useState } from 'react';

import {
  type Action,
  ACTIONS,
  DEFAULT_MAPPING,
  describeBinding,
  detectInput,
  firstPad,
  type Mapping,
  readBinding,
  saveMapping,
} from './controls.ts';

export function GamepadMapper({ mapping, onChange }: { mapping: Mapping; onChange: (m: Mapping) => void }) {
  const [listening, setListening] = useState<Action | null>(null);
  const [values, setValues] = useState<Record<Action, number>>({
    throttle: 0,
    brake: 0,
    steer: 0,
    pitch: 0,
    reverse: 0,
    anchor: 0,
  });
  const [padName, setPadName] = useState<string | null>(null);

  const update = (m: Mapping) => {
    saveMapping(m);
    onChange(m);
  };

  // Live readout of every binding, and capture for "Assign".
  useEffect(() => {
    let frame = 0;
    let rest: { axes: number[]; buttons: number[] } | null = null;
    const tick = () => {
      const pad = firstPad();
      setPadName(pad?.id ?? null);
      if (pad) {
        if (listening) {
          rest ??= { axes: [...pad.axes], buttons: pad.buttons.map((b) => b.value) };
          const found = detectInput(pad, rest);
          if (found) {
            update({ ...mapping, [listening]: found });
            setListening(null);
            rest = null;
          }
        }
        const v = {} as Record<Action, number>;
        for (const { action } of ACTIONS) v[action] = readBinding(pad, mapping[action]);
        setValues(v);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [listening, mapping]);

  return (
    <div className='space-y-3'>
      <p className='text-xs text-slate-500'>
        {padName
          ? `Gamepad: ${padName}`
          : 'No gamepad yet: connect one and press any button (browsers only show a pad after a press).'}
      </p>
      <table className='w-full text-sm'>
        <tbody>
          {ACTIONS.map(({ action, label, hint }) => {
            const b = mapping[action];
            return (
              <tr key={action} className='border-b border-slate-100 last:border-0 dark:border-slate-800'>
                <td className='py-1.5 pr-2'>
                  <span className='text-slate-800 dark:text-slate-100'>{label}</span>
                  <span className='block text-xs text-slate-500'>{hint}</span>
                </td>
                <td className='w-24 py-1.5'>
                  <div className='h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800'>
                    <div
                      className='h-full bg-sky-600'
                      style={{ width: `${Math.round(Math.min(1, Math.abs(values[action])) * 100)}%` }}
                    />
                  </div>
                  <span className='text-xs text-slate-500'>{describeBinding(b)}</span>
                </td>
                <td className='py-1.5 pl-2 text-right whitespace-nowrap'>
                  <button
                    type='button'
                    onClick={() => setListening(listening === action ? null : action)}
                    className={`rounded-md border px-2 py-1 text-xs ${
                      listening === action
                        ? 'border-sky-600 bg-sky-600 text-white'
                        : 'border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
                    }`}
                  >
                    {listening === action ? 'Move it now…' : 'Assign'}
                  </button>
                  {b && (
                    <button
                      type='button'
                      onClick={() => update({ ...mapping, [action]: { ...b, invert: !b.invert } })}
                      className='ml-1 rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800'
                      title='Reverse the direction'
                    >
                      Flip
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button
        type='button'
        onClick={() => update(DEFAULT_MAPPING)}
        className='text-xs text-slate-600 underline dark:text-slate-400'
      >
        Reset to the standard layout (triggers drive, left stick steers, A = GPS fix)
      </button>
    </div>
  );
}
