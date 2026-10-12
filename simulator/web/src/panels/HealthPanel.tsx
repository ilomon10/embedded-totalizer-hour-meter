// HealthPanel.tsx: error counters, extra status flags, calibration, and the
// statusFlags word the host receives (tag 53).
import { NumberField, Panel, Toggle } from '../controls.tsx';
import { activeFlags } from '../format.ts';
import type { PanelProps } from './types.ts';

const EXTRA_FLAGS = [
  { key: 'imuStuck', note: 'identical samples: sensor frozen' },
  { key: 'imuSaturated', note: 'a reading hit the end of its range' },
  { key: 'storageError', note: 'EEPROM write failed' },
  { key: 'eepromFormatted', note: 'a new EEPROM was formatted at boot' },
] as const;

export function HealthPanel({ state, send }: PanelProps) {
  const { values, inputs, status } = state;
  const flags = activeFlags(status.flags);
  return (
    <Panel
      title='Errors & flags'
      mode={inputs.modes.errors}
      onAuto={() => send({ type: 'auto', group: 'errors' })}
    >
      <div className='flex flex-wrap gap-4 text-sm'>
        <label className='flex items-center gap-2'>
          <span className='text-slate-600 dark:text-slate-400'>I2C errors</span>
          <NumberField
            label='I2C errors'
            value={values.errors.i2cErrors}
            min={0}
            onCommit={(i2cErrors) => send({ type: 'set', group: 'errors', patch: { i2cErrors } })}
          />
        </label>
        <label className='flex items-center gap-2'>
          <span className='text-slate-600 dark:text-slate-400'>Overruns</span>
          <NumberField
            label='Overruns'
            value={values.errors.overruns}
            min={0}
            onCommit={(overruns) => send({ type: 'set', group: 'errors', patch: { overruns } })}
          />
        </label>
      </div>
      <div className='space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800'>
        {EXTRA_FLAGS.map((f) => (
          <Toggle
            key={f.key}
            label={f.key}
            note={f.note}
            checked={values.flags[f.key]}
            onChange={(on) => send({ type: 'set', group: 'flags', patch: { [f.key]: on } })}
          />
        ))}
        {inputs.modes.flags === 'manual' && (
          <button
            type='button'
            className='text-xs text-amber-700 underline dark:text-amber-300'
            onClick={() => send({ type: 'auto', group: 'flags' })}
          >
            clear these flags (auto)
          </button>
        )}
      </div>
      <div className='space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800'>
        <Toggle
          label='IMU calibrated'
          checked={(state.calibrationFlags & 1) !== 0}
          onChange={(on) => send({ type: 'calibration', flags: (state.calibrationFlags & ~1) | (on ? 1 : 0) })}
        />
        <Toggle
          label='Magnetometer calibrated'
          checked={(state.calibrationFlags & 2) !== 0}
          onChange={(on) => send({ type: 'calibration', flags: (state.calibrationFlags & ~2) | (on ? 2 : 0) })}
        />
      </div>
      <div className='border-t border-slate-200 pt-3 dark:border-slate-800'>
        <p className='mb-1 text-xs text-slate-500'>
          statusFlags sent to the host: <span className='font-mono'>0x{status.flags.toString(16)}</span>
        </p>
        <div className='flex flex-wrap gap-1'>
          {flags.length === 0 && <span className='text-sm text-emerald-700 dark:text-emerald-400'>none: all OK</span>}
          {flags.map((f) => (
            <span
              key={f}
              className='rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700 dark:bg-slate-800 dark:text-slate-300'
            >
              {f}
            </span>
          ))}
        </div>
      </div>
    </Panel>
  );
}
