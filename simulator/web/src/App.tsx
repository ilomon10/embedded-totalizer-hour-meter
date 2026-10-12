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
import { BT_STATE } from './format.ts';
import { type Simulator, useSimulator } from './useSimulator.ts';

function Dot({ on, label }: { on: boolean; label: string }) {
  return (
    <span className='flex min-w-0 items-center gap-1.5'>
      <span className={`h-2 w-2 shrink-0 rounded-full ${on ? 'bg-emerald-500' : 'bg-slate-400'}`} />
      <span className='break-all'>{label}</span>
    </span>
  );
}

function Header({ sim }: { sim: Simulator }) {
  const s = sim.state;
  return (
    <header className='sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90'>
      <div className='mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 text-sm'>
        <h1 className='text-base font-semibold'>
          Hour Meter Simulator{' '}
          {s && <span className='font-normal text-slate-500'>v{s.version} · fw 2.3.0 protocol</span>}
        </h1>
        <Dot on={sim.link === 'open'} label={sim.link === 'open' ? 'web UI connected' : 'web UI reconnecting…'} />
        {s && (
          <>
            <Dot
              on={s.clientConnected}
              label={`host ${s.clientConnected ? 'connected' : 'not connected'} · ${s.transport}`}
            />
            <span className='text-slate-500'>
              device 0x{s.deviceId.toString(16)} · next seq #{s.nextSeq}
              {s.bluetoothSession && ` · Bluetooth: ${BT_STATE[s.status.btState]}`}
              {!s.liveData && ' · live data off (no client / locked / output)'}
            </span>
          </>
        )}
      </div>
    </header>
  );
}

export function App() {
  const sim = useSimulator();
  const { state, send } = sim;
  return (
    <div className='min-h-screen bg-slate-100 text-slate-900 dark:bg-slate-950 dark:text-slate-100'>
      <Header sim={sim} />
      <main className='mx-auto max-w-7xl p-4'>
        {!state
          ? <p className='p-8 text-center text-slate-500'>Connecting to the simulator…</p>
          : (
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
          )}
      </main>
    </div>
  );
}
