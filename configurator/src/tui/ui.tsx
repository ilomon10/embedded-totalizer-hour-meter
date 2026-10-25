// ui.tsx: the small building blocks every screen uses: styled lines, section headings, key hints, a one-line text
// field (our own: masks a PIN, and keys stay with the shell's routing), dialogs and checklist rows.
import { type KeyEvent, TextAttributes } from '@opentui/core';
import type { ReactNode } from 'react';

import { useContext } from 'react';

import { charOf, ShellContext, useShell } from './shell-context.tsx';
import { C, MARK } from './theme.ts';

/** A piece of a line: plain text, or text with a colour / bold / background. */
export type Seg = string | { t: string; fg?: string; bg?: string; bold?: boolean } | false | undefined;

export const ok = (t: string): Seg => ({ t, fg: C.green });
export const warn = (t: string): Seg => ({ t, fg: C.yellow });
export const bad = (t: string): Seg => ({ t, fg: C.red });
export const dim = (t: string): Seg => ({ t, fg: C.dim });
export const cyan = (t: string): Seg => ({ t, fg: C.cyan });
export const bold = (t: string, fg?: string): Seg => ({ t, fg, bold: true });

/** Cut the pieces at `width` cells, the last visible one ending in "…". */
export function fitSegs(segs: Seg[], width: number): Seg[] {
  const out: Seg[] = [];
  let used = 0;
  for (const s of segs) {
    if (!s) continue;
    const text = typeof s === 'string' ? s : s.t;
    const n = [...text].length;
    if (used + n <= width) {
      out.push(s);
      used += n;
      continue;
    }
    const room = width - used;
    if (room > 0) {
      const cut = `${[...text].slice(0, Math.max(0, room - 1)).join('')}…`;
      out.push(typeof s === 'string' ? cut : { ...s, t: cut });
    }
    break;
  }
  return out;
}

/**
 * One line of styled pieces. In the shell it is cut at the content width (or `max`) with "…" at the end;
 * `wrap` word-wraps it instead (help texts).
 */
export function Line({
  segs,
  fg = C.fg,
  bg,
  wrap,
  max,
}: {
  segs: Seg[];
  fg?: string;
  bg?: string;
  wrap?: boolean;
  max?: number;
}) {
  const shell = useContext(ShellContext);
  const width = max ?? shell?.width;
  const shown = wrap || width === undefined ? segs : fitSegs(segs, width);
  return (
    <text fg={fg} bg={bg} wrapMode={wrap ? 'word' : 'none'}>
      {shown.map((s, i) =>
        !s ? null : typeof s === 'string' ? (
          <span key={i}>{s}</span>
        ) : (
          <span key={i} fg={s.fg} bg={s.bg} attributes={s.bold ? TextAttributes.BOLD : TextAttributes.NONE}>
            {s.t}
          </span>
        ),
      )}
    </text>
  );
}

export function Blank() {
  return <text> </text>;
}

/** Left and right on one line (`max`: the line's width when it is not the content area's, e.g. the footer). */
export function Spread({ left, right, max }: { left: Seg[]; right: Seg[]; max?: number }) {
  return (
    <box style={{ flexDirection: 'row', justifyContent: 'space-between', flexShrink: 1, minWidth: 0 }}>
      <Line segs={left} max={max} />
      <Line segs={right} max={max} />
    </box>
  );
}

/** A section heading in capitals ("NEEDS ATTENTION"), with an optional note on the right. */
export function Heading({ title, right }: { title: string; right?: Seg[] }) {
  return <Spread left={[bold(title, C.dim)]} right={right ?? []} />;
}

/** "[k] label" key hints, for the bottom of a screen. */
export function keyHint(key: string, label: string): Seg[] {
  return [{ t: `[${key}]`, fg: C.cyan }, ` ${label}   `];
}

// -------------------------------------------------------------- line editing --

export interface FieldValue {
  text: string;
}

/**
 * Apply one key to a single-line field: characters are appended, Backspace deletes, Ctrl+U clears. Returns the new
 * text, or undefined when the key is not for the field (Enter, Esc, arrows...). `accept` filters characters.
 */
export function editLine(text: string, key: KeyEvent, accept: (c: string) => boolean = () => true): string | undefined {
  if (key.name === 'backspace') return text.slice(0, -1);
  if (key.ctrl && key.name === 'u') return '';
  const c = charOf(key);
  if (c === undefined) return undefined;
  return accept(c) ? text + c : text;
}

/** The field as text: the value (or dots for a PIN), the cursor, and a gray placeholder when empty. */
export function FieldLine({
  label,
  text,
  placeholder,
  mask,
  focused = true,
  after,
}: {
  label?: string;
  text: string;
  placeholder?: string;
  mask?: boolean;
  focused?: boolean;
  after?: Seg[];
}) {
  const shown = mask ? '•'.repeat(text.length) : text;
  return (
    <Line
      segs={[
        label,
        { t: shown, fg: C.fg, bold: true },
        focused ? { t: '█', fg: C.cyan } : false,
        !text && placeholder ? dim(` ${placeholder}`) : false,
        ...(after ?? []),
      ]}
    />
  );
}

// ------------------------------------------------------------------ dialogs --

/** A dialog in the middle of the content area. Its keys come through useDialogKeys. */
export function Dialog({ title, width, children }: { title: string; width: number; children: ReactNode }) {
  const shell = useShell();
  const w = Math.min(width, shell.width + 2);
  return (
    <box
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 20,
      }}
    >
      <box
        border
        borderStyle="rounded"
        borderColor={C.borderFocus}
        title={` ${title} `}
        backgroundColor={C.dialogBg}
        style={{ width: w, flexDirection: 'column', paddingLeft: 2, paddingRight: 2, paddingTop: 1, paddingBottom: 1 }}
      >
        <ShellContext.Provider value={{ ...shell, width: w - 6 }}>{children}</ShellContext.Provider>
      </box>
    </box>
  );
}

/** "[Enter] Apply        [Esc] Cancel" */
export function DialogButtons({
  ok: okLabel,
  cancel = 'Cancel',
  disabled,
}: {
  ok: string;
  cancel?: string;
  disabled?: boolean;
}) {
  return (
    <Line
      segs={[
        { t: '[Enter]', fg: disabled ? C.dim : C.cyan },
        { t: ` ${okLabel}`, fg: disabled ? C.dim : C.fg, bold: !disabled },
        '          ',
        { t: '[Esc]', fg: C.cyan },
        ` ${cancel}`,
      ]}
    />
  );
}

// ----------------------------------------------------------------- checklist --

export type CheckMark = 'ok' | 'fail' | 'warn' | 'wait' | 'todo' | 'run';

const CHECK: Record<CheckMark, Seg> = {
  ok: { t: MARK.ok, fg: C.green },
  fail: { t: MARK.error, fg: C.red },
  warn: { t: MARK.warn, fg: C.yellow },
  wait: { t: MARK.busy, fg: C.yellow },
  run: { t: MARK.busy, fg: C.yellow },
  todo: { t: ' ', fg: C.dim },
};

export function checkMark(status: CheckMark): Seg {
  return CHECK[status];
}

/** "✔ Label            detail" (a long detail wraps under itself). */
export function CheckRow({
  status,
  label,
  detail,
  labelWidth = 22,
}: {
  status: CheckMark;
  label: string;
  detail?: string;
  labelWidth?: number;
}) {
  const color = status === 'fail' ? C.red : status === 'todo' ? C.dim : C.fg;
  return (
    <box style={{ flexDirection: 'row' }}>
      <box style={{ width: labelWidth + 2, flexShrink: 0 }}>
        <Line segs={[CHECK[status], ' ', { t: label, fg: color }]} max={labelWidth + 2} />
      </box>
      {detail ? <Line wrap segs={[{ t: detail, fg: status === 'fail' ? C.red : C.dim }]} /> : null}
    </box>
  );
}
