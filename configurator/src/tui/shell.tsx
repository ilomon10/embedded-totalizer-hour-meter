// shell.tsx: the frame around every screen.
//
//   HOUR METER │ 1A2B3C4D │ fw 2.6.0 ↑ │ ● USB /dev/ttyUSB0 (CP2102) │ 14:32:05 UTC        ▲ 2 to check
//   ✖ Board unplugged 12 s ago. Plug it back in: it reconnects by itself.              [p] other port
//   ╭ MAINTAIN ──────╮╭─ Overview ─────────────────────────────────────────────────────────────╮
//   │ ▸1 Overview    ││ ...                                                                   │
//   ...
//    ✔ last result                                        ↑↓ select   Enter open   ? help   q quit
//
// From 100 columns the menu is a sidebar, below that one tab line. Keys go to the open dialog, then the screen,
// then the global keys: 1-9 0 screens, Tab menu, ? help, : or Ctrl+K palette, r refresh, p port, q quit.
import type { KeyEvent } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import { isValidElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { formatFirmware } from '../releases.ts';
import { FLASH_RUNNING, type TuiController, type UiState } from './controller.ts';
import { banner } from './model/banner.ts';
import { age, deviceIdText, fit, shortPort, utcClock } from './model/format.ts';
import { problems, summary } from './model/health.ts';
import { GROUPS, SCREENS, type ScreenId, screenByKey, screenInfo, WIDE_COLUMNS } from './model/nav.ts';
import { pendingChanges, SETTING_UI, type Transport } from './model/settings.ts';
import { activeFlags, updateAvailable } from './state.ts';
import { CalibrateScreen } from './screens/calibrate.tsx';
import { CommissionScreen } from './screens/commission.tsx';
import { CountersScreen } from './screens/counters.tsx';
import { DiagnosticsScreen } from './screens/diagnostics.tsx';
import { FirmwareScreen } from './screens/firmware.tsx';
import { LiveScreen } from './screens/live.tsx';
import { LogScreen } from './screens/log.tsx';
import { OverviewScreen } from './screens/overview.tsx';
import { ReportScreen } from './screens/report.tsx';
import { SettingsScreen } from './screens/settings.tsx';
import {
  charOf,
  type Intent,
  type KeyHandler,
  type ShellApi,
  ShellContext,
  useDialogKeys,
  useNow,
  useRefState,
  useShell,
  useUi,
} from './shell-context.tsx';
import { C, MARK } from './theme.ts';
import { bold, dim, Dialog, DialogButtons, editLine, FieldLine, keyHint, Line, type Seg, Spread } from './ui.tsx';

export interface ShellProps {
  ctrl: TuiController;
  transport: Transport;
  /** The adapter's name from the connect screen ("Silicon Labs CP2102 ..."). */
  portLabel?: string;
  canSwitchPort: boolean;
  onSwitchPort(): void;
  onQuit(): void;
  autoTimeSync: boolean;
  toolVersion: string;
}

const SIDEBAR = 20;

const FOOTER: Record<ScreenId, string> = {
  overview: '↑↓ select   Enter open   h hours   t time   ? help   : command   q quit',
  counters: '↑↓ select   Enter change…   ? help   q quit',
  report: 'Enter fill in   Tab next field   s save   ? help',
  commission: 'Enter check/next   s skip   b back   ? help',
  live: 'o / i measure 10 s   t threshold…   - + zoom   z since now   ? help',
  settings: '↑↓ select   Enter edit   / filter   a apply…   z undo   d default   ? help',
  calibrate: '↑↓ select   Enter start   ? help',
  diagnostics: 'a all checks   b reboot…   n panic…   x hard reset…   ? help',
  firmware: '↑↓ select   Enter update…   f file…   d download   c check   ? help',
  log: '↑↓ scroll   ←→ filter   f follow   s save to file   ? help',
};

/** Each screen's keys for the help (?): a key in 10 columns, what it does in 20. */
export const SCREEN_HELP: Record<ScreenId, Array<[string, string]>> = {
  overview: [
    ['↑↓ Enter', 'open a problem'],
    ['h', 'set hours…'],
    ['t', 'set time'],
    ['w', 'service report'],
  ],
  counters: [['↑↓ Enter', 'change a counter…']],
  report: [
    ['Enter', 'fill in the fields'],
    ['Tab', 'next field'],
    ['s', 'save the report'],
  ],
  commission: [
    ['↑↓', 'pick a step'],
    ['Enter', 'run step, then next'],
    ['Space', 'tick / untick'],
    ['s', 'skip the step'],
    ['b', 'back'],
  ],
  live: [
    ['o', 'measure engine off'],
    ['i', 'measure idling'],
    ['t', 'set the threshold…'],
    ['- +', 'zoom the chart'],
    ['z', 'count from now'],
  ],
  settings: [
    ['Enter', 'edit the setting'],
    ['/', 'filter'],
    ['a', 'review and apply…'],
    ['z', 'undo this change'],
    ['d', 'factory default'],
  ],
  calibrate: [
    ['↑↓', 'pick'],
    ['Enter', 'start'],
  ],
  diagnostics: [
    ['a', 'all 20 checks'],
    ['b', 'reboot…'],
    ['n', 'panic signal…'],
    ['x', 'hard reset…'],
  ],
  firmware: [
    ['Enter', 'update to selected…'],
    ['f', 'flash a file…'],
    ['d', 'download only'],
    ['c', 'check again'],
  ],
  log: [
    ['↑↓', 'scroll'],
    ['←→', 'filter'],
    ['f', 'follow'],
    ['s', 'save to a file'],
  ],
};

/** "CP2102", "CH340", "FTDI" from an adapter label. */
function chipName(label?: string): string | undefined {
  return label?.match(/CP21\d\d|CH34\d|CH9102|FT232\w*|FTDI|USB JTAG/i)?.[0];
}

const LINK_WORD: Record<Transport, string> = { serial: 'USB', bluetooth: 'BT', tcp: 'TCP', demo: 'DEMO' };

function Header({ ui, props, now, width }: { ui: UiState; props: ShellProps; now: number; width: number }) {
  const d = ui.device;
  const flags = d.values.statusFlags === undefined ? undefined : activeFlags(d);
  const health = summary(flags, {
    fwVersion: d.values.fwVersion as number | undefined,
    autoTimeSync: props.autoTimeSync,
  });
  const update = updateAvailable(d.values.fwVersion, ui.releases);
  const live = d.lastFrameMs !== undefined && now - d.lastFrameMs < 5000;
  const port = shortPort(d.port, 24);
  const link: Seg =
    d.connection === 'demo'
      ? { t: `${MARK.live} DEMO simulated`, fg: C.green }
      : d.connection === 'waiting'
        ? { t: `${MARK.off} disconnected ${port}`, fg: C.red }
        : d.connection === 'paused'
          ? { t: `${MARK.busy} flashing ${port}`, fg: C.yellow }
          : d.connection === 'connecting'
            ? { t: `${MARK.busy} connecting ${port}`, fg: C.yellow }
            : {
                t: `${MARK.live} ${live ? LINK_WORD[props.transport] : 'no data'} ${port}${chipName(props.portLabel) ? ` (${chipName(props.portLabel)})` : ''}`,
                fg: live ? C.green : C.yellow,
              };
  const clock =
    ui.clock && d.values.timeValid !== false
      ? `${utcClock(ui.clock.epoch + Math.floor((now - ui.clock.atMs) / 1000))} UTC`
      : 'time unknown';
  const sep: Seg = { t: ' │ ', fg: C.dim };
  const left: Seg[] = [
    bold(' HOUR METER', C.fg),
    sep,
    deviceIdText(d.deviceId),
    sep,
    `fw ${formatFirmware(d.values.fwVersion)}`,
    update ? { t: ` ${MARK.update}`, fg: C.yellow } : false,
    sep,
    link,
  ];
  const cells = (segs: Seg[]) => segs.reduce((n, x) => n + (typeof x === 'string' ? x.length : x ? x.t.length : 0), 0);
  if (cells(left) + 3 + clock.length + health.text.length + 2 <= width) left.push(sep, clock); // the clock only if it fits
  const tone =
    health.level === 'error' ? C.red : health.level === 'warn' ? C.yellow : health.level === 'ok' ? C.green : C.dim;
  return (
    <box style={{ flexDirection: 'row', justifyContent: 'space-between', backgroundColor: C.headerBg, height: 1 }}>
      <Line segs={left} bg={C.headerBg} max={width - health.text.length - 2} />
      <Line segs={[{ t: `${health.text} `, fg: tone }]} bg={C.headerBg} max={width} />
    </box>
  );
}

function Sidebar({
  current,
  badges,
  focused,
  height,
}: {
  current: ScreenId;
  badges: Partial<Record<ScreenId, Seg>>;
  focused: boolean;
  height: number;
}) {
  const rows: ReactNode[] = [];
  for (const group of GROUPS) {
    rows.push(<Line key={group} segs={[dim(group)]} />);
    for (const s of SCREENS.filter((x) => x.group === group)) {
      const on = s.id === current;
      const badge = badges[s.id];
      const name = `${on ? MARK.select : ' '}${s.key} ${s.label}`;
      rows.push(
        <box key={s.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Line segs={[{ t: name, fg: on ? C.cyan : C.fg, bold: on, bg: on && focused ? C.selectBg : undefined }]} />
          <Line segs={[badge]} />
        </box>,
      );
    }
  }
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={focused ? C.borderFocus : C.border}
      style={{ width: SIDEBAR, height, flexDirection: 'column', paddingLeft: 1, paddingRight: 1, flexShrink: 0 }}
    >
      {rows}
    </box>
  );
}

function TabLine({ current, width }: { current: ScreenId; width: number }) {
  const line = (long: boolean): Seg[] => [
    ' ',
    ...SCREENS.flatMap((s): Seg[] => {
      const on = s.id === current;
      return [{ t: `${s.key} ${on && long ? s.label : s.short}`, fg: on ? C.cyan : C.dim, bold: on }, ' '];
    }),
  ];
  const long = line(true);
  const length = long.reduce((n, x) => n + (typeof x === 'string' ? x.length : x ? x.t.length : 0), 0);
  return <Line segs={length <= width ? long : line(false)} max={width} />;
}

// ------------------------------------------------------------------ overlays --

function HelpDialog({ screen, onClose }: { screen: ScreenId; onClose(): void }) {
  useDialogKeys(() => {
    onClose();
    return true;
  });
  const global: Array<[string, string]> = [
    ['1–9, 0', 'go to a screen'],
    ['Tab', 'menu ↔ screen'],
    ['↑↓  j k', 'move'],
    ['Enter', 'open, edit, run'],
    ['Esc', 'back, cancel, close'],
    ['?', 'this help'],
    [':  Ctrl+K', 'go to or do anything'],
    ['r', 'refresh from the device'],
    ['p', 'other port'],
    ['q', 'quit'],
  ];
  const local = SCREEN_HELP[screen];
  const rows = Math.max(global.length, local.length);
  return (
    <Dialog title="Keys" width={72}>
      <Line segs={[bold('EVERYWHERE'.padEnd(36), C.dim), bold(`THIS SCREEN (${screenInfo(screen).label})`, C.dim)]} />
      {Array.from({ length: rows }, (_, i) => (
        <Line
          key={i}
          segs={[
            { t: (global[i]?.[0] ?? '').padEnd(11), fg: C.cyan },
            (global[i]?.[1] ?? '').padEnd(25),
            { t: (local[i]?.[0] ?? '').padEnd(10), fg: C.cyan },
            local[i]?.[1] ?? '',
          ]}
        />
      ))}
      <text> </text>
      <Line segs={[dim('Nothing that changes the device runs on one key: you always')]} />
      <Line segs={[dim('see what will change and confirm it.   Any key closes this.')]} />
    </Dialog>
  );
}

interface PaletteEntry {
  label: string;
  where: string;
  intent: Intent;
}

function paletteEntries(): PaletteEntry[] {
  const entries: PaletteEntry[] = SCREENS.map((s) => ({
    label: s.label,
    where: `${s.key} ${s.label}`,
    intent: { screen: s.id },
  }));
  const actions: Array<[string, Intent]> = [
    ['Set hour meter…', { screen: 'counters', action: 'hours' }],
    ['Set totalizer…', { screen: 'counters', action: 'units' }],
    ['Reset counters…', { screen: 'counters', action: 'resetBoth' }],
    ['Calibrate accel + gyro', { screen: 'calibrate', item: 'imu' }],
    ['Calibrate compass', { screen: 'calibrate', item: 'mag' }],
    ['Reboot…', { screen: 'diagnostics', action: 'reboot' }],
    ['Panic signal…', { screen: 'diagnostics', action: 'panic' }],
    ['Hard reset…', { screen: 'diagnostics', action: 'hard' }],
    ['Update firmware…', { screen: 'firmware' }],
    ['Save service report', { screen: 'report' }],
    ['Measure vibration threshold', { screen: 'live' }],
  ];
  for (const [label, intent] of actions)
    entries.push({ label, where: `${screenInfo(intent.screen).key} ${screenInfo(intent.screen).label}`, intent });
  for (const s of SETTING_UI)
    entries.push({
      label: `${s.label} (${s.name})`,
      where: '6 Settings',
      intent: { screen: 'settings', item: s.name },
    });
  return entries;
}

function PaletteDialog({ onPick, onClose }: { onPick(intent: Intent): void; onClose(): void }) {
  const [text, setText, textRef] = useRefState('');
  const [sel, setSel, selRef] = useRefState(0);
  const all = useMemo(paletteEntries, []);
  const search = (t: string) => {
    const words = t.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((e) => words.every((w) => `${e.label} ${e.where}`.toLowerCase().includes(w))).slice(0, 8);
  };
  const found = search(text);
  const index = Math.min(sel, Math.max(0, found.length - 1));
  useDialogKeys((k: KeyEvent) => {
    const list = search(textRef.current);
    const n = Math.max(1, list.length);
    const at = Math.min(selRef.current, n - 1);
    if (k.name === 'escape') onClose();
    else if (k.name === 'return') {
      if (list[at]) onPick(list[at].intent);
    } else if (k.name === 'down') setSel((at + 1) % n);
    else if (k.name === 'up') setSel((at + n - 1) % n);
    else {
      const next = editLine(textRef.current, k);
      if (next !== undefined) {
        setText(next);
        setSel(0);
      }
    }
    return true;
  });
  return (
    <Dialog title="Go to or do…" width={62}>
      <FieldLine label="› " text={text} placeholder="type a screen, an action or a setting" />
      {found.map((e, i) => (
        <Spread
          key={e.label}
          left={[
            { t: `${i === index ? MARK.select : ' '} ${e.label}`, fg: i === index ? C.cyan : C.fg, bold: i === index },
          ]}
          right={[dim(e.where)]}
        />
      ))}
      {found.length === 0 ? <Line segs={[dim('  nothing matches')]} /> : null}
    </Dialog>
  );
}

function ConfirmQuitDialog({
  pending,
  onQuit,
  onClose,
  word,
}: {
  pending: number;
  onQuit(): void;
  onClose(): void;
  word: string;
}) {
  useDialogKeys((k) => {
    if (k.name === 'return') onQuit();
    if (k.name === 'escape') onClose();
    return true;
  });
  return (
    <Dialog title={word === 'quit' ? 'Quit' : 'Other port'} width={58}>
      <Line segs={[`${pending} settings change${pending === 1 ? ' is' : 's are'} not applied yet.`]} />
      <Line segs={[dim(`They are lost if you ${word} now.`)]} />
      <text> </text>
      <DialogButtons ok={word === 'quit' ? 'Quit anyway' : 'Leave anyway'} cancel="Stay" />
    </Dialog>
  );
}

/** The Bluetooth PIN (dots), from the banner's [u] or the palette. */
export function UnlockDialog({ onClose }: { onClose(): void }) {
  const { ctrl } = useShell();
  const ui = useUi(ctrl);
  const [pin, setPin, pinRef] = useRefState('');
  const [error, setError] = useState<string>();
  const [, setSending, sendingRef] = useRefState(false);
  useDialogKeys((k) => {
    if (sendingRef.current) return true; // one try at a time: a wrong PIN counts toward the 60 s lockout
    const typed = pinRef.current;
    if (k.name === 'escape') onClose();
    else if (k.name === 'return') {
      if (!/^\d{1,4}$/.test(typed)) setError('the PIN is 1 to 4 digits');
      else {
        setSending(true);
        void ctrl.unlock(typed).then((r) => {
          setSending(false);
          if (r.ok) onClose();
          else setError(r.text.replace(/^unlock: /, ''));
        });
      }
    } else {
      const next = editLine(typed, k, (c) => /\d/.test(c) && typed.length < 4);
      if (next !== undefined) setPin(next);
    }
    return true;
  });
  return (
    <Dialog title="Unlock Bluetooth session" width={60}>
      <FieldLine label="PIN  " text={pin} mask placeholder="4 digits" />
      <text> </text>
      <Line segs={[dim('Kept for automatic reconnects. 5 wrong PINs lock unlocking for 60 s.')]} />
      {error ? <Line segs={[{ t: `${MARK.error} ${error}`, fg: C.red }]} /> : null}
      {ui.busy ? <Line segs={[{ t: `${MARK.busy} ${ui.busy}…`, fg: C.yellow }]} /> : null}
      <text> </text>
      <DialogButtons ok="Unlock" />
    </Dialog>
  );
}

// --------------------------------------------------------------------- shell --

function Screen({ id }: { id: ScreenId }) {
  switch (id) {
    case 'overview':
      return <OverviewScreen />;
    case 'counters':
      return <CountersScreen />;
    case 'report':
      return <ReportScreen />;
    case 'commission':
      return <CommissionScreen />;
    case 'live':
      return <LiveScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'calibrate':
      return <CalibrateScreen />;
    case 'diagnostics':
      return <DiagnosticsScreen />;
    case 'firmware':
      return <FirmwareScreen />;
    case 'log':
      return <LogScreen />;
  }
}

export function Shell(props: ShellProps) {
  const { ctrl } = props;
  const { width, height } = useTerminalDimensions();
  const ui = useUi(ctrl);
  const now = useNow(1000);
  const [screen, setScreen, screenRef] = useRefState<ScreenId>('overview');
  const [menuFocus, setMenuFocus, menuRef] = useRefState(false);
  const [dialog, setDialog, dialogRef] = useRefState<ReactNode>(undefined);
  const [visit, setVisit] = useState(0); // a new value opens the current screen afresh
  const screenKeys = useRef<KeyHandler | undefined>(undefined);
  const dialogKeys = useRef<KeyHandler | undefined>(undefined);
  const intent = useRef<Intent | undefined>(undefined);
  // Keys that arrive after a change of screen or dialog, before it is drawn, wait here: they belong to the new
  // screen or dialog, whose handler is not registered yet (OpenTUI hands over all the keys of one read at once).
  const waiting = useRef<KeyEvent[] | undefined>(undefined);

  const wide = width >= WIDE_COLUMNS;
  const pending = pendingChanges(ui.device.settings, ui.draft).length;
  const flags = ui.device.values.statusFlags === undefined ? [] : activeFlags(ui.device);
  const ctx = { fwVersion: ui.device.values.fwVersion as number | undefined, autoTimeSync: props.autoTimeSync };
  const issues = problems(flags, ctx);
  const bn = banner(ui.device, {
    nowMs: now,
    sinceMs: ui.sinceMs,
    transport: props.transport,
    canSwitchPort: props.canSwitchPort,
    flashing: ctrl.flashing,
    locked: ui.locked,
  });
  const bodyHeight = height - 2 - (bn ? 1 : 0) - (wide ? 0 : 1);
  const contentWidth = (wide ? width - SIDEBAR : width) - 4;

  /** Show screen `id`; keys wait until it is drawn. */
  const show = (id: ScreenId) => {
    if (id !== screenRef.current) waiting.current ??= [];
    setScreen(id);
  };
  const go = (id: ScreenId) => {
    if (id === screenRef.current && intent.current?.screen === id) {
      // Already there: open it afresh, as screens take an intent when they open (else it would fire on a later visit).
      waiting.current ??= [];
      setVisit((n) => n + 1);
    }
    show(id);
    setMenuFocus(false);
  };
  const openDialog = (d: ReactNode) => {
    waiting.current ??= [];
    setDialog(d);
  };
  const closeDialog = () => {
    dialogKeys.current = undefined;
    setDialog(undefined);
  };
  const api: ShellApi = {
    ctrl,
    width: contentWidth,
    height: bodyHeight - 2,
    wide,
    go,
    openDialog: (d) => (d === undefined ? closeDialog() : openDialog(d)),
    transport: props.transport,
    screenKeys,
    dialogKeys,
    intent,
    autoTimeSync: props.autoTimeSync,
    toolVersion: props.toolVersion,
  };

  const leave = (word: 'quit' | 'switch', run: () => void) => {
    if (ctrl.flashing) return ctrl.log('warn', FLASH_RUNNING);
    if (pending > 0) {
      return openDialog(
        <ConfirmQuitDialog
          pending={pending}
          word={word === 'quit' ? 'quit' : 'switch port'}
          onQuit={() => {
            closeDialog();
            run();
          }}
          onClose={closeDialog}
        />,
      );
    }
    run();
  };

  /** One key: to the open dialog, else the menu or the screen, else the global keys. */
  const route = (key: KeyEvent) => {
    if (dialogKeys.current) {
      dialogKeys.current(key);
      return;
    }
    const c = charOf(key);
    if (menuRef.current) {
      const index = SCREENS.findIndex((s) => s.id === screenRef.current);
      if (key.name === 'down' || c === 'j') show(SCREENS[(index + 1) % SCREENS.length].id);
      else if (key.name === 'up' || c === 'k') show(SCREENS[(index + SCREENS.length - 1) % SCREENS.length].id);
      else if (key.name === 'return' || key.name === 'tab' || key.name === 'escape' || key.name === 'right')
        setMenuFocus(false);
      else if (c && screenByKey(c)) go(screenByKey(c)!.id);
      else if (c === 'q') leave('quit', props.onQuit);
      return;
    }
    if (screenKeys.current?.(key)) return;
    if (c && screenByKey(c)) return go(screenByKey(c)!.id);
    if (key.name === 'tab') return setMenuFocus(true);
    if (c === '?') return openDialog(<HelpDialog screen={screenRef.current} onClose={closeDialog} />);
    if (c === ':' || (key.ctrl && key.name === 'k')) {
      return openDialog(
        <PaletteDialog
          onClose={closeDialog}
          onPick={(i) => {
            closeDialog();
            intent.current = i;
            go(i.screen);
          }}
        />,
      );
    }
    if (c === 'r') return void ctrl.refresh();
    if (c === 'p' && props.canSwitchPort) return leave('switch', props.onSwitchPort);
    if (c === 'u' && ui.locked) return openDialog(<UnlockDialog onClose={closeDialog} />);
    if (c === 'q') return leave('quit', props.onQuit);
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === 'c') return leave('quit', props.onQuit);
    if (waiting.current) return void waiting.current.push(key);
    route(key);
  });

  // The new screen or dialog is drawn and has registered its keys (children's effects run before this one): it gets
  // the keys that waited, in order. A key among them that changes the screen or dialog again holds back the rest.
  useEffect(() => {
    const keys = waiting.current;
    if (!keys || screen !== screenRef.current || dialog !== dialogRef.current) return;
    waiting.current = undefined;
    const held = () => waiting.current; // route() may start waiting again: read it fresh
    for (const [i, key] of keys.entries()) {
      const again = held();
      if (again) {
        again.push(...keys.slice(i));
        return;
      }
      route(key);
    }
  });

  const errors = issues.filter((i) => i.severity === 'error').length;
  const badges: Partial<Record<ScreenId, Seg>> = {
    diagnostics: issues.length
      ? { t: `${errors ? MARK.error : MARK.warn}${issues.length}`, fg: errors ? C.red : C.yellow }
      : undefined,
    firmware: updateAvailable(ui.device.values.fwVersion, ui.releases) ? { t: MARK.update, fg: C.yellow } : undefined,
    settings: pending ? { t: `${MARK.changed}${pending}`, fg: C.yellow } : undefined,
  };
  const recent = ui.result && now - ui.result.atMs < 8000 ? ui.result : undefined;
  const status: Seg = ui.busy
    ? { t: ` ${MARK.busy} ${ui.busy}…`, fg: C.yellow }
    : recent
      ? { t: ` ${recent.ok ? MARK.ok : MARK.error} ${recent.text}`, fg: recent.ok ? C.green : C.red }
      : false;
  const footerKeys = dialog
    ? isValidElement(dialog) && dialog.type === HelpDialog
      ? 'any key closes'
      : isValidElement(dialog) && dialog.type === PaletteDialog
        ? 'type to search   ↑↓ select   Enter go   Esc close'
        : 'Enter confirm   Esc cancel'
    : menuFocus
      ? '↑↓ choose   Enter open   1–9 0 jump'
      : ctrl.flashing
        ? 'q and p wait for the update   1–9 0 screens   ? help'
        : screen === 'firmware' && ui.flash
          ? 'Enter back to the list   ? help'
          : FOOTER[screen];
  const statusWidth = status ? Math.max(0, width - footerKeys.length - 3) : 0;
  const bottomTitle = ctrl.flashing
    ? ` ${MARK.busy} flashing `
    : ui.device.lastFrameMs !== undefined && (screen === 'overview' || screen === 'live')
      ? ` updated ${age(ui.device.lastFrameMs, now)} ago `
      : undefined;

  return (
    <ShellContext.Provider value={api}>
      <box style={{ flexDirection: 'column', width, height }}>
        <Header ui={ui} props={props} now={now} width={width} />
        {bn ? (
          <Spread
            left={[{ t: ` ${bn.text}`, fg: bn.level === 'error' ? C.red : C.yellow, bold: true }]}
            right={bn.key ? [...keyHint(bn.key, bn.action ?? '')] : []}
            max={width - (bn.key ? (bn.action?.length ?? 0) + 7 : 0)}
          />
        ) : null}
        {!wide ? <TabLine current={screen} width={width} /> : null}
        <box style={{ flexDirection: 'row', height: bodyHeight }}>
          {wide ? <Sidebar current={screen} badges={badges} focused={menuFocus} height={bodyHeight} /> : null}
          <box
            border
            borderStyle="rounded"
            borderColor={menuFocus ? C.border : C.border}
            title={` ${screenInfo(screen).label} `}
            bottomTitle={bottomTitle}
            bottomTitleAlignment="right"
            style={{
              width: wide ? width - SIDEBAR : width,
              height: bodyHeight,
              overflow: 'hidden',
              flexDirection: 'column',
              paddingLeft: 1,
              paddingRight: 1,
            }}
          >
            <Screen key={`${screen}:${visit}`} id={screen} />
            {dialog}
          </box>
        </box>
        <Spread
          left={[status && { ...status, t: fit(status.t, statusWidth) }]}
          right={[dim(`${footerKeys} `)]}
          max={width}
        />
      </box>
    </ShellContext.Provider>
  );
}
