// calibrate.tsx: 7 Calibrate, guided. What to do with the board, the checks that must pass first (IMU present,
// engine off, level within 6°), a running progress bar until the calibration EVENT, and the result with the new
// biases or what to do about a failure.
import { useEffect } from 'react';

import { num, progressBar } from '../model/format.ts';
import { activeFlags } from '../state.ts';
import { charOf, takeIntent, useNow, useRefState, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { C, MARK } from '../theme.ts';
import { Blank, bold, CheckRow, dim, Line, ok, type Seg } from '../ui.tsx';

const EXPECTED_MS = { 1: 5000, 2: 20000 } as const;

export function CalibrateScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const now = useNow(250);
  const [sel, setSel, selRef] = useRefState<1 | 2>(1); // a ref: ↓ and Enter can come before the next draw
  const v = ui.device.values;
  const flags = activeFlags(ui.device);
  const known = v.statusFlags !== undefined;
  const imu = known && !flags.includes('imuMissing');
  const mag = known && imu && !flags.includes('magMissing');
  const level =
    typeof v.roll === 'number' && typeof v.pitch === 'number'
      ? Math.max(Math.abs(v.roll), Math.abs(v.pitch))
      : undefined;
  const engineOff = v.alternator === false;
  const cal = ui.calibration;
  const running = cal !== undefined && cal.result === undefined;

  useEffect(() => {
    const intent = takeIntent(shell, 'calibrate');
    if (intent?.item === 'mag') setSel(2);
  }, []);

  const ready1 = imu && engineOff && level !== undefined && level < 6;
  const ready2 = mag && engineOff;
  useScreenKeys((k) => {
    const c = charOf(k);
    if (k.name === 'down' || k.name === 'up' || c === 'j' || c === 'k') setSel((s) => (s === 1 ? 2 : 1));
    else if (k.name === 'return') {
      const which = selRef.current;
      if (running) ctrl.log('warn', 'a calibration is running: wait for its result');
      else if (which === 1 ? !ready1 : !ready2) ctrl.log('warn', 'calibration: the checks above must pass first');
      else void ctrl.calibrate(which);
    } else return false;
    return true;
  });

  const status = (missing: boolean, notCal: string): Seg =>
    !known
      ? dim('reading…')
      : missing
        ? dim('not fitted')
        : flags.includes(notCal)
          ? { t: `${MARK.error} not calibrated`, fg: C.red }
          : ok(`${MARK.ok} calibrated`);
  const runLine = (kind: 1 | 2) => {
    if (!cal || cal.kind !== kind) return null;
    if (!cal.result) {
      const elapsed = now - cal.startedMs;
      return (
        <>
          <Line
            segs={[
              '   ',
              { t: `${MARK.busy} calibrating… ${kind === 1 ? 'keep it still' : 'keep turning it'}`, fg: C.yellow },
            ]}
          />
          <Line
            segs={[
              '   ',
              { t: progressBar(elapsed / EXPECTED_MS[kind], 28), fg: C.cyan },
              dim(`  ${(elapsed / 1000).toFixed(1)} s of about ${EXPECTED_MS[kind] / 1000} s`),
            ]}
          />
        </>
      );
    }
    if (!cal.result.ok) {
      const why =
        cal.result.text === 'Failed'
          ? kind === 1
            ? 'the board moved or is tilted more than 6°. Level it and try again.'
            : 'not turned enough (every axis must swing 20 µT). Try again, away from steel.'
          : cal.result.text;
      return <Line segs={['   ', { t: `${MARK.error} Failed: ${why}`, fg: C.red }]} />;
    }
    const at = new Date(cal.result.atMs).toTimeString().slice(0, 5);
    return kind === 1 ? (
      <>
        <Line
          segs={[
            '   ',
            ok(`${MARK.ok} Calibrated at ${at}.`),
            dim('  gyro bias  '),
            `${num(v.calGyroBiasX, 2)} / ${num(v.calGyroBiasY, 2)} / ${num(v.calGyroBiasZ, 2)} °/s`,
          ]}
        />
        <Line
          segs={[
            ''.padEnd(26),
            dim('accel bias '),
            `${num(v.calAccelBiasX, 3)} / ${num(v.calAccelBiasY, 3)} / ${num(v.calAccelBiasZ, 3)} g`,
          ]}
        />
      </>
    ) : (
      <Line
        segs={[
          '   ',
          ok(`${MARK.ok} Calibrated at ${at}.`),
          dim('  offset '),
          `${num(v.calMagOffsetX, 1)} / ${num(v.calMagOffsetY, 1)} / ${num(v.calMagOffsetZ, 1)} µT`,
        ]}
      />
    );
  };
  const title = (kind: 1 | 2, text: string, time: string) => (
    <Line
      segs={[
        { t: sel === kind ? `${MARK.select} ` : '  ', fg: C.cyan },
        bold(`${kind}  ${text}`, sel === kind ? C.cyan : C.fg),
        dim(`${''.padEnd(Math.max(1, 44 - text.length))}${time}`),
      ]}
    />
  );
  return (
    <box style={{ flexDirection: 'column' }}>
      <Line
        segs={['STATUS   IMU ', status(!imu, 'imuNotCalibrated'), '   ·   compass ', status(!mag, 'magNotCalibrated')]}
      />
      <Blank />
      {title(1, 'ACCEL + GYRO', 'about 5 s')}
      <Line segs={[dim('   Board flat (z up) and completely still, engine OFF.')]} />
      <box style={{ flexDirection: 'row', paddingLeft: 3 }}>
        <CheckRow status={!known ? 'wait' : imu ? 'ok' : 'fail'} label="IMU present" labelWidth={13} />
        <CheckRow
          status={v.alternator === undefined ? 'wait' : engineOff ? 'ok' : 'fail'}
          label="engine off"
          labelWidth={12}
        />
        <CheckRow
          status={level === undefined ? 'wait' : level < 6 ? 'ok' : 'fail'}
          label={`level: roll ${num(v.roll, 1)}°, pitch ${num(v.pitch, 1)}° (< 6°)`}
          labelWidth={10}
        />
      </box>
      {runLine(1)}
      <Blank />
      {title(2, 'COMPASS (magnetometer)', '20 s')}
      {!mag && known ? (
        <Line segs={[dim('   Not available: no compass fitted (normal on MPU-6500 boards).')]} />
      ) : (
        <>
          <Line segs={[dim('   Turn the board slowly through every direction, away from steel.')]} />
          <Line segs={[dim('   In a vehicle, turning the vehicle is not enough: every axis must swing,')]} />
          <Line segs={[dim('   so calibrate the board before it is mounted.')]} />
        </>
      )}
      {runLine(2)}
      <Blank />
      <Line
        segs={[
          dim(running ? 'Wait for the result.' : `[Enter] start ${sel === 1 ? 'accel + gyro' : 'compass'} · ↑↓ pick`),
        ]}
      />
    </box>
  );
}
