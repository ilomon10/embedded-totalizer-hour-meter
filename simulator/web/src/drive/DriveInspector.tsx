// DriveInspector.tsx: the Drive page's side panel. Vehicle, how it moves (route,
// live, replay), how far the IMU-only estimate has drifted, and what the host receives.
import type { ReactNode } from 'react';

import type { ClientMessage, SimState, VehicleKind, Waypoint } from '../../../src/web/messages.ts';
import { SliderField, Toggle } from '../controls.tsx';
import type { Mapping } from './controls.ts';
import type { CustomModel } from './modelStore.ts';
import type { ModelChoice } from './DrivePage.tsx';
import { GamepadMapper } from './GamepadMapper.tsx';

export type Tab = 'route' | 'live' | 'replay';

const BTN =
  'rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800';
const PRIMARY = 'rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-40';

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className='border-b border-slate-200 px-5 py-5 last:border-0 dark:border-slate-800'>
      <header className='mb-3 flex items-center justify-between gap-2'>
        <h2 className='text-sm font-semibold text-slate-800 dark:text-slate-100'>{title}</h2>
        {aside}
      </header>
      <div className='space-y-3'>{children}</div>
    </section>
  );
}

function Segmented<T extends string>(
  { value, options, onChange, label }: {
    value: T;
    options: { value: T; label: string }[];
    onChange: (v: T) => void;
    label: string;
  },
) {
  return (
    <div role='tablist' aria-label={label} className='flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800'>
      {options.map((o) => (
        <button
          key={o.value}
          type='button'
          role='tab'
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md px-2 py-1 text-sm font-medium transition-colors duration-150 ${
            value === o.value
              ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100'
              : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex items-baseline justify-between gap-3 text-sm'>
      <dt className='text-slate-500'>{label}</dt>
      <dd className='text-right tabular-nums'>{children}</dd>
    </div>
  );
}

function Bar({ label, value, signed }: { label: string; value: number; signed?: boolean }) {
  const pct = Math.round(Math.min(1, Math.abs(value)) * 50);
  return (
    <div className='grid grid-cols-[4.5rem_1fr_3rem] items-center gap-2 text-xs'>
      <span className='text-slate-500'>{label}</span>
      <div className='relative h-1.5 rounded-full bg-slate-200 dark:bg-slate-800'>
        <div
          className='absolute h-full rounded-full bg-sky-600'
          style={signed
            ? { left: value < 0 ? `${50 - pct}%` : '50%', width: `${pct}%` }
            : { left: 0, width: `${pct * 2}%` }}
        />
      </div>
      <span className='text-right tabular-nums'>{value.toFixed(2)}</span>
    </div>
  );
}

const fmtM = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`);

export interface InspectorProps {
  state: SimState;
  send: (msg: ClientMessage) => void;
  choice: ModelChoice;
  onChoose: (c: ModelChoice) => void;
  custom: CustomModel | null;
  onUploadModel: (f: File) => void;
  onUpdateCustom: (p: Partial<CustomModel>) => void;
  placing: boolean;
  onPlace: () => void;
  onStopDriving: () => void;
  tab: Tab;
  onTab: (t: Tab) => void;
  waypoints: Waypoint[];
  onClearRoute: () => void;
  speedKmh: number;
  onSpeed: (v: number) => void;
  altM: number;
  onAlt: (v: number) => void;
  loop: boolean;
  onLoop: (v: boolean) => void;
  onPlay: () => void;
  follow: boolean;
  onFollow: (v: boolean) => void;
  mapping: Mapping;
  onMapping: (m: Mapping) => void;
  replayInfo: string | null;
  onReplayFile: (f: File) => void;
  error: string | null;
}

export function DriveInspector(p: InspectorProps) {
  const { state, send } = p;
  const v = state.vehicle;
  const kind: VehicleKind = p.choice === 'custom' ? (p.custom?.kind ?? 'truck') : p.choice;
  const streamHz = Number(state.settings.imuStreamHz);
  const streaming = Number(state.settings.streamMode) !== 0 && streamHz > 0;
  const driftPct = v && v.distanceM > 20 ? (v.errorM / v.distanceM) * 100 : null;

  return (
    <div className='text-slate-900 dark:text-slate-100'>
      {p.error && (
        <p className='mx-5 mt-4 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-300'>
          {p.error}
        </p>
      )}

      <Section
        title='Vehicle'
        aside={v
          ? (
            <button
              type='button'
              onClick={p.onStopDriving}
              className='text-xs text-slate-600 underline dark:text-slate-400'
            >
              Stop driving
            </button>
          )
          : null}
      >
        <Segmented
          label='Vehicle model'
          value={p.choice}
          onChange={p.onChoose}
          options={[{ value: 'truck', label: 'Truck' }, { value: 'plane', label: 'Plane' }, {
            value: 'custom',
            label: 'Your model',
          }]}
        />
        {p.choice === 'custom' && (
          <div className='space-y-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-950'>
            <label className='block text-sm'>
              <span className='text-slate-700 dark:text-slate-200'>
                {p.custom ? `Model: ${p.custom.name}` : 'Upload a .glb or .gltf file'}
              </span>
              <input
                type='file'
                accept='.glb,.gltf,model/gltf-binary,model/gltf+json'
                onChange={(e) => e.target.files?.[0] && p.onUploadModel(e.target.files[0])}
                className='mt-1 block w-full text-xs file:mr-2 file:rounded-md file:border-0 file:bg-sky-600 file:px-2 file:py-1 file:text-white'
              />
            </label>
            {p.custom && (
              <>
                <Segmented
                  label='Moves like'
                  value={p.custom.kind}
                  onChange={(k) => p.onUpdateCustom({ kind: k })}
                  options={[{ value: 'truck', label: 'Moves like a truck' }, { value: 'plane', label: 'like a plane' }]}
                />
                <SliderField
                  label='Length'
                  value={p.custom.lengthM}
                  min={1}
                  max={40}
                  step={0.5}
                  unit='m'
                  digits={1}
                  stacked
                  onChange={(lengthM) => p.onUpdateCustom({ lengthM })}
                />
                <div className='flex flex-wrap gap-2'>
                  <button
                    type='button'
                    className={BTN}
                    onClick={() => p.onUpdateCustom({ yawSteps: (p.custom!.yawSteps + 1) % 4 })}
                  >
                    Turn 90°
                  </button>
                  <button type='button' className={BTN} onClick={() => p.onUpdateCustom({ zUp: !p.custom!.zUp })}>
                    {p.custom.zUp ? 'File is Z-up' : 'File is Y-up'}
                  </button>
                </div>
                <p className='text-xs text-slate-500'>
                  Turn it until the orange arrow under it points at its nose. Stays in this browser only.
                </p>
              </>
            )}
          </div>
        )}
        {!v && !p.placing && (
          <button type='button' className={PRIMARY} onClick={p.onPlace}>Place the {kind} on the map</button>
        )}
        {v && (
          <div className='flex flex-wrap items-center gap-2'>
            <button type='button' className={BTN} onClick={p.onPlace} disabled={v.playing}>Move it</button>
            <Toggle label='Follow on the map' checked={p.follow} onChange={p.onFollow} />
          </div>
        )}
      </Section>

      {v && (
        <Section title='Drive'>
          <Segmented
            label='How it moves'
            value={p.tab}
            onChange={p.onTab}
            options={[{ value: 'route', label: 'Route' }, { value: 'live', label: 'Live' }, {
              value: 'replay',
              label: 'Replay',
            }]}
          />
          {p.tab !== 'live' && (
            <>
              {p.tab === 'replay' && (
                <label className='block rounded-lg border border-dashed border-slate-300 p-3 text-sm dark:border-slate-700'>
                  <span className='text-slate-700 dark:text-slate-200'>
                    Recorded track: GPX, or CSV with lat, lon (alt, time)
                  </span>
                  <input
                    type='file'
                    accept='.gpx,.csv,.txt,application/gpx+xml,text/csv'
                    onChange={(e) => e.target.files?.[0] && p.onReplayFile(e.target.files[0])}
                    className='mt-1 block w-full text-xs file:mr-2 file:rounded-md file:border-0 file:bg-sky-600 file:px-2 file:py-1 file:text-white'
                  />
                  {p.replayInfo && <span className='mt-1 block text-xs text-slate-500'>{p.replayInfo}</span>}
                </label>
              )}
              <p className='text-xs text-slate-500'>
                {p.waypoints.length} waypoint{p.waypoints.length === 1 ? '' : 's'}
                {p.waypoints.some((w) => w.speed !== undefined) ? ', recorded speeds used where present' : ''}
              </p>
              <SliderField
                label='Speed'
                value={p.speedKmh}
                min={kind === 'plane' ? 110 : 5}
                max={kind === 'plane' ? 270 : 90}
                step={1}
                unit='km/h'
                digits={0}
                stacked
                onChange={p.onSpeed}
              />
              {kind === 'plane' && (
                <SliderField
                  label='Height'
                  value={p.altM}
                  min={50}
                  max={3000}
                  step={10}
                  unit='m'
                  digits={0}
                  stacked
                  onChange={p.onAlt}
                />
              )}
              <Toggle label='Loop' note='Drive the route again and again' checked={p.loop} onChange={p.onLoop} />
              <div className='flex flex-wrap gap-2'>
                {!v.playing
                  ? (
                    <button type='button' className={PRIMARY} disabled={p.waypoints.length < 2} onClick={p.onPlay}>
                      Play
                    </button>
                  )
                  : (
                    <button type='button' className={BTN} onClick={() => send({ type: 'play', action: 'pause' })}>
                      Pause
                    </button>
                  )}
                <button
                  type='button'
                  className={BTN}
                  disabled={!v.route}
                  onClick={() => send({ type: 'play', action: 'stop' })}
                >
                  Stop
                </button>
                <button
                  type='button'
                  className={BTN}
                  disabled={v.playing || p.waypoints.length === 0}
                  onClick={p.onClearRoute}
                >
                  Clear route
                </button>
              </div>
              {v.routeDone && <p className='text-xs text-emerald-700 dark:text-emerald-400'>Route finished.</p>}
            </>
          )}
          {p.tab === 'live' && (
            <>
              <p className='text-xs text-slate-500'>
                Keyboard: W throttle, S or Space brake, A / D steer{kind === 'plane' ? ', Q / E climb / descend' : ''},
                R GPS fix.
              </p>
              <div className='space-y-1.5'>
                <Bar label='Throttle' value={v.controls.throttle} />
                <Bar label='Brake' value={v.controls.brake} />
                <Bar label='Steer' value={v.controls.steer} signed />
                {kind === 'plane' && <Bar label='Climb' value={v.controls.pitch} signed />}
              </div>
              <details className='rounded-lg bg-slate-50 p-3 dark:bg-slate-950'>
                <summary className='cursor-pointer text-sm font-medium'>Gamepad controls</summary>
                <div className='mt-3'>
                  <GamepadMapper mapping={p.mapping} onChange={p.onMapping} />
                </div>
              </details>
            </>
          )}
        </Section>
      )}

      {v && (
        <Section
          title='Dead reckoning'
          aside={
            <button type='button' className={PRIMARY} onClick={() => send({ type: 'anchor' })}>
              GPS fix
            </button>
          }
        >
          <div className='flex items-baseline gap-3'>
            <span className='text-3xl font-semibold whitespace-nowrap tabular-nums'>{fmtM(v.errorM)}</span>
            <span className='text-sm text-slate-500'>
              off after {fmtM(v.distanceM)}
              {driftPct !== null && `, ${driftPct.toFixed(1)}% of the distance`}
            </span>
          </div>
          <p className='flex items-center gap-4 text-xs text-slate-600 dark:text-slate-400'>
            <span className='flex items-center gap-1.5'>
              <span className='h-1 w-5 rounded-full bg-[#0f766e]' /> true path
            </span>
            <span className='flex items-center gap-1.5'>
              <span className='h-0 w-5 border-t-2 border-dashed border-[#ee6a1f]' /> IMU-only estimate
            </span>
          </p>
          <dl className='space-y-1'>
            <Row label='Since the last fix'>{v.sinceAnchorS.toFixed(0)} s</Row>
            <Row label='Speed, true / estimated'>
              {(v.truth.speed * 3.6).toFixed(1)} / {(v.estimate.speed * 3.6).toFixed(1)} km/h
            </Row>
            <Row label='Heading, true / estimated'>
              {v.truth.headingDeg.toFixed(1)}° / {v.estimate.headingDeg.toFixed(1)}°
            </Row>
          </dl>
          <Segmented
            label='Estimate heading from'
            value={v.headingSource}
            onChange={(h) => send({ type: 'estimator', headingSource: h })}
            options={[{ value: 'gyro', label: 'Gyro' }, { value: 'compass', label: 'Compass' }]}
          />
          {(!streaming || streamHz < 50) && (
            <p className='rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-300'>
              {streaming
                ? `The IMU stream runs at ${streamHz} Hz, so the estimate integrates coarse steps.`
                : 'The IMU stream is off, so there is nothing to estimate from.'} A host sets it with{' '}
              <code className='font-mono'>hour-meter set imuStreamHz=100 streamMode=2</code>.
            </p>
          )}
          <button
            type='button'
            className='text-xs text-slate-600 underline dark:text-slate-400'
            onClick={() => send({ type: 'clear-tracks' })}
          >
            Clear the tracks
          </button>
        </Section>
      )}

      {v && (
        <Section title='What the host receives'>
          <dl className='space-y-1'>
            <Row label='Roll / pitch (firmware)'>
              {state.values.motion.rollDeg.toFixed(1)}° / {state.values.motion.pitchDeg.toFixed(1)}°
            </Row>
            <Row label='Roll / pitch (true)'>
              {v.truth.rollDeg.toFixed(1)}° / {v.truth.pitchDeg.toFixed(1)}°
            </Row>
            <Row label='Heading (compass)'>{state.values.motion.headingDeg.toFixed(1)}°</Row>
            <Row label='Vibration'>{Math.round(state.values.vibration.rmsMg)} mg RMS</Row>
            <Row label='Engine, fuel'>
              {state.values.engine.running ? 'running' : 'off'}, {state.values.pulses.perSecond.toFixed(1)} pulses/s
            </Row>
          </dl>
          <p className='text-xs text-slate-500'>
            Roll and pitch come from the firmware's own filter, ported to the simulator: in turns and while braking they
            differ from the truth exactly as on the real device. Pitch is positive nose up.
          </p>
        </Section>
      )}
    </div>
  );
}
