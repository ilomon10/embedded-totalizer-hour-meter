// EnginePanel.tsx: alternator (engine running), totalizer pulse rate, and the counters.
import { NumberField, Panel, SliderField, Stat, Toggle } from '../controls.tsx';
import { hours } from '../format.ts';
import type { PanelProps } from './types.ts';

export function EnginePanel({ state, send }: PanelProps) {
  const { values, inputs, hourMeter } = state;
  const units = hourMeter.totalCount / Math.max(1, hourMeter.pulsesPerUnit);
  return (
    <Panel
      title='Engine & counters'
      mode={inputs.modes.engine}
      onAuto={() => send({ type: 'auto', group: 'engine' })}
    >
      <Toggle
        label='Engine running'
        note='Alternator input. Run hours only count while it is on.'
        checked={values.engine.running}
        onChange={(running) => send({ type: 'set', group: 'engine', patch: { running } })}
      />
      <SliderField
        label='Pulse rate'
        value={values.pulses.perSecond}
        min={0}
        max={50}
        step={0.5}
        unit='/s'
        digits={1}
        onChange={(perSecond) => send({ type: 'set', group: 'pulses', patch: { perSecond } })}
      />
      {inputs.modes.pulses === 'manual' && (
        <button
          type='button'
          className='text-xs text-amber-700 underline dark:text-amber-300'
          onClick={() => send({ type: 'auto', group: 'pulses' })}
        >
          pulse rate back to the --pulse-hz value
        </button>
      )}
      <div className='space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800'>
        <div className='flex items-center justify-between gap-3 text-sm'>
          <span className='text-slate-600 dark:text-slate-400'>Run hours</span>
          <span className='flex items-center gap-2'>
            <NumberField
              label='Run hours'
              width='w-32'
              value={Number(hours(hourMeter.runSeconds))}
              step={0.01}
              min={0}
              onCommit={(h) => send({ type: 'counters', runSeconds: h * 3600 })}
            />
            <span className='w-10 text-xs text-slate-500'>h</span>
          </span>
        </div>
        <div className='flex items-center justify-between gap-3 text-sm'>
          <span className='text-slate-600 dark:text-slate-400'>Totalizer</span>
          <span className='flex items-center gap-2'>
            <NumberField
              label='Totalizer pulses'
              width='w-32'
              value={hourMeter.totalCount}
              min={0}
              onCommit={(totalCount) => send({ type: 'counters', totalCount })}
            />
            <span className='w-10 text-xs text-slate-500'>pulses</span>
          </span>
        </div>
        <Stat label='Run seconds'>{hourMeter.runSeconds}</Stat>
        <Stat label='Units'>{units.toFixed(2)} (÷ {hourMeter.pulsesPerUnit})</Stat>
        <Stat label='Last EEPROM save'>#{hourMeter.journalSeq}</Stat>
      </div>
    </Panel>
  );
}
