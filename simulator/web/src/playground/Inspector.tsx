// Inspector.tsx: exact numbers for what the canvas shows, vibration, and the IMU
// readings the host receives as a result.
import type { ClientMessage, SimState } from '../../../src/web/messages.ts';
import { ModeBadge, NumberField, SliderField, Toggle } from '../controls.tsx';
import { round } from '../format.ts';
import type { Attitude } from './attitude3d.ts';

const PRESETS = [
  { label: 'Idle', rmsMg: 12, peakMg: 30 },
  { label: 'Running', rmsMg: 40, peakMg: 110 },
  { label: 'Rough road', rmsMg: 250, peakMg: 900 },
  { label: 'Worn bearing', rmsMg: 600, peakMg: 2400 },
] as const;

function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-slate-200 px-5 py-5 last:border-0 dark:border-slate-800">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
        {aside}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function AngleRow({
  label,
  value,
  onCommit,
  hint,
}: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  hint: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span>
        <span className="text-slate-700 dark:text-slate-200">{label}</span>
        <span className="block text-xs text-slate-500">{hint}</span>
      </span>
      <span className="flex items-center gap-1">
        <NumberField label={label} value={round(value, 2)} step={0.1} onCommit={onCommit} width="w-24" />
        <span className="w-4 text-sm text-slate-500">°</span>
      </span>
    </div>
  );
}

export function Inspector({
  state,
  attitude,
  setAttitude,
  send,
}: {
  state: SimState;
  attitude: Attitude;
  setAttitude: (next: Attitude) => void;
  send: (msg: ClientMessage) => void;
}) {
  const { inputs, values } = state;
  const customVibration = inputs.modes.vibration === 'manual';
  const accel = values.imu.accelG;
  const hasMag = (state.status.devices & 0x08) !== 0;
  const vibration = (patch: { rmsMg?: number; peakMg?: number }) => send({ type: 'set', group: 'vibration', patch });

  return (
    <div className="bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100">
      <Section
        title="Orientation"
        aside={<ModeBadge mode={inputs.modes.motion} onAuto={() => send({ type: 'auto', group: 'motion' })} />}
      >
        <AngleRow
          label="Roll"
          hint="drag left / right"
          value={attitude.rollDeg}
          onCommit={(rollDeg) => setAttitude({ ...attitude, rollDeg })}
        />
        <AngleRow
          label="Pitch"
          hint="drag up = nose up = positive"
          value={attitude.pitchDeg}
          onCommit={(pitchDeg) => setAttitude({ ...attitude, pitchDeg })}
        />
        <AngleRow
          label="Heading"
          hint="drag the ring, 0 = north"
          value={attitude.headingDeg}
          onCommit={(headingDeg) => setAttitude({ ...attitude, headingDeg })}
        />
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            onClick={() => setAttitude({ ...attitude, rollDeg: 0, pitchDeg: 0 })}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Level
          </button>
          <button
            type="button"
            onClick={() => setAttitude({ ...attitude, headingDeg: 0 })}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Face north
          </button>
        </div>
        {!hasMag && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            No magnetometer detected: the host gets roll and pitch, but no heading.
          </p>
        )}
      </Section>

      <Section title="Vibration">
        <Toggle
          label="Custom vibration"
          note={
            customVibration
              ? 'Held at the values below.'
              : 'Off: follows the engine, about 40 mg running, 2 mg stopped.'
          }
          checked={customVibration}
          onChange={(on) => (on ? vibration({ rmsMg: 250, peakMg: 900 }) : send({ type: 'auto', group: 'vibration' }))}
        />
        <div className="reveal" data-open={customVibration}>
          <div className="space-y-3">
            <SliderField
              label="RMS"
              value={values.vibration.rmsMg}
              min={0}
              max={2000}
              step={1}
              unit="mg"
              digits={0}
              stacked
              onChange={(rmsMg) => vibration({ rmsMg })}
            />
            <SliderField
              label="Peak"
              value={values.vibration.peakMg}
              min={0}
              max={8000}
              step={1}
              unit="mg"
              digits={0}
              stacked
              onChange={(peakMg) => vibration({ peakMg })}
            />
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => {
                const on =
                  Math.round(values.vibration.rmsMg) === p.rmsMg && Math.round(values.vibration.peakMg) === p.peakMg;
                return (
                  <button
                    key={p.label}
                    type="button"
                    aria-pressed={on}
                    onClick={() => vibration({ rmsMg: p.rmsMg, peakMg: p.peakMg })}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors duration-150 ${
                      on
                        ? 'border-sky-600 bg-sky-600 text-white'
                        : 'border-slate-300 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
                    }`}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </Section>

      <Section title="What the host receives">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm tabular-nums">
          <dt className="text-slate-500">Roll / pitch</dt>
          <dd className="text-right">
            {round(values.motion.rollDeg, 2)}° / {round(values.motion.pitchDeg, 2)}°
          </dd>
          <dt className="text-slate-500">Heading</dt>
          <dd className="text-right">{hasMag ? `${round(values.motion.headingDeg, 2)}°` : 'not sent'}</dd>
          <dt className="text-slate-500">Accel (g)</dt>
          <dd className="text-right">
            {accel.x.toFixed(3)}, {accel.y.toFixed(3)}, {accel.z.toFixed(3)}
          </dd>
          <dt className="text-slate-500">Vibration</dt>
          <dd className="text-right">
            {Math.round(values.vibration.rmsMg)} mg RMS, {Math.round(values.vibration.peakMg)} mg peak
          </dd>
        </dl>
        <p className="text-xs text-slate-500">
          The accelerometer and magnetometer in the IMU stream follow this attitude, so a driver that works out roll and
          pitch itself gets the same answer.
        </p>
      </Section>
    </div>
  );
}
