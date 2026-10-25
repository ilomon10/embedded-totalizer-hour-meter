// diagnostics.tsx: 8 Diagnostics, for technicians. Every problem flag in plain words with its fix (`a` lists all
// 20 checks), the restarts, where the values are kept, bus and link counters, and the recovery tools, each behind
// a dialog that says what it does.
import { useEffect, useState } from 'react';

import { causeText } from '../../restart.ts';
import { duration } from '../model/format.ts';
import { ALL_FLAGS, issueFor, issues, okAreas } from '../model/health.ts';
import { activeFlags } from '../state.ts';
import { charOf, takeIntent, useDialogKeys, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { C, MARK } from '../theme.ts';
import { Blank, bold, dim, Dialog, DialogButtons, Heading, keyHint, Line, ok, type Seg } from '../ui.tsx';
import { issueSegs, storageSegs } from './common.tsx';

type Recovery = 'reboot' | 'panic' | 'hard';

function RecoveryDialog({ kind, onClose }: { kind: Recovery; onClose(): void }) {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const persist = Number(ui.device.settings.persistIntervalS ?? 60);
  const text: Record<Recovery, { title: string; lines: string[]; ok: string }> = {
    reboot: {
      title: 'Reboot',
      lines: ['Saves the counters, then restarts the device.', 'It answers again after about 2 s.'],
      ok: 'Reboot',
    },
    panic: {
      title: 'Panic signal',
      lines: [
        'Sends 64 zero bytes: a frozen device restarts at once.',
        'Wired links only (never over Bluetooth). Nothing is saved first.',
      ],
      ok: 'Send',
    },
    hard: {
      title: 'Hard reset',
      lines: [
        "Pulses EN through the USB adapter (like the board's EN button).",
        `Counting since the last save is lost: up to ${duration(persist)}.`,
      ],
      ok: 'Reset',
    },
  };
  const t = text[kind];
  useDialogKeys((k) => {
    if (k.name === 'escape') onClose();
    if (k.name === 'return') {
      onClose();
      void (kind === 'reboot' ? ctrl.reboot() : kind === 'panic' ? ctrl.panic() : ctrl.hardReset());
    }
    return true;
  });
  return (
    <Dialog title={t.title} width={66}>
      {t.lines.map((l) => (
        <Line key={l} segs={[l]} />
      ))}
      <Blank />
      <DialogButtons ok={t.ok} />
    </Dialog>
  );
}

export function DiagnosticsScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const [all, setAll] = useState(false);
  const d = ui.device;
  const v = d.values;
  const flags = activeFlags(d);
  const ctx = { fwVersion: v.fwVersion as number | undefined, autoTimeSync: shell.autoTimeSync };
  const list = issues(flags, ctx);
  const problemList = list.filter((i) => i.severity !== 'info');
  const wired = shell.transport === 'serial' || shell.transport === 'tcp';
  const why: Record<Recovery, string | undefined> = {
    reboot: undefined,
    panic: wired ? undefined : 'wired links only',
    hard: ctrl.canHardReset ? undefined : 'needs a local USB serial port',
  };

  const open = (kind: Recovery) => {
    if (why[kind]) return ctrl.log('warn', `${kind === 'panic' ? 'panic signal' : 'hard reset'}: ${why[kind]}`);
    shell.openDialog(<RecoveryDialog kind={kind} onClose={() => shell.openDialog(undefined)} />);
  };
  useEffect(() => {
    const intent = takeIntent(shell, 'diagnostics');
    if (intent?.action) open(intent.action as Recovery);
  }, []);
  useScreenKeys((k) => {
    const c = charOf(k);
    if (c === 'a') setAll((x) => !x);
    else if (c === 'b') open('reboot');
    else if (c === 'n') open('panic');
    else if (c === 'x') open('hard');
    else return false;
    return true;
  });

  const recovery = (key: string, kind: Recovery, label: string, what: string): Seg[] => [
    { t: `[${key}]`, fg: why[kind] ? C.dim : C.cyan },
    { t: ` ${label}`.padEnd(18), fg: why[kind] ? C.dim : C.fg },
    dim(why[kind] ? `not here: ${why[kind]}` : what),
  ];
  return (
    <box style={{ flexDirection: 'column' }}>
      <Heading
        title="HEALTH"
        right={[
          dim(
            v.statusFlags === undefined
              ? 'reading…'
              : `${problemList.length} to check · ${ALL_FLAGS.length - problemList.length} OK`,
          ),
        ]}
      />
      {all ? (
        ALL_FLAGS.map((f) => {
          const on = flags.includes(f);
          const issue = issueFor(f, flags, ctx);
          return (
            <Line
              key={f}
              segs={[
                on
                  ? {
                      t: issue.severity === 'error' ? MARK.error : issue.severity === 'warn' ? MARK.warn : MARK.live,
                      fg: issue.severity === 'error' ? C.red : issue.severity === 'warn' ? C.yellow : C.dim,
                    }
                  : ok(MARK.ok),
                ` ${f.padEnd(20)}`,
                dim(on ? issue.title : 'ok'),
              ]}
            />
          );
        })
      ) : (
        <>
          {problemList.map((i) => (
            <box key={i.flag} style={{ flexDirection: 'column' }}>
              <Line segs={issueSegs(i, shell.width, false)} />
              {i.fix ? (
                <box style={{ flexDirection: 'row' }}>
                  <box style={{ width: 28, flexShrink: 0 }} />
                  <Line wrap segs={[dim(`Fix: ${i.fix}`)]} />
                </box>
              ) : null}
            </box>
          ))}
          <Line
            segs={[
              ...okAreas(flags).flatMap((a) => [ok(`${MARK.ok} ${a}`), '  ']),
              ...keyHint('a', `all ${ALL_FLAGS.length}`),
            ]}
          />
        </>
      )}
      <Blank />
      <Heading title="RESTARTS" />
      <Line
        segs={[
          'This boot       ',
          dim(
            `${typeof v.resetReason === 'number' ? (v.resetReason === 1 ? 'power-on' : `reset reason ${v.resetReason}`) : '?'}${typeof v.uptime === 'number' ? ` · up ${duration(v.uptime)}` : ''}`,
          ),
        ]}
      />
      <Line
        segs={[
          'Previous run    ',
          causeText(v) ? { t: `ended by ${causeText(v)}`, fg: C.yellow } : dim('ended normally'),
        ]}
      />
      <Line
        segs={[
          'Safe mode       ',
          flags.includes('safeMode')
            ? { t: `${MARK.error} on: I2C is skipped after 3 unplanned restarts`, fg: C.red }
            : dim('off'),
        ]}
      />
      <Blank />
      <Line segs={[bold('STORAGE         ', C.dim), ...storageSegs(d)]} />
      <Line
        segs={[
          ''.padEnd(16),
          dim(
            `save #${String(v.journalSeq ?? '?')} · saves every ${String(d.settings.persistIntervalS ?? '?')} s while running`,
          ),
        ]}
      />
      <Line
        segs={[
          bold('BUS & LINK      ', C.dim),
          dim(
            `I2C errors ${String(v.i2cErrors ?? '–')} · overruns ${String(v.overruns ?? '–')} · RTC ${typeof v.rtcTemp === 'number' ? `${v.rtcTemp.toFixed(1)} °C` : '–'} · frames ${d.frames}`,
          ),
        ]}
      />
      <Blank />
      <Heading title="RECOVERY" right={[dim('each one says what it does and asks first')]} />
      <Line segs={recovery('b', 'reboot', 'Reboot', 'saves the counters, then restarts')} />
      <Line segs={recovery('n', 'panic', 'Panic signal', '64 zero bytes: restarts a frozen device')} />
      <Line segs={recovery('x', 'hard', 'Hard reset', 'pulses EN; loses counting since the last save')} />
    </box>
  );
}
