// counters.tsx: 2 Counters, for maintainers. The hour meter and the totalizer as the device keeps them, and every
// change through a dialog that shows now → new before it is sent. An empty value cannot be applied; a reset
// needs RESET typed.
import { useEffect, useState } from 'react';

import { duration, num } from '../model/format.ts';
import {
  COUNTER_ACTIONS,
  type CounterAction,
  counterInfo,
  type CounterNow,
  counterPrompt,
  planCounter,
} from '../model/counters.ts';
import {
  charOf,
  takeIntent,
  useDialogKeys,
  useNow,
  useRefState,
  useScreenKeys,
  useShell,
  useUi,
} from '../shell-context.tsx';
import { C, MARK } from '../theme.ts';
import { Blank, bold, dim, Dialog, DialogButtons, editLine, FieldLine, Heading, Line, ok } from '../ui.tsx';
import { deviceEpochNow } from './common.tsx';

function useCounterNow(): CounterNow {
  const { ctrl } = useShell();
  const ui = useUi(ctrl);
  const v = ui.device.values;
  return {
    runSeconds: typeof v.runSeconds === 'number' ? v.runSeconds : undefined,
    totalCount: typeof v.totalCount === 'number' ? v.totalCount : undefined,
    pulsesPerUnit: Number(ui.device.settings.pulsesPerUnit ?? 1),
  };
}

export function CounterDialog({ id, onClose }: { id: CounterAction; onClose(): void }) {
  const { ctrl } = useShell();
  const ui = useUi(ctrl);
  const now = useCounterNow();
  const info = counterInfo(id);
  const [text, setText, textRef] = useRefState('');
  const [error, setError] = useState<string>();
  const [sending, setSending, sendingRef] = useRefState(false);
  const preview = planCounter(id, text, now);
  useDialogKeys((k) => {
    if (sendingRef.current) return true;
    if (k.name === 'escape') onClose();
    else if (k.name === 'return') {
      const plan = planCounter(id, textRef.current, now);
      if (!plan.plan) setError(plan.error);
      else {
        setSending(true);
        void ctrl.applyCounter(plan.plan).then((r) => {
          setSending(false);
          if (r.ok) onClose();
          else setError(r.text);
        });
      }
    } else {
      const accept = info.reset
        ? (c: string) => /[A-Za-z]/.test(c)
        : id === 'pulses'
          ? (c: string) => /\d/.test(c)
          : (c: string) => /[\d.]/.test(c);
      const next = editLine(textRef.current, k, accept);
      if (next !== undefined) {
        setText(next);
        setError(undefined);
      }
    }
    return true;
  });
  const plan = preview.plan;
  if (info.reset) {
    const reset = planCounter(id, 'RESET', now).plan!;
    return (
      <Dialog title={info.title} width={56}>
        <Line segs={[`${reset.now} → ${reset.next}. `, bold('This cannot be undone.', C.yellow)]} />
        <Blank />
        <FieldLine label="Type RESET to confirm:  " text={text} />
        {error ? <Line segs={[{ t: `${MARK.error} ${error}`, fg: C.red }]} /> : <Blank />}
        {sending ? <Line segs={[{ t: `${MARK.busy} ${ui.busy ?? 'sending'}…`, fg: C.yellow }]} /> : <Blank />}
        <DialogButtons ok="Reset" disabled={!plan} />
      </Dialog>
    );
  }
  const unit = id === 'hours' ? 'h' : id === 'units' ? 'units' : 'pulses';
  const nowText = planCounter(id, '0', now).plan?.now ?? '?';
  return (
    <Dialog title={info.title} width={58}>
      <Line segs={['Now        ', bold(nowText)]} />
      <FieldLine
        label="New        "
        text={text}
        placeholder={counterPrompt(id, now)}
        after={text ? [` ${unit}`] : []}
      />
      <Blank />
      <Line segs={['Change     ', plan ? `${plan.change}   (${plan.now} → ${plan.next})` : dim('–')]} />
      <Blank />
      <Line segs={[dim('Saved on the device at once (a manual preset).')]} />
      {error ? <Line segs={[{ t: `${MARK.error} ${error}`, fg: C.red }]} /> : <Blank />}
      {sending ? <Line segs={[{ t: `${MARK.busy} ${ui.busy ?? 'sending'}…`, fg: C.yellow }]} /> : <Blank />}
      <DialogButtons ok="Apply" disabled={!plan} />
    </Dialog>
  );
}

const HINTS: Record<CounterAction, (ppu: number) => string> = {
  hours: () => 'the reading of the meter this one replaces',
  units: (ppu) => `uses ${ppu} pulse${ppu === 1 ? '' : 's'} per unit (6 Settings)`,
  pulses: () => '',
  resetHours: () => 'asks you to type RESET',
  resetTotal: () => 'asks you to type RESET',
  resetBoth: () => 'asks you to type RESET',
};

export function CountersScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const now = useNow(1000);
  const [sel, setSel, selRef] = useRefState(0);
  const v = ui.device.values;
  const ppu = Number(ui.device.settings.pulsesPerUnit ?? 1);

  const open = (id: CounterAction) =>
    shell.openDialog(<CounterDialog id={id} onClose={() => shell.openDialog(undefined)} />);
  useEffect(() => {
    const intent = takeIntent(shell, 'counters');
    if (intent?.action) {
      setSel(
        Math.max(
          0,
          COUNTER_ACTIONS.findIndex((a) => a.id === intent.action),
        ),
      );
      open(intent.action as CounterAction);
    }
  }, []);
  useScreenKeys((k) => {
    const c = charOf(k);
    const n = COUNTER_ACTIONS.length;
    if (k.name === 'down' || c === 'j') setSel((s) => (s + 1) % n);
    else if (k.name === 'up' || c === 'k') setSel((s) => (s + n - 1) % n);
    else if (k.name === 'return') open(COUNTER_ACTIONS[selRef.current].id);
    else return false;
    return true;
  });

  const epoch = deviceEpochNow(ui, now);
  const saved =
    typeof v.lastSavedEpoch === 'number' && v.lastSavedEpoch > 0 && epoch !== undefined
      ? `Last saved ${duration(Math.max(0, epoch - v.lastSavedEpoch))} ago`
      : 'Last saved: time unknown';
  const session = ui.device.log.filter((e) => /^(hour meter|totalizer)/.test(e.text)).slice(-4);
  const col = 39;
  return (
    <box style={{ flexDirection: 'column' }}>
      <Line segs={[bold('HOUR METER'.padEnd(col), C.dim), bold('TOTALIZER', C.dim)]} />
      <Line
        segs={[
          bold(`${num(v.runHours)} h`, C.green),
          `  (${String(v.runSeconds ?? '–')} s)`.padEnd(col - `${num(v.runHours)} h`.length),
          bold(`${num(v.totalUnits)} units`, C.green),
        ]}
      />
      <Line
        segs={[
          ''.padEnd(col),
          dim(`${String(v.totalCount ?? '–')} pulses · ${ppu} pulse${ppu === 1 ? '' : 's'} per unit`),
        ]}
      />
      <Line segs={[dim(`${saved}${v.journalSeq !== undefined ? ` · save #${String(v.journalSeq)}` : ''}`)]} />
      <Blank />
      <Heading title="CHANGE" />
      {COUNTER_ACTIONS.map((a, i) => (
        <Line
          key={a.id}
          segs={[
            { t: i === sel ? `${MARK.select} ` : '  ', fg: C.cyan },
            { t: a.label.padEnd(27), fg: i === sel ? C.cyan : C.fg, bold: i === sel },
            dim(HINTS[a.id](ppu)),
          ]}
        />
      ))}
      <Blank />
      <Heading title="THIS SESSION" />
      {session.length === 0 ? (
        <Line segs={[dim('no changes yet')]} />
      ) : (
        session.map((e, i) => (
          <Line
            key={i}
            segs={[
              dim(new Date(e.atMs).toTimeString().slice(0, 5)),
              '  ',
              e.level === 'ok'
                ? ok(`${MARK.ok} ${e.text.replace(/: Ok$/, '')}`)
                : { t: `${MARK.error} ${e.text}`, fg: C.red },
            ]}
          />
        ))
      )}
      <Blank />
      <Line segs={[dim('A change is saved on the device at once and marked as a manual preset,')]} />
      <Line segs={[dim('so an EEPROM moved in later from another unit does not add to it.')]} />
    </box>
  );
}
