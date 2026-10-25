// ClockPanel.tsx: device time (UTC), RTC temperature and backup battery, reset reason.
import { Panel, SliderField, Stat, Toggle } from '../controls.tsx';
import { LAST_CAUSE, LAST_STAGE, RESET_REASON, utc } from '../format.ts';
import type { PanelProps } from './types.ts';

export function ClockPanel({ state, send }: PanelProps) {
  const { status, values, inputs } = state;
  return (
    <Panel title="Clock & RTC" mode={inputs.modes.rtc} onAuto={() => send({ type: 'auto', group: 'rtc' })}>
      <Stat label="Device time (UTC)">{status.timeValid ? utc(status.epoch) : 'unknown'}</Stat>
      <Stat label="Uptime">{status.uptimeS} s</Stat>
      <Stat label="Reset reason">{RESET_REASON[status.resetReason] ?? status.resetReason}</Stat>
      <Stat label="Last cause">{LAST_CAUSE[status.lastCause] ?? status.lastCause}</Stat>
      <Stat label="Last stage">{LAST_STAGE[status.lastStage] ?? status.lastStage}</Stat>
      <SliderField
        label="RTC temperature"
        value={values.rtc.tempC}
        min={-40}
        max={85}
        step={0.25}
        unit="°C"
        onChange={(tempC) => send({ type: 'set', group: 'rtc', patch: { tempC } })}
      />
      <Toggle
        label="RTC backup battery"
        note="Without it, the next power cycle loses the time (rtcBatteryLost + timeInvalid) until the host sends setTime."
        checked={values.rtc.battery}
        onChange={(battery) => send({ type: 'set', group: 'rtc', patch: { battery } })}
      />
    </Panel>
  );
}
