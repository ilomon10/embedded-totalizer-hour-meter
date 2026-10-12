// controls.tsx: the building blocks every panel uses.
import { type ReactNode, useState } from 'react';

import type { Mode, Vec3 } from '../../src/web/messages.ts';
import { round } from './format.ts';

export function Panel(
  { title, mode, onAuto, children, wide }: {
    title: string;
    mode?: Mode;
    onAuto?: () => void;
    children: ReactNode;
    wide?: boolean;
  },
) {
  return (
    <section
      className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900 ${
        wide ? 'md:col-span-2' : ''
      }`}
    >
      <header className='mb-3 flex items-center justify-between gap-2'>
        <h2 className='text-sm font-semibold tracking-wide text-slate-700 uppercase dark:text-slate-200'>{title}</h2>
        {mode && <ModeBadge mode={mode} onAuto={onAuto} />}
      </header>
      <div className='space-y-3'>{children}</div>
    </section>
  );
}

/** "auto" (animated) or "manual" with a button back to auto. */
export function ModeBadge({ mode, onAuto }: { mode: Mode; onAuto?: () => void }) {
  if (mode === 'auto') {
    return (
      <span className='rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300'>
        auto
      </span>
    );
  }
  return (
    <button
      type='button'
      onClick={onAuto}
      title='Give this group back to the built-in animation'
      className='rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 hover:bg-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:hover:bg-amber-900'
    >
      manual · back to auto
    </button>
  );
}

/** A number typed by hand: committed on Enter or when the field loses focus. */
export function NumberField(
  { value, onCommit, step = 1, min, max, width = 'w-20 sm:w-24', label }: {
    value: number;
    onCommit: (v: number) => void;
    step?: number;
    min?: number;
    max?: number;
    /** Tailwind width classes; counters need more room than sensor values. */
    width?: string;
    label: string;
  },
) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = Number(draft);
    setDraft(null);
    if (draft.trim() !== '' && Number.isFinite(v)) onCommit(v);
  };
  return (
    <input
      type='number'
      aria-label={label}
      step={step}
      min={min}
      max={max}
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(null);
      }}
      className={`${width} rounded-md border border-slate-300 bg-white px-2 py-1 text-right font-mono text-sm tabular-nums dark:border-slate-700 dark:bg-slate-950`}
    />
  );
}

/** Slider + exact number for one value. Every change is sent at once. */
export function SliderField(
  { label, value, min, max, step, unit, digits = 2, onChange }: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
    digits?: number;
    onChange: (v: number) => void;
  },
) {
  return (
    <label className='grid grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-2 text-sm sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:gap-3'>
      <span className='text-slate-600 dark:text-slate-400'>{label}</span>
      <input
        type='range'
        min={min}
        max={max}
        step={step}
        value={Math.min(max, Math.max(min, value))}
        onChange={(e) => onChange(Number(e.target.value))}
        className='w-full min-w-0 accent-sky-600'
      />
      <span className='flex items-center gap-1'>
        <NumberField label={label} value={round(value, digits)} step={step} onCommit={onChange} />
        <span className='w-8 text-xs text-slate-500 sm:w-10'>{unit}</span>
      </span>
    </label>
  );
}

export function Toggle(
  { label, checked, onChange, note }: {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    note?: string;
  },
) {
  return (
    <label className='flex cursor-pointer items-start justify-between gap-3 text-sm'>
      <span>
        <span className='text-slate-700 dark:text-slate-200'>{label}</span>
        {note && <span className='block text-xs text-slate-500'>{note}</span>}
      </span>
      <button
        type='button'
        role='switch'
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-sky-600' : 'bg-slate-300 dark:bg-slate-700'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-4' : ''
          }`}
        />
      </button>
    </label>
  );
}

/** Three axes of one sensor. */
export function Vec3Field(
  { label, value, unit, step, digits, onChange }: {
    label: string;
    value: Vec3;
    unit: string;
    step: number;
    digits: number;
    onChange: (v: Vec3) => void;
  },
) {
  return (
    <div className='grid grid-cols-1 items-center gap-1 text-sm sm:grid-cols-[7rem_1fr] sm:gap-3'>
      <span className='text-slate-600 dark:text-slate-400'>
        {label} <span className='text-xs text-slate-500'>{unit}</span>
      </span>
      <div className='flex flex-wrap gap-2'>
        {(['x', 'y', 'z'] as const).map((axis) => (
          <span key={axis} className='flex items-center gap-1'>
            <span className='font-mono text-xs text-slate-500 uppercase'>{axis}</span>
            <NumberField
              label={`${label} ${axis}`}
              value={round(value[axis], digits)}
              step={step}
              onCommit={(v) => onChange({ ...value, [axis]: v })}
            />
          </span>
        ))}
      </div>
    </div>
  );
}

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex items-baseline justify-between gap-3 text-sm'>
      <span className='text-slate-600 dark:text-slate-400'>{label}</span>
      <span className='font-mono tabular-nums text-slate-900 dark:text-slate-100'>{children}</span>
    </div>
  );
}

export function Button(
  { children, onClick, tone = 'default' }: { children: ReactNode; onClick: () => void; tone?: 'default' | 'danger' },
) {
  const colors = tone === 'danger'
    ? 'border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950'
    : 'border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800';
  return (
    <button type='button' onClick={onClick} className={`rounded-md border px-3 py-1.5 text-sm ${colors}`}>
      {children}
    </button>
  );
}
