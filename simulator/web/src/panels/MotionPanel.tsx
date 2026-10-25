// MotionPanel.tsx: roll, pitch, heading and vibration (TELEMETRY tags 40..44).
import { Panel, SliderField } from '../controls.tsx';
import type { PanelProps } from './types.ts';

export function MotionPanel({ state, send }: PanelProps) {
  const { values, inputs } = state;
  const motion = (patch: Partial<typeof values.motion>) => send({ type: 'set', group: 'motion', patch });
  const vibration = (patch: Partial<typeof values.vibration>) => send({ type: 'set', group: 'vibration', patch });
  return (
    <>
      <Panel title="Orientation" mode={inputs.modes.motion} onAuto={() => send({ type: 'auto', group: 'motion' })}>
        <SliderField
          label="Roll"
          value={values.motion.rollDeg}
          min={-90}
          max={90}
          step={0.01}
          unit="°"
          onChange={(rollDeg) => motion({ rollDeg })}
        />
        <SliderField
          label="Pitch"
          value={values.motion.pitchDeg}
          min={-90}
          max={90}
          step={0.01}
          unit="°"
          onChange={(pitchDeg) => motion({ pitchDeg })}
        />
        <SliderField
          label="Heading"
          value={values.motion.headingDeg}
          min={0}
          max={359.99}
          step={0.01}
          unit="°"
          onChange={(headingDeg) => motion({ headingDeg })}
        />
        <p className="text-xs text-slate-500">Heading is only sent while a magnetometer is detected.</p>
      </Panel>
      <Panel title="Vibration" mode={inputs.modes.vibration} onAuto={() => send({ type: 'auto', group: 'vibration' })}>
        <SliderField
          label="RMS"
          value={values.vibration.rmsMg}
          min={0}
          max={2000}
          step={1}
          unit="mg"
          digits={0}
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
          onChange={(peakMg) => vibration({ peakMg })}
        />
        <p className="text-xs text-slate-500">
          Sent after the first vibration window ({String(state.settings.vibrationWindowMs)} ms) since the IMU appeared.
        </p>
      </Panel>
    </>
  );
}
