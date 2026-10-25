// commission.tsx: 4 Commission, the install wizard. Eight steps on the left, the current one on the right with
// its checks worked out from the device; the engine input is checked over 3 s of live readings once the
// technician says the key is on (engine off) or the engine runs. Progress is kept per device id.
// Keys: Enter runs the step, or goes on once it passed; Space ticks a module (step 2). One meaning per key.
import { useEffect } from 'react';

import {
  checks,
  doneCount,
  emptyProgress,
  engineVerdict,
  MODULES,
  passed,
  type Progress,
  presentModules,
  STEPS,
  type StepId,
} from '../model/commission.ts';
import { deviceIdText } from '../model/format.ts';
import { findRelease } from '../../releases.ts';
import { charOf, useNow, useRefState, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { loadDeviceJson, saveDeviceJson } from '../store.ts';
import { C, MARK } from '../theme.ts';
import { Blank, bold, CheckRow, dim, keyHint, Line, type Seg } from '../ui.tsx';

const ENGINE_CHECK_MS = 3000;

export function CommissionScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const now = useNow(500);
  const id = ui.device.deviceId;
  // Refs: several keys can arrive before the next draw, and each must act on the state the one before left.
  const [progress, setProgress, progressRef] = useRefState<Progress>(emptyProgress);
  const [step, setStep, stepRef] = useRefState(0);
  const [engineRun, setEngineRun, engineRunRef] = useRefState<{ expect: 'off' | 'on'; fromMs: number } | undefined>(
    undefined,
  );
  const [fittedCursor, setFittedCursor, cursorRef] = useRefState(0);

  useEffect(() => {
    if (id === undefined) return;
    const shown = stepRef.current;
    void loadDeviceJson('commission', id, emptyProgress()).then((p) => {
      setProgress(p);
      if (stepRef.current !== shown) return; // the technician moved meanwhile: stay there
      const first = STEPS.findIndex((s) => !p.marks[s.id]);
      setStep(first < 0 ? STEPS.length - 1 : first);
    });
  }, [id]);

  const save = (next: Progress) => {
    const stamped = { ...next, updatedAt: new Date().toISOString() };
    setProgress(stamped);
    if (id !== undefined) void saveDeviceJson('commission', id, stamped);
  };

  // The 3 s engine check ends here.
  useEffect(() => {
    if (!engineRun || now - engineRun.fromMs < ENGINE_CHECK_MS) return;
    const verdict = engineVerdict(ui.history, engineRun.fromMs - 1000, now, engineRun.expect);
    save({ ...progressRef.current, [engineRun.expect === 'off' ? 'engineOff' : 'engineOn']: verdict });
    setEngineRun(undefined);
  }, [now, engineRun]);

  const current = STEPS[step];
  const latest = ui.releases ? findRelease(ui.releases, 'latest')?.version : undefined;
  const list = checks(current.id, { state: ui.device, progress, latest });
  const ok = passed(list);

  /** A step's checks as they are now (from the refs and the controller, not the last draw). */
  const passedNow = (s: StepId) =>
    passed(checks(s, { state: ctrl.snapshot.device, progress: progressRef.current, latest }));

  /** Mark the step (done if it passed, else skipped) and go to the next one. */
  const next = () => {
    const at = stepRef.current;
    const s = STEPS[at].id;
    const p = progressRef.current;
    save({ ...p, marks: { ...p.marks, [s]: passedNow(s) ? 'done' : 'skipped' } });
    setStep(Math.min(STEPS.length - 1, at + 1));
  };

  /** Space on step 2: tick or untick the module under the cursor (a module that is not fitted need not answer). */
  const toggleFitted = () => {
    const present = presentModules(ctrl.snapshot.device);
    if (!present) return;
    const p = progressRef.current;
    const fitted = p.fitted ?? present;
    const key = MODULES[cursorRef.current][0];
    save({ ...p, fitted: { ...fitted, [key]: !fitted[key] } });
  };

  /** Enter: go on when the step passed, else run what it needs. */
  const act = (s: StepId) => {
    if (passedNow(s)) return next();
    const p = progressRef.current;
    const device = ctrl.snapshot.device;
    switch (s) {
      case 'identify':
        return shell.go('firmware');
      case 'modules':
        return void ctrl.refresh();
      case 'engine': {
        if (engineRunRef.current) return;
        const expect = !p.engineOff?.ok ? 'off' : 'on';
        return setEngineRun({ expect, fromMs: Date.now() });
      }
      case 'pulse':
        return save({ ...p, pulseFrom: Number(device.values.totalCount ?? 0) });
      case 'clock':
        return void ctrl.setTime();
      case 'calibrate':
        return shell.go('calibrate');
      case 'counters':
        save({ ...p, marks: { ...p.marks, counters: 'done' } });
        shell.intent.current = { screen: 'counters', action: 'hours' };
        return shell.go('counters');
      case 'finish':
        return shell.go(Number(device.settings.btPin) === 1234 && device.settings.bluetooth ? 'settings' : 'report');
    }
  };

  useScreenKeys((k) => {
    const c = charOf(k);
    const s = STEPS[stepRef.current].id;
    if (s === 'modules' && (k.name === 'left' || k.name === 'right')) {
      setFittedCursor((f) => (f + (k.name === 'right' ? 1 : MODULES.length - 1)) % MODULES.length);
    } else if (s === 'modules' && k.name === 'space') toggleFitted();
    else if (k.name === 'down' || c === 'j') setStep((x) => Math.min(STEPS.length - 1, x + 1));
    else if (k.name === 'up' || c === 'k') setStep((x) => Math.max(0, x - 1));
    else if (k.name === 'return') act(s);
    else if (c === 's') next();
    else if (c === 'b') setStep((x) => Math.max(0, x - 1));
    else if (c === 'x' && s === 'engine') save({ ...progressRef.current, engineOff: undefined, engineOn: undefined });
    else return false;
    return true;
  });

  const leftWidth = 28;
  const stepRows: Seg[][] = STEPS.map((s, i) => {
    const mark = progress.marks[s.id];
    const on = i === step;
    return [
      mark === 'done'
        ? { t: MARK.ok, fg: C.green }
        : mark === 'skipped'
          ? { t: '–', fg: C.dim }
          : on
            ? { t: MARK.select, fg: C.cyan }
            : ' ',
      ' ',
      { t: `${s.n} ${s.label}`.padEnd(leftWidth - 2), fg: on ? C.cyan : mark ? C.dim : C.fg, bold: on },
    ];
  });

  const fitted = progress.fitted ?? presentModules(ui.device);
  const detail: Array<Seg[] | 'checks'> = [
    [bold(current.label.toUpperCase(), C.dim), dim(`   step ${current.n} of ${STEPS.length}`)],
    [dim(current.intro)],
    [' '],
    'checks',
  ];
  return (
    <box style={{ flexDirection: 'column' }}>
      <Line
        segs={[dim(`${deviceIdText(id)} · ${doneCount(progress)} of ${STEPS.length} steps done · progress is saved`)]}
      />
      <Blank />
      <box style={{ flexDirection: 'row' }}>
        <box style={{ width: leftWidth, flexDirection: 'column', flexShrink: 0 }}>
          <Line segs={[bold('STEPS', C.dim)]} />
          {stepRows.map((segs, i) => (
            <Line key={i} segs={segs} />
          ))}
        </box>
        <box style={{ flexDirection: 'column', width: Math.max(20, shell.width - leftWidth) }}>
          {detail.map((row, i) =>
            row === 'checks' ? (
              <box key={i} style={{ flexDirection: 'column' }}>
                {list.map((c) => (
                  <CheckRow
                    key={c.label}
                    status={engineRun && c.status === 'todo' ? 'run' : c.status}
                    label={c.label}
                    detail={c.detail}
                  />
                ))}
              </box>
            ) : (
              <Line key={i} segs={row} wrap={i === 1} max={shell.width - leftWidth} />
            ),
          )}
          {current.id === 'modules' && fitted ? (
            <>
              <Blank />
              <Line
                segs={[
                  dim('Fitted: '),
                  // One space apart: all four fit in the 48 columns beside the steps.
                  ...MODULES.flatMap(([key, name], i): Seg[] => [
                    i ? ' ' : false,
                    {
                      t: `${fitted[key] ? '[x]' : '[ ]'} ${name}`,
                      fg: i === fittedCursor ? C.cyan : C.fg,
                      bold: i === fittedCursor,
                    },
                  ]),
                ]}
              />
              <Line segs={[dim('←→ pick a module · Space tick or untick')]} />
            </>
          ) : null}
          {current.id === 'engine' ? (
            <>
              <Blank />
              <Line
                segs={[
                  dim('Live   '),
                  `input ${ui.device.values.altInput ? `${MARK.live} on` : `${MARK.off} off`} · counted ${ui.device.values.alternator ? `${MARK.live} RUNNING` : `${MARK.off} stopped`}`,
                ]}
              />
              {engineRun ? (
                <Line
                  segs={[
                    {
                      t: `${MARK.busy} checking ${Math.max(0, Math.ceil((ENGINE_CHECK_MS - (now - engineRun.fromMs)) / 1000))} s…`,
                      fg: C.yellow,
                    },
                  ]}
                />
              ) : null}
              {progress.engineOff && !progress.engineOff.ok ? (
                <>
                  <Blank />
                  <Line
                    wrap
                    segs={[
                      dim(
                        'The wire is live at key-on (IG/ACC). Move it to the alternator L/D+ terminal or the oil-pressure switch, or set a vibration threshold in 5 Live inputs. Then x to check again.',
                      ),
                    ]}
                  />
                </>
              ) : null}
            </>
          ) : null}
          <Blank />
          <Line
            segs={
              ok
                ? [{ t: `${MARK.ok} step passed`, fg: C.green }, '   ', ...keyHint('Enter', 'next step')]
                : [...keyHint('Enter', ACT[current.id]), ...keyHint('s', 'skip'), ...keyHint('b', 'back')]
            }
          />
        </box>
      </box>
    </box>
  );
}

const ACT: Record<StepId, string> = {
  identify: 'open 9 Firmware',
  modules: 'check again',
  engine: 'check now (3 s)',
  pulse: 'start watching',
  clock: 'set time from this PC',
  calibrate: 'open 7 Calibrate',
  counters: 'open 2 Counters',
  finish: 'fix / save the report',
};
