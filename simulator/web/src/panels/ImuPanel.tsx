// ImuPanel.tsx: the IMU stream's raw and filtered axes (msgType 128, tags 20..38).
import type { Vec3 } from '../../../src/web/messages.ts';
import { Panel, Vec3Field } from '../controls.tsx';
import type { PanelProps } from './types.ts';

type ImuKey = 'accelG' | 'gyroDps' | 'magUt' | 'rawAccelG' | 'rawGyroDps' | 'rawMagUt';

const ROWS: { field: ImuKey; label: string; unit: string; step: number; digits: number }[] = [
  { field: 'accelG', label: 'Accel', unit: 'g', step: 0.001, digits: 3 },
  { field: 'gyroDps', label: 'Gyro', unit: '°/s', step: 0.1, digits: 1 },
  { field: 'magUt', label: 'Mag', unit: 'µT', step: 0.1, digits: 1 },
];

export function ImuPanel({ state, send }: PanelProps) {
  const { values, inputs, settings } = state;
  const set = (key: ImuKey, v: Vec3) => send({ type: 'set', group: 'imu', patch: { [key]: v } });
  const mode = ['off', 'raw', 'filtered', 'both'][Number(settings.streamMode)] ?? '?';
  return (
    <Panel title="IMU axes" mode={inputs.modes.imu} onAuto={() => send({ type: 'auto', group: 'imu' })} wide>
      <p className="text-xs text-slate-500">
        Stream: <span className="font-mono">{mode}</span> at {String(settings.imuStreamHz)} Hz (set by the host). In
        auto mode the raw values are the filtered ones plus sensor noise.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-500 uppercase">Filtered (tags 30–38)</h3>
          {ROWS.map(({ field, ...r }) => (
            <Vec3Field key={field} {...r} value={values.imu[field]} onChange={(v) => set(field, v)} />
          ))}
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-slate-500 uppercase">Raw (tags 20–28)</h3>
          {ROWS.map(({ field, ...r }) => {
            const raw = `raw${field[0].toUpperCase()}${field.slice(1)}` as ImuKey;
            return <Vec3Field key={raw} {...r} value={values.imu[raw]} onChange={(v) => set(raw, v)} />;
          })}
        </div>
      </div>
    </Panel>
  );
}
