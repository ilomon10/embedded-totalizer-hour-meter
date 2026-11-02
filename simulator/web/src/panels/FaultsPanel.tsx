// FaultsPanel.tsx: damage on the wire, a bad I2C bus, and restarts.
import { Button, Panel, SliderField, Toggle } from '../controls.tsx';
import type { PanelProps } from './types.ts';

export function FaultsPanel({ state, send }: PanelProps) {
  const { faults, busFault } = state;
  return (
    <Panel title="Faults & power">
      <SliderField
        label="Line noise"
        value={faults.noise * 100}
        min={0}
        max={100}
        step={1}
        unit="%"
        digits={0}
        onChange={(p) => send({ type: 'faults', patch: { noise: p / 100 } })}
      />
      <p className="-mt-1 text-xs text-slate-500">Share of frames preceded by junk bytes (zeros included).</p>
      <SliderField
        label="Corrupt 1 in"
        value={faults.corruptEvery}
        min={0}
        max={50}
        step={1}
        unit="frames"
        digits={0}
        onChange={(corruptEvery) => send({ type: 'faults', patch: { corruptEvery } })}
      />
      <p className="-mt-1 text-xs text-slate-500">Flips one byte, so the host sees a CRC/COBS error. 0 = off.</p>
      <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
        <Toggle
          label="SDA held low"
          note="A module or a short pulls the I2C data line down (i2cLines 1)."
          checked={busFault.sdaLow}
          onChange={(sdaLow) => send({ type: 'bus-fault', patch: { sdaLow } })}
        />
        <Toggle
          label="SCL held low"
          note="The same for the clock line (i2cLines 2; both: 3)."
          checked={busFault.sclLow}
          onChange={(sclLow) => send({ type: 'bus-fault', patch: { sclLow } })}
        />
        <Toggle
          label="Transfers time out"
          note="Lines free, but every transfer fails (a module that hangs, noise): parked after 5 s, i2cLines 0."
          checked={busFault.timeouts}
          onChange={(timeouts) => send({ type: 'bus-fault', patch: { timeouts } })}
        />
        <p className="text-xs text-slate-500">
          The firmware never restarts for this. It parks the bus (flag i2cParked, every module missing, tag i2cLines)
          and retries after 10 s, 20 s, 40 s … up to 5 min; the modules come back once the fault is gone. The hour meter
          keeps counting.
        </p>
      </div>
      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
        <Button onClick={() => send({ type: 'power', action: 'reboot' })}>Reboot</Button>
        <Button onClick={() => send({ type: 'power', action: 'watchdog' })}>Watchdog reset</Button>
        <Button onClick={() => send({ type: 'power', action: 'panic' })}>Panic signal</Button>
        <Button tone="danger" onClick={() => send({ type: 'power', action: 'hang' })}>
          Freeze
        </Button>
        <Button tone="danger" onClick={() => send({ type: 'power', action: 'power-cycle' })}>
          Power cycle
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        Each restart sends a boot EVENT (resetReason 3, 6 or 1; lastCause 5, 1 or 0; panic signal: resetReason 3,
        lastCause 4) and restarts seq at 0. A power cycle also loses the time when the RTC has no battery. Freeze stops
        all output and ignores commands until the panic signal, a restart or a power cycle.
      </p>
    </Panel>
  );
}
