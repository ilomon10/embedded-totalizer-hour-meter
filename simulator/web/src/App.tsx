// App.tsx: the simulator control page. Header with the live link state, then a
// grid of panels. Every value is shown as the device sends it right now; touching a
// control switches that group to manual (see src/inputs.ts).
import { ClockPanel } from './panels/ClockPanel.tsx';
import { EnginePanel } from './panels/EnginePanel.tsx';
import { FaultsPanel } from './panels/FaultsPanel.tsx';
import { HealthPanel } from './panels/HealthPanel.tsx';
import { ImuPanel } from './panels/ImuPanel.tsx';
import { LogPanel } from './panels/LogPanel.tsx';
import { ModulesPanel } from './panels/ModulesPanel.tsx';
import { MotionPanel } from './panels/MotionPanel.tsx';
import { SettingsPanel } from './panels/SettingsPanel.tsx';
import { lazy, Suspense } from 'react';

import { BT_STATE } from './format.ts';
import { hrefOf, type Route, useRoute } from './router.ts';
import { type Simulator, useSimulator } from './useSimulator.ts';

const Playground = lazy(() => import('./playground/Playground.tsx').then((m) => ({ default: m.Playground })));

const TABS: { route: Route; label: string }[] = [
  { route: 'panels', label: 'Panels' },
  { route: 'playground', label: 'Bench' },
];

function Dot({ on, label, title }: { on: boolean; label: string; title?: string }) {
  return (
    <span className='flex min-w-0 items-center gap-1.5' title={title}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-400'}`} />
      <span className='max-w-[26rem] truncate'>{label}</span>
    </span>
  );
}

function Header({ sim, route, navigate }: { sim: Simulator; route: Route; navigate: (r: Route) => void }) {
  const s = sim.state;
  return (
    <header className='sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90'>
      <div className='flex min-h-16 flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2 text-sm'>
        <h1 className='text-base font-semibold'>
          Hour Meter Simulator
          {s && <span className='ml-2 font-normal text-slate-500'>v{s.version}, firmware 2.3.0 protocol</span>}
        </h1>
        <nav aria-label='Pages' className='flex rounded-lg bg-slate-100 p-0.5 dark:bg-slate-800'>
          {TABS.map((t) => (
            <a
              key={t.route}
              href={hrefOf(t.route)}
              aria-current={route === t.route ? 'page' : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) {return; // let new-tab clicks through
                }
                e.preventDefault();
                navigate(t.route);
              }}
              className={`rounded-md px-3 py-1 font-medium transition-colors duration-150 ${
                route === t.route
                  ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-950 dark:text-slate-100'
                  : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {t.label}
            </a>
          ))}
        </nav>
        <div className='ml-auto flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 text-slate-600 dark:text-slate-400'>
          <Dot on={sim.link === 'open'} label={sim.link === 'open' ? 'Web UI live' : 'Reconnecting…'} />
          {s && (
            <Dot
              on={s.clientConnected}
              label={s.clientConnected ? `Host connected on ${s.transport}` : `No host on ${s.transport}`}
              title={s.transport}
            />
          )}
          {s && (
            <span className='tabular-nums' title='deviceId and the seq of the next frame'>
              0x{s.deviceId.toString(16)}, next #{s.nextSeq}
              {s.bluetoothSession && `, Bluetooth ${BT_STATE[s.status.btState]}`}
            </span>
          )}
        </div>
      </div>
    </header>
  );
}

function PanelsPage({ sim }: { sim: Simulator }) {
  const { state, send } = sim;
  if (!state) return null;
  return (
    <main className='mx-auto max-w-7xl p-4'>
      {!state.liveData && (
        <p className='mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-950 dark:text-amber-300'>
          Live data is not reaching a host right now (no client connected, Bluetooth still locked, or output set to
          UART).
        </p>
      )}
      <div className='grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3'>
        <EnginePanel state={state} send={send} />
        <MotionPanel state={state} send={send} />
        <ClockPanel state={state} send={send} />
        <ModulesPanel state={state} send={send} />
        <HealthPanel state={state} send={send} />
        <ImuPanel state={state} send={send} />
        <FaultsPanel state={state} send={send} />
        <SettingsPanel state={state} send={send} />
        <LogPanel log={sim.log} onClear={sim.clearLog} />
      </div>
    </main>
  );
}

export function App() {
  const sim = useSimulator();
  const [route, navigate] = useRoute();
  return (
    <div className='min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100'>
      <Header sim={sim} route={route} navigate={navigate} />
      {!sim.state
        ? <p className='p-8 text-center text-slate-500'>Connecting to the simulator…</p>
        : (
          <div key={route} className='route-enter'>
            {route === 'panels'
              ? <PanelsPage sim={sim} />
              : (
                <Suspense fallback={<p className='p-8 text-center text-slate-500'>Loading the 3D view…</p>}>
                  <Playground state={sim.state} send={sim.send} />
                </Suspense>
              )}
          </div>
        )}
    </div>
  );
}
