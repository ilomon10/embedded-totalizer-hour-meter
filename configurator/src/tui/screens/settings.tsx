// settings.tsx: 6 Settings. The 20 settings grouped by what they control, with their factory default and a mark
// on the ones changed but not applied yet. Enter edits in place (a number starts from the current value, a choice
// is a picker); `a` reviews all changes with their consequences and link warnings, and sends them as one command.
import { useEffect, useState } from 'react';

import { activeFlags } from '../state.ts';
import {
  type Change,
  crossCheck,
  editText,
  parseSettingInput,
  pendingChanges,
  rangeText,
  reviewNotes,
  SETTING_GROUPS,
  SETTING_UI,
  type SettingUi,
  valueText,
} from '../model/settings.ts';
import { SETTINGS } from '../../tags.ts';
import { charOf, takeIntent, useDialogKeys, useRefState, useScreenKeys, useShell, useUi } from '../shell-context.tsx';
import { C, MARK } from '../theme.ts';
import { bold, dim, Dialog, DialogButtons, editLine, Line, type Seg, Spread } from '../ui.tsx';

/** Review staged changes, then send them as one command (all or nothing). */
export function ApplyDialog({ changes, onClose }: { changes: Change[]; onClose(): void }) {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const [error, setError] = useState<string>();
  const [sending, setSending, sendingRef] = useRefState(false);
  const after = { ...ui.device.settings, ...Object.fromEntries(changes.map((c) => [c.name, c.to])) };
  const blocking = crossCheck(after);
  const ctx = { transport: shell.transport, values: ui.device.values, flags: activeFlags(ui.device) };
  const cutsLink = changes.some((c) => reviewNotes(c, ctx).some((n) => n.level === 'error'));
  useDialogKeys((k) => {
    if (sendingRef.current) return true;
    if (k.name === 'escape') onClose();
    else if (k.name === 'return' && !blocking) {
      setSending(true);
      void ctrl.applySettings(changes).then((r) => {
        setSending(false);
        if (r.ok) onClose();
        else setError(r.text.replace(/^settings: .*?: /, ''));
      });
    }
    return true;
  });
  return (
    <Dialog title={`Apply ${changes.length} change${changes.length === 1 ? '' : 's'}`} width={74}>
      {changes.map((c) => {
        const label = SETTING_UI.find((s) => s.name === c.name)?.label ?? c.name;
        return (
          <box key={c.name} style={{ flexDirection: 'column' }}>
            <Line
              segs={[label.padEnd(24), bold(`${valueText(c.name, c.from, true)} → ${valueText(c.name, c.to, true)}`)]}
            />
            {reviewNotes(c, ctx).map((n, i) => (
              <Line
                key={i}
                segs={[
                  ''.padEnd(2),
                  {
                    t: `${n.level === 'error' ? MARK.error : n.level === 'warn' ? MARK.warn : ' '} ${n.text}`,
                    fg: n.level === 'error' ? C.red : n.level === 'warn' ? C.yellow : C.dim,
                  },
                ]}
              />
            ))}
          </box>
        );
      })}
      <text> </text>
      {blocking ? (
        <Line segs={[{ t: `${MARK.error} ${blocking}`, fg: C.red }]} />
      ) : (
        <Line segs={[dim('Sent as one command: all are applied, or none.')]} />
      )}
      {error ? <Line segs={[{ t: `${MARK.error} the device refused: ${error}`, fg: C.red }]} /> : null}
      {sending ? <Line segs={[{ t: `${MARK.busy} sending…`, fg: C.yellow }]} /> : null}
      <text> </text>
      <DialogButtons ok={cutsLink ? 'Apply anyway' : 'Apply'} cancel="Keep editing" disabled={Boolean(blocking)} />
    </Dialog>
  );
}

type Row = { kind: 'group'; title: string } | { kind: 'setting'; ui: SettingUi };

export function SettingsScreen() {
  const shell = useShell();
  const { ctrl } = shell;
  const ui = useUi(ctrl);
  const device = ui.device.settings;
  const [filter, setFilter, filterRef] = useRefState('');
  const [filtering, setFiltering, filteringRef] = useRefState(false);
  const [sel, setSel, selRef] = useRefState(0);
  const [edit, setEdit, editRef] = useRefState<{ text: string; choice: number } | undefined>(undefined);
  const [error, setError] = useState<string>();

  const matching = (text: string) => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    return SETTING_UI.filter((s) => words.every((w) => `${s.label} ${s.name} ${s.group}`.toLowerCase().includes(w)));
  };
  const visible = matching(filter);
  const rows: Row[] = SETTING_GROUPS.flatMap((g) => {
    const inGroup = visible.filter((s) => s.group === g);
    return inGroup.length
      ? [{ kind: 'group' as const, title: g }, ...inGroup.map((s) => ({ kind: 'setting' as const, ui: s }))]
      : [];
  });
  const index = Math.min(sel, Math.max(0, visible.length - 1));
  const current = visible[index];
  const changes = pendingChanges(device, ui.draft);
  const shown = (name: string) => (name in ui.draft ? ui.draft[name] : device[name]);

  useEffect(() => {
    const intent = takeIntent(shell, 'settings');
    if (intent?.item)
      setSel(
        Math.max(
          0,
          SETTING_UI.findIndex((s) => s.name === intent.item),
        ),
      );
  }, []);

  useScreenKeys((k) => {
    const c = charOf(k);
    // Read the refs: several keys can arrive before the next draw.
    const list = matching(filterRef.current);
    const at = Math.min(selRef.current, Math.max(0, list.length - 1));
    const cur = list[at];
    const e = editRef.current;
    if (e) {
      if (k.name === 'escape') {
        setEdit(undefined);
        setError(undefined);
      } else if (k.name === 'return' && cur) {
        if (cur.choices) {
          ctrl.stage(cur.name, cur.choices[e.choice].value);
          setEdit(undefined);
        } else {
          const parsed = parseSettingInput(cur.name, e.text);
          if (parsed.error !== undefined || parsed.value === undefined) setError(parsed.error);
          else {
            ctrl.stage(cur.name, parsed.value);
            setEdit(undefined);
          }
        }
      } else if (cur?.choices && (k.name === 'left' || k.name === 'right' || k.name === 'up' || k.name === 'down')) {
        const n = cur.choices.length;
        setEdit({ ...e, choice: (e.choice + (k.name === 'left' || k.name === 'up' ? n - 1 : 1)) % n });
      } else if (!cur?.choices) {
        const next = editLine(e.text, k, (ch) => /[\d.eE+-]/.test(ch) || /[a-z]/i.test(ch));
        if (next !== undefined) {
          setEdit({ ...e, text: next });
          setError(undefined);
        }
      }
      return true;
    }
    if (filteringRef.current) {
      if (k.name === 'escape') {
        setFilter('');
        setFiltering(false);
      } else if (k.name === 'return' || k.name === 'down') setFiltering(false);
      else {
        const next = editLine(filterRef.current, k);
        if (next !== undefined) {
          setFilter(next);
          setSel(0);
        }
      }
      return true;
    }
    if ((k.name === 'down' || c === 'j') && list.length) setSel((at + 1) % list.length);
    else if ((k.name === 'up' || c === 'k') && list.length) setSel((at + list.length - 1) % list.length);
    else if (k.name === 'return' && cur) {
      setError(undefined);
      const v =
        cur.name in ctrl.snapshot.draft ? ctrl.snapshot.draft[cur.name] : ctrl.snapshot.device.settings[cur.name];
      const choice = Math.max(0, cur.choices?.findIndex((ch) => Number(ch.value) === Number(v)) ?? 0);
      setEdit({ text: editText(cur.name, v), choice });
    } else if (c === '/') setFiltering(true);
    else if (k.name === 'escape' && filterRef.current) setFilter('');
    else if (c === 'a') {
      const pending = pendingChanges(ctrl.snapshot.device.settings, ctrl.snapshot.draft);
      if (pending.length)
        shell.openDialog(<ApplyDialog changes={pending} onClose={() => shell.openDialog(undefined)} />);
      else ctrl.log('info', 'no setting changes to apply');
    } else if (c === 'z' && cur) ctrl.unstage(cur.name);
    else if (c === 'd' && cur) ctrl.stage(cur.name, cur.factory);
    else return false;
    return true;
  });

  // Rows that fit: the detail pane takes up to 7 lines (help texts wrap), the filter line 1.
  const listHeight = Math.max(4, shell.height - 9);
  const selRow = rows.findIndex((r) => r.kind === 'setting' && r.ui === current);
  const top = Math.max(0, Math.min(selRow - Math.floor(listHeight / 2), rows.length - listHeight));
  const page = rows.slice(top, top + listHeight);

  const rowSegs = (s: SettingUi): Seg[] => {
    const on = s === current;
    const staged = s.name in ui.draft;
    const value = valueText(s.name, shown(s.name));
    let valueSegs: Seg[];
    if (on && edit) {
      valueSegs = s.choices
        ? s.choices.flatMap((ch, i) => [
            {
              t: i === edit.choice ? `(•) ${ch.label}` : `( ) ${ch.label}`,
              fg: i === edit.choice ? C.cyan : C.dim,
              bold: i === edit.choice,
            },
            '  ',
          ])
        : [
            { t: edit.text, fg: C.fg, bold: true },
            { t: '█', fg: C.cyan },
            dim(` ${s.unit ?? ''}  ${rangeText(s.name)}`),
          ];
    } else {
      valueSegs = [
        { t: `${value} `.padEnd(18), fg: staged ? C.yellow : C.green },
        staged
          ? { t: `${MARK.changed} was ${valueText(s.name, device[s.name])} `.padEnd(16), fg: C.yellow }
          : ''.padEnd(16),
        dim(`default ${valueText(s.name, s.factory, true)}`),
      ];
    }
    return [
      { t: on ? MARK.select : ' ', fg: C.cyan },
      ' ',
      { t: s.label.padEnd(25), fg: on ? C.cyan : C.fg, bold: on },
      ...valueSegs,
    ];
  };

  return (
    <box style={{ flexDirection: 'column' }}>
      <Spread
        left={
          filtering || filter
            ? [{ t: '/ ', fg: C.cyan }, { t: filter, bold: true }, filtering ? { t: '█', fg: C.cyan } : '']
            : [dim('/ filter settings')]
        }
        right={
          changes.length
            ? [
                { t: `${changes.length} change${changes.length === 1 ? '' : 's'} · `, fg: C.yellow },
                { t: '[a]', fg: C.cyan },
                ' apply…',
              ]
            : [dim('no changes')]
        }
      />
      {page.map((r, i) =>
        r.kind === 'group' ? (
          <Line key={`g${top + i}`} segs={[bold(r.title, C.dim)]} />
        ) : (
          <Line key={r.ui.name} segs={rowSegs(r.ui)} />
        ),
      )}
      {top + listHeight < rows.length ? (
        <Line segs={[dim(`${''.padEnd(Math.max(0, shell.width - 12))}▼ ${rows.length - top - listHeight} more`)]} />
      ) : null}
      <Line segs={[dim('─'.repeat(Math.max(10, shell.width - 1)))]} />
      {current ? (
        <>
          <Line
            segs={[
              bold(current.label),
              dim(` · ${current.name} (tag ${SETTINGS[current.name].tag}) · ${rangeText(current.name)}`),
            ]}
          />
          <Line wrap segs={[current.help]} />
          {error ? (
            <Line segs={[{ t: `${MARK.error} ${error}`, fg: C.red }]} />
          ) : (
            <Line wrap segs={[dim(current.advice ?? '')]} />
          )}
          <Line
            segs={[
              dim(
                edit
                  ? current.choices
                    ? '←→ choose · Enter keep · Esc cancel'
                    : 'Enter keep · Esc cancel · Ctrl+U clear'
                  : 'Enter edit · z undo · d factory default · a review and apply',
              ),
            ]}
          />
        </>
      ) : (
        <Line segs={[dim('no setting matches the filter')]} />
      )}
    </box>
  );
}
